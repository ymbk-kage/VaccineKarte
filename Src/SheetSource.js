// Sheets API access with a 60 s in-isolate cache, background refresh (stale-while-revalidate) and 10 min stale
// fallback (Design §2-2, §2-4).
import { validateHeader, mapRows, cellText } from "./Records.js";
import { createSingleFlight, withTimeout, INFLIGHT_MAX_AGE_MS } from "./SingleFlight.js";

// Fresh data lifetime
export const CACHE_TTL_MS = 60 * 1000;
// How long old data may be served after refresh failures
export const STALE_LIMIT_MS = 10 * 60 * 1000;
// Pause between refresh attempts after a failure (avoids hammering Google on every request)
export const RETRY_BACKOFF_MS = 10 * 1000;

/**
 * Build the spreadsheets.get URL that returns values and background colours together.
 * @param {string} sheetId
 * @param {string} sheetName
 * @returns {string}
 */
export function buildSheetUrl(sheetId, sheetName) {
  // Quote the sheet name so any characters are safe inside the A1 range (A-S = 19 fixed columns, T = 備考)
  const range = `'${String(sheetName).replace(/'/g, "''")}'!A1:T`;
  // Values, colours and the three kinds of cell links in the same single call (Design §10-2)
  const fields = "sheets(properties(title),data(rowData(values(formattedValue,effectiveFormat(backgroundColor),"
    + "hyperlink,textFormatRuns(format(link(uri))),chipRuns(chip(richLinkProperties(uri,mimeType)))))))";
  // prettyPrint=false: Google indents JSON by default; the grid of ~1000 mostly blank rows shrinks 3.2 MB -> 0.85 MB
  const params = new URLSearchParams({ ranges: range, includeGridData: "true", fields, prettyPrint: "false" });
  return `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}?${params.toString()}`;
}

/**
 * Create a grid loader that calls the Sheets API.
 * @param {{fetchFn: typeof fetch, getToken: () => Promise<string>, sheetId: string, sheetName: string}} options
 * @returns {() => Promise<any[]>} resolves to rowData (header row first)
 */
export function createSheetsGridLoader({ fetchFn, getToken, sheetId, sheetName }) {
  return async function loadGrid() {
    // Authorise with a read-only access token
    const token = await getToken();
    // Bounded by a deadline so a stalled Google call fails instead of hanging the request
    const response = await fetchFn(buildSheetUrl(sheetId, sheetName), withTimeout({
      headers: { Authorization: `Bearer ${token}` },
    }));
    if (!response.ok) {
      // Keep only the HTTP status and Google's status string (never the body text)
      let googleStatus = null;
      try {
        googleStatus = (await response.json())?.error?.status ?? null;
      } catch {
        googleStatus = null;
      }
      throw Object.assign(new Error("sheets request failed"), { code: "sheet_unavailable", httpStatus: response.status, googleStatus });
    }
    const body = await response.json();
    // An empty sheet has no rowData at all
    return body?.sheets?.[0]?.data?.[0]?.rowData || [];
  };
}

/**
 * Create the cached record source.
 * @param {{loadGrid: () => Promise<any[]>, now?: () => number, log?: (entry: object) => void, inflightMaxAgeMs?: number}} options
 * @returns {{load: (options?: {waitUntil?: (promise: Promise<any>) => void}) => Promise<{records: object[], fetchedAt: number, stale: boolean, cacheHit: boolean}>}}
 */
export function createSheetSource({ loadGrid, now = () => Date.now(), log = () => {}, inflightMaxAgeMs = INFLIGHT_MAX_AGE_MS }) {
  // Last good snapshot: {records, fetchedAt, headerOk}
  let snapshot = null;
  // Shared in-flight refresh with a lifetime (an orphaned refresh is abandoned, see SingleFlight.js)
  const singleFlight = createSingleFlight({
    now,
    maxAgeMs: inflightMaxAgeMs,
    timeoutError: () => Object.assign(new Error("sheet refresh timed out"), { code: "sheet_unavailable", detail: "inflight_timeout" }),
  });
  // Time of the last failed refresh
  let lastFailureAt = -Infinity;
  // Error of the last failed refresh
  let lastError = null;

  /**
   * Fetch, validate and map the grid into a new snapshot.
   */
  async function refresh() {
    const rows = await loadGrid();
    // Refuse to map columns when the header row differs (column shift guard)
    const headerTexts = (rows[0]?.values || []).map(cellText);
    const header = validateHeader(headerTexts);
    if (!header.ok) {
      throw Object.assign(new Error("sheet layout changed"), { code: "sheet_layout_changed", reason: header.reason });
    }
    snapshot = { records: mapRows(rows), fetchedAt: now(), headerOk: true };
    return snapshot;
  }

  /**
   * Serve the old snapshot within the stale limit, otherwise rethrow.
   */
  function staleOrThrow(error) {
    if (snapshot && now() - snapshot.fetchedAt <= STALE_LIMIT_MS) {
      return { records: snapshot.records, fetchedAt: snapshot.fetchedAt, stale: true, cacheHit: true };
    }
    throw error;
  }

  /**
   * Start (or join) the single shared refresh. The promise is handed to waitUntil so that a cancelled request
   * (the browser aborts the previous search on every keystroke) cannot cancel the Google fetch it started:
   * otherwise every later caller in the isolate would wait out the 20 s in-flight lifetime.
   * @param {((promise: Promise<any>) => void)|undefined} waitUntil
   */
  function startRefresh(waitUntil) {
    const shared = singleFlight("sheet", () => refresh()
        .then((result) => {
          lastError = null;
          return result;
        })
        .catch((error) => {
          // Log only the error code and upstream status, never data
          lastFailureAt = now();
          lastError = error;
          log({
            event: "sheet_refresh_failed",
            code: error.code || "sheet_unavailable",
            httpStatus: error.httpStatus ?? null,
            googleStatus: error.googleStatus ?? null,
            // Fixed reason id (e.g. sa_json_invalid, token_http) so failures before any HTTP call stay diagnosable
            detail: error.detail ?? null,
          });
          throw error;
        }));
    // Keep the refresh alive past the request; the registered copy never rejects (failures are logged above)
    if (typeof waitUntil === "function") waitUntil(shared.catch(() => {}));
    return shared;
  }

  /**
   * Return records. Within the TTL the cache answers; after it, a snapshot inside the stale limit is returned
   * at once while one shared refresh runs in the background (stale-while-revalidate); with no usable snapshot
   * the caller waits for the refresh.
   * @param {{waitUntil?: (promise: Promise<any>) => void}} [options] ctx.waitUntil of the current request
   */
  async function load({ waitUntil } = {}) {
    // Fresh cache hit
    if (snapshot && now() - snapshot.fetchedAt < CACHE_TTL_MS) {
      return { records: snapshot.records, fetchedAt: snapshot.fetchedAt, stale: false, cacheHit: true };
    }
    // Recently failed: do not retry yet
    if (lastError && now() - lastFailureAt < RETRY_BACKOFF_MS) return staleOrThrow(lastError);
    // Old but usable snapshot: answer now and refresh in the background
    if (snapshot && now() - snapshot.fetchedAt <= STALE_LIMIT_MS) {
      // The background promise is observed (waitUntil + catch) so a failure is never an unhandled rejection
      startRefresh(waitUntil).catch(() => {});
      // stale is true only while refreshes are known to be failing (same meaning as before)
      return { records: snapshot.records, fetchedAt: snapshot.fetchedAt, stale: lastError !== null, cacheHit: true };
    }
    // No usable snapshot: wait for the shared refresh
    try {
      const result = await startRefresh(waitUntil);
      return { records: result.records, fetchedAt: result.fetchedAt, stale: false, cacheHit: false };
    } catch (error) {
      // A refresh that never settled is invisible otherwise: record the abandonment itself
      if (error.detail === "inflight_timeout") {
        log({ event: "sheet_refresh_failed", code: error.code, httpStatus: null, googleStatus: null, detail: error.detail });
      }
      // Make unexpected errors look like an unavailable sheet
      if (!error.code) error.code = "sheet_unavailable";
      return staleOrThrow(error);
    }
  }

  return { load };
}
