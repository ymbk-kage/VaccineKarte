<?php
// Unit tests for the PHP I/O layer (cache, sheet source, auth gate, routing, image variants, headers).
// The pure logic (Normalize/Records/Search/Attachments) is covered by Tests/Parity against the JS originals.
// Usage: php Php/Tests/Unit/RunUnitTests.php   (exit code = number of failures; no network access)
declare(strict_types=1);

namespace VaccinePortal;

// A php.ini-less local install loads no extensions: re-run once with the ones shared PHP hosting has enabled
$required = ['intl', 'mbstring', 'openssl', 'curl', 'gd'];
$missing = array_filter($required, static fn (string $ext): bool => !extension_loaded($ext));
if ($missing !== []) {
    if (getenv('VACCINE_UNIT_RELAUNCHED') === '1') {
        fwrite(STDERR, 'required extensions missing: ' . implode(', ', $missing) . "\n");
        exit(1);
    }
    putenv('VACCINE_UNIT_RELAUNCHED=1');
    $command = escapeshellarg(PHP_BINARY) . ' -d ' . escapeshellarg('extension_dir=' . dirname(PHP_BINARY) . DIRECTORY_SEPARATOR . 'ext');
    foreach ($required as $ext) {
        $command .= ' -d extension=' . $ext;
    }
    passthru($command . ' ' . escapeshellarg(__FILE__), $exitCode);
    exit($exitCode);
}

require_once __DIR__ . '/../../Private/Lib/App.php';

$failures = 0;
$passes = 0;

/**
 * Run one named test; any Throwable counts as a failure.
 */
function test(string $name, callable $body): void
{
    global $failures, $passes;
    try {
        $body();
        $passes++;
        echo "PASS {$name}\n";
    } catch (\Throwable $e) {
        $failures++;
        echo "FAIL {$name}: {$e->getMessage()} ({$e->getFile()}:{$e->getLine()})\n";
    }
}

/**
 * Throw when the condition is false.
 */
function check(bool $condition, string $message = 'assertion failed'): void
{
    if (!$condition) {
        throw new \RuntimeException($message);
    }
}

/**
 * Fresh temporary directory removed at shutdown.
 */
function tempDir(): string
{
    $dir = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'VaccinePortalTest-' . bin2hex(random_bytes(6));
    mkdir($dir, 0700, true);
    register_shutdown_function(static function () use ($dir): void {
        foreach (glob($dir . DIRECTORY_SEPARATOR . '*') ?: [] as $file) {
            @unlink($file);
        }
        @rmdir($dir);
    });
    return $dir;
}

// Synthetic grid exported from Src/Fixture.js (no real data)
$fixturePath = __DIR__ . '/../Fixture/FixtureData.json';
$fixture = json_decode((string) file_get_contents($fixturePath), true);

// ---------------------------------------------------------------- SecureCache

test('SecureCache: round trip keeps stdClass and arrays apart', function (): void {
    $cache = new SecureCache(tempDir(), 'secret');
    $value = ['list' => [], 'map' => new \stdClass(), 'n' => 1, 'text' => '山田'];
    $cache->put('Entry', $value);
    $back = $cache->get('Entry');
    check($back['map'] instanceof \stdClass, 'stdClass lost');
    check($back['list'] === [] && $back['n'] === 1 && $back['text'] === '山田');
    check(json_encode($back['map']) === '{}' && json_encode($back['list']) === '[]');
});

test('SecureCache: file is encrypted and unreadable with another key', function (): void {
    $dir = tempDir();
    (new SecureCache($dir, 'key-a'))->put('Entry', ['name' => '山田　太郎']);
    $raw = (string) file_get_contents($dir . '/Entry.bin');
    check(!str_contains($raw, '山田'), 'plaintext found on disk');
    check((new SecureCache($dir, 'key-b'))->get('Entry') === null, 'decrypted with wrong key');
});

test('SecureCache: missing and corrupt entries read as null', function (): void {
    $dir = tempDir();
    $cache = new SecureCache($dir, 'k');
    check($cache->get('Nothing') === null);
    file_put_contents($dir . '/Broken.bin', str_repeat('x', 40));
    check($cache->get('Broken') === null);
});

test('SecureCache: non-waiting lock fails while held', function (): void {
    $cache = new SecureCache(tempDir(), 'k');
    [$outer, $inner] = $cache->withLock('L', fn () => $cache->withLock('L', fn () => 'inner', false), false);
    check($outer === true && $inner === [false, null], 'nested lock was granted');
});

// ---------------------------------------------------------------- SheetSource

/**
 * Build a SheetSource over the fixture grid with a controllable clock, call counter and failure switch.
 */
function makeSource(array $grid, int &$clock, int &$calls, ?\Throwable &$failWith, array &$logs): SheetSource
{
    $loader = function () use ($grid, &$calls, &$failWith): array {
        $calls++;
        if ($failWith !== null) {
            throw $failWith;
        }
        return $grid;
    };
    return new SheetSource($loader, new SecureCache(tempDir(), 'k'), 'Sheet', function (array $e) use (&$logs): void {
        $logs[] = $e;
    }, function () use (&$clock): int {
        return $clock;
    });
}

test('SheetSource: miss, then cache hit within the TTL', function () use ($fixture): void {
    $clock = 1_000_000;
    $calls = 0;
    $fail = null;
    $logs = [];
    $source = makeSource($fixture['grid'], $clock, $calls, $fail, $logs);
    $first = $source->load();
    check($first['cacheHit'] === false && $first['stale'] === false && $calls === 1);
    check(count($first['records']) > 0, 'no records mapped');
    $clock += CACHE_TTL_MS - 1;
    $second = $source->load();
    check($second['cacheHit'] === true && $calls === 1, 'refetched inside TTL');
});

test('SheetSource: refresh after TTL; failure serves stale data and backs off', function () use ($fixture): void {
    $clock = 1_000_000;
    $calls = 0;
    $fail = null;
    $logs = [];
    $source = makeSource($fixture['grid'], $clock, $calls, $fail, $logs);
    $source->load();
    // Upstream breaks after the TTL
    $clock += CACHE_TTL_MS + 1;
    $fail = new UpstreamError('sheet_unavailable', 500, 'INTERNAL');
    $stale = $source->load();
    check($stale['stale'] === true && $stale['cacheHit'] === true && $calls === 2, 'no stale answer');
    check(($logs[0]['event'] ?? '') === 'sheet_refresh_failed' && $logs[0]['httpStatus'] === 500);
    // Inside the backoff no new call is made
    $clock += 1000;
    $source->load();
    check($calls === 2, 'retried inside backoff');
    // Beyond the stale limit the error surfaces
    $clock += STALE_LIMIT_MS;
    try {
        $source->load();
        check(false, 'expected an exception');
    } catch (UpstreamError $e) {
        check($e->errorCode === 'sheet_unavailable');
    }
});

test('SheetSource: a changed header is sheet_layout_changed', function () use ($fixture): void {
    $grid = $fixture['grid'];
    $grid[0]['values'][0]['formattedValue'] = '別の見出し';
    $clock = 1_000_000;
    $calls = 0;
    $fail = null;
    $logs = [];
    try {
        makeSource($grid, $clock, $calls, $fail, $logs)->load();
        check(false, 'expected an exception');
    } catch (UpstreamError $e) {
        check($e->errorCode === 'sheet_layout_changed', $e->errorCode);
    }
});

test('buildSheetUrl: quotes the sheet name and requests links and colours', function (): void {
    $url = buildSheetUrl('ID', "患者'管理");
    check(str_starts_with($url, 'https://sheets.googleapis.com/v4/spreadsheets/ID?'));
    parse_str((string) parse_url($url, PHP_URL_QUERY), $q);
    check($q['ranges'] === "'患者''管理'!A1:T", $q['ranges']);
    check($q['prettyPrint'] === 'false' && str_contains($q['fields'], 'chipRuns'));
    // A row band is requested as an explicit range
    parse_str((string) parse_url(buildSheetUrl('ID', '患者管理', 1001, 2000), PHP_URL_QUERY), $band);
    check($band['ranges'] === "'患者管理'!A1001:T2000", $band['ranges']);
    // The size call asks for the grid size only (no cell data)
    parse_str((string) parse_url(buildSheetSizeUrl('ID', "患者'管理"), PHP_URL_QUERY), $size);
    check($size['ranges'] === "'患者''管理'!A1:T1" && $size['fields'] === 'sheets(properties(gridProperties(rowCount)))');
    check(!isset($size['includeGridData']), 'size call downloads cells');
});

test('sheetBands: covers every row once, always at least the header band', function (): void {
    check(sheetBands(0, 1000) === [[1, 1000]], 'empty grid');
    check(sheetBands(1000, 1000) === [[1, 1000]]);
    check(sheetBands(1001, 1000) === [[1, 1000], [1001, 2000]]);
    check(count(sheetBands(7384, 1000)) === 8 && sheetBands(7384, 1000)[7] === [7001, 8000]);
});

test('SheetSource: banded loader gives the same records and row numbers as one big grid', function () use ($fixture): void {
    $grid = $fixture['grid'];
    // Reference: the whole grid mapped in one go
    $expected = mapRows($grid);
    // Split into bands of 7 rows (header in the first band only), with an all-blank band in between
    $bandSize = 7;
    $blank = array_fill(0, $bandSize, []);
    $loader = function () use ($grid, $bandSize, $blank): \Generator {
        $first = 1;
        foreach (array_chunk($grid, $bandSize) as $band) {
            yield [$first, $band];
            $first += $bandSize;
        }
        // Trailing blank band (Sheets omits rowData there) must be harmless
        yield [$first, []];
        yield [$first + $bandSize, $blank];
    };
    $source = new SheetSource($loader, new SecureCache(tempDir(), 'k'), 'Sheet', static function (): void {
    });
    $records = $source->load()['records'];
    check(count($records) === count($expected), count($records) . ' vs ' . count($expected));
    check(array_column($records, 'rowNumber') === array_column($expected, 'rowNumber'), 'row numbers shifted');
    check(json_encode($records) === json_encode($expected), 'banded records differ');
});

test('SheetSource: banded loader still rejects a changed header', function () use ($fixture): void {
    $grid = $fixture['grid'];
    $grid[0]['values'][0]['formattedValue'] = '別の見出し';
    $loader = function () use ($grid): \Generator {
        yield [1, array_slice($grid, 0, 3)];
        yield [4, array_slice($grid, 3)];
    };
    try {
        (new SheetSource($loader, new SecureCache(tempDir(), 'k'), 'Sheet', static function (): void {
        }))->load();
        check(false, 'expected an exception');
    } catch (UpstreamError $e) {
        check($e->errorCode === 'sheet_layout_changed', $e->errorCode);
    }
});

// ---------------------------------------------------------------- App (auth gate and routing)

/**
 * App over the fixture with caches in a temp dir; $env selects dev flags.
 */
function makeApp(array $env, array &$logs, array $configOverrides = []): App
{
    $dir = tempDir();
    // Overrides win over the defaults (array union keeps the left-hand keys)
    $config = $configOverrides + ['sheetId' => 'X', 'sheetName' => 'Y', 'serviceAccountPath' => $dir . '/none.json', 'cacheDir' => $dir, 'logDir' => $dir];
    return new App($config, $env + ['FIXTURE_DATA_PATH' => __DIR__ . '/../Fixture/FixtureData.json'], function (array $e) use (&$logs): void {
        $logs[] = $e;
    });
}

/**
 * Build a request with defaults.
 */
function req(string $method, string $path, string $host = 'localhost', ?string $user = null, string $body = '', array $headers = []): Request
{
    return new Request($method, $path, $host, 'http://' . $host, $headers, $body, $user);
}

test('App: no authenticated user is refused (fail-closed 503)', function (): void {
    $logs = [];
    $app = makeApp([], $logs);
    $response = $app->handle(req('GET', '/api/meta', 'vaccine.example.org'));
    check($response->status === 503 && str_contains((string) $response->body, 'access_not_configured'));
    // ?? would turn a null value into the fallback, so test the key and value explicitly
    check(array_key_exists('user', $logs[0]) && $logs[0]['user'] === null, 'refused request logged a user');
});

test('App: dev bypass works only on localhost', function (): void {
    $logs = [];
    $app = makeApp(['DEV_BYPASS_AUTH' => '1', 'FIXTURE_MODE' => '1'], $logs);
    check($app->handle(req('GET', '/api/me'))->status === 200);
    check($app->handle(req('GET', '/api/me', 'example.com'))->status === 503, 'bypass leaked to another host');
});

test('App: Basic user is accepted and reported as mode basic', function (): void {
    $logs = [];
    $app = makeApp([], $logs);
    $response = $app->handle(req('GET', '/api/me', 'vaccine.example.org', 'staff'));
    check($response->status === 200);
    check(json_decode((string) $response->body, true) === ['email' => 'staff', 'mode' => 'basic']);
    check($response->headers['Cache-Control'] === 'no-store' && str_contains($response->headers['Content-Security-Policy'], "frame-ancestors 'none'"));
});

test('App: production host never uses the fixture (no key file -> sheet_unavailable)', function (): void {
    $logs = [];
    $app = makeApp(['FIXTURE_MODE' => '1'], $logs);
    $response = $app->handle(req('GET', '/api/meta', 'vaccine.example.org', 'staff'));
    check($response->status === 503 && str_contains((string) $response->body, 'sheet_unavailable'), (string) $response->body);
});

test('App: search validates content type, origin and JSON', function (): void {
    $logs = [];
    $app = makeApp(['DEV_BYPASS_AUTH' => '1', 'FIXTURE_MODE' => '1'], $logs);
    $json = ['content-type' => 'application/json'];
    check($app->handle(req('POST', '/api/search', 'localhost', null, '{}', ['content-type' => 'text/plain']))->status === 400);
    check($app->handle(req('POST', '/api/search', 'localhost', null, '{}', $json + ['origin' => 'https://evil.example']))->status === 403);
    check($app->handle(req('POST', '/api/search', 'localhost', null, '{bad', $json))->status === 400);
    check($app->handle(req('POST', '/api/search', 'localhost', null, str_repeat(' ', MAX_BODY_LENGTH + 1), $json))->status === 400);
    check($app->handle(req('GET', '/api/search'))->status === 405);
    $ok = $app->handle(req('POST', '/api/search', 'localhost', null, '{"q":"山田太郎"}', $json + ['origin' => 'http://localhost']));
    $body = json_decode((string) $ok->body, true);
    check($ok->status === 200 && $body['total'] === 1, (string) $ok->body);
    // The log line never carries the search text
    check(!str_contains(json_encode($logs, JSON_UNESCAPED_UNICODE), '山田'), 'search text logged');
});

test('App: attachments (HEAD, GET, missing file, external link, unknown index)', function (): void {
    $logs = [];
    $app = makeApp(['DEV_BYPASS_AUTH' => '1', 'FIXTURE_MODE' => '1'], $logs);
    $head = $app->handle(req('HEAD', '/api/records/2/attachments/0'));
    check($head->status === 200 && $head->body === null && $head->headers['Content-Type'] === 'image/png' && !isset($head->headers['X-Attachment-Format']));
    $png = $app->handle(req('GET', '/api/records/2/attachments/0', 'localhost', null, '', ['accept' => 'image/webp,*/*']));
    check($png->status === 200 && str_starts_with((string) $png->body, "\x89PNG") && $png->headers['X-Attachment-Format'] === 'original');
    check($png->headers['Content-Security-Policy'] === ATTACHMENT_IMAGE_CSP && $png->headers['Content-Length'] === (string) strlen((string) $png->body));
    $pdf = $app->handle(req('GET', '/api/records/15/attachments/0'));
    check($pdf->status === 200 && str_starts_with((string) $pdf->body, '%PDF') && $pdf->headers['Content-Security-Policy'] === ATTACHMENT_PDF_CSP);
    check($app->handle(req('GET', '/api/records/31/attachments/0'))->status === 404, 'missing drive file');
    check($app->handle(req('GET', '/api/records/17/attachments/0'))->status === 404, 'external link proxied');
    check($app->handle(req('GET', '/api/records/2/attachments/9'))->status === 404);
    check($app->handle(req('POST', '/api/records/2/attachments/0'))->status === 405);
    // The log uses the route template, never the row number
    $routes = array_column($logs, 'route');
    check(in_array(ATTACHMENT_ROUTE, $routes, true) && !str_contains(json_encode($logs), '/records/2'));
});

test('App: record detail and unknown routes', function (): void {
    $logs = [];
    $app = makeApp(['DEV_BYPASS_AUTH' => '1', 'FIXTURE_MODE' => '1'], $logs);
    $detail = $app->handle(req('GET', '/api/records/2'));
    check($detail->status === 200 && str_contains((string) $detail->body, '山田'));
    check(!str_contains((string) $detail->body, 'attachmentFileIds'), 'private ids leaked');
    check($app->handle(req('GET', '/api/records/9999'))->status === 404);
    check($app->handle(req('GET', '/api/nothing'))->status === 404);
    check($app->handle(req('GET', '/index.html'))->status === 404, 'PHP served a static path');
});

test('isoTime matches Date#toISOString', function (): void {
    check(isoTime(1760918400123) === '2025-10-20T00:00:00.123Z', isoTime(1760918400123));
    check(isoTime(5) === '1970-01-01T00:00:00.005Z');
});

// ---------------------------------------------------------------- ImageVariant

test('acceptsWebp follows the Worker rules', function (): void {
    check(acceptsWebp('image/webp,*/*') && acceptsWebp('text/html, image/webp;q=0.5'));
    check(!acceptsWebp('image/webp;q=0') && !acceptsWebp('*/*') && !acceptsWebp(null) && !acceptsWebp(''));
});

test('chooseImageVariant: GD makes a smaller WebP from a photo-like JPEG', function (): void {
    // Noisy 400x300 JPEG at quality 100 (WebP at 80 is reliably smaller)
    $image = imagecreatetruecolor(400, 300);
    for ($i = 0; $i < 4000; $i++) {
        imagefilledrectangle($image, random_int(0, 399), random_int(0, 299), random_int(0, 399), random_int(0, 299),
            imagecolorallocate($image, random_int(0, 255), random_int(0, 255), random_int(0, 255)));
    }
    ob_start();
    imagejpeg($image, null, 100);
    $jpeg = (string) ob_get_clean();
    $logs = [];
    $variant = chooseImageVariant($jpeg, 'image/jpeg', 'image/webp', __NAMESPACE__ . '\\gdToWebp', function ($e) use (&$logs) {
        $logs[] = $e;
    });
    check($variant['format'] === 'webp' && $variant['mimeType'] === 'image/webp' && strlen($variant['body']) < strlen($jpeg));
    check(str_starts_with($variant['body'], 'RIFF') && substr($variant['body'], 8, 4) === 'WEBP');
    // Without WebP in Accept the original is kept
    check(chooseImageVariant($jpeg, 'image/jpeg', 'image/*', __NAMESPACE__ . '\\gdToWebp', fn ($e) => null)['format'] === 'original');
});

test('chooseImageVariant: skip reasons', function (): void {
    $logs = [];
    $log = function ($e) use (&$logs) {
        $logs[] = $e['reason'];
    };
    chooseImageVariant('abc', 'image/png', 'image/webp', null, $log);
    chooseImageVariant('abc', 'image/png', 'image/webp', fn () => '', $log);
    chooseImageVariant('abc', 'image/png', 'image/webp', fn () => throw new \RuntimeException(), $log);
    check($logs === ['binding_missing', 'transform_error', 'transform_error'], json_encode($logs));
    // A larger result keeps the original silently
    check(chooseImageVariant('abc', 'image/png', 'image/webp', fn () => 'abcdef', $log)['format'] === 'original' && count($logs) === 3);
});

// ---------------------------------------------------------------- Http

test('errorResponse: unknown codes become internal_error; HTML page never echoes input', function (): void {
    $r = errorResponse('no_such_code');
    check($r->status === 500 && str_contains((string) $r->body, 'internal_error'));
    $h = htmlErrorResponse('access_not_configured');
    check($h->status === 503 && !str_contains((string) $h->body, '<script'));
});

echo "\n{$passes} passed, {$failures} failed\n";
exit($failures);
