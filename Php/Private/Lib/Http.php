<?php
// Response helpers and security headers (PHP port of Src/Http.js, Design §1-2(6), §2-5).
declare(strict_types=1);

namespace VaccinePortal;

// Headers attached to every response (same values as the Worker)
const SECURITY_HEADERS = [
    'Content-Security-Policy' => "default-src 'none'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; "
        . "font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; frame-src 'self'; "
        . "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'Cache-Control' => 'no-store',
    'X-Robots-Tag' => 'noindex, nofollow, noarchive',
    'Referrer-Policy' => 'no-referrer',
    'X-Content-Type-Options' => 'nosniff',
    'Permissions-Policy' => 'camera=(), microphone=(), geolocation=()',
    'Strict-Transport-Security' => 'max-age=31536000; includeSubDomains',
];

// Error code -> HTTP status and Japanese message shown to staff
const ERRORS = [
    'access_not_configured' => [503, '認証の設定が完了していません．管理者に連絡してください．'],
    'unauthorized' => [401, 'ログインが確認できません．ページを再読み込みしてください．'],
    'forbidden' => [403, 'このアカウントには閲覧権限がありません．'],
    'sheet_layout_changed' => [503, 'データベースの列構成が変わっています．管理者に連絡してください．'],
    'sheet_unavailable' => [503, 'データベースに接続できません．しばらくしてから再試行してください．'],
    'not_found' => [404, '該当する記録がありません．'],
    'bad_request' => [400, '検索条件の形式が正しくありません．'],
    'method_not_allowed' => [405, 'この操作は許可されていません．'],
    'attachment_unavailable' => [404, '添付ファイルを開けません．ファイルが Google ドライブの「VaccineFormFiles」フォルダにあり，共有されているか確認してください．'],
    'attachment_unsupported' => [415, 'この形式のファイルは表示できません（JPEG・PNG・WebP・PDF のみ）．HEIC は JPEG に変換して保存し直してください．'],
    'attachment_too_large' => [413, 'ファイルが大きすぎます（上限 20 MB）．縮小して保存し直してください．'],
    'internal_error' => [500, '予期しないエラーが発生しました．しばらくしてから再試行してください．'],
];

// CSP for attachment images: embeddable only by our pages, sandboxed in case the bytes are read as a document
const ATTACHMENT_IMAGE_CSP = "default-src 'none'; frame-ancestors 'self'; sandbox";
// CSP for attachment PDFs: no sandbox (Chrome's PDF viewer renders blank inside a sandboxed document)
const ATTACHMENT_PDF_CSP = "default-src 'none'; frame-ancestors 'self'";

/**
 * A buffered or streamed HTTP response. The body is either a string or a callable that echoes the content.
 */
final class Response
{
    /**
     * @param int $status HTTP status code
     * @param array<string,string> $headers Header name => value
     * @param string|callable|null $body Bytes, a streaming callback, or null (HEAD)
     */
    public function __construct(
        public int $status,
        public array $headers = [],
        public mixed $body = null,
    ) {
    }

    /**
     * Send the status, headers and body to the client.
     */
    public function send(bool $head = false): void
    {
        // Status line first
        http_response_code($this->status);
        // Every header replaces any earlier value (Apache or PHP defaults)
        foreach ($this->headers as $name => $value) {
            header($name . ': ' . $value, true);
        }
        // HEAD responses carry headers only
        if ($head || $this->body === null) {
            return;
        }
        // Stream callbacks write the content themselves
        if (is_callable($this->body)) {
            ($this->body)();
            return;
        }
        echo $this->body;
    }
}

/**
 * Merge the security headers over the given headers (security headers win, like the Worker).
 * @param array<string,string> $headers
 * @return array<string,string>
 */
function withSecurityHeaders(array $headers): array
{
    return array_merge($headers, SECURITY_HEADERS);
}

/**
 * Encode data as JSON exactly like JSON.stringify (no escaped slashes or Unicode).
 */
function encodeJson(mixed $data): string
{
    // LINE_TERMINATORS: JS leaves U+2028/U+2029 unescaped, so the bytes match the Worker exactly
    return json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_LINE_TERMINATORS | JSON_THROW_ON_ERROR);
}

/**
 * Build a JSON response with security headers.
 * @param array<string,string> $extraHeaders
 */
function json(mixed $data, int $status = 200, array $extraHeaders = []): Response
{
    // Label as UTF-8 JSON, then apply the common headers
    $headers = array_merge(['Content-Type' => 'application/json; charset=utf-8'], $extraHeaders);
    return new Response($status, withSecurityHeaders($headers), encodeJson($data));
}

/**
 * Build a JSON error response for a known code (unknown codes become internal_error).
 * @param array<string,string> $extraHeaders
 */
function errorResponse(string $code, array $extraHeaders = []): Response
{
    // Fall back to a generic 500 for unknown codes
    $safeCode = array_key_exists($code, ERRORS) ? $code : 'internal_error';
    [$status, $message] = ERRORS[$safeCode];
    return json(['error' => ['code' => $safeCode, 'message' => $message]], $status, $extraHeaders);
}

/**
 * Build a minimal script-free HTML error page (never echoes request data).
 * @param array<string,string> $extraHeaders
 */
function htmlErrorResponse(string $code, array $extraHeaders = []): Response
{
    // Resolve the message from the fixed table only
    $safeCode = array_key_exists($code, ERRORS) ? $code : 'internal_error';
    [$status, $message] = ERRORS[$safeCode];
    $title = 'VaccineKarte ワクチンカルテ';
    $body = implode("\n", [
        '<!doctype html>',
        '<html lang="ja"><head><meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        '<meta name="robots" content="noindex, nofollow, noarchive">',
        "<title>{$title}</title></head>",
        "<body><h1>{$title}</h1><p>{$message}</p></body></html>",
    ]);
    $headers = array_merge(['Content-Type' => 'text/html; charset=utf-8'], $extraHeaders);
    return new Response($status, withSecurityHeaders($headers), $body);
}

/**
 * Build the headers of an attachment response (Design §10-3).
 * @param array{mimeType:string,ext:string,size:int,format?:?string} $options
 * @return array<string,string>
 */
function attachmentHeaders(array $options): array
{
    // Start from the common security headers (no-store, nosniff, no-referrer, noindex ...)
    $headers = SECURITY_HEADERS;
    // Allow-listed type string, never the upstream value
    $headers['Content-Type'] = $options['mimeType'];
    $headers['Content-Length'] = (string) $options['size'];
    // Neutral file name: no row number or patient name
    $headers['Content-Disposition'] = 'inline; filename="attachment.' . $options['ext'] . '"';
    // PDFs drop the sandbox directive
    $headers['Content-Security-Policy'] = $options['mimeType'] === 'application/pdf' ? ATTACHMENT_PDF_CSP : ATTACHMENT_IMAGE_CSP;
    // The body may differ by Accept (WebP negotiation)
    $headers['Vary'] = 'Accept';
    // Only GET responses report which variant was sent
    if (!empty($options['format'])) {
        $headers['X-Attachment-Format'] = $options['format'];
    }
    return $headers;
}

/**
 * True only for the local development hostnames.
 */
function isLocalHost(string $hostname): bool
{
    return $hostname === 'localhost' || $hostname === '127.0.0.1';
}
