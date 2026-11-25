// Unit tests for Src/Attachments.js (Design §10-2)
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDriveFileId, classifyLink, extractCellLinks, buildAttachments, DRIVE_ID_RE, hasValidAceLabels } from "../../Src/Attachments.js";
import { ATTACHMENT_COLUMNS } from "../../Src/Records.js";

// A syntactically valid synthetic Drive id
const ID = "AbCdEfGhIj_0123-xyz";
const ID2 = "ZyXwVuTsRq_9876-abc";

test("parseDriveFileId accepts exactly the three Drive shapes", () => {
  assert.equal(parseDriveFileId(`https://drive.google.com/file/d/${ID}/view?usp=sharing`), ID);
  assert.equal(parseDriveFileId(`https://drive.google.com/file/d/${ID}`), ID);
  assert.equal(parseDriveFileId(`https://docs.google.com/file/d/${ID}/edit`), ID);
  assert.equal(parseDriveFileId(`https://drive.google.com/open?id=${ID}`), ID);
  assert.equal(parseDriveFileId(`https://drive.google.com/uc?id=${ID}&export=download`), ID);
});

test("parseDriveFileId rejects Docs/Sheets/Slides, http, short ids and other hosts", () => {
  for (const url of [
    `https://docs.google.com/document/d/${ID}/edit`,
    `https://docs.google.com/spreadsheets/d/${ID}/edit`,
    `https://docs.google.com/presentation/d/${ID}/edit`,
    `http://drive.google.com/file/d/${ID}/view`,
    "https://drive.google.com/file/d/short/view",
    `https://drive.google.com.evil.example/file/d/${ID}/view`,
    `https://evil.example/file/d/${ID}/view`,
    "https://drive.google.com/open",
    `https://drive.google.com/drive/folders/${ID}`,
    "not a url",
    "",
    null,
  ]) {
    assert.equal(parseDriveFileId(url), null, String(url));
  }
  // Characters outside the id alphabet are refused
  assert.equal(DRIVE_ID_RE.test("abc<def>ghij"), false);
});

test("classifyLink: drive, external and dropped", () => {
  assert.deepEqual(classifyLink(`https://drive.google.com/file/d/${ID}/view`), { kind: "drive", url: `https://drive.google.com/file/d/${ID}/view`, fileId: ID });
  assert.deepEqual(classifyLink("https://example.com/a"), { kind: "external", url: "https://example.com/a" });
  // Google Docs stay external (not fetchable with alt=media)
  assert.equal(classifyLink(`https://docs.google.com/document/d/${ID}/edit`).kind, "external");
  // Non-https schemes are dropped
  for (const uri of ["http://example.com", "mailto:a@b.c", "tel:0900000000", "javascript:alert(1)", "data:text/html,x", "ftp://x", "", "  "]) {
    assert.equal(classifyLink(uri), null, uri);
  }
});

test("extractCellLinks reads hyperlink, textFormatRuns and chipRuns in order, each URI once", () => {
  const cell = {
    formattedValue: "x",
    hyperlink: "https://a.example/1",
    textFormatRuns: [{ format: {} }, { startIndex: 1, format: { link: { uri: "https://a.example/2" } } }, { format: { link: { uri: "https://a.example/1" } } }],
    chipRuns: [{ chip: { richLinkProperties: { uri: "https://a.example/3", mimeType: "image/jpeg" } } }, { chip: {} }],
  };
  assert.deepEqual(extractCellLinks(cell), ["https://a.example/1", "https://a.example/2", "https://a.example/3"]);
  // Cells without links or not objects
  assert.deepEqual(extractCellLinks({ formattedValue: "x" }), []);
  assert.deepEqual(extractCellLinks(undefined), []);
  assert.deepEqual(extractCellLinks({ hyperlink: 42 }), []);
});

test("buildAttachments dedupes per row (first column wins), numbers index and labels", () => {
  const cells = [];
  // 氏名 (col 4): the Drive file twice in different shapes + an external link
  cells[4] = { hyperlink: `https://drive.google.com/file/d/${ID}/view`, textFormatRuns: [{ format: { link: { uri: `https://drive.google.com/open?id=${ID}` } } }, { format: { link: { uri: "https://example.com/x/" } } }] };
  // 住所 (col 12): the same Drive file again (dropped), same external link without slash/with fragment (dropped), a new Drive file
  cells[12] = { hyperlink: `https://drive.google.com/uc?id=${ID}`, textFormatRuns: [{ format: { link: { uri: "https://example.com/x#top" } } }], chipRuns: [{ chip: { richLinkProperties: { uri: `https://drive.google.com/file/d/${ID2}/view` } } }] };
  // 備考 (col 19): a dropped mailto
  cells[19] = { hyperlink: "mailto:a@b.c" };
  const { attachments, fileIds } = buildAttachments(cells, ATTACHMENT_COLUMNS);
  assert.deepEqual(attachments, [
    { index: 0, field: "name", label: "氏名のリンク", kind: "drive", url: `https://drive.google.com/file/d/${ID}/view` },
    { index: 1, field: "name", label: "氏名のリンク (2)", kind: "external", url: "https://example.com/x/" },
    { index: 2, field: "address", label: "住所のリンク", kind: "drive", url: `https://drive.google.com/file/d/${ID2}/view` },
  ]);
  // File ids align with attachments; external is null
  assert.deepEqual(fileIds, [ID, null, ID2]);
});

test("buildAttachments labels the 20th column as 備考 and handles empty rows", () => {
  const cells = [];
  cells[19] = { hyperlink: "https://example.com/n" };
  assert.deepEqual(buildAttachments(cells, ATTACHMENT_COLUMNS).attachments, [{ index: 0, field: "note", label: "備考のリンク", kind: "external", url: "https://example.com/n" }]);
  assert.deepEqual(buildAttachments([], ATTACHMENT_COLUMNS), { attachments: [], fileIds: [] });
  assert.deepEqual(buildAttachments(undefined, ATTACHMENT_COLUMNS), { attachments: [], fileIds: [] });
});

test("xn-- labels are judged by an explicit rule, not by the runtime URL parser", () => {
  // Valid ACE labels (bücher, 日本語) pass and keep their canonical form
  assert.equal(hasValidAceLabels("xn--bcher-kva.example"), true);
  assert.equal(hasValidAceLabels("xn--wgv71a119e.jp"), true);
  assert.equal(hasValidAceLabels("plain.example"), true);
  // Malformed: decodes to U+0080, empty payload, dangling digits, ASCII-only payload
  for (const host of ["xn--a.com", "xn--.com", "xn--abc-.com", "a.xn--bcher-kva.xn--a.com"]) assert.equal(hasValidAceLabels(host), false, host);
  // classifyLink drops such links on every Node version (CI once disagreed with local Node)
  assert.equal(classifyLink("https://xn--a.com/"), null);
  assert.deepEqual(classifyLink("https://xn--bcher-kva.example/"), { kind: "external", url: "https://xn--bcher-kva.example/" });
});
