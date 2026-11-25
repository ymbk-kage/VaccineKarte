// Generate Golden.json: input/output pairs of the pure JS modules, replayed by RunParity.php.
// Usage: node Php/Tests/Parity/GenerateGolden.mjs
// Only synthetic data is used (Src/Fixture.js and hand-written strings below).
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as Normalize from "../../../Src/Normalize.js";
import * as Attachments from "../../../Src/Attachments.js";
import * as Records from "../../../Src/Records.js";
import * as Search from "../../../Src/Search.js";
import { loadFixtureGrid } from "../../../Src/Fixture.js";

// Output path next to this script
const OUT = join(dirname(fileURLToPath(import.meta.url)), "Golden.json");

// The fixture grid and its records (deep copies, never mutated afterwards)
const fixtureGrid = await loadFixtureGrid();
const fixtureRecords = Records.mapRows(fixtureGrid);

// Reference markers that RunParity.php resolves to the shared data above
const REF_RECORDS = { $ref: "fixtureRecords" };
const REF_GRID = { $ref: "fixtureGrid" };
// Reference to one fixture record by index
const recordRef = (index) => ({ $ref: "fixtureRecords", index });

// Collected cases
const cases = [];

/**
 * Record one case: the output is stored as the JSON.stringify string so PHP compares bytes.
 * @param {string} fn  function (or composite) name understood by RunParity.php
 * @param {any[]} input  arguments (JSON-serialisable; undefined becomes null)
 * @param {any} output  JS result
 */
function add(fn, input, output) {
  // Round-trip the input through JSON so what PHP reads is exactly what JS saw (undefined -> null)
  const serialisedInput = JSON.parse(JSON.stringify(input));
  const entry = { fn, input: serialisedInput, output: JSON.stringify(output === undefined ? null : output) };
  // Flag inputs that json_decode($x, true) cannot tell apart from a JSON array ({"0":..,"1":..})
  if (hasListLikeObject(serialisedInput)) entry.assocAmbiguous = true;
  cases.push(entry);
}

/**
 * True when a value contains a non-empty JSON object whose keys are exactly "0".."n-1".
 */
function hasListLikeObject(value) {
  // Primitives never qualify
  if (!value || typeof value !== "object") return false;
  // Arrays: look inside
  if (Array.isArray(value)) return value.some(hasListLikeObject);
  // Objects: check the key shape, then look inside
  const keys = Object.keys(value);
  if (keys.length > 0 && keys.every((key, i) => key === String(i))) return true;
  return Object.values(value).some(hasListLikeObject);
}

/**
 * Resolve reference markers the same way RunParity.php does.
 */
function resolve(value) {
  // Swap markers for the shared data
  if (value && typeof value === "object" && !Array.isArray(value) && value.$ref) {
    const base = value.$ref === "fixtureGrid" ? structuredClone(fixtureGrid) : structuredClone(fixtureRecords);
    return value.index === undefined ? base : base[value.index];
  }
  return value;
}

/**
 * Run a function on JSON round-tripped inputs and record it.
 */
function run(fn, impl, ...args) {
  // JS sees the same JSON-decoded values that PHP will see
  const roundTripped = JSON.parse(JSON.stringify(args)).map(resolve);
  add(fn, args, impl(...roundTripped));
}

// ---------- constants ----------
const CONSTANTS = {
  HEADERS: Records.HEADERS, FIELDS: Records.FIELDS, NOTE_HEADER: Records.NOTE_HEADER, ATTACHMENT_COLUMNS: Records.ATTACHMENT_COLUMNS,
  DRIVE_HOSTS: Attachments.DRIVE_HOSTS, ATTACHMENT_TYPES: Attachments.ATTACHMENT_TYPES, MAX_ATTACHMENT_BYTES: Attachments.MAX_ATTACHMENT_BYTES,
  KINDS: Search.KINDS, CATEGORIES: Search.CATEGORIES, SORTS: Search.SORTS, DEFAULT_PAGE_SIZE: Search.DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE: Search.MAX_PAGE_SIZE, TEXT_FIELDS: Search.TEXT_FIELDS,
};
// One case per exported constant
for (const [name, value] of Object.entries(CONSTANTS)) add("constant", [name], value);

// ---------- Normalize ----------
const TEXTS = [
  // From Normalize.test.js
  "ＡＢＣ１２３", "\uFA1A", "HA2601C", "ヤマダ", "ﾔﾏﾀﾞ", "ヴ", "山田　太郎", "090-0000‐0001", "a‑b‒c–d—e―f−g", "ルーシー",
  "2026/10／15", " a\tb\nc ", null, 13,
  // Extra: width, kana, separators and case mapping
  "ｶﾞｷﾞｸﾞｹﾞｺﾞ", "ﾊﾟﾋﾟﾌﾟﾍﾟﾎﾟ", "ァィゥェォヵヶ", "ヷヸヹヺ", "ゝゞヽヾ", "ｰ", "ｱｲｳ ｴｵ", "ＴＥＬ：０９０－００００－０００１",
  "山田\u3000\u3000太郎", "山田\u00A0太郎", "山田\u2003太郎", "山田\u2028太郎", "山田\u2029太郎", "山田\uFEFF太郎", "山田\u205F太郎",
  "山田\u180E太郎", "山田\u0085太郎", "山田\u200B太郎", "a/b／c\\d", "Ａ－Ｂ", "ÀÉÎÕÜ", "ΟΔΟΣ", "İstanbul", "ǅ", "ﬃ", "Ⅻ", "①②③",
  "㍻", "㌔", "㈱", "℡", "ｷﾞｮｳｻﾞ", "\u{20B9F}田", "𠀋", "😀ヤ", "髙橋", "\uFA11", "神\uFA19", "長谷川　ハル", "やまだ　たろう", "",
  "   ", "\t\n\r", "0", 0, 1.5, -2, 1e21, 0.000001, 1e-7, 123456789.125, true, false, ["ア", "B"], "Ｍｃｃｌｏｕｄ", "ＡＢＣ　ＤＥＦ",
  "カ\u3099", "ｶ\uFF9E", "は\u309A", "ア\u0301", "ﾃﾞｨｽﾞﾆｰ", "架空県見本市みほん町1-1", "①介護保険料額決定通知書",
];
for (const text of TEXTS) run("normalizeText", Normalize.normalizeText, text);

const DATES = [
  // From Normalize.test.js
  "2026/10/15", "2026-10-15", "2026.10.15", "20261015", "2026/1/5", "２０２６／１０／１５", "不明", "", null, "2026/02/30",
  "2026/13/01", "2026/10/15 extra", "261015",
  // Extra: separators, padding, leap years, ranges and odd inputs
  "２０２６－１０－１５", "２０２６．１０．１５", "２０２６１０１５", " 2026/10/15 ", "\u30002026/10/15\u3000", "\u20282026/10/15\u2029",
  "2026/10/15\n", "2026/10/15\t", "2026/2/29", "2024/2/29", "2000/02/29", "1900/02/29", "2026/00/10", "2026/10/00", "2026/10/32",
  "2026/04/31", "2026/4/30", "2026-1-1", "2026.1.1", "2026/10-15", "2026/010/15", "20261315", "20260230", "202610150",
  "0099/01/01", "0050/12/31", "0100/01/01", "0000/01/01", "9999/12/31", "1926/12/25", "令和8年10月15日", "2026年10月15日", "R8.10.15",
  "H30/01/01", "S20.08.15", "10/15/2026", "15.10.2026", "2026 10 15", "2026/10/15/", "٢٠٢٦/١٠/١٥", "２０２６/1０/１５", 20261015,
  20260230, 2026.1015, true, "2026⁄10⁄15", "2026∕10∕15", "2026／10／15",
];
for (const date of DATES) run("parseDate", Normalize.parseDate, date);

const AGES = [
  // From Normalize.test.js
  "13", "１３", "13歳", " 0 ", "不明", "", "13.5", null,
  // Extra
  "12歳3ヶ月", "12歳3か月", "13 歳", "13\u3000歳", "１３歳", "１３\u3000歳", "013", "0013", "100", "999", "1000", "-1", "+5", "5才",
  "歳", "13歳 ", " 13歳", "13歳歳", "１３才", "3ヶ月", "0歳", "120歳", "13\n", "١٣", "⑬", "13 ", "1 3", 13, 13.5, 0, true, "13\u2028",
  "13\u00A0歳",
];
for (const age of AGES) run("parseAge", Normalize.parseAge, age);

// ---------- Attachments ----------
const ID = "AbCdEfGhIj_0123-xyz";
const ID2 = "ZyXwVuTsRq_9876-abc";
const URLS = [
  // From Attachments.test.js
  `https://drive.google.com/file/d/${ID}/view?usp=sharing`, `https://drive.google.com/file/d/${ID}`, `https://docs.google.com/file/d/${ID}/edit`,
  `https://drive.google.com/open?id=${ID}`, `https://drive.google.com/uc?id=${ID}&export=download`,
  `https://docs.google.com/document/d/${ID}/edit`, `https://docs.google.com/spreadsheets/d/${ID}/edit`,
  `https://docs.google.com/presentation/d/${ID}/edit`, `http://drive.google.com/file/d/${ID}/view`, "https://drive.google.com/file/d/short/view",
  `https://drive.google.com.evil.example/file/d/${ID}/view`, `https://evil.example/file/d/${ID}/view`, "https://drive.google.com/open",
  `https://drive.google.com/drive/folders/${ID}`, "not a url", "", null, "https://example.com/a", "http://example.com", "mailto:a@b.c",
  "tel:0900000000", "javascript:alert(1)", "data:text/html,x", "ftp://x", "  ",
  // Extra: casing, ports, credentials, slashes, encodings, IDN and IP hosts
  `HTTPS://DRIVE.GOOGLE.COM/file/d/${ID}/view`, `https://Drive.Google.Com/file/d/${ID}/view`, `https://drive.google.com:443/file/d/${ID}/view`,
  `https://drive.google.com:0443/file/d/${ID}`, `https://drive.google.com:8443/file/d/${ID}`, `https://drive.google.com:/file/d/${ID}`,
  `https://user:pass@drive.google.com/file/d/${ID}/view`, `https://u@x@drive.google.com/file/d/${ID}`, `https://@drive.google.com/file/d/${ID}`,
  `https:drive.google.com/file/d/${ID}/view`, `https:/drive.google.com/file/d/${ID}`, `https:\\\\drive.google.com\\file\\d\\${ID}\\view`,
  `https:///drive.google.com/file/d/${ID}`, `https://drive.google.com//file/d/${ID}`, `https://drive.google.com/file/d//${ID}`,
  `https://drive.google.com/a/../file/d/${ID}/view`, `https://drive.google.com/./file/d/./${ID}`, `https://drive.google.com/file/d/${ID}/..`,
  `https://drive.google.com/x/%2e%2E/file/d/${ID}`, `https://drive.google.com/file/d/${ID}/view#frag`, `https://drive.google.com/file/d/${ID}?`,
  `https://drive.google.com/file/d/${ID}#`, `https://drive.google.com/file/d/${ID}/view?usp=sharing&x=1#a#b`,
  `https://drive.google.com/file/d/${ID}%3F/view`, `https://drive.google.com/file/d/Ab%43dEfGhIj/view`, `https://drive.google.com/file/d/${ID}é/view`,
  `https://drive.google.com/open?id=Ab%43dEfGhIj_01`, `https://drive.google.com/open?%69d=${ID}`, `https://drive.google.com/open?ID=${ID}`,
  `https://drive.google.com/open?x=1&id=${ID}&id=${ID2}`, `https://drive.google.com/open?id=&id=${ID}`, `https://drive.google.com/open?id=${ID}+x`,
  `https://drive.google.com/open?id=short`, `https://drive.google.com/open/?id=${ID}`, `https://drive.google.com/OPEN?id=${ID}`,
  `https://drive.google.com/uc?export=download&id=${ID2}`, `https://drive.google.com/uc?id=${ID}#id=${ID2}`, `https://drive.google.com/open?id=${ID}%`,
  `https://drive.google.com/open?id=${ID}%zz`, `https://drive.google.com/open?id=%E3%81%82${ID}`, `https://drive.google.com/open?id`,
  `https://ｄｒｉｖｅ.google.com/file/d/${ID}/view`, `https://drive。google。com/file/d/${ID}`, `https://drive%2Egoogle.com/file/d/${ID}`,
  `https://DRIVE.GOOGLE.COM./file/d/${ID}`, `https://docs.google.com/uc?id=${ID}`, `https://drive.google.com.:443/file/d/${ID}`,
  "https://日本語.jp/path", "https://bücher.example/ä?ö#ü", "https://xn--bcher-kva.example/", "https://xn--a.com/", "https://-a-.com/",
  "https://a_b.com/", "https://a..b/", "https://ab--c.com/", "https://a%25b.com/", "https://a b.com/", "https://a<b.com/",
  "https://0x7f.1/", "https://1.2.3.4./", "https://a.123/", "https://127.0.0.1:443/x", "https://4294967295/", "https://4294967296/",
  "https://0x/", "https://a.0x/", "https://1.256/", "https://1.2.3.256/", "https://017.0.0.1/", "https://09.0.0.1/",
  "https://[::1]/", "https://[1:0:0:2:0:0:0:3]/", "https://[::ffff:1.2.3.4]/", "https://[0:0:0:0:0:0:0:0]/", "https://[1::]/",
  "https://[::1/", "https://[::1]:8080/a", "https://[1:2:3:4:5:6:7:8:9]/", "https://[FFFF::ABCD]/", "https://[::1.2.3]/",
  "https://example.com/p^`{}|[]\\z?q^`{}|'\"<>#f^`{}|\"<> #x", "https://example.com/a b?c d#e f", "https://example.com/\u00e9?\u00e9#\u00e9",
  "https://example.com/😀?😀#😀", "https://example.com/x\ty\nz", "  https://example.com  ", "\u3000https://example.com/\u3000",
  "\u0001https://example.com/\u001F", "https://example.com:65535/", "https://example.com:65536/", "https://example.com:x/",
  "https://example.com:80/", "https://example.com:1:2/", "https://example.com/a/b/../../..", "https://example.com/%2e/x",
  "https://example.com/x/", "https://example.com/x/#", "https://example.com/x#", "https://example.com/x/#frag", "https://example.com",
  "https://example.com?", "https://example.com#", "https://example.com/?a=1&b=2", "HtTpS://ExAmPlE.CoM/Path", "https:", "https://",
  "https:///", "https://?x", "https://#x", "https://u@/", "https://u:@example.com/", "https://:p@example.com/", "https://:@example.com/",
  "https://u%40x@example.com/", "https://user name:p ss@example.com/", "https://example.com/%zz%2", "https://example.com\\a\\b",
  "file:///etc/passwd", "HTTP://example.com/", "https//example.com", "//example.com/x", "example.com", "1https://example.com",
  "https+x://example.com", "https://ex\u00ADample.com/", "https://EXAMPLE.com/\u2028", "https://example.com/?\u0000",
];
for (const url of URLS) {
  run("parseDriveFileId", Attachments.parseDriveFileId, url);
  run("classifyLink", Attachments.classifyLink, url);
}
// Non-string inputs
for (const value of [42, true, ["https://example.com"], { href: "https://example.com" }]) {
  run("parseDriveFileId", Attachments.parseDriveFileId, value);
  run("classifyLink", Attachments.classifyLink, value);
}

const CELLS = [
  // From Attachments.test.js
  {
    formattedValue: "x",
    hyperlink: "https://a.example/1",
    textFormatRuns: [{ format: {} }, { startIndex: 1, format: { link: { uri: "https://a.example/2" } } }, { format: { link: { uri: "https://a.example/1" } } }],
    chipRuns: [{ chip: { richLinkProperties: { uri: "https://a.example/3", mimeType: "image/jpeg" } } }, { chip: {} }],
  },
  { formattedValue: "x" }, undefined, { hyperlink: 42 },
  // Extra
  { hyperlink: "  https://a.example/1  ", textFormatRuns: [{ format: { link: { uri: "https://a.example/1" } } }] },
  { hyperlink: "", textFormatRuns: [null, 1, "x", { format: null }, { format: { link: null } }, { format: { link: { uri: 5 } } }] },
  { chipRuns: [{ chip: { richLinkProperties: { uri: "\u3000https://a.example/c\u3000" } } }, { chip: { richLinkProperties: {} } }, null] },
  { textFormatRuns: "notarray", chipRuns: { 0: { chip: { richLinkProperties: { uri: "https://a.example/x" } } } } },
  { hyperlink: "mailto:a@b.c", textFormatRuns: [{ format: { link: { uri: "mailto:a@b.c" } } }] },
  "string-cell", 0, null, [], [{ hyperlink: "https://a.example/1" }],
];
for (const cell of CELLS) run("extractCellLinks", Attachments.extractCellLinks, cell);

// buildAttachments rows (sparse JS arrays become null-filled lists in JSON)
const attachmentRows = [];
{
  // From Attachments.test.js: dedupe across cells and kinds
  const cells = [];
  cells[4] = { hyperlink: `https://drive.google.com/file/d/${ID}/view`, textFormatRuns: [{ format: { link: { uri: `https://drive.google.com/open?id=${ID}` } } }, { format: { link: { uri: "https://example.com/x/" } } }] };
  cells[12] = { hyperlink: `https://drive.google.com/uc?id=${ID}`, textFormatRuns: [{ format: { link: { uri: "https://example.com/x#top" } } }], chipRuns: [{ chip: { richLinkProperties: { uri: `https://drive.google.com/file/d/${ID2}/view` } } }] };
  cells[19] = { hyperlink: "mailto:a@b.c" };
  attachmentRows.push(cells);
}
{
  // 備考 only
  const cells = [];
  cells[19] = { hyperlink: "https://example.com/n" };
  attachmentRows.push(cells);
}
attachmentRows.push([], undefined, "x", { 4: { hyperlink: "https://example.com/obj" } });
{
  // Many links in one cell, numbering (2), (3) ... and canonical-form dedupe
  const cells = [];
  cells[0] = {
    hyperlink: "https://example.com/a",
    textFormatRuns: [
      { format: { link: { uri: "https://example.com/b" } } }, { format: { link: { uri: "HTTPS://EXAMPLE.COM/a" } } },
      { format: { link: { uri: "https://example.com/a/" } } }, { format: { link: { uri: "https://example.com/a#x" } } },
      { format: { link: { uri: "https://example.com:443/c" } } }, { format: { link: { uri: "http://example.com/d" } } },
    ],
    chipRuns: [{ chip: { richLinkProperties: { uri: `https://drive.google.com/file/d/${ID}/view` } } }, { chip: { richLinkProperties: { uri: `https://drive.google.com/file/d/${ID}/edit` } } }],
  };
  cells[7] = { hyperlink: "https://example.com/c" };
  cells[17] = { hyperlink: `https://drive.google.com/open?id=${ID2}` };
  // 左右 (col 9) carries a link too; col 21 (CLIUS登録) is outside ATTACHMENT_COLUMNS
  cells[9] = { hyperlink: "https://example.com/side" };
  cells[20] = { hyperlink: "https://example.com/col21-ignored" };
  attachmentRows.push(cells);
}
for (const cells of attachmentRows) run("buildAttachments", Attachments.buildAttachments, cells, Records.ATTACHMENT_COLUMNS);
// Custom column metadata
run("buildAttachments", Attachments.buildAttachments, [{ hyperlink: "https://example.com/1" }, { hyperlink: "https://example.com/2" }], [{ field: "f1", header: "H1" }, { field: "f2", header: "H2" }]);

// ---------- Records ----------
for (const cell of [{ formattedValue: "abc" }, { formattedValue: "  pad  " }, { formattedValue: 13 }, { formattedValue: 1.5 }, { formattedValue: true },
  { formattedValue: null }, {}, null, undefined, 0, "", "str", { formattedValue: "" }, { formattedValue: ["a", "b"] }, { formattedValue: { a: 1 } }]) {
  run("cellText", Records.cellText, cell);
}

// Header variants (from Records.test.js plus extras)
const NEW_LAYOUT = [...Records.HEADERS];
const OLD_LAYOUT = NEW_LAYOUT.filter((header) => header !== "性別");
const swapped = Records.HEADERS.slice();
[swapped[4], swapped[5]] = [swapped[5], swapped[4]];
const HEADER_ROWS = [
  Records.HEADERS.map((h) => ` ${h} `), [...Records.HEADERS, "備考"], [...Records.HEADERS, "メモ"], swapped, Records.HEADERS.slice(1, 13),
  undefined, [], NEW_LAYOUT, [...NEW_LAYOUT, "備考"], OLD_LAYOUT, [...OLD_LAYOUT, "備考"], [...Records.HEADERS, " 備考\u3000"],
  [...Records.HEADERS, "備 考"], [...Records.HEADERS, "備考", "extra"], Records.HEADERS.map((h) => `\u3000${h}\n`),
  Records.HEADERS.map((h, i) => (i === 15 ? "Lot No." : h)), Records.HEADERS.map((h, i) => (i === 16 ? "60~64歳の方" : h)),
  Records.HEADERS.slice(0, 17), [...Records.HEADERS.slice(0, 17), null], [...Records.HEADERS, null], [...Records.HEADERS, 5],
  "区分", { 0: "区分" }, null,
];
for (const header of HEADER_ROWS) run("validateHeader", Records.validateHeader, header);

const COLORS_IN = [
  { red: 1 }, { red: 1, green: 1 }, { red: 1, green: 0.6 }, { red: 0.9, green: 0.25, blue: 0.25 }, { red: 0.9, green: 0.9, blue: 0.25 },
  { red: 0.9, green: 0.45 }, { red: 0.9, green: 0.75 }, { red: 0.89 }, { red: 1, green: 0.3 }, { red: 1, green: 0.8 }, { red: 1, blue: 0.3 },
  { red: 1, green: 1, blue: 1 }, { red: 0.12, green: 0.27, blue: 0.47 }, undefined, null,
  // Extra: strings, booleans, NaN-ish, alpha, arrays
  { red: "1" }, { red: "1", green: "0.6" }, { red: "abc" }, { red: "abc", green: 0.5 }, { red: true }, { red: 1, green: null },
  { red: 1, green: "" }, { red: 1, green: " 0.5 " }, { red: 1, alpha: 0 }, {}, [], "red", 1, { red: 1, green: 0.44999 }, { red: 1, green: 0.7500001 },
  { red: 0.9000001, green: 0.2500001 }, { red: 1, green: 0.95, blue: 0.2 }, { red: [1] }, { red: { v: 1 } }, { red: "0x1" }, { red: "1e0" },
];
for (const color of COLORS_IN) run("classifyColor", Records.classifyColor, color);

for (const flags of [{}, { a: "yellow", b: "orange" }, { a: "orange", b: "red", c: "yellow" }, { a: "yellow" }, { a: "red", b: "yellow" },
  { a: "yellow", b: "yellow" }, { a: "orange", b: "yellow", c: "orange" }, { a: "bogus", b: "red" }, { a: "red", b: "bogus" }]) {
  run("worstFlag", Records.worstFlag, flags);
}

// Grid helpers mirroring Records.test.js
const cell = (text, bg = { red: 1, green: 1, blue: 1 }) => {
  const result = { effectiveFormat: { backgroundColor: bg } };
  if (text !== "") result.formattedValue = text;
  return result;
};
const row = (texts, colors = {}) => ({ values: texts.map((text, i) => cell(text, colors[i])) });
const dataTexts = (overrides = {}) => {
  const texts = Array(19).fill("");
  texts[0] = "任意";
  texts[3] = "2026/10/15";
  texts[4] = "山田　太郎";
  for (const [index, value] of Object.entries(overrides)) texts[index] = value;
  return texts;
};

const GRIDS = [
  // Fixture as-is
  REF_GRID,
  // From Records.test.js
  [row(Records.HEADERS), row(dataTexts()), {}, row(Array(19).fill(""), { 4: { red: 1 } }), row(dataTexts({ 4: "佐藤　花子" }))],
  [row(Records.HEADERS), row(dataTexts({ 1: "20260001", 2: "インフルエンザ", 6: "2013/04/02", 7: "男", 8: "13", 9: "右", 13: "090-0000-0001" }), { 8: { red: 1, green: 0.6 }, 9: { red: 1 }, 12: { red: 1, green: 1 } })],
  [{ values: [...Records.HEADERS, "備考"].map((h) => cell(h, { red: 1 })) }, row([...dataTexts(), "要電話確認"], { 19: { red: 1 } })],
  [row([...Records.HEADERS, "備考"]), row([...dataTexts(), "要電話確認"])],
  [row([...Records.HEADERS, "その他"]), row([...dataTexts(), "要電話確認"])],
  [row(Records.HEADERS), row(dataTexts({ 5: "ヤマダ　タロウ", 13: "090-0000-0001" }))],
  [], undefined, [row(Records.HEADERS)],
  // Extra: padded 備考 header, numeric/odd cell values, short rows, missing values, links everywhere
  [row([...Records.HEADERS, " 備考 "]), row([...dataTexts({ 8: "１３歳", 3: "２０２６．１０．０５", 6: "20130402" }), "  メモ  "])],
  [row(Records.HEADERS), { values: [{ formattedValue: "任意" }, { formattedValue: 20260001 }, null, { formattedValue: "2026/10/15" }, { formattedValue: "  鈴木\u3000一  " }] }],
  [row(Records.HEADERS), { values: [] }, { values: null }, null, { values: [null, null, { effectiveFormat: { backgroundColor: { red: 1 } } }] }, row(dataTexts({ 4: "x" }))],
  [row(Records.HEADERS), row(dataTexts({ 1: "A-1", 8: "不明", 3: "不明" }), { 0: { red: 1 }, 1: { red: 1, green: 0.6 }, 3: { red: 1, green: 1 }, 17: { red: 1 } })],
  [row(Records.HEADERS), row(dataTexts(), { 4: { red: "1", green: "0.6" }, 5: { red: 0.95, green: 0.2, blue: 0.1 }, 6: { red: 1, green: 0.5, blue: 0.3 } })],
  [{ values: [...Records.HEADERS, "備考"].map((h) => cell(h)) }, {
    values: [...dataTexts(), "note"].map((text, i) => {
      const result = cell(text);
      if (i === 4) result.hyperlink = `https://drive.google.com/file/d/${ID}/view`;
      if (i === 12) result.textFormatRuns = [{ format: { link: { uri: `https://drive.google.com/open?id=${ID}` } } }, { format: { link: { uri: "https://example.com/m" } } }];
      if (i === 19) result.chipRuns = [{ chip: { richLinkProperties: { uri: "https://example.com/m/" } } }, { chip: { richLinkProperties: { uri: `https://drive.google.com/uc?id=${ID2}` } } }];
      return result;
    }),
  }],
  [row(Records.HEADERS), row(dataTexts({ 5: "\uE000", 4: "PUA" })), row(dataTexts({ 5: "\u{20000}", 4: "ExtB" })), row(dataTexts({ 5: "ｱ", 4: "half" }))],
];
for (const grid of GRIDS) run("mapRows", Records.mapRows, grid);

// ---------- Search ----------
const BODIES = [
  // From Search.test.js (parseQuery cases)
  {}, null, { ageMin: "65", ageMax: 100, page: "2", flagged: false, q: "  山田  " },
  [], "text", 42, { visitFrom: "2026/10/01" }, { visitTo: "2026-02-30" }, { birthFrom: "20261001" }, { ageMin: "abc" }, { ageMax: -1 },
  { ageMin: 1.5 }, { pageSize: 201 }, { pageSize: 0 }, { page: 0 }, { kind: "麻しん" }, { category: "定期" }, { sort: "random" },
  { flagged: "true" }, { q: { $ne: "" } }, { name: ["a"] }, { q: "x".repeat(201) },
  // Extra
  { q: "x".repeat(200) }, { q: "😀".repeat(100) }, { q: "😀".repeat(101) }, { q: "あ".repeat(200) }, { q: "あ".repeat(201) },
  { q: 9000000001 }, { q: 1.5 }, { q: 1e21 }, { q: 0 }, { q: true }, { q: "0" }, { q: "   " }, { q: "\u3000山田\u3000" },
  { name: " 山田 ", furigana: "ヤマダ", phone: 9000000001, address: "", managementNumber: "2026", lotNumber: "cv", vaccine: "インフル" },
  { kind: "コロナ", category: "公費" }, { kind: " コロナ " }, { kind: "ｺﾛﾅ" }, { category: 1 }, { kind: "" }, { kind: null },
  { visitFrom: "2026-10-10", visitTo: "2026-10-12" }, { visitFrom: " 2026-10-10 " }, { visitFrom: "２０２６-10-10" }, { birthTo: "2026-13-01" },
  { birthFrom: "0099-01-01" }, { birthFrom: "0100-01-01" }, { visitTo: "2024-02-29" }, { visitTo: "2026-1-01" },
  { ageMin: "６５" }, { ageMin: " 65 " }, { ageMin: "" }, { ageMin: null }, { ageMin: 0 }, { ageMax: 150 }, { ageMax: 151 }, { ageMin: "1e2" },
  { ageMin: "0x10" }, { ageMin: "+5" }, { ageMin: true }, { ageMin: [5] }, { ageMin: 65.0 }, { ageMin: "007" }, { ageMin: "99999999999999999999" },
  { flagged: true }, { flagged: false }, { flagged: null }, { flagged: 1 }, { sort: "furigana" }, { sort: "" }, { sort: null }, { sort: 1 },
  { sort: "visitAsc" }, { sort: "rowDesc" }, { sort: "VisitAsc" }, { page: "3", pageSize: "7" }, { page: 1000000 }, { page: 1000001 },
  { page: "１" }, { pageSize: 200 }, { pageSize: "200" }, { pageSize: -5 }, { page: 2.5 }, { unknown: "ignored", q: "a" },
  { q: "a", name: { x: 1 } }, { furigana: "x".repeat(201) }, { vaccine: false }, { "0": "x" }, { visitFrom: "2026-10-10", q: 5 },
];
for (const body of BODIES) run("parseQuery", Search.parseQuery, body);

for (const q of ["", null, "山田 太郎", "　山田　　太郎　", "ヤマダ\tタロウ\n", "a-b c/d", "ー ー", "ＡＢＣ　ｄｅｆ", 123, "x\u2028y", "x\u00A0y", "x\u0085y", "x\u180Ey"]) {
  run("splitTerms", Search.splitTerms, q);
}

// Search scenarios over the fixture (parseQuery -> searchRecords -> toSummary)
const SEARCHES = [
  {}, { pageSize: 200 }, { q: "ヤマダ" }, { q: "山田太郎" }, { q: "09000000001" }, { q: "やまだ　インフルエンザ" }, { q: "やまだ コロナ" },
  { q: "存在しない名前" }, { name: "山田太郎" }, { furigana: "ヤマダ" }, { phone: "090 0000 0001" }, { address: "ためし町 3-3" },
  { managementNumber: "20269012" }, { lotNumber: "cv2603c" }, { vaccine: "高齢者定期" }, { kind: "コロナ" }, { category: "公費" },
  { kind: "コロナ", category: "公費", ageMin: 65, ageMax: 100 }, { ageMin: 95, ageMax: 95 }, { kind: "コロナ", category: "公費", ageMax: 64 },
  { visitFrom: "2026-10-10", visitTo: "2026-10-12" }, { visitFrom: "2000-01-01" }, { birthFrom: "2013-04-02", birthTo: "2013-04-02" },
  { flagged: true }, { sort: "visitAsc" }, { sort: "furigana" }, { sort: "rowDesc" }, { sort: "visitDesc", pageSize: 7 },
  { pageSize: 7, page: 5 }, { pageSize: 7, page: 6 }, { pageSize: 1, page: 30 }, { pageSize: 1, page: 31 }, { pageSize: 13, page: 3 },
  { flagged: true, sort: "furigana" }, { flagged: true, kind: "インフルエンザ", sort: "visitAsc" }, { q: "架空県" , sort: "rowDesc", pageSize: 10, page: 2 },
  { q: "みほん町 1" }, { q: "ﾐﾎﾝﾁｮｳ" }, { q: "インフルエンザ（高齢者定期）" }, { q: "インフルエンザ(高齢者定期)" }, { q: "管理番号の重複" },
  { q: "付き添い" }, { q: "女" }, { q: "男", category: "公費" }, { q: "36.5" }, { q: "CV2602B" }, { q: "drive" }, { q: "example" },
  { birthTo: "1950-12-31", sort: "visitAsc" }, { birthFrom: "2010-01-01", sort: "furigana" }, { visitTo: "2026-10-05", sort: "rowDesc" },
  { ageMin: 0, ageMax: 15 }, { ageMin: 60 }, { ageMax: 10 }, { address: "ﾐﾎﾝ" }, { phone: "0000-0030" }, { vaccine: "新型コロナ" },
  { name: "　" }, { managementNumber: "2026901" }, { lotNumber: "HA" }, { q: "2026/10/15" }, { q: "20261015" }, { q: "ハル" },
  { q: "ゆうき", sort: "visitAsc" }, { visitFrom: "2026-10-15", visitTo: "2026-10-15", sort: "visitAsc" }, { visitFrom: "2026-10-16" },
  { flagged: true, category: "公費" }, { kind: "インフルエンザ", category: "任意", flagged: true, ageMin: 10, sort: "furigana", pageSize: 3, page: 2 },
];
for (const body of SEARCHES) {
  // Run the full request path the App uses for POST /api/search
  const query = Search.parseQuery(JSON.parse(JSON.stringify(body)));
  const result = Search.searchRecords(structuredClone(fixtureRecords), query);
  add("searchSummary", [REF_RECORDS, body], { ...result, items: result.items.map(Search.toSummary) });
}

// searchRecords with raw (unvalidated) query objects
for (const query of [{}, { page: 2, pageSize: 5 }, { sort: "bogus" }, { page: 0, pageSize: 0 }, { page: -1, pageSize: 5 }, { page: 7, pageSize: 5 },
  { sort: "furigana", pageSize: 100 }, { q: "やまだ", sort: "" }, { ageMin: 64, ageMax: 64 }, { ageMin: "64" }, { kind: "コロナ", flagged: 1 }]) {
  const result = Search.searchRecords(structuredClone(fixtureRecords), query);
  add("searchRecords", [REF_RECORDS, query], { ...result, items: result.items.map(Search.toSummary) });
}

// sortRecords (compared by row order)
for (const sort of ["visitDesc", "visitAsc", "furigana", "rowDesc", "unknown", null]) {
  add("sortRecords", [REF_RECORDS, sort], Search.sortRecords(structuredClone(fixtureRecords), sort).map((r) => r.rowNumber));
}

// matches on selected records
const MATCH_QUERIES = [{}, { q: "やまだ" }, { kind: "コロナ" }, { visitFrom: "2026-10-01" }, { ageMin: 13, ageMax: 13 }, { flagged: true }, { name: "太郎" }, { q: "" }];
for (const index of [0, 1, 10, 13, 29]) {
  for (const query of MATCH_QUERIES) run("matches", Search.matches, recordRef(index), query);
}

// toSummary / toDetail for every fixture record
fixtureRecords.forEach((_, index) => {
  run("toSummary", Search.toSummary, recordRef(index));
  run("toDetail", Search.toDetail, recordRef(index), REF_RECORDS);
});
// Odd records
run("toSummary", Search.toSummary, { rowNumber: 1 });
run("toSummary", Search.toSummary, {});
run("toSummary", Search.toSummary, { rowNumber: 2, name: null, attachments: { 0: 1 } });
run("toDetail", Search.toDetail, { rowNumber: 5, managementNumber: "X", searchText: "s", attachmentFileIds: [null] }, [{ managementNumber: "X" }, { managementNumber: "x" }, {}]);
run("toDetail", Search.toDetail, { flags: { age: "red" }, rowNumber: 3, attachments: [{ index: 0, url: "u" }], managementNumber: "" }, []);

// computeMeta
run("computeMeta", Search.computeMeta, REF_RECORDS);
run("computeMeta", Search.computeMeta, []);
run("computeMeta", Search.computeMeta, [{ flagLevel: "red", visitDateIso: null }, { flagLevel: null, visitDateIso: "2026-01-02" }, { visitDateIso: "2025-12-31" }]);

// End-to-end from a grid: mapRows -> parseQuery -> searchRecords (full records, including flags and private fields)
const PIPELINES = [
  [REF_GRID, { sort: "furigana", pageSize: 5 }],
  [REF_GRID, { flagged: true, pageSize: 3, page: 2 }],
  [REF_GRID, { q: "備考" }],
  [GRIDS[15], { sort: "furigana" }],
  [GRIDS[16], {}],
  [GRIDS[16], { sort: "furigana" }],
  [GRIDS[10], { q: "メモ" }],
];
for (const [grid, body] of PIPELINES) {
  const records = Records.mapRows(resolve(JSON.parse(JSON.stringify(grid))));
  add("pipeline", [grid, body], Search.searchRecords(records, Search.parseQuery(JSON.parse(JSON.stringify(body)))));
}

// Write the golden file (refs hold the shared synthetic data once)
const golden = { refs: { fixtureGrid, fixtureRecords }, cases };
writeFileSync(OUT, JSON.stringify(golden, null, 1) + "\n", "utf8");
// Report the per-function counts
const counts = {};
for (const c of cases) counts[c.fn] = (counts[c.fn] || 0) + 1;
console.log(`Wrote ${cases.length} cases to ${OUT}`);
console.log(counts);
