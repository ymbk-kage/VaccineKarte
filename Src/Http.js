// Response helpers and security headers (Design §1-2(6), §2-5). Pure functions.

// Headers attached to every response
export const SECURITY_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "connect-src 'self'",
    "img-src 'self' data:",
    // Attachment PDFs are shown in a same-origin <iframe> (Design §10-5)
    "frame-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};

// Error code -> HTTP status and Japanese message shown to staff
export const ERRORS = {
  access_not_configured: { status: 503, message: "認証の設定が完了していません．管理者に連絡してください．" },
  unauthorized: { status: 401, message: "ログインが確認できません．ページを再読み込みしてください．" },
  forbidden: { status: 403, message: "このアカウントには閲覧権限がありません．" },
  sheet_layout_changed: { status: 503, message: "データベースの列構成が変わっています．管理者に連絡してください．" },
  sheet_unavailable: { status: 503, message: "データベースに接続できません．しばらくしてから再試行してください．" },
  not_found: { status: 404, message: "該当する記録がありません．" },
  bad_request: { status: 400, message: "検索条件の形式が正しくありません．" },
  method_not_allowed: { status: 405, message: "この操作は許可されていません．" },
  // Default wording without a folder name; attachmentUnavailableMessage() adds the configured one
  attachment_unavailable: { status: 404, message: "添付ファイルを開けません．ファイルが Google ドライブの共有フォルダにあり，サービスアカウントに共有されているか確認してください．" },
  attachment_unsupported: { status: 415, message: "この形式のファイルは表示できません（JPEG・PNG・WebP・PDF のみ）．HEIC は JPEG に変換して保存し直してください．" },
  attachment_too_large: { status: 413, message: "ファイルが大きすぎます（上限 20 MB）．縮小して保存し直してください．" },
  internal_error: { status: 500, message: "予期しないエラーが発生しました．しばらくしてから再試行してください．" },
};

/**
 * Return a copy of the response with the security headers set (overwriting any existing ones).
 * @param {Response} response
 * @returns {Response}
 */
export function withSecurityHeaders(response) {
  // Clone headers so immutable asset responses can be modified
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  // Remove validators that would let the browser revalidate cached copies
  headers.delete("ETag");
  headers.delete("Last-Modified");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * Build a JSON response with security headers.
 * @param {unknown} data
 * @param {number} [status=200]
 * @param {Record<string,string>} [extraHeaders]
 * @returns {Response}
 */
export function json(data, status = 200, extraHeaders = {}) {
  // Serialise and label as UTF-8 JSON
  const headers = { "Content-Type": "application/json; charset=utf-8", ...extraHeaders };
  return withSecurityHeaders(new Response(JSON.stringify(data), { status, headers }));
}

/**
 * Message for attachment_unavailable, naming the Drive folder when one is configured (Design §10-3).
 * @param {string|undefined|null} folderName  ATTACHMENT_FOLDER_NAME; empty means "not configured"
 * @returns {string}
 */
export function attachmentUnavailableMessage(folderName) {
  // Trim so a value of only spaces counts as not configured
  const name = String(folderName ?? "").trim();
  // No folder configured: keep the generic default wording
  if (!name) return ERRORS.attachment_unavailable.message;
  // Folder configured: tell staff exactly which folder to check
  return `添付ファイルを開けません．ファイルが Google ドライブの「${name}」フォルダにあり，共有されているか確認してください．`;
}

/**
 * Build a JSON error response for a known code.
 * @param {string} code
 * @param {Record<string,string>} [extraHeaders]
 * @param {string} [message]  Replaces the table message (used for the configured attachment folder name)
 * @returns {Response}
 */
export function errorResponse(code, extraHeaders = {}, message = undefined) {
  // Unknown codes fall back to a generic 500
  const entry = ERRORS[code] || ERRORS.internal_error;
  const safeCode = ERRORS[code] ? code : "internal_error";
  // An override applies only to known codes, so an unknown code never carries a custom text
  const text = ERRORS[code] && typeof message === "string" ? message : entry.message;
  return json({ error: { code: safeCode, message: text } }, entry.status, extraHeaders);
}

/**
 * Build a minimal script-free HTML error page (no patient data, no external resources).
 * @param {string} code
 * @param {Record<string,string>} [extraHeaders]
 * @returns {Response}
 */
export function htmlErrorResponse(code, extraHeaders = {}) {
  // Resolve the message from the fixed table only (never echo request data)
  const entry = ERRORS[code] || ERRORS.internal_error;
  const body = [
    "<!doctype html>",
    '<html lang="ja"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    "<title>VaccineKarte ワクチンカルテ</title></head>",
    `<body><h1>VaccineKarte ワクチンカルテ</h1><p>${entry.message}</p></body></html>`,
  ].join("\n");
  return withSecurityHeaders(new Response(body, {
    status: entry.status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...extraHeaders },
  }));
}

// CSP for attachment images: only embeddable by our own pages, and sandboxed (opaque origin) in case
// the bytes were ever interpreted as a document
export const ATTACHMENT_IMAGE_CSP = "default-src 'none'; frame-ancestors 'self'; sandbox";
// CSP for attachment PDFs: no sandbox, because Chrome's built-in PDF viewer renders a blank page inside
// a sandboxed document (Design §10-3)
export const ATTACHMENT_PDF_CSP = "default-src 'none'; frame-ancestors 'self'";

/**
 * Build an attachment response (Design §10-3): security headers with attachment-specific overrides.
 * @param {BodyInit|null} body  null for HEAD
 * @param {{mimeType: string, ext: string, size: number, format?: "webp"|"original"|null}} options
 * @returns {Response}
 */
export function attachmentResponse(body, { mimeType, ext, size, format = null }) {
  // Start from the common security headers (no-store, nosniff, no-referrer, noindex ...)
  const headers = new Headers(SECURITY_HEADERS);
  // Allow-listed type string, never the upstream value
  headers.set("Content-Type", mimeType);
  headers.set("Content-Length", String(size));
  // Neutral file name: no row number or patient name
  headers.set("Content-Disposition", `inline; filename="attachment.${ext}"`);
  // PDFs drop the sandbox directive (see ATTACHMENT_PDF_CSP)
  headers.set("Content-Security-Policy", mimeType === "application/pdf" ? ATTACHMENT_PDF_CSP : ATTACHMENT_IMAGE_CSP);
  // The body may differ by Accept (WebP negotiation)
  headers.set("Vary", "Accept");
  // Only GET responses report which variant was sent
  if (format) headers.set("X-Attachment-Format", format);
  return new Response(body, { status: 200, headers });
}

/**
 * True only for the local development hostnames.
 * @param {string} hostname
 * @returns {boolean}
 */
export function isLocalHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1";
}
