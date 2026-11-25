// Cell link extraction and attachment list building (Design §10-2). Pure functions, no I/O.

// Hosts whose file links are fetched through the Worker
export const DRIVE_HOSTS = ["drive.google.com", "docs.google.com"];
// Shape of a Drive file id (letters, digits, "_" and "-", at least 10 chars)
export const DRIVE_ID_RE = /^[A-Za-z0-9_-]{10,}$/;
// MIME types the attachment endpoint serves, mapped to the neutral file extension (Design §10-3)
export const ATTACHMENT_TYPES = Object.freeze({
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
});
// Largest file the endpoint serves (matches the Cloudflare Images input limit)
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
// Path form of a Drive file link: /file/d/<id> optionally followed by more segments
const FILE_PATH_RE = /^\/file\/d\/([^/]+)(?:\/.*)?$/;

/**
 * Parse a URL string safely.
 * @param {unknown} value
 * @returns {URL|null}
 */
function safeUrl(value) {
  // Only strings can be links
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    return new URL(value.trim());
  } catch {
    return null;
  }
}

/**
 * Extract the Drive file id from the three supported link shapes.
 * @param {string} url
 * @returns {string|null}
 */
export function parseDriveFileId(url) {
  const parsed = safeUrl(url);
  // Only https links on the Drive hosts qualify
  if (!parsed || parsed.protocol !== "https:" || !DRIVE_HOSTS.includes(parsed.hostname)) return null;
  let candidate = null;
  // Shape 1: /file/d/<id>/...
  const pathMatch = parsed.pathname.match(FILE_PATH_RE);
  if (pathMatch) candidate = pathMatch[1];
  // Shapes 2 and 3: /open?id=<id> and /uc?id=<id>
  else if (parsed.pathname === "/open" || parsed.pathname === "/uc") candidate = parsed.searchParams.get("id");
  // The id must look like a Drive id (Docs/Sheets/Slides paths never reach here)
  return candidate && DRIVE_ID_RE.test(candidate) ? candidate : null;
}

/**
 * Classify one link URI.
 * @param {string} uri
 * @returns {{kind:"drive", url:string, fileId:string}|{kind:"external", url:string}|null}
 */
export function classifyLink(uri) {
  const parsed = safeUrl(uri);
  // Drop anything that is not https (http:, mailto:, tel:, javascript: ...)
  if (!parsed || parsed.protocol !== "https:") return null;
  // Use the canonical form so whitespace and casing quirks do not leak through
  const url = parsed.href;
  const fileId = parseDriveFileId(url);
  if (fileId) return { kind: "drive", url, fileId };
  // Everything else on https is an external link opened in a new tab
  return { kind: "external", url };
}

/**
 * Collect the link URIs of one cell (hyperlink -> textFormatRuns -> chipRuns), each URI once.
 * @param {any} cell  Sheets CellData
 * @returns {string[]}
 */
export function extractCellLinks(cell) {
  const result = [];
  // Add a URI once, ignoring non-strings and blanks
  const add = (uri) => {
    if (typeof uri !== "string" || uri.trim() === "") return;
    const value = uri.trim();
    if (!result.includes(value)) result.push(value);
  };
  if (!cell || typeof cell !== "object") return result;
  // Whole-cell link (Insert link or HYPERLINK())
  add(cell.hyperlink);
  // Links on part of the text
  if (Array.isArray(cell.textFormatRuns)) {
    for (const run of cell.textFormatRuns) add(run?.format?.link?.uri);
  }
  // Smart chips (e.g. a Drive file inserted with @)
  if (Array.isArray(cell.chipRuns)) {
    for (const run of cell.chipRuns) add(run?.chip?.richLinkProperties?.uri);
  }
  return result;
}

/**
 * Comparison key for de-duplicating external URLs (drop the fragment and a trailing slash).
 * @param {string} url
 * @returns {string}
 */
function externalKey(url) {
  return url.replace(/#.*$/, "").replace(/\/$/, "");
}

/**
 * Build the attachment list of one row.
 * @param {any[]} cells  the row's CellData (up to 19 columns)
 * @param {Array<{field:string, header:string}>} columns  column metadata in sheet order
 * @returns {{attachments: Array<{index:number, field:string, label:string, kind:"drive"|"external", url:string}>, fileIds: (string|null)[]}}
 */
export function buildAttachments(cells, columns) {
  const attachments = [];
  const fileIds = [];
  // Keys already kept in this row (first column / first kind wins)
  const seen = new Set();
  const list = Array.isArray(cells) ? cells : [];
  columns.forEach((column, col) => {
    // Number of links kept from this cell, for the "(2)" suffix
    let inCell = 0;
    for (const uri of extractCellLinks(list[col])) {
      const link = classifyLink(uri);
      if (!link) continue;
      // Drive links dedupe by file id, external links by normalised URL
      const key = link.kind === "drive" ? `drive:${link.fileId}` : `external:${externalKey(link.url)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      inCell += 1;
      // Label is the column header plus a counter for the 2nd and later links of the same cell
      const base = `${column.header}のリンク`;
      attachments.push({
        index: attachments.length,
        field: column.field,
        label: inCell === 1 ? base : `${base} (${inCell})`,
        kind: link.kind,
        url: link.url,
      });
      // Server-only file id list aligned with attachments (null for external)
      fileIds.push(link.kind === "drive" ? link.fileId : null);
    }
  });
  return { attachments, fileIds };
}
