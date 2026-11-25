<?php
// Sheets API access with a shared 60 s cache and 10 min stale fallback (PHP port of Src/SheetSource.js, Design §2-2, §2-4).
// The Worker kept the snapshot in isolate memory and refreshed it in the background; PHP keeps it in the encrypted
// file cache, and the refresh runs inside the request that wins the lock (others answer from the old snapshot).
declare(strict_types=1);

namespace VaccinePortal;

require_once __DIR__ . '/HttpClient.php';
require_once __DIR__ . '/SecureCache.php';
require_once __DIR__ . '/Records.php';

// Fresh data lifetime
const CACHE_TTL_MS = 60 * 1000;
// How long old data may be served after refresh failures
const STALE_LIMIT_MS = 10 * 60 * 1000;
// Pause between refresh attempts after a failure (avoids hammering Google on every request)
const RETRY_BACKOFF_MS = 10 * 1000;
// Rows fetched per Sheets API call. Decoding the whole grid at once needed ~240 MB for about 7,400 rows and
// can exceed a shared host's PHP memory_limit; one band of this size decodes to about 30-40 MB.
const SHEET_CHUNK_ROWS = 1000;
// Bands downloaded concurrently. Only their raw JSON text (~1-2 MB each) is held together; decoding stays
// one band at a time. Sequential bands took ~10 s for 7,384 rows versus ~3.5 s for the old single call.
const SHEET_PARALLEL_BANDS = 4;

/**
 * Quote the sheet name for an A1 range (any characters are safe inside single quotes).
 */
function quoteSheetName(string $sheetName): string
{
    return "'" . str_replace("'", "''", $sheetName) . "'";
}

/**
 * Build the spreadsheets.get URL that returns only the worksheet's grid size (no cell data).
 */
function buildSheetSizeUrl(string $sheetId, string $sheetName): string
{
    $query = http_build_query([
        'ranges' => quoteSheetName($sheetName) . '!A1:T1',
        'fields' => 'sheets(properties(gridProperties(rowCount)))',
        'prettyPrint' => 'false',
    ], '', '&', PHP_QUERY_RFC3986);
    return 'https://sheets.googleapis.com/v4/spreadsheets/' . rawurlencode($sheetId) . '?' . $query;
}

/**
 * Build the spreadsheets.get URL that returns values, colours and cell links together.
 * With $firstRow/$lastRow only that row band is requested (1-based, inclusive); without them the whole sheet.
 */
function buildSheetUrl(string $sheetId, string $sheetName, ?int $firstRow = null, ?int $lastRow = null): string
{
    // Quote the sheet name so any characters are safe inside the A1 range (A-S fixed columns, T = 備考)
    $band = $firstRow === null ? 'A1:T' : 'A' . $firstRow . ':T' . ($lastRow ?? '');
    $range = quoteSheetName($sheetName) . '!' . $band;
    // Values, colours and the three kinds of cell links in one call (Design §10-2)
    $fields = 'sheets(properties(title),data(rowData(values(formattedValue,effectiveFormat(backgroundColor),'
        . 'hyperlink,textFormatRuns(format(link(uri))),chipRuns(chip(richLinkProperties(uri,mimeType)))))))';
    // prettyPrint=false keeps the response compact
    $query = http_build_query([
        'ranges' => $range,
        'includeGridData' => 'true',
        'fields' => $fields,
        'prettyPrint' => 'false',
    ], '', '&', PHP_QUERY_RFC3986);
    return 'https://sheets.googleapis.com/v4/spreadsheets/' . rawurlencode($sheetId) . '?' . $query;
}

/**
 * Throw the tagged error for a non-2xx Sheets answer (keeps only the HTTP status and Google's status string).
 * @param array{status:int,body:string} $response
 * @throws UpstreamError
 */
function assertSheetsOk(array $response): void
{
    if ($response['status'] >= 200 && $response['status'] < 300) {
        return;
    }
    // Never keep the body text itself
    $error = json_decode($response['body'], true);
    $googleStatus = is_array($error) ? ($error['error']['status'] ?? null) : null;
    throw new UpstreamError('sheet_unavailable', $response['status'], is_string($googleStatus) ? $googleStatus : null);
}

/**
 * Split rows 1..$rowCount into [firstRow, lastRow] bands of $chunkRows (at least one band, for the header).
 * @return array<int,array{0:int,1:int}>
 */
function sheetBands(int $rowCount, int $chunkRows): array
{
    $bands = [];
    for ($first = 1; $first === 1 || $first <= $rowCount; $first += $chunkRows) {
        $bands[] = [$first, $first + $chunkRows - 1];
    }
    return $bands;
}

/**
 * Create a grid loader that reads the Sheets API in row bands.
 * The loader returns a generator of [firstRowNumber, rowData] pairs (the first band starts at row 1 = header),
 * so the caller can map and drop each band before the next one is decoded.
 * @param callable():string $getToken
 * @return callable():\Generator<int,array{0:int,1:array}>
 */
function createSheetsGridLoader(callable $getToken, string $sheetId, string $sheetName, int $chunkRows = SHEET_CHUNK_ROWS, int $parallel = SHEET_PARALLEL_BANDS): callable
{
    return static function () use ($getToken, $sheetId, $sheetName, $chunkRows, $parallel): \Generator {
        // Authorise with a read-only access token (reused for every band of this refresh)
        $headers = ['Authorization: Bearer ' . $getToken()];
        // The grid size decides how many bands exist (blank bands return no rowData, so it cannot be inferred)
        $sizeResponse = httpRequest('GET', buildSheetSizeUrl($sheetId, $sheetName), $headers);
        assertSheetsOk($sizeResponse);
        $size = json_decode($sizeResponse['body'], true);
        $rowCount = (int) ($size['sheets'][0]['properties']['gridProperties']['rowCount'] ?? 0);
        // Download a group of bands at once, then decode and hand them out one by one
        foreach (array_chunk(sheetBands($rowCount, $chunkRows), max(1, $parallel)) as $group) {
            $urls = array_map(static fn (array $band): string => buildSheetUrl($sheetId, $sheetName, $band[0], $band[1]), $group);
            $responses = httpGetMany($urls, $headers);
            foreach ($group as $index => [$firstRow]) {
                assertSheetsOk($responses[$index]);
                $body = json_decode($responses[$index]['body'], true);
                // Free the raw JSON text as soon as it is decoded
                $responses[$index] = null;
                // A blank band (or an empty sheet) has no rowData at all
                $rows = $body['sheets'][0]['data'][0]['rowData'] ?? [];
                unset($body);
                yield [$firstRow, $rows];
                unset($rows);
            }
        }
    };
}

/**
 * Normalise a loader result into [firstRowNumber, rowData] bands.
 * A plain rowData array (fixture, tests) is one band starting at row 1.
 * @return iterable<array{0:int,1:array}>
 */
function gridBands(mixed $loaded): iterable
{
    return $loaded instanceof \Generator ? $loaded : [[1, is_array($loaded) ? $loaded : []]];
}

/**
 * Cached record source shared by all requests through the encrypted file cache.
 */
final class SheetSource
{
    /**
     * @param callable():array $loadGrid Returns rowData (header first)
     * @param string $cacheName Cache entry name (fixture and production never share one)
     * @param callable(array):void $log One-line logger (never receives data)
     * @param callable():int $now Clock in epoch milliseconds
     */
    public function __construct(
        private $loadGrid,
        private SecureCache $cache,
        private string $cacheName,
        private $log,
        private $now = null,
    ) {
        $this->now ??= static fn (): int => (int) floor(microtime(true) * 1000);
    }

    /**
     * Return records: fresh cache, else a refresh (only one process at a time), else a usable stale snapshot.
     * @return array{records:array,fetchedAt:int,stale:bool,cacheHit:bool}
     * @throws UpstreamError
     */
    public function load(): array
    {
        $now = ($this->now)();
        $snapshot = $this->cache->get($this->cacheName);
        // Fresh cache hit
        if ($this->isFresh($snapshot, $now)) {
            return $this->answer($snapshot, false, true);
        }
        // Recently failed: do not retry yet
        $failure = $this->cache->get($this->cacheName . 'Failure');
        if (is_array($failure) && $now - (int) $failure['at'] < RETRY_BACKOFF_MS) {
            return $this->staleOrThrow($snapshot, $this->failureToError($failure));
        }
        $usable = $this->isUsable($snapshot, $now);
        // Old but usable snapshot: try to refresh without waiting; if another process is refreshing, answer now
        // (same meaning as the Worker's stale-while-revalidate: stale is true only while refreshes are failing)
        // The old snapshot is released during the refresh (it is ~35 MB at 7,000 rows) and read back only
        // for the fallback answers below
        unset($snapshot);
        [$acquired, $result] = $this->cache->withLock($this->cacheName, fn () => $this->refreshUnlessFresh(), !$usable);
        if (!$acquired || $result instanceof UpstreamError) {
            $snapshot = $this->cache->get($this->cacheName);
        }
        if (!$acquired) {
            // The re-read copy is the same or newer (another process may have just refreshed it)
            if ($usable && is_array($snapshot)) {
                return $this->answer($snapshot, is_array($failure), true);
            }
            // Waited the full in-flight lifetime without getting the lock
            ($this->log)(['event' => 'sheet_refresh_failed', 'code' => 'sheet_unavailable', 'httpStatus' => null,
                'googleStatus' => null, 'detail' => 'inflight_timeout']);
            throw new UpstreamError('sheet_unavailable', null, null, 'inflight_timeout');
        }
        // The refresh failed: fall back to the old snapshot within the stale limit
        if ($result instanceof UpstreamError) {
            return $this->staleOrThrow($snapshot, $result);
        }
        return $this->answer($result['snapshot'], false, $result['cacheHit']);
    }

    /**
     * Inside the lock: reuse a snapshot another process just wrote, otherwise fetch a new one.
     * Returns the error object instead of throwing so the lock is released normally.
     * @return array{snapshot:array,cacheHit:bool}|UpstreamError
     */
    private function refreshUnlessFresh(): array|UpstreamError
    {
        // Another process may have refreshed while we waited
        $current = $this->cache->get($this->cacheName);
        if ($this->isFresh($current, ($this->now)())) {
            return ['snapshot' => $current, 'cacheHit' => true];
        }
        try {
            $records = [];
            $headerRow = null;
            // Map band by band so only one band of raw grid data is in memory at a time
            foreach (gridBands(($this->loadGrid)()) as [$firstRow, $rows]) {
                if ($headerRow === null) {
                    // The first band starts at row 1: its first row is the header
                    $headerRow = $rows[0] ?? [];
                    // Refuse to map columns when the header row differs (column shift guard)
                    $headerTexts = array_map(__NAMESPACE__ . '\\cellText', $headerRow['values'] ?? []);
                    $header = validateHeader($headerTexts);
                    if (!($header['ok'] ?? false)) {
                        throw new UpstreamError('sheet_layout_changed', null, null, 'header_mismatch');
                    }
                    array_push($records, ...mapRows($rows));
                } elseif ($rows !== []) {
                    // Later bands: put the header in front so mapRows sees the same layout, then shift the
                    // row numbers (mapRows numbers index 1 as row 2; here index 1 is sheet row $firstRow)
                    $offset = $firstRow - 2;
                    foreach (mapRows(array_merge([$headerRow], $rows)) as $record) {
                        $record['rowNumber'] += $offset;
                        $records[] = $record;
                    }
                }
                // Drop the raw band before the next one is fetched
                unset($rows);
            }
            $snapshot = ['records' => $records, 'fetchedAt' => ($this->now)()];
            unset($records);
            // Publish the snapshot and clear the failure marker
            $this->cache->put($this->cacheName, $snapshot);
            $this->cache->put($this->cacheName . 'Failure', null);
            return ['snapshot' => $snapshot, 'cacheHit' => false];
        } catch (\Throwable $error) {
            // Unexpected errors look like an unavailable sheet
            $tagged = $error instanceof UpstreamError ? $error : new UpstreamError('sheet_unavailable', null, null, 'unexpected');
            // Log only the error code and upstream status, never data
            ($this->log)([
                'event' => 'sheet_refresh_failed',
                'code' => $tagged->errorCode,
                'httpStatus' => $tagged->httpStatus,
                'googleStatus' => $tagged->googleStatus,
                'detail' => $tagged->detail,
            ]);
            // Remember the failure for the retry backoff
            $this->cache->put($this->cacheName . 'Failure', [
                'at' => ($this->now)(),
                'code' => $tagged->errorCode,
                'httpStatus' => $tagged->httpStatus,
                'detail' => $tagged->detail,
            ]);
            return $tagged;
        }
    }

    /**
     * True when the snapshot is within the fresh TTL.
     */
    private function isFresh(mixed $snapshot, int $now): bool
    {
        return is_array($snapshot) && $now - (int) $snapshot['fetchedAt'] < CACHE_TTL_MS;
    }

    /**
     * True when the snapshot may still be served as stale data.
     */
    private function isUsable(mixed $snapshot, int $now): bool
    {
        return is_array($snapshot) && $now - (int) $snapshot['fetchedAt'] <= STALE_LIMIT_MS;
    }

    /**
     * Serve the old snapshot within the stale limit, otherwise rethrow.
     * @throws UpstreamError
     */
    private function staleOrThrow(mixed $snapshot, UpstreamError $error): array
    {
        if ($this->isUsable($snapshot, ($this->now)())) {
            return $this->answer($snapshot, true, true);
        }
        throw $error;
    }

    /**
     * Rebuild the error remembered in the failure marker.
     */
    private function failureToError(array $failure): UpstreamError
    {
        return new UpstreamError((string) ($failure['code'] ?? 'sheet_unavailable'), $failure['httpStatus'] ?? null, null, $failure['detail'] ?? null);
    }

    /**
     * Shape the result returned to the router.
     */
    private function answer(array $snapshot, bool $stale, bool $cacheHit): array
    {
        return ['records' => $snapshot['records'], 'fetchedAt' => (int) $snapshot['fetchedAt'], 'stale' => $stale, 'cacheHit' => $cacheHit];
    }
}
