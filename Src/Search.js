// Query parsing, matching, sorting and response shaping (Design §3-2, §4). Pure functions.
import { normalizeText, parseDate } from "./Normalize.js";

// Allowed values of the exact-match filters
export const KINDS = ["インフルエンザ", "コロナ"];
export const CATEGORIES = ["任意", "公費"];
// Allowed sort orders (first one is the default)
export const SORTS = ["visitDesc", "visitAsc", "furigana", "rowDesc"];
// Paging limits
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;
// Longest accepted text condition (guards against oversized bodies)
const MAX_TEXT_LENGTH = 200;

// Text conditions mapped to the record field they search
export const TEXT_FIELDS = {
  name: "name",
  furigana: "furigana",
  phone: "phone",
  address: "address",
  managementNumber: "managementNumber",
  lotNumber: "lotNumber",
  vaccine: "desiredVaccine",
};

// Date range conditions mapped to the ISO field they compare
const DATE_FIELDS = { visitFrom: "visitDateIso", visitTo: "visitDateIso", birthFrom: "birthDateIso", birthTo: "birthDateIso" };

/**
 * Validate a JSON request body and turn it into a Query.
 * @param {unknown} body
 * @returns {object} Query, or {error: string} on invalid input
 */
export function parseQuery(body) {
  // Missing body means "no conditions"
  if (body === undefined || body === null) body = {};
  // Only plain objects are accepted
  if (typeof body !== "object" || Array.isArray(body)) return { error: "body_not_object" };
  const query = {};
  // Free words: keep the raw string, AND-split later
  const q = readText(body.q, "q");
  if (q.error) return q;
  if (q.value) query.q = q.value;
  // Per-field partial-match conditions
  for (const key of Object.keys(TEXT_FIELDS)) {
    const result = readText(body[key], key);
    if (result.error) return result;
    if (result.value) query[key] = result.value;
  }
  // Exact-match selections must be one of the known values
  for (const [key, allowed] of [["kind", KINDS], ["category", CATEGORIES]]) {
    const result = readText(body[key], key);
    if (result.error) return result;
    if (result.value) {
      if (!allowed.includes(result.value)) return { error: `invalid_${key}` };
      query[key] = result.value;
    }
  }
  // Date ranges must be strict YYYY-MM-DD
  for (const key of Object.keys(DATE_FIELDS)) {
    const result = readText(body[key], key);
    if (result.error) return result;
    if (result.value) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(result.value) || parseDate(result.value) !== result.value) {
        return { error: `invalid_${key}` };
      }
      query[key] = result.value;
    }
  }
  // Age bounds must be integers in a human range
  for (const key of ["ageMin", "ageMax"]) {
    const result = readInteger(body[key], key, 0, 150);
    if (result.error) return result;
    if (result.value !== null) query[key] = result.value;
  }
  // Flagged-only switch must be a real boolean
  if (body.flagged !== undefined && body.flagged !== null) {
    if (typeof body.flagged !== "boolean") return { error: "invalid_flagged" };
    if (body.flagged) query.flagged = true;
  }
  // Sort order defaults to newest visit first
  if (body.sort !== undefined && body.sort !== null && body.sort !== "") {
    if (!SORTS.includes(body.sort)) return { error: "invalid_sort" };
    query.sort = body.sort;
  } else {
    query.sort = SORTS[0];
  }
  // Paging defaults and limits
  const page = readInteger(body.page, "page", 1, 1000000);
  if (page.error) return page;
  query.page = page.value ?? 1;
  const pageSize = readInteger(body.pageSize, "pageSize", 1, MAX_PAGE_SIZE);
  if (pageSize.error) return pageSize;
  query.pageSize = pageSize.value ?? DEFAULT_PAGE_SIZE;
  return query;
}

/**
 * Read an optional text condition (string or number), trimmed.
 * @returns {{value:string}|{error:string}}
 */
function readText(raw, key) {
  // Absent values become empty strings
  if (raw === undefined || raw === null) return { value: "" };
  // Accept numbers so a numeric phone/management number still works
  if (typeof raw === "number" && Number.isFinite(raw)) return { value: String(raw) };
  if (typeof raw !== "string") return { error: `invalid_${key}` };
  // Reject oversized conditions
  if (raw.length > MAX_TEXT_LENGTH) return { error: `too_long_${key}` };
  return { value: raw.trim() };
}

/**
 * Read an optional integer condition within [min, max].
 * @returns {{value:number|null}|{error:string}}
 */
function readInteger(raw, key, min, max) {
  // Absent or empty means "no condition"
  if (raw === undefined || raw === null || raw === "") return { value: null };
  // Accept numeric strings as well as numbers (full-width digits too)
  const text = typeof raw === "string" ? raw.normalize("NFKC").trim() : raw;
  const value = typeof text === "number" ? text : /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(value) || value < min || value > max) return { error: `invalid_${key}` };
  return { value };
}

/**
 * Split the free-word condition into normalised AND terms.
 * @param {string|undefined} q
 * @returns {string[]}
 */
export function splitTerms(q) {
  // NFKC first so full-width spaces also separate words
  if (!q) return [];
  return String(q).normalize("NFKC").split(/\s+/u).map(normalizeText).filter((term) => term !== "");
}

/**
 * Evaluate every condition of a query against one record (AND; empty conditions are ignored).
 * @param {object} record
 * @param {object} query
 * @returns {boolean}
 */
export function matches(record, query) {
  // Free words must all appear in the haystack
  for (const term of splitTerms(query.q)) {
    if (!record.searchText.includes(term)) return false;
  }
  // Field conditions are normalised partial matches
  for (const [key, field] of Object.entries(TEXT_FIELDS)) {
    const needle = normalizeText(query[key]);
    if (needle && !normalizeText(record[field]).includes(needle)) return false;
  }
  // Exact-match selections
  if (query.kind && record.kind !== query.kind) return false;
  if (query.category && record.category !== query.category) return false;
  // Date ranges (inclusive); unparsable dates are excluded once a bound is set
  for (const [key, field] of Object.entries(DATE_FIELDS)) {
    const bound = query[key];
    if (!bound) continue;
    const value = record[field];
    if (!value) return false;
    if (key.endsWith("From") && value < bound) return false;
    if (key.endsWith("To") && value > bound) return false;
  }
  // Age range (inclusive); unknown ages are excluded once a bound is set
  const hasMin = typeof query.ageMin === "number";
  const hasMax = typeof query.ageMax === "number";
  if (hasMin || hasMax) {
    if (record.ageNumber === null || record.ageNumber === undefined) return false;
    if (hasMin && record.ageNumber < query.ageMin) return false;
    if (hasMax && record.ageNumber > query.ageMax) return false;
  }
  // Flagged-only switch
  if (query.flagged && !record.flagLevel) return false;
  return true;
}

/**
 * Compare two ISO dates with nulls last; direction 1 = ascending, -1 = descending.
 */
function compareDates(a, b, direction) {
  // Unparsable dates always go to the end
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  if (a === b) return 0;
  return a < b ? -direction : direction;
}

/**
 * Return a new array sorted by the given order.
 * @param {object[]} records
 * @param {string} sort
 * @returns {object[]}
 */
export function sortRecords(records, sort) {
  // Never mutate the cached array
  const copy = records.slice();
  switch (sort) {
    case "visitAsc":
      // Oldest visit first, then sheet order
      return copy.sort((a, b) => compareDates(a.visitDateIso, b.visitDateIso, 1) || a.rowNumber - b.rowNumber);
    case "furigana":
      // Normalised reading ascending, then sheet order
      return copy.sort((a, b) => {
        const fa = normalizeText(a.furigana);
        const fb = normalizeText(b.furigana);
        if (fa !== fb) return fa < fb ? -1 : 1;
        return a.rowNumber - b.rowNumber;
      });
    case "rowDesc":
      // Most recently appended row first
      return copy.sort((a, b) => b.rowNumber - a.rowNumber);
    case "visitDesc":
    default:
      // Newest visit first, then newest row
      return copy.sort((a, b) => compareDates(a.visitDateIso, b.visitDateIso, -1) || b.rowNumber - a.rowNumber);
  }
}

/**
 * Filter, sort and page records.
 * @param {object[]} records
 * @param {object} query  output of parseQuery
 * @returns {{total:number, page:number, pageSize:number, sort:string, items:object[]}}
 */
export function searchRecords(records, query) {
  // Fill defaults so raw objects work too
  const sort = query.sort || SORTS[0];
  const page = query.page || 1;
  const pageSize = query.pageSize || DEFAULT_PAGE_SIZE;
  // Filter then sort
  const hits = sortRecords(records.filter((record) => matches(record, query)), sort);
  // Cut out the requested page
  const start = (page - 1) * pageSize;
  return { total: hits.length, page, pageSize, sort, items: hits.slice(start, start + pageSize) };
}

/**
 * Reduce a record to the list fields (Design §4-1).
 * @param {object} record
 * @returns {object}
 */
export function toSummary(record) {
  return {
    rowNumber: record.rowNumber,
    name: record.name,
    furigana: record.furigana,
    visitDate: record.visitDate,
    kind: record.kind,
    category: record.category,
    age: record.age,
    flagLevel: record.flagLevel,
    managementNumber: record.managementNumber,
    // Number of cell links (Design §10-2); ids and URLs stay in the detail only
    attachmentCount: Array.isArray(record.attachments) ? record.attachments.length : 0,
  };
}

/**
 * Build the detail payload: all fields except searchText plus sameNumberCount (Design §4-2).
 * @param {object} record
 * @param {object[]} records  all records, for counting shared management numbers
 * @returns {object}
 */
export function toDetail(record, records) {
  // Drop the internal haystack and the server-only Drive ids
  const { searchText, attachmentFileIds, ...rest } = record;
  // Count rows sharing the management number (blank numbers count as 0)
  const number = record.managementNumber;
  const sameNumberCount = number ? records.filter((other) => other.managementNumber === number).length : 0;
  // Copy attachments so callers cannot mutate the cached record
  const attachments = (record.attachments || []).map((item) => ({ ...item }));
  return { ...rest, flags: { ...record.flags }, attachments, sameNumberCount };
}

/**
 * Summarise the data set for GET /api/meta (Design §4-3).
 * @param {object[]} records
 * @returns {object}
 */
export function computeMeta(records) {
  // Count flagged rows and find the visit date range
  let flagged = 0;
  let min = null;
  let max = null;
  for (const record of records) {
    if (record.flagLevel) flagged += 1;
    const iso = record.visitDateIso;
    if (iso && (!min || iso < min)) min = iso;
    if (iso && (!max || iso > max)) max = iso;
  }
  return {
    total: records.length,
    flagged,
    kinds: KINDS.slice(),
    categories: CATEGORIES.slice(),
    visitDateRange: { min, max },
  };
}
