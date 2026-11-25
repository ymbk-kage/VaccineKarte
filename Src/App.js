// Request handler factory: fail-closed config check -> authentication -> routing -> security headers (Design §1, §4).
// Kept separate from Worker.js because the Workers runtime rejects non-handler named exports in the main module.
import { createAccessVerifier } from "./Access.js";
import { createGoogleTokenProvider } from "./GoogleAuth.js";
import { createSheetSource, createSheetsGridLoader } from "./SheetSource.js";
import { createDriveFileLoader } from "./DriveSource.js";
import { loadFixtureGrid, loadFixtureFile as defaultLoadFixtureFile } from "./Fixture.js";
import { parseQuery, searchRecords, toSummary, toDetail, computeMeta } from "./Search.js";
import { ATTACHMENT_TYPES, MAX_ATTACHMENT_BYTES } from "./Attachments.js";
import { chooseImageVariant, createImagesTransform, WEBP_SOURCE_TYPES } from "./ImageVariant.js";
import { json, errorResponse, htmlErrorResponse, isLocalHost, withSecurityHeaders, attachmentResponse, attachmentUnavailableMessage } from "./Http.js";

// Pseudo user for local development
export const DEV_EMAIL = "dev@localhost";
// Largest accepted search body (bytes of text)
export const MAX_BODY_LENGTH = 16 * 1024;
// Record detail path pattern
const RECORD_PATH = /^\/api\/records\/(\d{1,7})$/;
// Attachment path pattern (checked before RECORD_PATH; the query string is never read)
const ATTACHMENT_PATH = /^\/api\/records\/(\d{1,7})\/attachments\/(\d{1,2})$/;
// Route template written to the log instead of the real path (no row number or index)
export const ATTACHMENT_ROUTE = "/api/records/:rowNumber/attachments/:index";

/**
 * Write one JSON log line to the console.
 * @param {object} entry
 */
function defaultLog(entry) {
  console.log(JSON.stringify(entry));
}

/**
 * Create the request handler with injectable I/O (fetch, clock, logger, fixture loaders, image transformer factory).
 * @param {{fetchFn?: typeof fetch, now?: () => number, log?: (entry: object) => void, loadFixture?: () => Promise<any[]>,
 *          loadFixtureFile?: (fileId: string) => Promise<{mimeType: string, size: number, body: ReadableStream}|null>,
 *          makeTransform?: (images: any) => ((bytes: ArrayBuffer) => Promise<ArrayBuffer>)|null}} [deps]
 * @returns {{fetch: (request: Request, env: object, ctx?: object) => Promise<Response>}}
 */
export function createApp({
  fetchFn = (...args) => fetch(...args),
  now = () => Date.now(),
  log = defaultLog,
  loadFixture = loadFixtureGrid,
  loadFixtureFile = defaultLoadFixtureFile,
  makeTransform = createImagesTransform,
} = {}) {
  // Access verifier with its own JWKS cache
  const verifier = createAccessVerifier({ fetchFn, now });
  // Google-backed sheet source and Drive loader sharing one token provider (rebuilt only if settings change)
  let google = null;
  let googleKey = null;
  // Fixture-backed source for local development
  let fixtureSource = null;
  // Fixture-backed attachment provider: never calls Google (a missing file behaves like Drive 403)
  const fixtureFiles = {
    async getMeta(fileId) {
      const file = await loadFixtureFile(fileId);
      if (!file) throw Object.assign(new Error("fixture file missing"), { code: "attachment_unavailable", httpStatus: null });
      return { mimeType: file.mimeType, size: String(file.size) };
    },
    async openMedia(fileId) {
      const file = await loadFixtureFile(fileId);
      if (!file) throw Object.assign(new Error("fixture file missing"), { code: "attachment_unavailable", httpStatus: null });
      return new Response(file.body);
    },
  };

  /**
   * True when the synthetic fixture replaces Google (localhost AND FIXTURE_MODE=1).
   */
  function isFixture(env, local) {
    return local && env.FIXTURE_MODE === "1";
  }

  /**
   * Return the Google-backed sheet source and Drive loader for the current settings.
   */
  function getGoogle(env) {
    // Rebuild when the configuration changes (normally never within an isolate)
    const key = `${env.SHEET_ID}\u0000${env.SHEET_NAME}\u0000${env.GOOGLE_SA_JSON || ""}`;
    if (!google || googleKey !== key) {
      const tokens = createGoogleTokenProvider({ saJson: env.GOOGLE_SA_JSON, fetchFn, now });
      const loadGrid = createSheetsGridLoader({ fetchFn, getToken: tokens.getToken, sheetId: env.SHEET_ID, sheetName: env.SHEET_NAME });
      google = {
        sheetSource: createSheetSource({ loadGrid, now, log }),
        drive: createDriveFileLoader({ fetchFn, getToken: tokens.getToken, now }),
      };
      googleKey = key;
    }
    return google;
  }

  /**
   * Pick the record source: fixture only on localhost with FIXTURE_MODE=1, otherwise Google Sheets.
   */
  function getSource(env, local) {
    if (isFixture(env, local)) {
      // Same cache/mapping path as production, but fed by the synthetic grid
      if (!fixtureSource) fixtureSource = createSheetSource({ loadGrid: loadFixture, now, log });
      return fixtureSource;
    }
    return getGoogle(env).sheetSource;
  }

  /**
   * Authenticate the request. Returns {email, mode} or {errorCode}.
   */
  async function authenticate(request, env, local) {
    // Local bypass needs BOTH the dev flag and a localhost hostname
    if (env.DEV_BYPASS_ACCESS === "1" && local) return { email: DEV_EMAIL, mode: "dev" };
    // Fail closed when Access is not configured
    if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return { errorCode: "access_not_configured" };
    // Verify the Access JWT header
    const result = await verifier.verify(request, env);
    if (!result.ok) return { errorCode: result.code };
    return { email: result.email, mode: "access" };
  }

  /**
   * Route an authenticated request. Returns the response plus log fields.
   */
  async function route(request, env, url, user, local, info, ctx) {
    const { pathname } = url;
    const method = request.method;
    // Non-API paths are static assets
    if (!pathname.startsWith("/api/")) {
      info.route = "static";
      if (method !== "GET") return errorResponse("method_not_allowed", { Allow: "GET" });
      if (!env.ASSETS) return errorResponse("not_found");
      // Serve the asset; headers are overwritten by the caller
      return env.ASSETS.fetch(request);
    }
    // Search is the only non-GET route
    if (pathname === "/api/search") {
      info.route = "/api/search";
      if (method !== "POST") return errorResponse("method_not_allowed", { Allow: "POST" });
      return handleSearch(request, env, url, local, info, ctx);
    }
    // Attachments: the only route that also allows HEAD (checked before RECORD_PATH)
    const attachmentMatch = pathname.match(ATTACHMENT_PATH);
    if (attachmentMatch) {
      // Log the route template, never the row number or index
      info.route = ATTACHMENT_ROUTE;
      if (method !== "GET" && method !== "HEAD") return errorResponse("method_not_allowed", { Allow: "GET, HEAD" });
      return handleAttachment(request, env, local, info, ctx, Number(attachmentMatch[1]), Number(attachmentMatch[2]));
    }
    // Every other API route is GET-only
    if (method !== "GET") {
      info.route = "api_other";
      return errorResponse("method_not_allowed", { Allow: "GET" });
    }
    if (pathname === "/api/me") {
      info.route = "/api/me";
      return json({ email: user.email, mode: user.mode });
    }
    if (pathname === "/api/meta") {
      info.route = "/api/meta";
      const data = await loadData(env, local, info, ctx);
      if (data.error) return data.error;
      // attachmentFolder lets the UI name the Drive folder in its attachment error (empty = not configured)
      const attachmentFolder = String(env.ATTACHMENT_FOLDER_NAME ?? "").trim();
      return json({ ...computeMeta(data.records), fetchedAt: new Date(data.fetchedAt).toISOString(), stale: data.stale, attachmentFolder });
    }
    const recordMatch = pathname.match(RECORD_PATH);
    if (recordMatch) {
      // Log the route template, never the row number
      info.route = "/api/records/:rowNumber";
      const data = await loadData(env, local, info, ctx);
      if (data.error) return data.error;
      const rowNumber = Number(recordMatch[1]);
      const record = data.records.find((item) => item.rowNumber === rowNumber);
      if (!record) return errorResponse("not_found");
      info.resultCount = 1;
      return json(toDetail(record, data.records));
    }
    // Unknown API path
    info.route = "api_unknown";
    return errorResponse("not_found");
  }

  /**
   * POST /api/search: validate headers and body, then search.
   */
  async function handleSearch(request, env, url, local, info, ctx) {
    // Only JSON bodies are accepted
    const contentType = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
    if (contentType !== "application/json") return errorResponse("bad_request");
    // CSRF guard: a present Origin must be our own
    const origin = request.headers.get("Origin");
    if (origin !== null && origin !== url.origin) return errorResponse("forbidden");
    // Read the body with a size limit
    const text = await request.text();
    if (text.length > MAX_BODY_LENGTH) return errorResponse("bad_request");
    let body;
    try {
      body = text.trim() === "" ? {} : JSON.parse(text);
    } catch {
      return errorResponse("bad_request");
    }
    // Validate the conditions
    const query = parseQuery(body);
    if (query.error) return errorResponse("bad_request");
    // Search the cached records
    const data = await loadData(env, local, info, ctx);
    if (data.error) return data.error;
    const result = searchRecords(data.records, query);
    info.resultCount = result.total;
    return json({
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      sort: result.sort,
      items: result.items.map(toSummary),
      meta: { fetchedAt: new Date(data.fetchedAt).toISOString(), stale: data.stale },
    });
  }

  /**
   * GET|HEAD /api/records/:rowNumber/attachments/:index (Design §10-3).
   * The Drive id is resolved from the cached record; nothing in the request names a file.
   */
  async function handleAttachment(request, env, local, info, ctx, rowNumber, index) {
    // 1. Resolve the attachment from cached records (stale data is fine)
    const data = await loadData(env, local, info, ctx);
    if (data.error) return data.error;
    const record = data.records.find((item) => item.rowNumber === rowNumber);
    const attachment = record?.attachments?.[index];
    const fileId = record?.attachmentFileIds?.[index];
    if (!attachment || attachment.kind !== "drive" || !fileId) return errorResponse("not_found");
    const fixture = isFixture(env, local);
    const files = fixture ? fixtureFiles : getGoogle(env).drive;
    // Map upstream failures: unshared/missing -> attachment_unavailable, anything else -> outage
    const upstreamFailure = (error) => {
      info.upstreamStatus = error?.httpStatus ?? null;
      // The unavailable message names the configured Drive folder (ATTACHMENT_FOLDER_NAME), if any
      if (error?.code === "attachment_unavailable") {
        return errorResponse("attachment_unavailable", {}, attachmentUnavailableMessage(env.ATTACHMENT_FOLDER_NAME));
      }
      return errorResponse("sheet_unavailable");
    };
    // 2. Metadata only (mimeType, size)
    let meta;
    try {
      meta = await files.getMeta(fileId);
    } catch (error) {
      return upstreamFailure(error);
    }
    // 3. Allow-listed types only; the response uses our own type string
    const mimeType = String(meta.mimeType || "").split(";")[0].trim().toLowerCase();
    const ext = Object.hasOwn(ATTACHMENT_TYPES, mimeType) ? ATTACHMENT_TYPES[mimeType] : null;
    if (!ext) return errorResponse("attachment_unsupported");
    // 4. Size must be a number within the limit
    const size = meta.size === undefined || meta.size === null || meta.size === "" ? Number.NaN : Number(meta.size);
    if (!Number.isFinite(size) || size < 0) return errorResponse("attachment_unsupported");
    if (size > MAX_ATTACHMENT_BYTES) return errorResponse("attachment_too_large");
    // HEAD stops here: no media download, no conversion, original size, no format header
    if (request.method === "HEAD") return attachmentResponse(null, { mimeType, ext, size });
    // 5. Download the content
    let media;
    try {
      media = await files.openMedia(fileId);
    } catch (error) {
      return upstreamFailure(error);
    }
    // PDF and WebP stream straight through
    if (!WEBP_SOURCE_TYPES.includes(mimeType)) {
      return attachmentResponse(media.body, { mimeType, ext, size, format: "original" });
    }
    // JPEG/PNG are buffered so a smaller WebP can be tried (fixture mode never converts)
    const bytes = await media.arrayBuffer();
    const transform = fixture ? null : makeTransform(env.IMAGES);
    const variant = await chooseImageVariant({ bytes, mimeType, accept: request.headers.get("Accept"), transform, log });
    return attachmentResponse(variant.body, {
      mimeType: variant.mimeType,
      ext: variant.ext,
      size: variant.body.byteLength,
      format: variant.format,
    });
  }

  /**
   * Load records from the source, mapping failures to error responses.
   */
  async function loadData(env, local, info, ctx) {
    try {
      // waitUntil keeps a refresh started by this request running even if the request itself is cancelled
      const waitUntil = ctx && typeof ctx.waitUntil === "function" ? (promise) => ctx.waitUntil(promise) : undefined;
      const data = await getSource(env, local).load({ waitUntil });
      info.cacheHit = data.cacheHit;
      return data;
    } catch (error) {
      // Only known sheet errors are exposed; anything else is a generic outage
      const code = error && error.code === "sheet_layout_changed" ? "sheet_layout_changed" : "sheet_unavailable";
      return { error: errorResponse(code) };
    }
  }

  /**
   * Handle one request and emit exactly one log line.
   */
  async function handle(request, env, ctx) {
    const startedAt = now();
    const url = new URL(request.url);
    const local = isLocalHost(url.hostname);
    const isApi = url.pathname.startsWith("/api/");
    // Log fields (no query text, patient fields or row numbers)
    const info = { route: isApi ? "api" : "static", method: request.method, status: 0, email: null, resultCount: null, ms: 0, cacheHit: null };
    let response;
    try {
      const user = await authenticate(request, env, local);
      if (user.errorCode) {
        // Unauthenticated: JSON for the API, minimal HTML otherwise
        response = isApi ? errorResponse(user.errorCode) : htmlErrorResponse(user.errorCode);
      } else {
        info.email = user.email;
        response = await route(request, env, url, user, local, info, ctx);
        // Static responses get the security headers too
        if (info.route === "static") response = withSecurityHeaders(response);
      }
    } catch {
      // Unexpected failure: never leak details
      response = isApi ? errorResponse("internal_error") : htmlErrorResponse("internal_error");
    }
    // One JSON line per request
    info.status = response.status;
    info.ms = now() - startedAt;
    log(info);
    return response;
  }

  return { fetch: handle };
}
