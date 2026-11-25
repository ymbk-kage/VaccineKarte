// Unit tests for Src/Records.js (Design §2-3)
import { test } from "node:test";
import assert from "node:assert/strict";
import { HEADERS, validateHeader, classifyColor, mapRows, worstFlag, ATTACHMENT_COLUMNS } from "../../Src/Records.js";
import { FIXTURE_GRID, FIXTURE_EXPECTATIONS as EX } from "../../Src/Fixture.js";

// Build a grid cell like the Sheets API does
function cell(text, bg = { red: 1, green: 1, blue: 1 }) {
  const result = { effectiveFormat: { backgroundColor: bg } };
  if (text !== "") result.formattedValue = text;
  return result;
}

// Build a grid row from texts, with optional colours per column index
function row(texts, colors = {}) {
  return { values: texts.map((text, i) => cell(text, colors[i])) };
}

// 19 data cells with a name and visit date
function dataTexts(overrides = {}) {
  const texts = Array(19).fill("");
  texts[0] = "任意";
  texts[3] = "2026/10/15";
  texts[4] = "山田　太郎";
  for (const [index, value] of Object.entries(overrides)) texts[index] = value;
  return texts;
}

test("validateHeader accepts the exact 19 headers (with surrounding blanks)", () => {
  const result = validateHeader(HEADERS.map((h) => ` ${h} `));
  assert.deepEqual(result, { ok: true, hasNote: false });
});

test("validateHeader detects the 備考 column", () => {
  assert.deepEqual(validateHeader([...HEADERS, "備考"]), { ok: true, hasNote: true });
  assert.deepEqual(validateHeader([...HEADERS, "メモ"]), { ok: true, hasNote: false });
});

test("validateHeader rejects mismatches and the legacy 12-column layout", () => {
  // Swapped column
  const swapped = HEADERS.slice();
  [swapped[4], swapped[5]] = [swapped[5], swapped[4]];
  assert.equal(validateHeader(swapped).ok, false);
  // Legacy layout without 区分 at column A
  assert.equal(validateHeader(HEADERS.slice(1, 13)).ok, false);
  // Missing row
  assert.equal(validateHeader(undefined).ok, false);
  assert.equal(validateHeader([]).ok, false);
});

// The 19-column layout with 左右 inserted right after 年齢 (column J, 2026-10-26), spelled out literally
const NEW_LAYOUT = ["区分", "管理番号", "種別", "受診日", "氏名", "ふりがな", "生年月日", "性別", "年齢", "左右", "保護者署名",
  "郵便番号", "住所", "電話番号", "希望ワクチン", "体温", "LOT No.", "60～64歳の方", "自己負担免除対象者"];
// The 18-column layout of 2026-10-17..2026-10-26 (性別 present, no 左右)
const SEX_LAYOUT = NEW_LAYOUT.filter((header) => header !== "左右");
// The 17-column layout before that (no 性別; 年齢 directly after 生年月日)
const OLD_LAYOUT = SEX_LAYOUT.filter((header) => header !== "性別");

test("validateHeader accepts the new 19-column layout with 左右 after 年齢", () => {
  // HEADERS itself is the new layout
  assert.deepEqual(HEADERS, NEW_LAYOUT);
  assert.equal(HEADERS.length, 19);
  // Accepted with and without 備考 in column T, and with the trailing CLIUS登録 column of the live sheet
  assert.deepEqual(validateHeader(NEW_LAYOUT), { ok: true, hasNote: false });
  assert.deepEqual(validateHeader([...NEW_LAYOUT, "備考"]), { ok: true, hasNote: true });
  assert.deepEqual(validateHeader([...NEW_LAYOUT, "備考", "CLIUS登録"]), { ok: true, hasNote: true });
});

test("validateHeader rejects the 18-column layout without 左右 as header_mismatch", () => {
  // Column J holds 保護者署名 instead of 左右
  assert.deepEqual(validateHeader(SEX_LAYOUT), { ok: false, reason: "header_mismatch_at_10" });
  assert.deepEqual(validateHeader([...SEX_LAYOUT, "備考"]), { ok: false, reason: "header_mismatch_at_10" });
});

test("validateHeader rejects the old 17-column layout as header_mismatch", () => {
  // Column H holds 年齢 instead of 性別
  assert.deepEqual(validateHeader(OLD_LAYOUT), { ok: false, reason: "header_mismatch_at_8" });
  // 備考 in the old column R does not rescue the old layout
  assert.deepEqual(validateHeader([...OLD_LAYOUT, "備考"]), { ok: false, reason: "header_mismatch_at_8" });
});

test("fixture fills 性別 only on 公費 rows", () => {
  const records = mapRows(FIXTURE_GRID);
  // Collect rows per gender value
  const rowsWith = (value) => records.filter((r) => r.gender === value).map((r) => r.rowNumber);
  assert.deepEqual(rowsWith("女"), EX.gender.femaleRowNumbers);
  assert.deepEqual(rowsWith("男"), EX.gender.maleRowNumbers);
  // Every non-blank 性別 belongs to a 公費 row
  for (const record of records) {
    if (record.gender !== "") assert.equal(record.category, "公費");
  }
  // 年齢 still lands in age after the shift (row 2 = 13)
  assert.equal(records.find((r) => r.rowNumber === 2).age, "13");
});

test("fixture fills 左右 on the expected rows and keeps the columns after it aligned", () => {
  const records = mapRows(FIXTURE_GRID);
  // Rows with a 左右 value, keyed by row number
  const filled = Object.fromEntries(records.filter((r) => r.side !== "").map((r) => [r.rowNumber, r.side]));
  assert.deepEqual(filled, EX.side);
  // 保護者署名 and 電話番号 still land in their fields after the shift (row 2)
  const row2 = records.find((r) => r.rowNumber === 2);
  assert.equal(row2.guardianName, "山田　花子");
  assert.equal(row2.phone, "090-0000-0001");
  // 左右 is part of the free-word haystack
  assert.ok(row2.searchText.split("|").includes("左"));
});

test("classifyColor thresholds", () => {
  // Pure colours as written by SheetGateway / conditional formatting
  assert.equal(classifyColor({ red: 1 }), "red");
  assert.equal(classifyColor({ red: 1, green: 1 }), "yellow");
  assert.equal(classifyColor({ red: 1, green: 0.6 }), "orange");
  // Boundary values
  assert.equal(classifyColor({ red: 0.9, green: 0.25, blue: 0.25 }), "red");
  assert.equal(classifyColor({ red: 0.9, green: 0.9, blue: 0.25 }), "yellow");
  assert.equal(classifyColor({ red: 0.9, green: 0.45 }), "orange");
  assert.equal(classifyColor({ red: 0.9, green: 0.75 }), "orange");
  // Just outside the bands
  assert.equal(classifyColor({ red: 0.89 }), null);
  assert.equal(classifyColor({ red: 1, green: 0.3 }), null);
  assert.equal(classifyColor({ red: 1, green: 0.8 }), null);
  assert.equal(classifyColor({ red: 1, blue: 0.3 }), null);
  // White, navy header and missing colour
  assert.equal(classifyColor({ red: 1, green: 1, blue: 1 }), null);
  assert.equal(classifyColor({ red: 0.12, green: 0.27, blue: 0.47 }), null);
  assert.equal(classifyColor(undefined), null);
  assert.equal(classifyColor(null), null);
});

test("worstFlag priority is red > orange > yellow", () => {
  assert.equal(worstFlag({}), null);
  assert.equal(worstFlag({ a: "yellow", b: "orange" }), "orange");
  assert.equal(worstFlag({ a: "orange", b: "red", c: "yellow" }), "red");
  assert.equal(worstFlag({ a: "yellow" }), "yellow");
});

test("mapRows skips blank rows but keeps sheet row numbers", () => {
  const grid = [
    row(HEADERS),
    row(dataTexts()),
    {},
    row(Array(19).fill(""), { 4: { red: 1 } }),
    row(dataTexts({ 4: "佐藤　花子" })),
  ];
  const records = mapRows(grid);
  // Rows 3 (no values) and 4 (colour only) are dropped
  assert.deepEqual(records.map((r) => r.rowNumber), [2, 5]);
  assert.equal(records[1].name, "佐藤　花子");
});

test("mapRows maps fields, derived values and flags", () => {
  const texts = dataTexts({ 1: "20260001", 2: "インフルエンザ", 6: "2013/04/02", 7: "男", 8: "13", 9: "右", 13: "090-0000-0001" });
  const grid = [row(HEADERS), row(texts, { 8: { red: 1, green: 0.6 }, 12: { red: 1, green: 1 } })];
  const [record] = mapRows(grid);
  assert.equal(record.category, "任意");
  assert.equal(record.managementNumber, "20260001");
  assert.equal(record.kind, "インフルエンザ");
  assert.equal(record.phone, "090-0000-0001");
  assert.equal(record.visitDateIso, "2026-10-15");
  assert.equal(record.birthDateIso, "2013-04-02");
  // 性別 sits between 生年月日 and 年齢
  assert.equal(record.gender, "男");
  assert.equal(record.ageNumber, 13);
  // 左右 sits right after 年齢
  assert.equal(record.side, "右");
  assert.deepEqual(record.flags, { age: "orange", address: "yellow" });
  assert.equal(record.flagLevel, "orange");
  // No 備考 header -> note is null
  assert.equal(record.note, null);
});

test("mapRows ignores colours on the header row and the 備考 column", () => {
  const header = { values: [...HEADERS, "備考"].map((h) => cell(h, { red: 1 })) };
  const texts = [...dataTexts(), "要電話確認"];
  const grid = [header, row(texts, { 19: { red: 1 } })];
  const [record] = mapRows(grid);
  assert.deepEqual(record.flags, {});
  assert.equal(record.flagLevel, null);
  assert.equal(record.note, "要電話確認");
});

test("mapRows puts the note into searchText only when the header is 備考", () => {
  // With 備考 header
  const withNote = mapRows([row([...HEADERS, "備考"]), row([...dataTexts(), "要電話確認"])])[0];
  assert.ok(withNote.searchText.includes("要電話確認"));
  // With an unrelated 20th header the text is ignored
  const withoutNote = mapRows([row([...HEADERS, "その他"]), row([...dataTexts(), "要電話確認"])])[0];
  assert.equal(withoutNote.note, null);
  assert.ok(!withoutNote.searchText.includes("要電話確認"));
});

test("mapRows builds a normalised, pipe-joined searchText", () => {
  const [record] = mapRows([row(HEADERS), row(dataTexts({ 5: "ヤマダ　タロウ", 13: "090-0000-0001" }))]);
  // 19 columns + note = 20 parts
  assert.equal(record.searchText.split("|").length, 20);
  assert.ok(record.searchText.includes("山田太郎"));
  assert.ok(record.searchText.includes("やまだたろう"));
  assert.ok(record.searchText.includes("09000000001"));
});

test("mapRows handles empty input", () => {
  assert.deepEqual(mapRows([]), []);
  assert.deepEqual(mapRows(undefined), []);
  assert.deepEqual(mapRows([row(HEADERS)]), []);
});

// ---------- attachments (Design §10-2, §10-6) ----------

test("ATTACHMENT_COLUMNS covers the 19 columns plus 備考", () => {
  assert.equal(ATTACHMENT_COLUMNS.length, 20);
  assert.deepEqual(ATTACHMENT_COLUMNS[4], { field: "name", header: "氏名" });
  assert.deepEqual(ATTACHMENT_COLUMNS[7], { field: "gender", header: "性別" });
  assert.deepEqual(ATTACHMENT_COLUMNS[9], { field: "side", header: "左右" });
  assert.deepEqual(ATTACHMENT_COLUMNS[19], { field: "note", header: "備考" });
});

test("fixture rows carry the attachments of the §10-6 table", () => {
  const byRow = new Map(mapRows(FIXTURE_GRID).map((r) => [r.rowNumber, r]));
  const { image, pdf, external, unavailable } = EX.attachments;
  // Row 2: whole-cell hyperlink on 氏名 -> Drive PNG
  assert.deepEqual(byRow.get(image.rowNumber).attachments, [{
    index: 0, field: "name", label: "氏名のリンク", kind: "drive",
    url: "https://drive.google.com/file/d/FixturePng0000000000000000000001/view?usp=sharing",
  }]);
  assert.deepEqual(byRow.get(image.rowNumber).attachmentFileIds, ["FixturePng0000000000000000000001"]);
  // Row 15: partial-text link on 備考 -> Drive PDF via open?id=
  assert.deepEqual(byRow.get(pdf.rowNumber).attachments, [{
    index: 0, field: "note", label: "備考のリンク", kind: "drive",
    url: "https://drive.google.com/open?id=FixturePdf0000000000000000000002",
  }]);
  assert.deepEqual(byRow.get(pdf.rowNumber).attachmentFileIds, ["FixturePdf0000000000000000000002"]);
  // Row 17: external link on 住所
  assert.deepEqual(byRow.get(external.rowNumber).attachments, [{ index: 0, field: "address", label: "住所のリンク", kind: "external", url: external.url }]);
  assert.deepEqual(byRow.get(external.rowNumber).attachmentFileIds, [null]);
  // Row 31: smart chip on 備考 -> Drive file that the fixture cannot serve
  assert.deepEqual(byRow.get(unavailable.rowNumber).attachments, [{ index: 0, field: "note", label: "備考のリンク", kind: "drive", url: unavailable.url }]);
  // Exactly four rows have links, all others have []
  let total = 0;
  for (const record of byRow.values()) {
    total += record.attachments.length;
    if (!EX.attachments.rowNumbers.includes(record.rowNumber)) {
      assert.deepEqual(record.attachments, [], `row ${record.rowNumber}`);
      assert.deepEqual(record.attachmentFileIds, []);
    }
  }
  assert.equal(total, EX.attachments.total);
});

test("links never enter searchText", () => {
  for (const record of mapRows(FIXTURE_GRID)) {
    assert.ok(!record.searchText.includes("drive"), `row ${record.rowNumber}`);
    assert.ok(!record.searchText.includes("fixture"), `row ${record.rowNumber}`);
    assert.ok(!record.searchText.includes("example"), `row ${record.rowNumber}`);
  }
});
