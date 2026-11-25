// Unit tests for Src/Http.js (Design §1-2(6), §2-5)
import { test } from "node:test";
import assert from "node:assert/strict";
import { SECURITY_HEADERS, ERRORS, json, errorResponse, htmlErrorResponse, withSecurityHeaders, isLocalHost, attachmentResponse,
  ATTACHMENT_IMAGE_CSP, ATTACHMENT_PDF_CSP, attachmentUnavailableMessage } from "../../Src/Http.js";

// Assert that every security header is present with the exact value
function assertSecurityHeaders(response) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    assert.equal(response.headers.get(name), value, name);
  }
}

test("CSP contains the designed directives", () => {
  const csp = SECURITY_HEADERS["Content-Security-Policy"];
  for (const directive of ["default-src 'none'", "script-src 'self'", "style-src 'self' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com", "connect-src 'self'", "img-src 'self' data:", "frame-src 'self'", "base-uri 'none'",
    "form-action 'none'", "frame-ancestors 'none'"]) {
    assert.ok(csp.includes(directive), directive);
  }
});

test("json() sets content type, status and security headers", async () => {
  const response = json({ a: 1 }, 201);
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("Content-Type"), "application/json; charset=utf-8");
  assertSecurityHeaders(response);
  assert.deepEqual(await response.json(), { a: 1 });
});

test("errorResponse maps every code to its status and Japanese message", async () => {
  for (const [code, entry] of Object.entries(ERRORS)) {
    const response = errorResponse(code);
    assert.equal(response.status, entry.status, code);
    assertSecurityHeaders(response);
    const body = await response.json();
    assert.equal(body.error.code, code);
    assert.equal(body.error.message, entry.message);
  }
  // Unknown codes become internal_error
  const unknown = errorResponse("whatever");
  assert.equal(unknown.status, 500);
  assert.equal((await unknown.json()).error.code, "internal_error");
});

test("design error table statuses", () => {
  assert.equal(ERRORS.access_not_configured.status, 503);
  assert.equal(ERRORS.unauthorized.status, 401);
  assert.equal(ERRORS.forbidden.status, 403);
  assert.equal(ERRORS.sheet_layout_changed.status, 503);
  assert.equal(ERRORS.sheet_unavailable.status, 503);
  assert.equal(ERRORS.not_found.status, 404);
  assert.equal(ERRORS.bad_request.status, 400);
  // Attachment codes (Design §10-3)
  assert.equal(ERRORS.attachment_unavailable.status, 404);
  assert.equal(ERRORS.attachment_unsupported.status, 415);
  assert.equal(ERRORS.attachment_too_large.status, 413);
  // The default wording names no specific folder (the name is configurable)
  assert.ok(ERRORS.attachment_unavailable.message.includes("共有フォルダ"));
  assert.ok(!ERRORS.attachment_unavailable.message.includes("VaccineFormFiles"));
  assert.ok(ERRORS.attachment_unsupported.message.includes("HEIC"));
  assert.ok(ERRORS.attachment_too_large.message.includes("20 MB"));
});

test("htmlErrorResponse is minimal and script-free", async () => {
  const response = htmlErrorResponse("access_not_configured");
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Content-Type"), "text/html; charset=utf-8");
  assertSecurityHeaders(response);
  const text = await response.text();
  assert.ok(text.includes(ERRORS.access_not_configured.message));
  assert.ok(!/<script/i.test(text));
  assert.ok(!/style=/i.test(text));
});

test("withSecurityHeaders overwrites existing headers and keeps the body", async () => {
  const original = new Response("hello", { status: 200, headers: { "Cache-Control": "max-age=3600", ETag: "\"x\"", "Content-Type": "text/plain" } });
  const response = withSecurityHeaders(original);
  assertSecurityHeaders(response);
  assert.equal(response.headers.get("ETag"), null);
  assert.equal(response.headers.get("Content-Type"), "text/plain");
  assert.equal(await response.text(), "hello");
});

test("isLocalHost is true only for localhost and 127.0.0.1", () => {
  assert.equal(isLocalHost("localhost"), true);
  assert.equal(isLocalHost("127.0.0.1"), true);
  assert.equal(isLocalHost("vaccine.example.org"), false);
  assert.equal(isLocalHost("localhost.evil.example"), false);
  assert.equal(isLocalHost("127.0.0.2"), false);
  assert.equal(isLocalHost("[::1]"), false);
  assert.equal(isLocalHost(""), false);
});

// ---------- attachments (Design §10-3, §10-5) ----------

test("page CSP gains frame-src 'self' and keeps frame-ancestors 'none'", () => {
  const csp = SECURITY_HEADERS["Content-Security-Policy"];
  assert.ok(csp.includes("frame-src 'self'"));
  assert.ok(csp.includes("frame-ancestors 'none'"));
  assert.ok(!csp.includes("frame-ancestors 'self'"));
  assert.ok(!csp.includes("object-src"));
});

test("attachmentResponse for an image: sandboxed CSP and attachment headers", async () => {
  const response = attachmentResponse(new Uint8Array([1, 2, 3]), { mimeType: "image/png", ext: "png", size: 3, format: "original" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "image/png");
  assert.equal(response.headers.get("Content-Length"), "3");
  assert.equal(response.headers.get("Content-Disposition"), 'inline; filename="attachment.png"');
  assert.equal(response.headers.get("Content-Security-Policy"), ATTACHMENT_IMAGE_CSP);
  assert.ok(ATTACHMENT_IMAGE_CSP.includes("frame-ancestors 'self'"));
  assert.ok(ATTACHMENT_IMAGE_CSP.includes("sandbox"));
  assert.equal(response.headers.get("Vary"), "Accept");
  assert.equal(response.headers.get("X-Attachment-Format"), "original");
  // Common protections stay
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(response.headers.get("X-Robots-Tag"), "noindex, nofollow, noarchive");
  assert.equal((await response.arrayBuffer()).byteLength, 3);
});

test("attachmentResponse for a PDF drops sandbox (Chrome PDF viewer) and HEAD omits the format", () => {
  const response = attachmentResponse(null, { mimeType: "application/pdf", ext: "pdf", size: 1234 });
  assert.equal(response.headers.get("Content-Security-Policy"), ATTACHMENT_PDF_CSP);
  assert.ok(ATTACHMENT_PDF_CSP.includes("frame-ancestors 'self'"));
  assert.ok(!ATTACHMENT_PDF_CSP.includes("sandbox"));
  assert.equal(response.headers.get("Content-Length"), "1234");
  assert.equal(response.headers.get("X-Attachment-Format"), null);
  assert.equal(response.headers.get("Vary"), "Accept");
});

test("attachmentUnavailableMessage names the configured folder, else keeps the default", () => {
  // Configured name appears in the message
  assert.ok(attachmentUnavailableMessage("FormFiles").includes("「FormFiles」フォルダ"));
  // Surrounding spaces are ignored
  assert.ok(attachmentUnavailableMessage("  FormFiles  ").includes("「FormFiles」フォルダ"));
  // Empty, blank or missing values fall back to the default wording
  for (const value of ["", "   ", undefined, null]) {
    assert.equal(attachmentUnavailableMessage(value), ERRORS.attachment_unavailable.message);
  }
});

test("errorResponse uses a message override for known codes only", async () => {
  // Known code: the override replaces the table message, status is unchanged
  const known = errorResponse("attachment_unavailable", {}, "custom");
  assert.equal(known.status, 404);
  assert.deepEqual(await known.json(), { error: { code: "attachment_unavailable", message: "custom" } });
  // Unknown code: the override is ignored and the generic 500 text is used
  const unknown = errorResponse("no_such_code", {}, "custom");
  assert.equal(unknown.status, 500);
  assert.equal((await unknown.json()).error.message, ERRORS.internal_error.message);
});
