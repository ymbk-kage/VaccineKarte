<?php
// Pure text/date/age normalisation helpers (Design §3-1). PHP port of Src/Normalize.js. No I/O.
declare(strict_types=1);

namespace VaccinePortal;

require_once __DIR__ . '/JsCompat.php';

// Characters removed after NFKC: JS whitespace, hyphen/dash variants, long-vowel mark and slashes
const STRIP_PATTERN = '/[' . JS_WHITESPACE_CLASS . '\x{002D}\x{2010}\x{2011}\x{2012}\x{2013}\x{2014}\x{2015}\x{2212}\x{30FC}\/\x{FF0F}]/u';

/**
 * Normalise text for partial matching.
 * NFKC -> lower case -> katakana to hiragana -> strip spaces, dashes, "ー" and slashes.
 */
function normalizeText(mixed $s): string
{
    // Treat null (JS null/undefined) as empty so callers never need guards
    if ($s === null) return '';
    // Unify full-width/half-width forms and compatibility ideographs, then lower-case (full Unicode mapping)
    $text = mb_strtolower(nfkc(jsString($s)), 'UTF-8');
    // Shift katakana U+30A1..U+30F6 down to the hiragana block
    $text = preg_replace_callback('/[\x{30A1}-\x{30F6}]/u', static fn(array $m): string => mb_chr(mb_ord($m[0], 'UTF-8') - 0x60, 'UTF-8'), $text) ?? $text;
    // Drop separators whose presence varies between handwritten forms
    return preg_replace(STRIP_PATTERN, '', $text) ?? $text;
}

/**
 * Parse a date string into ISO "YYYY-MM-DD" (or null).
 * Accepts "2026/10/15", "2026-10-15", "2026.10.15" and "20261015" (full-width digits too).
 */
function parseDate(mixed $s): ?string
{
    // Missing values cannot be parsed
    if ($s === null) return null;
    // Unify full-width digits/separators and trim surrounding blanks
    $text = jsTrim(nfkc(jsString($s)));
    // Try the separated form first, then the compact 8-digit form (ASCII digits only, like JS \d)
    if (!preg_match('/^([0-9]{4})[\/\-.]([0-9]{1,2})[\/\-.]([0-9]{1,2})$/D', $text, $match)
        && !preg_match('/^([0-9]{4})([0-9]{2})([0-9]{2})$/D', $text, $match)) {
        return null;
    }
    // Convert the captured parts into numbers
    $year = (int) $match[1];
    $month = (int) $match[2];
    $day = (int) $match[3];
    // Date.UTC maps years 0-99 to 1900-1999, so the JS round-trip check rejects them
    if ($year < 100) return null;
    // Reject impossible calendar dates such as 2026/02/30 (proleptic Gregorian, timezone independent)
    if (!checkdate($month, $day, $year)) return null;
    // Format with zero padding
    return sprintf('%04d-%02d-%02d', $year, $month, $day);
}

/**
 * Parse an age such as "13", "１３" or "13歳" (or null).
 */
function parseAge(mixed $s): ?int
{
    // Missing values are unknown ages
    if ($s === null) return null;
    // Unify full-width digits and trim
    $text = jsTrim(nfkc(jsString($s)));
    // Allow optional JS whitespace and a trailing "歳"
    if (!preg_match('/^([0-9]{1,3})[' . JS_WHITESPACE_CLASS . ']*歳?$/uD', $text, $match)) return null;
    // Leading zeros are dropped like Number("013")
    return (int) $match[1];
}
