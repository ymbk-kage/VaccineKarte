// Unit tests for Src/Search.js (Design §3-2, §4) using the synthetic fixture
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuery, matches, sortRecords, searchRecords, toSummary, toDetail, computeMeta } from "../../Src/Search.js";
import { mapRows } from "../../Src/Records.js";
import { FIXTURE_GRID, FIXTURE_EXPECTATIONS as EX } from "../../Src/Fixture.js";

// Records mapped through the real mapRows
const records = mapRows(FIXTURE_GRID);

// Run a body through parseQuery + searchRecords with a large page
function run(body) {
  const query = parseQuery({ pageSize: 200, ...body });
  assert.equal(query.error, undefined, `query rejected: ${query.error}`);
  return searchRecords(records, query);
}

// Row numbers of a result, sorted ascending
function rows(result) {
  return result.items.map((r) => r.rowNumber).sort((a, b) => a - b);
}

test("fixture has the documented size and blank row", () => {
  assert.equal(records.length, EX.total);
  assert.ok(!records.some((r) => r.rowNumber === EX.blankRowNumber));
});

test("empty query returns everything (default page 1 / 50)", () => {
  const result = searchRecords(records, parseQuery({}));
  assert.equal(result.total, EX.total);
  assert.equal(result.page, 1);
  assert.equal(result.pageSize, 50);
  assert.equal(result.sort, "visitDesc");
  assert.equal(result.items.length, EX.total);
});

test("free word matches name without space, katakana reading and bare phone digits", () => {
  for (const q of EX.yamadaSearches) {
    assert.deepEqual(rows(run({ q })), [EX.yamada.rowNumber], q);
  }
});

test("free words are ANDed", () => {
  // Both words hit row 2
  assert.deepEqual(rows(run({ q: "やまだ　インフルエンザ" })), [2]);
  // Second word excludes everything
  assert.equal(run({ q: "やまだ コロナ" }).total, 0);
});

test("no-hit query returns 0", () => {
  assert.equal(run({ q: EX.noHitQuery }).total, 0);
});

test("field conditions are normalised partial matches", () => {
  assert.deepEqual(rows(run({ name: "山田太郎" })), [2]);
  assert.deepEqual(rows(run({ furigana: "ヤマダ" })), [2]);
  assert.deepEqual(rows(run({ phone: "090 0000 0001" })), [2]);
  assert.deepEqual(rows(run({ address: "ためし町 3-3" })), [4]);
  assert.deepEqual(rows(run({ managementNumber: EX.sharedManagementNumber.number })), EX.sharedManagementNumber.rowNumbers);
  assert.deepEqual(rows(run({ lotNumber: "cv2603c" })), [24]);
  assert.equal(run({ vaccine: "高齢者定期" }).total, EX.blankManagementNumberPublicRows.length);
});

test("kind and category are exact matches", () => {
  const corona = run({ kind: "コロナ" });
  assert.ok(corona.items.every((r) => r.kind === "コロナ"));
  const publicRows = run({ category: "公費" });
  assert.deepEqual(rows(publicRows), EX.blankManagementNumberPublicRows);
});

test("コロナ + 公費 + age 65-100 gives the documented count", () => {
  const { kind, category, ageMin, ageMax, count, rowNumbers } = EX.coronaPublicAge65to100;
  const result = run({ kind, category, ageMin, ageMax });
  assert.equal(result.total, count);
  assert.deepEqual(rows(result), rowNumbers);
});

test("age bounds are inclusive", () => {
  assert.deepEqual(rows(run({ ageMin: 95, ageMax: 95 })), [7]);
  assert.deepEqual(rows(run({ kind: "コロナ", category: "公費", ageMax: 64 })), [8]);
});

test("visit date range is inclusive and excludes unparsable dates", () => {
  const { visitFrom, visitTo, count, rowNumbers } = EX.visitRange;
  const result = run({ visitFrom, visitTo });
  assert.equal(result.total, count);
  assert.deepEqual(rows(result), rowNumbers);
  // An open-ended range still excludes the 不明 row
  assert.ok(!rows(run({ visitFrom: "2000-01-01" })).includes(EX.unparsableVisitDateRowNumber));
  // Without date conditions the row is included
  assert.ok(rows(run({})).includes(EX.unparsableVisitDateRowNumber));
});

test("birth date range is inclusive", () => {
  assert.deepEqual(rows(run({ birthFrom: "2013-04-02", birthTo: "2013-04-02" })), [2]);
});

test("unparsable ages are excluded once an age bound is set", () => {
  const extra = [...records, { ...records[0], rowNumber: 99, age: "不明", ageNumber: null }];
  const result = searchRecords(extra, parseQuery({ ageMin: 0, pageSize: 200 }));
  assert.ok(!result.items.some((r) => r.rowNumber === 99));
});

test("flagged=true keeps only flagged rows", () => {
  const result = run({ flagged: true });
  assert.equal(result.total, EX.flagged);
  assert.deepEqual(rows(result), [...EX.redRowNumbers, ...EX.orangeRowNumbers, ...EX.yellowRowNumbers].sort((a, b) => a - b));
});

test("visitDesc sorts newest first, then row desc, unparsable last", () => {
  const sorted = sortRecords(records, "visitDesc");
  assert.equal(sorted[0].visitDateIso, "2026-10-15");
  // Among 2026-10-15 rows the highest row number comes first
  assert.equal(sorted[0].rowNumber, 26);
  assert.equal(sorted.at(-1).rowNumber, EX.unparsableVisitDateRowNumber);
  // The input array is not mutated
  assert.equal(records[0].rowNumber, 2);
});

test("visitAsc sorts oldest first, unparsable last", () => {
  const sorted = sortRecords(records, "visitAsc");
  assert.equal(sorted[0].visitDateIso, "2026-10-01");
  assert.equal(sorted.at(-1).rowNumber, EX.unparsableVisitDateRowNumber);
});

test("furigana sort is ascending by normalised reading", () => {
  const sorted = sortRecords(records, "furigana");
  assert.equal(sorted[0].furigana, "あおき　いちろう");
  assert.equal(sorted.at(-1).furigana, "わたなべ　さくら");
});

test("rowDesc sorts by row number descending", () => {
  const sorted = sortRecords(records, "rowDesc");
  assert.equal(sorted[0].rowNumber, 32);
  assert.equal(sorted.at(-1).rowNumber, 2);
});

test("paging boundaries", () => {
  const page1 = searchRecords(records, parseQuery({ pageSize: 7 }));
  const page5 = searchRecords(records, parseQuery({ pageSize: 7, page: 5 }));
  const page6 = searchRecords(records, parseQuery({ pageSize: 7, page: 6 }));
  assert.equal(page1.items.length, 7);
  assert.equal(page5.items.length, 2);
  assert.equal(page6.items.length, 0);
  assert.equal(page6.total, EX.total);
});

test("parseQuery fills defaults and accepts numeric strings", () => {
  assert.deepEqual(parseQuery({}), { sort: "visitDesc", page: 1, pageSize: 50 });
  assert.deepEqual(parseQuery(null), { sort: "visitDesc", page: 1, pageSize: 50 });
  const query = parseQuery({ ageMin: "65", ageMax: 100, page: "2", flagged: false, q: "  山田  " });
  assert.equal(query.ageMin, 65);
  assert.equal(query.ageMax, 100);
  assert.equal(query.page, 2);
  assert.equal(query.flagged, undefined);
  assert.equal(query.q, "山田");
});

test("parseQuery rejects malformed conditions (-> 400)", () => {
  const bad = [
    [],
    "text",
    42,
    { visitFrom: "2026/10/01" },
    { visitTo: "2026-02-30" },
    { birthFrom: "20261001" },
    { ageMin: "abc" },
    { ageMax: -1 },
    { ageMin: 1.5 },
    { pageSize: 201 },
    { pageSize: 0 },
    { page: 0 },
    { kind: "麻しん" },
    { category: "定期" },
    { sort: "random" },
    { flagged: "true" },
    { q: { $ne: "" } },
    { name: ["a"] },
    { q: "x".repeat(201) },
  ];
  for (const body of bad) {
    assert.ok(parseQuery(body).error, `should reject ${JSON.stringify(body)}`);
  }
});

test("matches with an empty query is true", () => {
  assert.equal(matches(records[0], {}), true);
});

test("toSummary exposes only list fields", () => {
  const summary = toSummary(records[0]);
  assert.deepEqual(Object.keys(summary).sort(), ["age", "attachmentCount", "category", "flagLevel", "furigana", "kind", "managementNumber", "name", "rowNumber", "visitDate"]);
  assert.equal(summary.name, EX.yamada.name);
  assert.equal(summary.flagLevel, EX.yamada.flagLevel);
});

test("toDetail drops searchText and counts shared management numbers", () => {
  const shared = records.find((r) => r.rowNumber === EX.sharedManagementNumber.rowNumbers[0]);
  const detail = toDetail(shared, records);
  assert.equal(detail.searchText, undefined);
  assert.equal(detail.sameNumberCount, 2);
  // Blank management numbers count as 0
  const publicRow = records.find((r) => r.rowNumber === EX.blankManagementNumberPublicRows[0]);
  assert.equal(toDetail(publicRow, records).sameNumberCount, 0);
  // A unique number counts itself
  assert.equal(toDetail(records[0], records).sameNumberCount, 1);
});

test("fixture flags and notes match the documented expectations", () => {
  const byRow = new Map(records.map((r) => [r.rowNumber, r]));
  assert.deepEqual(byRow.get(2).flags, { address: "yellow" });
  for (const n of EX.redRowNumbers) assert.equal(byRow.get(n).flagLevel, "red");
  for (const n of EX.orangeRowNumbers) {
    assert.equal(byRow.get(n).flagLevel, "orange");
    assert.equal(byRow.get(n).flags.age, "orange");
  }
  for (const n of EX.yellowRowNumbers) assert.equal(byRow.get(n).flagLevel, "yellow");
  assert.deepEqual(records.filter((r) => r.note).map((r) => r.rowNumber), EX.noteRowNumbers);
  assert.equal(byRow.get(EX.unparsableVisitDateRowNumber).visitDateIso, null);
  // Phones are all in the fictional 090-0000-00xx range
  assert.ok(records.every((r) => /^090-0000-00\d\d$/.test(r.phone)));
});

test("computeMeta summarises the data set", () => {
  const meta = computeMeta(records);
  assert.equal(meta.total, EX.total);
  assert.equal(meta.flagged, EX.flagged);
  assert.deepEqual(meta.kinds, ["インフルエンザ", "コロナ"]);
  assert.deepEqual(meta.categories, ["任意", "公費"]);
  assert.deepEqual(meta.visitDateRange, EX.visitDateRange);
  // Empty data has no range
  assert.deepEqual(computeMeta([]).visitDateRange, { min: null, max: null });
});

// ---------- attachments (Design §10-2) ----------

test("toSummary carries attachmentCount (1 on linked rows, 0 elsewhere)", () => {
  for (const record of records) {
    const expected = EX.attachments.rowNumbers.includes(record.rowNumber) ? 1 : 0;
    assert.equal(toSummary(record).attachmentCount, expected, `row ${record.rowNumber}`);
  }
  // A record without the field still reports 0
  assert.equal(toSummary({ rowNumber: 1 }).attachmentCount, 0);
});

test("toDetail drops attachmentFileIds but keeps attachments[].url", () => {
  const record = records.find((r) => r.rowNumber === EX.attachments.image.rowNumber);
  const detail = toDetail(record, records);
  assert.equal(detail.attachmentFileIds, undefined);
  assert.equal(detail.attachments.length, 1);
  assert.match(detail.attachments[0].url, /^https:\/\/drive\.google\.com\/file\/d\//);
  // No property anywhere in the attachment entries is a bare file id field
  assert.deepEqual(Object.keys(detail.attachments[0]).sort(), ["field", "index", "kind", "label", "url"]);
  // Mutating the detail does not touch the cached record
  detail.attachments[0].label = "changed";
  assert.equal(record.attachments[0].label, EX.attachments.image.label);
});
