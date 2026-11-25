// Header validation, colour classification and row mapping (Design §2-3). Pure functions.
import { normalizeText, parseDate, parseAge } from "./Normalize.js";
import { buildAttachments } from "./Attachments.js";

// Expected first 19 headers of the records sheet (default name 患者管理).
// 性別 sits right after 生年月日 and 左右 right after 年齢; older layouts without them are rejected by validateHeader.
export const HEADERS = ["区分", "管理番号", "種別", "受診日", "氏名", "ふりがな", "生年月日", "性別", "年齢", "左右", "保護者署名",
  "郵便番号", "住所", "電話番号", "希望ワクチン", "体温", "LOT No.", "60～64歳の方", "自己負担免除対象者"];

// Record field names in the same order as HEADERS
export const FIELDS = ["category", "managementNumber", "kind", "visitDate", "name", "furigana", "birthDate", "gender",
  "age", "side", "guardianName", "postalCode", "address", "phone", "desiredVaccine", "temperature", "lotNumber", "disability6064",
  "copayExemption"];

// Header of the optional human-maintained 20th column (column T)
export const NOTE_HEADER = "備考";

// All 20 columns (19 fixed + 備考) whose cell links become attachments (Design §10-2)
export const ATTACHMENT_COLUMNS = Object.freeze([
  ...FIELDS.map((field, col) => ({ field, header: HEADERS[col] })),
  { field: "note", header: NOTE_HEADER },
]);

// Severity order used to pick the worst flag of a row
const FLAG_RANK = { red: 3, orange: 2, yellow: 1 };

/**
 * Extract the display text of one grid cell.
 * @param {any} cell
 * @returns {string}
 */
export function cellText(cell) {
  // Absent cells and cells without a value are empty strings
  if (!cell || cell.formattedValue === undefined || cell.formattedValue === null) return "";
  return String(cell.formattedValue);
}

/**
 * Check that the first row has exactly the expected 19 headers.
 * @param {string[]} firstRow  trimmed or untrimmed header texts
 * @returns {{ok:true, hasNote:boolean}|{ok:false, reason:string}}
 */
export function validateHeader(firstRow) {
  // A missing header row is a layout change
  if (!Array.isArray(firstRow)) return { ok: false, reason: "header_missing" };
  // Compare each of the 19 cells after trimming
  for (let i = 0; i < HEADERS.length; i += 1) {
    const actual = String(firstRow[i] ?? "").trim();
    if (actual !== HEADERS[i]) return { ok: false, reason: `header_mismatch_at_${i + 1}` };
  }
  // The 20th column counts as 備考 only when titled exactly so
  const hasNote = String(firstRow[HEADERS.length] ?? "").trim() === NOTE_HEADER;
  return { ok: true, hasNote };
}

/**
 * Classify a Sheets backgroundColor (0-1 RGB, missing components = 0).
 * @param {{red?:number, green?:number, blue?:number}|null|undefined} bg
 * @returns {"red"|"yellow"|"orange"|null}
 */
export function classifyColor(bg) {
  // No colour information means no flag
  if (!bg || typeof bg !== "object") return null;
  // The Sheets API omits zero components, so default them to 0
  const r = Number(bg.red ?? 0);
  const g = Number(bg.green ?? 0);
  const b = Number(bg.blue ?? 0);
  // All flags need a strong red channel and a weak blue channel
  if (r < 0.9 || b > 0.25) return null;
  // Distinguish by the green channel
  if (g <= 0.25) return "red";
  if (g >= 0.9) return "yellow";
  if (g >= 0.45 && g <= 0.75) return "orange";
  return null;
}

/**
 * Pick the worst flag level among a row's flags (red > orange > yellow).
 * @param {Record<string,string>} flags
 * @returns {"red"|"yellow"|"orange"|null}
 */
export function worstFlag(flags) {
  // Walk every flag and keep the highest rank
  let worst = null;
  for (const level of Object.values(flags)) {
    if (!worst || FLAG_RANK[level] > FLAG_RANK[worst]) worst = level;
  }
  return worst;
}

/**
 * Map Sheets rowData (header row first) into VaccineRecord objects.
 * Rows whose 19 data cells are all blank are skipped; rowNumber keeps the sheet row.
 * @param {Array<{values?: any[]}>} gridRows
 * @returns {object[]}
 */
export function mapRows(gridRows) {
  // Nothing to map without rows
  if (!Array.isArray(gridRows) || gridRows.length === 0) return [];
  // Decide whether column 20 is the 備考 column from the header row
  const headerTexts = (gridRows[0]?.values || []).map(cellText);
  const hasNote = String(headerTexts[HEADERS.length] ?? "").trim() === NOTE_HEADER;
  const records = [];
  // Data rows start at sheet row 2 (index 1)
  for (let index = 1; index < gridRows.length; index += 1) {
    const cells = gridRows[index]?.values || [];
    const record = { rowNumber: index + 1 };
    const flags = {};
    let anyValue = false;
    // Copy the 19 fixed columns and their colour flags
    FIELDS.forEach((field, col) => {
      const text = cellText(cells[col]).trim();
      record[field] = text;
      if (text !== "") anyValue = true;
      const level = classifyColor(cells[col]?.effectiveFormat?.backgroundColor);
      if (level) flags[field] = level;
    });
    // Skip completely blank rows (colour alone does not make a record)
    if (!anyValue) continue;
    // Take 備考 only when the header says so; its colour is ignored
    record.note = hasNote ? cellText(cells[HEADERS.length]).trim() : null;
    // Derived values used for range filters and sorting
    record.visitDateIso = parseDate(record.visitDate);
    record.birthDateIso = parseDate(record.birthDate);
    record.ageNumber = parseAge(record.age);
    record.flags = flags;
    record.flagLevel = worstFlag(flags);
    // Normalised haystack for free-word search (19 columns + note)
    const parts = FIELDS.map((field) => normalizeText(record[field]));
    parts.push(normalizeText(record.note));
    record.searchText = parts.join("|");
    // Cell links of all 20 columns (links are never part of searchText)
    const { attachments, fileIds } = buildAttachments(cells, ATTACHMENT_COLUMNS);
    record.attachments = attachments;
    // Server-only Drive ids aligned with attachments; dropped by toDetail
    record.attachmentFileIds = fileIds;
    records.push(record);
  }
  return records;
}
