// Synthetic fixture data (Design §7-3): 30 fictional records shaped like Sheets API rowData.
// Every name, address and phone number below is invented. No real patient data.
//
// Known facts the unit tests and the E2E rely on (also exported as FIXTURE_EXPECTATIONS):
//   - total records ............................ 30 (sheet rows 2-32; row 12 is a fully blank row and is skipped)
//   - 山田　太郎 / やまだ　たろう ................ sheet row 2, phone 090-0000-0001, インフルエンザ, 任意,
//                                                 受診日 2026/10/15, age 13, yellow flag on 住所
//   - search "ヤマダ" / "山田太郎" / "09000000001" -> exactly 1 hit (row 2)
//   - 種別=コロナ + 区分=公費 + 年齢 65-100 ...... 6 hits (rows 4, 5, 6, 7, 24, 31); row 8 (コロナ公費 64歳) is outside
//   - flagged rows ............................. 10 (red 3: rows 11, 13, 21 / orange 2: rows 16, 26 / yellow 5: rows 2, 6, 14, 15, 29)
//   - orange flags are on 年齢 (rows 16 and 26; row 26 also has a yellow on 生年月日, so its level is orange)
//   - 管理番号 20269012 is shared by two different people (rows 14 and 15)
//   - 公費 rows have a blank 管理番号 (rows 4-9, 23, 24, 31 -> 9 rows)
//   - 受診日 "不明" (unparsable) ................. row 13 (加藤　誠)
//   - 備考 present ............................. rows 15 and 31
//   - 性別 filled only on the 9 公費 rows ........ 女: rows 4, 6, 9, 31 / 男: rows 5, 7, 8, 23, 24; 任意 rows are blank
//   - 受診日 2026-10-10..2026-10-12 inclusive .... 5 hits (rows 9, 16, 17, 18, 32); row 13 never matches a date range
//   - visit dates span 2026-10-01..2026-10-15; phones are 090-0000-0001..090-0000-0030
//   - 左右 filled on 2 rows ...................... 左: row 2 / 右: row 4 (injected by toGridRow from SIDES)
//   - search "存在しない名前" ................... 0 hits
//   - cell links (Design §10-6) ................ 4 rows: 2 (氏名, hyperlink -> PNG), 15 (備考, textFormatRuns -> PDF),
//                                                 17 (住所, hyperlink -> external), 31 (備考, chipRuns -> unshared Drive file)

// Background colours as returned by effectiveFormat (zero components omitted, like the real API)
const WHITE = { red: 1, green: 1, blue: 1 };
const RED = { red: 1 };
const YELLOW = { red: 1, green: 1 };
const ORANGE = { red: 1, green: 0.6 };
const NAVY = { red: 0.12, green: 0.27, blue: 0.47 };
const COLORS = { red: RED, yellow: YELLOW, orange: ORANGE };

// Header row: 19 fixed columns plus the human-maintained 備考 column
const HEADER = ["区分", "管理番号", "種別", "受診日", "氏名", "ふりがな", "生年月日", "性別", "年齢", "左右", "保護者署名",
  "郵便番号", "住所", "電話番号", "希望ワクチン", "体温", "LOT No.", "60～64歳の方", "自己負担免除対象者", "備考"];

// Grid column index of each flaggable field (after 左右 is inserted at index 9)
const COLUMN = { managementNumber: 1, visitDate: 3, furigana: 5, birthDate: 6, age: 8, address: 12, phone: 13, temperature: 15, lotNumber: 16 };

// Grid column index of 左右 and its values per sheet row (absent rows are blank)
const SIDE_COLUMN = 9;
const SIDES = { 2: "左", 4: "右" };

// Common vaccine labels
const FLU = "インフルエンザ";
const FLU_PUBLIC = "インフルエンザ（高齢者定期）";
const COVID = "新型コロナ";
const COVID_PUBLIC = "新型コロナ（高齢者定期）";
const EXEMPT = "①介護保険料額決定通知書";

// Compact rows (without 左右, which toGridRow inserts from SIDES):
//               [区分, 管理番号, 種別, 受診日, 氏名, ふりがな, 生年月日, 性別, 年齢, 保護者署名, 郵便番号, 住所,
//                電話番号, 希望ワクチン, 体温, LOT No., 60～64歳の方, 自己負担免除対象者, 備考, flags]
// null marks the fully blank sheet row. 性別 is filled only on 公費 rows (like the real sheet).
const ROWS = [
  /* r2  */ ["任意", "20269001", "インフルエンザ", "2026/10/15", "山田　太郎", "やまだ　たろう", "2013/04/02", "", "13", "山田　花子", "100-0001", "架空県見本市みほん町1-1", "090-0000-0001", FLU, "36.5", "", "", "", "", { address: "yellow" }],
  /* r3  */ ["任意", "20269002", "インフルエンザ", "2026/10/01", "青木　一郎", "あおき　いちろう", "1980/05/12", "", "46", "", "100-0002", "架空県見本市みほん町2-2", "090-0000-0002", FLU, "36.4", "", "", "", "", {}],
  /* r4  */ ["公費", "", "コロナ", "2026/10/02", "佐藤　花子", "さとう　はなこ", "1954/03/03", "女", "72", "", "100-0003", "架空県見本市ためし町3-3", "090-0000-0003", COVID_PUBLIC, "36.6", "CV2601A", "", EXEMPT, "", {}],
  /* r5  */ ["公費", "", "コロナ", "2026/10/03", "鈴木　次郎", "すずき　じろう", "1960/01/20", "男", "66", "", "100-0004", "架空県見本市ためし町4-4", "090-0000-0004", COVID_PUBLIC, "36.2", "CV2601A", "", "", "", {}],
  /* r6  */ ["公費", "", "コロナ", "2026/10/05", "高橋　松子", "たかはし　まつこ", "1945/02/11", "女", "81", "", "100-0005", "架空県見本市ためし町5-5", "090-0000-0005", COVID_PUBLIC, "36.8", "", "", "", "", { lotNumber: "yellow" }],
  /* r7  */ ["公費", "", "コロナ", "2026/10/08", "田中　梅吉", "たなか　うめきち", "1931/06/30", "男", "95", "", "100-0006", "架空県見本市ためし町6-6", "090-0000-0006", COVID_PUBLIC, "36.3", "CV2602B", "", EXEMPT, "", {}],
  /* r8  */ ["公費", "", "コロナ", "2026/10/09", "伊藤　竹男", "いとう　たけお", "1962/08/08", "男", "64", "", "100-0007", "架空県見本市ためし町7-7", "090-0000-0007", COVID_PUBLIC, "36.7", "CV2602B", "心臓", "", "", {}],
  /* r9  */ ["公費", "", "インフルエンザ", "2026/10/10", "渡辺　桜", "わたなべ　さくら", "1956/04/04", "女", "70", "", "100-0008", "架空県見本市ためし町8-8", "090-0000-0008", FLU_PUBLIC, "36.5", "HA2601C", "", "", "", {}],
  /* r10 */ ["任意", "20269003", "コロナ", "2026/10/04", "中村　健", "なかむら　けん", "1990/07/07", "", "36", "", "100-0009", "架空県見本市みほん町9-9", "090-0000-0009", COVID, "36.4", "", "", "", "", {}],
  /* r11 */ ["任意", "20269004", "インフルエンザ", "2026/10/06", "小林　陽子", "こばやし　ようこ", "2018/09/09", "", "8", "小林　一郎", "100-0010", "架空県見本市みほん町10-10", "090-0000-0010", FLU, "36.9", "", "", "", "", { furigana: "red" }],
  /* r12 */ null,
  /* r13 */ ["任意", "20269005", "インフルエンザ", "不明", "加藤　誠", "かとう　まこと", "1975/11/11", "", "50", "", "100-0011", "架空県見本市みほん町11-11", "090-0000-0011", FLU, "36.1", "", "", "", "", { visitDate: "red" }],
  /* r14 */ ["任意", "20269012", "インフルエンザ", "2026/10/07", "吉田　明", "よしだ　あきら", "1988/12/01", "", "37", "", "100-0012", "架空県見本市みほん町12-12", "090-0000-0012", FLU, "36.6", "", "", "", "", { managementNumber: "yellow" }],
  /* r15 */ ["任意", "20269012", "インフルエンザ", "2026/10/07", "山本　光", "やまもと　ひかる", "1999/02/14", "", "27", "", "100-0013", "架空県見本市みほん町13-13", "090-0000-0013", FLU, "36.2", "", "", "", "管理番号の重複は確認済み（別人）．", { managementNumber: "yellow" }],
  /* r16 */ ["任意", "20269006", "インフルエンザ", "2026/10/11", "松本　さくら", "まつもと　さくら", "2015/05/05", "", "12", "松本　健一", "100-0014", "架空県見本市みほん町14-14", "090-0000-0014", FLU, "36.7", "", "", "", "", { age: "orange" }],
  /* r17 */ ["任意", "20269007", "インフルエンザ", "2026/10/12", "井上　大輔", "いのうえ　だいすけ", "1970/03/15", "", "56", "", "100-0015", "架空県見本市みほん町15-15", "090-0000-0015", FLU, "36.3", "", "", "", "", {}],
  /* r18 */ ["任意", "20269008", "インフルエンザ", "2026/10/12", "木村　由美", "きむら　ゆみ", "1985/10/20", "", "40", "", "100-0016", "架空県見本市みほん町16-16", "090-0000-0016", FLU, "36.5", "", "", "", "", {}],
  /* r19 */ ["任意", "20269009", "コロナ", "2026/10/13", "林　浩二", "はやし　こうじ", "1979/01/01", "", "47", "", "100-0017", "架空県見本市みほん町17-17", "090-0000-0017", COVID, "36.4", "", "", "", "", {}],
  /* r20 */ ["任意", "20269010", "インフルエンザ", "2026/10/13", "清水　愛", "しみず　あい", "2020/06/06", "", "6", "清水　誠", "100-0018", "架空県見本市みほん町18-18", "090-0000-0018", FLU, "37.0", "", "", "", "", {}],
  /* r21 */ ["任意", "20269011", "インフルエンザ", "2026/10/14", "山崎　翔", "やまざき　しょう", "2010/08/18", "", "16", "", "100-0019", "架空県見本市みほん町19-19", "090-0000-0019", FLU, "36.6", "", "", "", "", { phone: "red" }],
  /* r22 */ ["任意", "20269013", "インフルエンザ", "2026/10/14", "森　直子", "もり　なおこ", "1968/04/22", "", "58", "", "100-0020", "架空県見本市みほん町20-20", "090-0000-0020", FLU, "36.2", "", "", "", "", {}],
  /* r23 */ ["公費", "", "インフルエンザ", "2026/10/14", "阿部　茂", "あべ　しげる", "1940/12/12", "男", "85", "", "100-0021", "架空県見本市ためし町21-21", "090-0000-0021", FLU_PUBLIC, "36.4", "HA2601C", "", EXEMPT, "", {}],
  /* r24 */ ["公費", "", "コロナ", "2026/10/15", "池田　清", "いけだ　きよし", "1950/10/01", "男", "76", "", "100-0022", "架空県見本市ためし町22-22", "090-0000-0022", COVID_PUBLIC, "36.5", "CV2603C", "", "", "", {}],
  /* r25 */ ["任意", "20269014", "インフルエンザ", "2026/10/15", "橋本　美咲", "はしもと　みさき", "2005/03/03", "", "21", "", "100-0023", "架空県見本市みほん町23-23", "090-0000-0023", FLU, "36.8", "", "", "", "", {}],
  /* r26 */ ["任意", "20269015", "インフルエンザ", "2026/10/15", "石川　悠", "いしかわ　ゆう", "2016/11/30", "", "10", "石川　恵", "100-0024", "架空県見本市みほん町24-24", "090-0000-0024", FLU, "36.6", "", "", "", "", { birthDate: "yellow", age: "orange" }],
  /* r27 */ ["任意", "20269016", "コロナ", "2026/10/02", "前田　剛", "まえだ　つよし", "1983/07/19", "", "43", "", "100-0025", "架空県見本市みほん町25-25", "090-0000-0025", COVID, "36.3", "", "", "", "", {}],
  /* r28 */ ["任意", "20269017", "インフルエンザ", "2026/10/03", "藤田　舞", "ふじた　まい", "1995/09/25", "", "31", "", "100-0026", "架空県見本市みほん町26-26", "090-0000-0026", FLU, "36.4", "", "", "", "", {}],
  /* r29 */ ["任意", "20269018", "インフルエンザ", "2026/10/05", "岡田　陸", "おかだ　りく", "2012/01/08", "", "14", "岡田　修", "100-0027", "架空県見本市みほん町27-27", "090-0000-0027", FLU, "", "", "", "", "", { temperature: "yellow" }],
  /* r30 */ ["任意", "20269019", "インフルエンザ", "2026/10/08", "後藤　葵", "ごとう　あおい", "2019/12/24", "", "6", "後藤　学", "100-0028", "架空県見本市みほん町28-28", "090-0000-0028", FLU, "36.9", "", "", "", "", {}],
  /* r31 */ ["公費", "", "コロナ", "2026/10/09", "長谷川　ハル", "はせがわ　はる", "1938/05/05", "女", "88", "", "100-0029", "架空県見本市ためし町29-29", "090-0000-0029", COVID_PUBLIC, "36.2", "CV2602B", "", EXEMPT, "付き添いあり．", {}],
  /* r32 */ ["任意", "20269020", "インフルエンザ", "2026/10/10", "村上　ユウキ", "むらかみ　ゆうき", "2001/02/02", "", "25", "", "100-0030", "架空県見本市みほん町30-30", "090-0000-0030", FLU, "36.5", "", "", "", "", {}],
];

// Synthetic Drive file ids used by the cell links below (not real files)
const PNG_FILE_ID = "FixturePng0000000000000000000001";
const PDF_FILE_ID = "FixturePdf0000000000000000000002";
const MISSING_FILE_ID = "FixtureMissing00000000000000003";
// Grid column index of the 備考 column
const NOTE_COLUMN = 19;

// Cell links: sheet row -> {col (grid column), shape, uri}. ROWS stays untouched; toGridRow merges these in (Design §10-6).
const LINKS = {
  2: { col: 4, shape: "hyperlink", uri: `https://drive.google.com/file/d/${PNG_FILE_ID}/view?usp=sharing` },
  15: { col: NOTE_COLUMN, shape: "textFormatRuns", uri: `https://drive.google.com/open?id=${PDF_FILE_ID}` },
  17: { col: 12, shape: "hyperlink", uri: "https://example.com/map/fixture" },
  31: { col: NOTE_COLUMN, shape: "chipRuns", uri: `https://drive.google.com/file/d/${MISSING_FILE_ID}/view` },
};

/**
 * Attach link information to a cell in the same shape the Sheets API uses.
 * @param {object} target  cell built by cell()
 * @param {{shape: string, uri: string}} link
 */
function applyLink(target, link) {
  // Whole-cell link
  if (link.shape === "hyperlink") target.hyperlink = link.uri;
  // Link on part of the text (an unlinked run first, then the linked run)
  if (link.shape === "textFormatRuns") target.textFormatRuns = [{ format: {} }, { startIndex: 1, format: { link: { uri: link.uri } } }];
  // Smart chip (mimeType is informational only)
  if (link.shape === "chipRuns") target.chipRuns = [{ chip: { richLinkProperties: { uri: link.uri, mimeType: "image/jpeg" } } }];
}

/**
 * Build one grid cell the way the Sheets API returns it (empty cells have no formattedValue).
 * @param {string} text
 * @param {object} background
 * @returns {object}
 */
function cell(text, background) {
  const result = { effectiveFormat: { backgroundColor: background } };
  if (text !== "") result.formattedValue = text;
  return result;
}

/**
 * Convert one compact row into a rowData entry.
 * @param {Array|null} row
 * @returns {object}
 */
function toGridRow(row, rowNumber) {
  // A fully blank row comes back without values
  if (row === null) return {};
  // 18 compact columns + 備考, then the flags object
  const values = row.slice(0, 19);
  const flags = row[19];
  // Insert 左右 right after 年齢 so the grid has 19 fixed columns + 備考
  values.splice(SIDE_COLUMN, 0, SIDES[rowNumber] ?? "");
  const link = LINKS[rowNumber];
  // Colour each flagged column, leave the rest white, and merge the row's link if any
  return {
    values: values.map((text, col) => {
      const field = Object.keys(COLUMN).find((key) => COLUMN[key] === col);
      const level = field ? flags[field] : undefined;
      const result = cell(text, level ? COLORS[level] : WHITE);
      if (link && link.col === col) applyLink(result, link);
      return result;
    }),
  };
}

// rowData exactly as spreadsheets.get would return it (header first)
export const FIXTURE_GRID = [
  { values: HEADER.map((text) => cell(text, NAVY)) },
  // ROWS[0] is sheet row 2
  ...ROWS.map((row, index) => toGridRow(row, index + 2)),
];

/**
 * Return a fresh deep copy of the fixture grid (so callers cannot mutate the shared one).
 * @returns {Promise<any[]>}
 */
export async function loadFixtureGrid() {
  return structuredClone(FIXTURE_GRID);
}

// 1x1 fully transparent PNG (grey+alpha, 68 bytes), kept as base64 so no binary lives in the repository
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/**
 * Decode base64 text into bytes.
 * @param {string} text
 * @returns {Uint8Array}
 */
function base64ToBytes(text) {
  const binary = atob(text);
  // Copy each char code into a byte array
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Build a minimal valid one-page PDF (blank 200x100 page) with a correct xref table.
 * @returns {Uint8Array}
 */
export function buildMinimalPdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << >> >>",
  ];
  // Line feed used throughout (PDF accepts LF line endings)
  const lf = String.fromCharCode(10);
  let text = `%PDF-1.4${lf}`;
  const offsets = [];
  // Write each object and remember its byte offset (the text is pure ASCII, so chars == bytes)
  objects.forEach((body, i) => {
    offsets.push(text.length);
    text += `${i + 1} 0 obj${lf}${body}${lf}endobj${lf}`;
  });
  // Cross-reference table: every entry is exactly 20 bytes (10 + space + 5 + space + flag + space + LF)
  const xrefAt = text.length;
  text += `xref${lf}0 ${objects.length + 1}${lf}0000000000 65535 f ${lf}`;
  for (const offset of offsets) text += `${String(offset).padStart(10, "0")} 00000 n ${lf}`;
  // Trailer pointing at the catalog and the xref position
  text += `trailer${lf}<< /Size ${objects.length + 1} /Root 1 0 R >>${lf}startxref${lf}${xrefAt}${lf}%%EOF${lf}`;
  return new TextEncoder().encode(text);
}

// Files the fixture "Drive" can serve; the third linked id (MISSING_FILE_ID) is deliberately absent
export const FIXTURE_FILES = Object.freeze({
  [PNG_FILE_ID]: { mimeType: "image/png", bytes: base64ToBytes(PNG_BASE64) },
  [PDF_FILE_ID]: { mimeType: "application/pdf", bytes: buildMinimalPdf() },
});

/**
 * Serve a fixture file without calling Google (null behaves like an unshared Drive file).
 * @param {string} fileId
 * @returns {Promise<{mimeType: string, size: number, body: ReadableStream}|null>}
 */
export async function loadFixtureFile(fileId) {
  // Own keys only, so prototype names never resolve
  if (typeof fileId !== "string" || !Object.hasOwn(FIXTURE_FILES, fileId)) return null;
  const file = FIXTURE_FILES[fileId];
  return { mimeType: file.mimeType, size: file.bytes.byteLength, body: new Blob([file.bytes]).stream() };
}

// Expected results checked by unit tests and used by Tests/E2E/RunE2E.py
export const FIXTURE_EXPECTATIONS = Object.freeze({
  total: 30,
  blankRowNumber: 12,
  flagged: 10,
  flagCounts: { red: 3, orange: 2, yellow: 5 },
  redRowNumbers: [11, 13, 21],
  orangeRowNumbers: [16, 26],
  yellowRowNumbers: [2, 6, 14, 15, 29],
  yamada: {
    rowNumber: 2, name: "山田　太郎", furigana: "やまだ　たろう", phone: "090-0000-0001",
    kind: "インフルエンザ", category: "任意", visitDate: "2026/10/15", age: "13", flagLevel: "yellow", flaggedField: "address",
  },
  yamadaSearches: ["ヤマダ", "山田太郎", "09000000001"],
  coronaPublicAge65to100: { kind: "コロナ", category: "公費", ageMin: 65, ageMax: 100, count: 6, rowNumbers: [4, 5, 6, 7, 24, 31] },
  sharedManagementNumber: { number: "20269012", rowNumbers: [14, 15] },
  blankManagementNumberPublicRows: [4, 5, 6, 7, 8, 9, 23, 24, 31],
  unparsableVisitDateRowNumber: 13,
  noteRowNumbers: [15, 31],
  gender: { femaleRowNumbers: [4, 6, 9, 31], maleRowNumbers: [5, 7, 8, 23, 24] },
  // 左右 values per sheet row (same as SIDES)
  side: { ...SIDES },
  visitRange: { visitFrom: "2026-10-10", visitTo: "2026-10-12", count: 5, rowNumbers: [9, 16, 17, 18, 32] },
  visitDateRange: { min: "2026-10-01", max: "2026-10-15" },
  noHitQuery: "存在しない名前",
  attachments: {
    rowNumbers: [2, 15, 17, 31],
    total: 4,
    image: { rowNumber: 2, index: 0, field: "name", label: "氏名のリンク", mimeType: "image/png", format: "original" },
    pdf: { rowNumber: 15, index: 0, field: "note", label: "備考のリンク", mimeType: "application/pdf" },
    external: { rowNumber: 17, index: 0, url: "https://example.com/map/fixture" },
    unavailable: { rowNumber: 31, index: 0, url: `https://drive.google.com/file/d/${MISSING_FILE_ID}/view` },
  },
});
