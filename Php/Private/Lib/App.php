<?php
// Request handler: fail-closed auth check -> routing -> security headers (PHP port of Src/App.js, Design §1, §4).
// In production Apache's Basic authentication runs first; this file re-checks that a user was authenticated
// (the counterpart of the Worker's JWT re-verification) and refuses everything when it was not.
declare(strict_types=1);

namespace VaccinePortal;

require_once __DIR__ . '/Http.php';
require_once __DIR__ . '/HttpClient.php';
require_once __DIR__ . '/SecureCache.php';
require_once __DIR__ . '/GoogleAuth.php';
require_once __DIR__ . '/SheetSource.php';
require_once __DIR__ . '/DriveSource.php';
require_once __DIR__ . '/ImageVariant.php';
require_once __DIR__ . '/Attachments.php';
require_once __DIR__ . '/Search.php';

// Pseudo user for local development
const DEV_EMAIL = 'dev@localhost';
// Largest accepted search body (bytes of text)
const MAX_BODY_LENGTH = 16 * 1024;
// Record detail path pattern
const RECORD_PATH = '#^/api/records/(\d{1,7})$#';
// Attachment path pattern (checked before RECORD_PATH; the query string is never read)
const ATTACHMENT_PATH = '#^/api/records/(\d{1,7})/attachments/(\d{1,2})$#';
// Route template written to the log instead of the real path (no row number or index)
const ATTACHMENT_ROUTE = '/api/records/:rowNumber/attachments/:index';

/**
 * Minimal request value object built from the PHP superglobals (or by tests).
 */
final class Request
{
    /**
     * @param array<string,string> $headers Lower-cased header name => value
     */
    public function __construct(
        public string $method,
        public string $path,
        public string $host,
        public string $origin,
        public array $headers,
        public string $body,
        public ?string $remoteUser,
    ) {
    }

    /**
     * Build the request from the PHP runtime.
     */
    public static function fromGlobals(): self
    {
        // Path only: the query string is never read
        $path = (string) parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH);
        // Host without the port
        $hostHeader = (string) ($_SERVER['HTTP_HOST'] ?? '');
        $host = strtolower((string) preg_replace('/:\d+$/', '', $hostHeader));
        $https = ($_SERVER['HTTPS'] ?? '') === 'on' || ($_SERVER['HTTPS'] ?? '') === '1';
        // Collect the few headers the handler reads
        $headers = [];
        foreach (['CONTENT_TYPE' => 'content-type', 'HTTP_ORIGIN' => 'origin', 'HTTP_ACCEPT' => 'accept'] as $key => $name) {
            if (isset($_SERVER[$key])) {
                $headers[$name] = (string) $_SERVER[$key];
            }
        }
        // Apache sets these only after a successful Basic authentication. PHP's built-in server fills
        // PHP_AUTH_USER straight from the client's header without checking any password, so there it is ignored
        $user = PHP_SAPI === 'cli-server'
            ? null
            : ($_SERVER['PHP_AUTH_USER'] ?? $_SERVER['REMOTE_USER'] ?? $_SERVER['REDIRECT_REMOTE_USER'] ?? null);
        $body = (string) file_get_contents('php://input');
        return new self(
            strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET')),
            $path,
            $host,
            ($https ? 'https://' : 'http://') . $hostHeader,
            $headers,
            $body,
            is_string($user) && $user !== '' ? $user : null,
        );
    }
}

/**
 * The application: authentication, routing and data access.
 */
final class App
{
    private ?SheetSource $source = null;
    private ?DriveFileLoader $drive = null;
    private ?GoogleTokenProvider $tokens = null;

    /**
     * @param array<string,mixed> $config Private/Config.php values
     * @param array<string,string> $env Development flags (FIXTURE_MODE, DEV_BYPASS_AUTH, FIXTURE_DATA_PATH)
     * @param callable(array):void|null $log
     */
    public function __construct(private array $config, private array $env = [], private $log = null)
    {
        $this->log ??= fn (array $entry) => $this->writeLog($entry);
    }

    /**
     * Handle one request and emit exactly one log line.
     */
    public function handle(Request $request): Response
    {
        $startedAt = microtime(true);
        $local = isLocalHost($request->host);
        $isApi = str_starts_with($request->path, '/api/');
        // Log fields (no query text, patient fields or row numbers)
        $info = ['route' => $isApi ? 'api' : 'static', 'method' => $request->method, 'status' => 0, 'user' => null,
            'resultCount' => null, 'ms' => 0, 'cacheHit' => null];
        // Fatal errors (memory_limit, max_execution_time) bypass catch and would leave no log line at all
        $finished = false;
        $this->logFatalOnShutdown($info, $finished, $startedAt);
        try {
            $user = $this->authenticate($request, $local);
            if (isset($user['errorCode'])) {
                // Unauthenticated: JSON for the API, minimal HTML otherwise
                $response = $isApi ? errorResponse($user['errorCode']) : htmlErrorResponse($user['errorCode']);
            } else {
                $info['user'] = $user['email'];
                $response = $this->route($request, $user, $local, $info);
            }
        } catch (\Throwable) {
            // Unexpected failure: never leak details
            $response = $isApi ? errorResponse('internal_error') : htmlErrorResponse('internal_error');
        }
        // One JSON line per request
        $info['status'] = $response->status;
        $info['ms'] = (int) round((microtime(true) - $startedAt) * 1000);
        ($this->log)($info);
        // The request completed normally: the shutdown hook has nothing to report
        $finished = true;
        return $response;
    }

    /**
     * Register a shutdown hook that writes one log line when the request dies of a fatal error.
     * Only the error kind is logged (never the message, which could hold paths or data).
     * @param array<string,mixed> $info Log fields of the running request (read at shutdown time)
     */
    private function logFatalOnShutdown(array &$info, bool &$finished, float $startedAt): void
    {
        // Memory kept aside so the hook can still run after memory_limit was hit
        $reserve = str_repeat(' ', 64 * 1024);
        register_shutdown_function(function () use (&$info, &$finished, &$reserve, $startedAt): void {
            // Release the reserve first so logging has room to work
            $reserve = null;
            $error = error_get_last();
            $fatalTypes = E_ERROR | E_CORE_ERROR | E_COMPILE_ERROR | E_USER_ERROR;
            if ($finished || $error === null || ($error['type'] & $fatalTypes) === 0) {
                return;
            }
            // Classify the fatal error without copying its text
            $message = (string) $error['message'];
            $detail = str_contains($message, 'Allowed memory size') ? 'memory'
                : (str_contains($message, 'Maximum execution time') ? 'timeout' : 'fatal');
            ($this->log)(['event' => 'fatal', 'detail' => $detail] + array_merge($info, [
                'status' => 500,
                'ms' => (int) round((microtime(true) - $startedAt) * 1000),
            ]));
        });
    }

    /**
     * Authenticate: dev bypass only on localhost with the flag, otherwise Apache must have authenticated the user.
     * @return array{email?:string,mode?:string,errorCode?:string}
     */
    private function authenticate(Request $request, bool $local): array
    {
        // Local bypass needs BOTH the dev flag and a localhost hostname
        if (($this->env['DEV_BYPASS_AUTH'] ?? '') === '1' && $local) {
            return ['email' => DEV_EMAIL, 'mode' => 'dev'];
        }
        // Fail closed when Basic authentication did not run (.htaccess missing or broken)
        if ($request->remoteUser === null) {
            return ['errorCode' => 'access_not_configured'];
        }
        return ['email' => $request->remoteUser, 'mode' => 'basic'];
    }

    /**
     * True when the synthetic fixture replaces Google (localhost AND FIXTURE_MODE=1).
     */
    private function isFixture(bool $local): bool
    {
        return $local && ($this->env['FIXTURE_MODE'] ?? '') === '1';
    }

    /**
     * Route an authenticated request.
     * @param array<string,mixed> $info
     */
    private function route(Request $request, array $user, bool $local, array &$info): Response
    {
        $path = $request->path;
        $method = $request->method;
        // Static files are served by Apache in production; only the dev router asks us for them
        if (!str_starts_with($path, '/api/')) {
            $info['route'] = 'static';
            return errorResponse('not_found');
        }
        // Search is the only non-GET route
        if ($path === '/api/search') {
            $info['route'] = '/api/search';
            if ($method !== 'POST') {
                return errorResponse('method_not_allowed', ['Allow' => 'POST']);
            }
            return $this->handleSearch($request, $local, $info);
        }
        // Attachments: the only route that also allows HEAD (checked before RECORD_PATH)
        if (preg_match(ATTACHMENT_PATH, $path, $match)) {
            // Log the route template, never the row number or index
            $info['route'] = ATTACHMENT_ROUTE;
            if ($method !== 'GET' && $method !== 'HEAD') {
                return errorResponse('method_not_allowed', ['Allow' => 'GET, HEAD']);
            }
            return $this->handleAttachment($request, $local, $info, (int) $match[1], (int) $match[2]);
        }
        // Every other API route is GET-only
        if ($method !== 'GET') {
            $info['route'] = 'api_other';
            return errorResponse('method_not_allowed', ['Allow' => 'GET']);
        }
        if ($path === '/api/me') {
            $info['route'] = '/api/me';
            return json(['email' => $user['email'], 'mode' => $user['mode']]);
        }
        if ($path === '/api/meta') {
            $info['route'] = '/api/meta';
            $data = $this->loadData($local, $info);
            if ($data instanceof Response) {
                return $data;
            }
            $meta = computeMeta($data['records']);
            $meta = is_object($meta) ? (array) $meta : $meta;
            return json($meta + ['fetchedAt' => isoTime($data['fetchedAt']), 'stale' => $data['stale']]);
        }
        if (preg_match(RECORD_PATH, $path, $match)) {
            // Log the route template, never the row number
            $info['route'] = '/api/records/:rowNumber';
            $data = $this->loadData($local, $info);
            if ($data instanceof Response) {
                return $data;
            }
            $record = findRecord($data['records'], (int) $match[1]);
            if ($record === null) {
                return errorResponse('not_found');
            }
            $info['resultCount'] = 1;
            return json(toDetail($record, $data['records']));
        }
        // Unknown API path
        $info['route'] = 'api_unknown';
        return errorResponse('not_found');
    }

    /**
     * POST /api/search: validate headers and body, then search.
     * @param array<string,mixed> $info
     */
    private function handleSearch(Request $request, bool $local, array &$info): Response
    {
        // Only JSON bodies are accepted
        $contentType = strtolower(trim(explode(';', $request->headers['content-type'] ?? '')[0]));
        if ($contentType !== 'application/json') {
            return errorResponse('bad_request');
        }
        // CSRF guard: a present Origin must be our own
        if (isset($request->headers['origin']) && $request->headers['origin'] !== $request->origin) {
            return errorResponse('forbidden');
        }
        // Size limit, then strict JSON parsing (an empty body means "no conditions")
        if (strlen($request->body) > MAX_BODY_LENGTH) {
            return errorResponse('bad_request');
        }
        if (trim($request->body) === '') {
            $body = new \stdClass();
        } else {
            try {
                // Decoded as objects so that [] and {} stay distinguishable, exactly like JSON.parse
                $body = json_decode($request->body, false, 64, JSON_THROW_ON_ERROR);
            } catch (\JsonException) {
                return errorResponse('bad_request');
            }
        }
        // Validate the conditions (objectDecoded = true)
        $query = parseQuery($body, true);
        if (is_array($query) && array_key_exists('error', $query)) {
            return errorResponse('bad_request');
        }
        // Search the cached records
        $data = $this->loadData($local, $info);
        if ($data instanceof Response) {
            return $data;
        }
        $result = searchRecords($data['records'], $query);
        $info['resultCount'] = $result['total'];
        return json([
            'total' => $result['total'],
            'page' => $result['page'],
            'pageSize' => $result['pageSize'],
            'sort' => $result['sort'],
            'items' => array_map(__NAMESPACE__ . '\\toSummary', $result['items']),
            'meta' => ['fetchedAt' => isoTime($data['fetchedAt']), 'stale' => $data['stale']],
        ]);
    }

    /**
     * GET|HEAD /api/records/:rowNumber/attachments/:index (Design §10-3).
     * The Drive id is resolved from the cached record; nothing in the request names a file.
     * @param array<string,mixed> $info
     */
    private function handleAttachment(Request $request, bool $local, array &$info, int $rowNumber, int $index): Response
    {
        // 1. Resolve the attachment from cached records (stale data is fine)
        $data = $this->loadData($local, $info);
        if ($data instanceof Response) {
            return $data;
        }
        $record = findRecord($data['records'], $rowNumber);
        $attachment = $record === null ? null : field($record, 'attachments')[$index] ?? null;
        $fileId = $record === null ? null : field($record, 'attachmentFileIds')[$index] ?? null;
        if ($attachment === null || field($attachment, 'kind') !== 'drive' || !is_string($fileId) || $fileId === '') {
            return errorResponse('not_found');
        }
        $fixture = $this->isFixture($local);
        // Map upstream failures: unshared/missing -> attachment_unavailable, anything else -> outage
        $upstreamFailure = static function (\Throwable $error) use (&$info): Response {
            $info['upstreamStatus'] = $error instanceof UpstreamError ? $error->httpStatus : null;
            $unavailable = $error instanceof UpstreamError && $error->errorCode === 'attachment_unavailable';
            return errorResponse($unavailable ? 'attachment_unavailable' : 'sheet_unavailable');
        };
        // 2. Metadata only (mimeType, size)
        try {
            $meta = $fixture ? $this->fixtureFile($fileId) : $this->drive()->getMeta($fileId);
        } catch (\Throwable $error) {
            return $upstreamFailure($error);
        }
        // 3. Allow-listed types only; the response uses our own type string
        $mimeType = strtolower(trim(explode(';', (string) $meta['mimeType'])[0]));
        $ext = ATTACHMENT_TYPES[$mimeType] ?? null;
        if ($ext === null) {
            return errorResponse('attachment_unsupported');
        }
        // 4. Size must be a number within the limit
        $rawSize = $meta['size'];
        if ($rawSize === null || $rawSize === '' || !is_numeric($rawSize) || (float) $rawSize < 0) {
            return errorResponse('attachment_unsupported');
        }
        $size = (int) $rawSize;
        if ($size > MAX_ATTACHMENT_BYTES) {
            return errorResponse('attachment_too_large');
        }
        // HEAD stops here: no media download, no conversion, original size, no format header
        if ($request->method === 'HEAD') {
            return new Response(200, attachmentHeaders(['mimeType' => $mimeType, 'ext' => $ext, 'size' => $size]), null);
        }
        // 5. Download the content
        try {
            $bytes = $fixture ? $meta['bytes'] : $this->drive()->openMedia($fileId);
        } catch (\Throwable $error) {
            return $upstreamFailure($error);
        }
        // PDF and WebP pass straight through
        if (!in_array($mimeType, WEBP_SOURCE_TYPES, true)) {
            return new Response(200, attachmentHeaders(['mimeType' => $mimeType, 'ext' => $ext, 'size' => strlen($bytes), 'format' => 'original']), $bytes);
        }
        // JPEG/PNG: try a smaller WebP (fixture mode never converts, like the Worker)
        $transform = $fixture ? null : __NAMESPACE__ . '\\gdToWebp';
        $variant = chooseImageVariant($bytes, $mimeType, $request->headers['accept'] ?? null, $transform, $this->log);
        return new Response(200, attachmentHeaders([
            'mimeType' => $variant['mimeType'],
            'ext' => $variant['ext'],
            'size' => strlen($variant['body']),
            'format' => $variant['format'],
        ]), $variant['body']);
    }

    /**
     * Load records from the source, mapping failures to error responses.
     * @param array<string,mixed> $info
     * @return array{records:array,fetchedAt:int,stale:bool,cacheHit:bool}|Response
     */
    private function loadData(bool $local, array &$info): array|Response
    {
        try {
            $data = $this->source($local)->load();
            $info['cacheHit'] = $data['cacheHit'];
            return $data;
        } catch (\Throwable $error) {
            // Only known sheet errors are exposed; anything else is a generic outage
            $layout = $error instanceof UpstreamError && $error->errorCode === 'sheet_layout_changed';
            return errorResponse($layout ? 'sheet_layout_changed' : 'sheet_unavailable');
        }
    }

    /**
     * Pick the record source: fixture only on localhost with FIXTURE_MODE=1, otherwise Google Sheets.
     */
    private function source(bool $local): SheetSource
    {
        if ($this->source !== null) {
            return $this->source;
        }
        if ($this->isFixture($local)) {
            // Same cache/mapping path as production, but fed by the synthetic grid and a fixed dev key
            $cache = new SecureCache($this->config['cacheDir'], 'fixture');
            $loadGrid = fn (): array => $this->fixtureData()['grid'];
            return $this->source = new SheetSource($loadGrid, $cache, 'FixtureSheet', $this->log);
        }
        $tokens = $this->tokens();
        $loadGrid = createSheetsGridLoader(fn (): string => $tokens->getToken(), $this->config['sheetId'], $this->config['sheetName']);
        return $this->source = new SheetSource($loadGrid, $this->cache(), 'Sheet', $this->log);
    }

    /**
     * Drive loader sharing the token provider.
     */
    private function drive(): DriveFileLoader
    {
        $tokens = $this->tokens();
        return $this->drive ??= new DriveFileLoader(fn (): string => $tokens->getToken());
    }

    /**
     * Token provider for the service account (the key file is read once per request).
     */
    private function tokens(): GoogleTokenProvider
    {
        return $this->tokens ??= new GoogleTokenProvider($this->account(), $this->cache());
    }

    /**
     * Production cache, keyed by the service-account private key.
     */
    private function cache(): SecureCache
    {
        $account = $this->account();
        return new SecureCache($this->config['cacheDir'], (string) ($account['private_key'] ?? 'missing-key'));
    }

    /**
     * Read the service-account key; null when missing or invalid.
     * On the server it is a .php file returning the JSON text (never servable); locally it may be a .json file.
     */
    private function account(): ?array
    {
        $path = (string) $this->config['serviceAccountPath'];
        if (str_ends_with($path, '.php')) {
            $raw = is_file($path) ? (include $path) : false;
            $raw = is_string($raw) ? $raw : false;
        } else {
            $raw = @file_get_contents($path);
        }
        $decoded = $raw === false ? null : json_decode($raw, true);
        return is_array($decoded) ? $decoded : null;
    }

    /**
     * Synthetic fixture exported from Src/Fixture.js (Tools/ExportFixture.mjs).
     * @return array{grid:array,files:array}
     */
    private function fixtureData(): array
    {
        $path = $this->env['FIXTURE_DATA_PATH'] ?? '';
        $decoded = $path === '' ? null : json_decode((string) @file_get_contents($path), true);
        if (!is_array($decoded)) {
            throw new UpstreamError('sheet_unavailable', null, null, 'fixture_missing');
        }
        return $decoded;
    }

    /**
     * Fixture "Drive": a missing id behaves like an unshared Drive file.
     * @return array{mimeType:string,size:int,bytes:string}
     */
    private function fixtureFile(string $fileId): array
    {
        $file = $this->fixtureData()['files'][$fileId] ?? null;
        if (!is_array($file)) {
            throw new UpstreamError('attachment_unavailable');
        }
        $bytes = base64_decode((string) $file['base64'], true);
        return ['mimeType' => (string) $file['mimeType'], 'size' => strlen((string) $bytes), 'bytes' => (string) $bytes];
    }

    /**
     * Append one JSON line to the monthly request log (no query text or patient fields ever reach $entry).
     * @param array<string,mixed> $entry
     */
    private function writeLog(array $entry): void
    {
        $dir = $this->config['logDir'];
        if (!is_dir($dir)) {
            @mkdir($dir, 0700, true);
        }
        $line = json_encode(['at' => gmdate('c')] + $entry, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n";
        @file_put_contents($dir . '/Requests-' . gmdate('Y-m') . '.log', $line, FILE_APPEND | LOCK_EX);
    }
}

/**
 * Read a field from a record that may be an array or an object.
 */
function field(mixed $item, string $name): mixed
{
    if (is_array($item)) {
        return $item[$name] ?? null;
    }
    if (is_object($item)) {
        return $item->{$name} ?? null;
    }
    return null;
}

/**
 * Find a record by its sheet row number.
 */
function findRecord(array $records, int $rowNumber): mixed
{
    foreach ($records as $record) {
        if (field($record, 'rowNumber') === $rowNumber) {
            return $record;
        }
    }
    return null;
}

/**
 * Format epoch milliseconds like JavaScript's Date#toISOString (UTC, millisecond precision).
 */
function isoTime(int $epochMs): string
{
    $seconds = intdiv($epochMs, 1000);
    return gmdate('Y-m-d\TH:i:s', $seconds) . sprintf('.%03dZ', $epochMs % 1000);
}
