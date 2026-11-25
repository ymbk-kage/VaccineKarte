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

// RFC 3492 (Punycode) parameters used to decode "xn--" labels
const PUNY = { base: 36, tMin: 1, tMax: 26, skew: 38, damp: 700, initialBias: 72, initialN: 128 };

/**
 * RFC 3492 bias adaptation.
 * @param {number} delta
 * @param {number} numPoints
 * @param {boolean} firstTime
 * @returns {number}
 */
function punyAdapt(delta, numPoints, firstTime) {
  // Scale the delta down (more on the first pass) and spread it over the output length
  let d = firstTime ? Math.floor(delta / PUNY.damp) : Math.floor(delta / 2);
  d += Math.floor(d / numPoints);
  let k = 0;
  // Shrink the delta until it fits the threshold, counting the steps
  while (d > ((PUNY.base - PUNY.tMin) * PUNY.tMax) / 2) {
    d = Math.floor(d / (PUNY.base - PUNY.tMin));
    k += PUNY.base;
  }
  return k + Math.floor(((PUNY.base - PUNY.tMin + 1) * d) / (d + PUNY.skew));
}

/**
 * Decode the part of an ACE label after "xn--" into code points (null when malformed).
 * @param {string} input
 * @returns {number[]|null}
 */
function punycodeDecode(input) {
  // The basic (ASCII) code points come before the last "-"
  const split = input.lastIndexOf("-");
  const output = [];
  for (let j = 0; j < Math.max(split, 0); j += 1) output.push(input.charCodeAt(j));
  let pos = split > 0 ? split + 1 : 0;
  let n = PUNY.initialN;
  let i = 0;
  let bias = PUNY.initialBias;
  // Each pass decodes one generalized variable-length integer and inserts one code point
  while (pos < input.length) {
    const oldI = i;
    let w = 1;
    for (let k = PUNY.base; ; k += PUNY.base) {
      // Running out of digits mid-number is malformed
      if (pos >= input.length) return null;
      const c = input.charCodeAt(pos++);
      // Digits are a-z (0-25) then 0-9 (26-35); anything else is malformed
      const digit = c >= 97 && c <= 122 ? c - 97 : c >= 48 && c <= 57 ? c - 22 : -1;
      if (digit < 0) return null;
      i += digit * w;
      // Guard against overflow (well past any valid code point)
      if (i > 0x7fffffff) return null;
      const t = k <= bias ? PUNY.tMin : k >= bias + PUNY.tMax ? PUNY.tMax : k - bias;
      if (digit < t) break;
      w *= PUNY.base - t;
    }
    const length = output.length + 1;
    bias = punyAdapt(i - oldI, length, oldI === 0);
    n += Math.floor(i / length);
    i %= length;
    // Beyond Unicode is malformed
    if (n > 0x10ffff) return null;
    output.splice(i, 0, n);
    i += 1;
  }
  return output;
}

/**
 * True when every "xn--" label of the host decodes to a usable Unicode label.
 * Decided here instead of by the URL parser, whose verdict differs between runtime versions.
 * @param {string} hostname  ASCII (already punycoded) host
 * @returns {boolean}
 */
export function hasValidAceLabels(hostname) {
  for (const label of String(hostname).toLowerCase().split(".")) {
    // Only ACE labels need checking
    if (!label.startsWith("xn--")) continue;
    const points = punycodeDecode(label.slice(4));
    if (!points || points.length === 0) return false;
    // Allowed: ASCII letters, digits and "-", or non-surrogate code points from U+00A0 up
    const allowed = (p) => (p >= 97 && p <= 122) || (p >= 48 && p <= 57) || p === 45 || (p >= 0xa0 && (p < 0xd800 || p > 0xdfff));
    if (!points.every(allowed)) return false;
    // An ACE label must actually encode something beyond ASCII
    if (!points.some((p) => p >= 0xa0)) return false;
  }
  return true;
}

/**
 * Parse a URL string safely.
 * @param {unknown} value
 * @returns {URL|null}
 */
function safeUrl(value) {
  // Only strings can be links
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const parsed = new URL(value.trim());
    // Malformed "xn--" labels are rejected the same way on every runtime (and in the PHP port)
    return hasValidAceLabels(parsed.hostname) ? parsed : null;
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
