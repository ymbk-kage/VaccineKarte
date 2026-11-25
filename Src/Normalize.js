// Pure text/date/age normalisation helpers (Design §3-1). No I/O.

// Characters removed after NFKC: whitespace, hyphen/dash variants, long-vowel mark and slashes
const STRIP_PATTERN = /[\s\-‐‑‒–—―−ー\/／]/gu;

/**
 * Normalise text for partial matching.
 * NFKC -> lower case -> katakana to hiragana -> strip spaces, dashes, "ー" and slashes.
 * @param {unknown} s
 * @returns {string}
 */
export function normalizeText(s) {
  // Treat null/undefined as empty so callers never need guards
  if (s === null || s === undefined) return "";
  // Unify full-width/half-width forms and compatibility ideographs (e.g. U+FA1A)
  let text = String(s).normalize("NFKC").toLowerCase();
  // Shift katakana U+30A1..U+30F6 down to the hiragana block
  text = text.replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
  // Drop separators whose presence varies between handwritten forms
  return text.replace(STRIP_PATTERN, "");
}

/**
 * Parse a date string into ISO "YYYY-MM-DD".
 * Accepts "2026/10/15", "2026-10-15", "2026.10.15" and "20261015" (full-width digits too).
 * @param {unknown} s
 * @returns {string|null}
 */
export function parseDate(s) {
  // Non-strings and empty values cannot be parsed
  if (s === null || s === undefined) return null;
  // Unify full-width digits/separators and trim surrounding blanks
  const text = String(s).normalize("NFKC").trim();
  // Try the separated form first, then the compact 8-digit form
  const match = text.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/) || text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!match) return null;
  // Convert the captured parts into numbers
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // Reject impossible calendar dates such as 2026/02/30
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  // Format with zero padding
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Parse an age such as "13", "１３" or "13歳".
 * @param {unknown} s
 * @returns {number|null}
 */
export function parseAge(s) {
  // Missing values are unknown ages
  if (s === null || s === undefined) return null;
  // Unify full-width digits and trim
  const text = String(s).normalize("NFKC").trim();
  // Allow an optional trailing "歳"
  const match = text.match(/^(\d{1,3})\s*歳?$/);
  return match ? Number(match[1]) : null;
}
