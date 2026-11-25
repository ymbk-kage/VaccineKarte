// Unit tests for Src/Normalize.js (Design §3-1)
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeText, parseDate, parseAge } from "../../Src/Normalize.js";

test("normalizeText applies NFKC to full-width alphanumerics", () => {
  // Full-width letters/digits become ASCII lower case
  assert.equal(normalizeText("ＡＢＣ１２３"), "abc123");
});

test("normalizeText unifies compatibility ideographs such as U+FA1A", () => {
  // U+FA1A (祥 compatibility form) normalises to U+7965
  assert.equal(normalizeText("祥"), "祥");
});

test("normalizeText lowers case", () => {
  assert.equal(normalizeText("HA2601C"), "ha2601c");
});

test("normalizeText converts katakana to hiragana (incl. half-width)", () => {
  // Full-width and half-width katakana both end up as hiragana
  assert.equal(normalizeText("ヤマダ"), "やまだ");
  assert.equal(normalizeText("ﾔﾏﾀﾞ"), "やまだ");
  assert.equal(normalizeText("ヴ"), "ゔ");
});

test("normalizeText strips spaces, dash variants, long vowel and slashes", () => {
  // Every separator listed in the design is removed
  assert.equal(normalizeText("山田　太郎"), "山田太郎");
  assert.equal(normalizeText("090-0000‐0001"), "09000000001");
  assert.equal(normalizeText("a‑b‒c–d—e―f−g"), "abcdefg");
  assert.equal(normalizeText("ルーシー"), "るし");
  assert.equal(normalizeText("2026/10／15"), "20261015");
  assert.equal(normalizeText(" a\tb\nc "), "abc");
});

test("normalizeText tolerates null and numbers", () => {
  assert.equal(normalizeText(null), "");
  assert.equal(normalizeText(undefined), "");
  assert.equal(normalizeText(13), "13");
});

test("parseDate accepts the four supported formats", () => {
  // Slash, hyphen, dot and compact forms
  assert.equal(parseDate("2026/10/15"), "2026-10-15");
  assert.equal(parseDate("2026-10-15"), "2026-10-15");
  assert.equal(parseDate("2026.10.15"), "2026-10-15");
  assert.equal(parseDate("20261015"), "2026-10-15");
  // Single-digit month/day and full-width digits
  assert.equal(parseDate("2026/1/5"), "2026-01-05");
  assert.equal(parseDate("２０２６／１０／１５"), "2026-10-15");
});

test("parseDate rejects invalid values", () => {
  assert.equal(parseDate("不明"), null);
  assert.equal(parseDate(""), null);
  assert.equal(parseDate(null), null);
  assert.equal(parseDate("2026/02/30"), null);
  assert.equal(parseDate("2026/13/01"), null);
  assert.equal(parseDate("2026/10/15 extra"), null);
  assert.equal(parseDate("261015"), null);
});

test("parseAge accepts plain, full-width and 歳 suffix", () => {
  assert.equal(parseAge("13"), 13);
  assert.equal(parseAge("１３"), 13);
  assert.equal(parseAge("13歳"), 13);
  assert.equal(parseAge(" 0 "), 0);
});

test("parseAge rejects non-numeric values", () => {
  assert.equal(parseAge("不明"), null);
  assert.equal(parseAge(""), null);
  assert.equal(parseAge("13.5"), null);
  assert.equal(parseAge(null), null);
});
