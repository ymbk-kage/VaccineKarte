// Google Drive file access for the attachment endpoint (Design §10-3).
// Reads only metadata (mimeType, size) and media; never the file name (no PII is kept).

// Drive v3 files endpoint
export const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files/";
// Metadata cache lifetime (pairs a HEAD probe with the following GET)
export const DRIVE_META_TTL_MS = 60 * 1000;
// Upper bound on cached metadata entries
const META_CACHE_LIMIT = 500;

/**
 * Turn a non-2xx Drive response into a tagged error.
 * 403/404 mean "not shared or gone" (attachment_unavailable); anything else is an upstream outage.
 * @param {Response} response
 * @returns {Error}
 */
function driveError(response) {
  const code = response.status === 403 || response.status === 404 ? "attachment_unavailable" : "sheet_unavailable";
  return Object.assign(new Error("drive request failed"), { code, httpStatus: response.status });
}

/**
 * Create a Drive loader with an in-isolate metadata cache.
 * @param {{fetchFn: typeof fetch, getToken: () => Promise<string>, now?: () => number}} options
 * @returns {{getMeta: (fileId: string) => Promise<{mimeType: string, size: string|undefined}>,
 *            openMedia: (fileId: string) => Promise<Response>}}
 */
export function createDriveFileLoader({ fetchFn, getToken, now = () => Date.now() }) {
  // fileId -> {mimeType, size, at}
  const metaCache = new Map();

  /**
   * Call one Drive URL with the service-account token.
   */
  async function call(url) {
    const token = await getToken();
    const response = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) {
      // Release the error body; only the status is kept
      try {
        await response.body?.cancel();
      } catch {
        // Ignore cancellation failures
      }
      throw driveError(response);
    }
    return response;
  }

  /**
   * Fetch (or reuse) the file's mimeType and size.
   */
  async function getMeta(fileId) {
    // Serve a fresh cached entry
    const cached = metaCache.get(fileId);
    if (cached && now() - cached.at < DRIVE_META_TTL_MS) return { mimeType: cached.mimeType, size: cached.size };
    const params = new URLSearchParams({ fields: "mimeType,size", supportsAllDrives: "true" });
    const response = await call(`${DRIVE_FILES_URL}${encodeURIComponent(fileId)}?${params.toString()}`);
    const body = await response.json();
    const meta = { mimeType: String(body?.mimeType ?? ""), size: body?.size };
    // Drop expired entries and keep the cache bounded
    for (const [key, entry] of metaCache) {
      if (now() - entry.at >= DRIVE_META_TTL_MS) metaCache.delete(key);
    }
    if (metaCache.size >= META_CACHE_LIMIT) metaCache.delete(metaCache.keys().next().value);
    metaCache.set(fileId, { ...meta, at: now() });
    return meta;
  }

  /**
   * Open the file content as a streaming Response.
   */
  async function openMedia(fileId) {
    const params = new URLSearchParams({ alt: "media", supportsAllDrives: "true" });
    return call(`${DRIVE_FILES_URL}${encodeURIComponent(fileId)}?${params.toString()}`);
  }

  return { getMeta, openMedia };
}
