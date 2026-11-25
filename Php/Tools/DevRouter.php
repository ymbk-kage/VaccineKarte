<?php
// Router for PHP's built-in server, emulating what Apache + .htaccess do on shared PHP hosting:
//   - every request (static files included) passes the authentication gate first
//   - /api/* goes to Api.php, everything else is a file from ../../Public with the security headers
//   - Private/ and dotfiles are never served
// Usage (fixture data, no Google access):
//   set FIXTURE_MODE=1, DEV_BYPASS_AUTH=1, FIXTURE_DATA_PATH=<Php/Tests/Fixture/FixtureData.json>
//   php -S 127.0.0.1:8799 Php/Tools/DevRouter.php
declare(strict_types=1);

require_once __DIR__ . '/../Private/Lib/Http.php';

use function VaccinePortal\htmlErrorResponse;
use function VaccinePortal\isLocalHost;
use function VaccinePortal\withSecurityHeaders;

// Static files come from the shared UI folder (the same files that are uploaded)
$publicDir = realpath(__DIR__ . '/../../Public');
$path = (string) parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH);

// API requests go to the real front controller
if (str_starts_with($path, '/api/')) {
    require __DIR__ . '/../Api.php';
    return true;
}

// Emulate the Basic-auth gate for static files: without the dev bypass on localhost, nothing is served
$host = strtolower((string) preg_replace('/:\d+$/', '', (string) ($_SERVER['HTTP_HOST'] ?? '')));
if (!(getenv('DEV_BYPASS_AUTH') === '1' && isLocalHost($host))) {
    htmlErrorResponse('access_not_configured')->send();
    return true;
}

// Map "/" to index.html and refuse anything outside Public/ or hidden
$relative = $path === '/' ? 'index.html' : ltrim(rawurldecode($path), '/');
$file = realpath($publicDir . DIRECTORY_SEPARATOR . $relative);
if ($file === false || !str_starts_with($file, $publicDir . DIRECTORY_SEPARATOR) || !is_file($file)
    || preg_match('#(^|[\\\\/])\.#', $relative)) {
    VaccinePortal\errorResponse('not_found')->send();
    return true;
}

// Same content types and headers as the .htaccess rules
$types = ['html' => 'text/html; charset=utf-8', 'js' => 'text/javascript; charset=utf-8', 'css' => 'text/css; charset=utf-8',
    'svg' => 'image/svg+xml', 'png' => 'image/png'];
$ext = strtolower(pathinfo($file, PATHINFO_EXTENSION));
(new VaccinePortal\Response(200, withSecurityHeaders(['Content-Type' => $types[$ext] ?? 'application/octet-stream']),
    (string) file_get_contents($file)))->send(($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'HEAD');
return true;
