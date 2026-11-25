<?php
// JavaScript semantics helpers shared by the ported pure modules (String(), trim(), Number(), UTF-16 order).
// No I/O. Requires the intl and mbstring extensions.
declare(strict_types=1);

namespace VaccinePortal;

// Code points JavaScript treats as whitespace in String.prototype.trim() and the regex class \s
const JS_WHITESPACE_CLASS = '\x{0009}-\x{000D}\x{0020}\x{00A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}';

/**
 * Emulate String.prototype.trim() (Unicode whitespace and line terminators, both ends).
 */
function jsTrim(string $s): string
{
    // Strip the JS whitespace class from the start and the end (D: "$" is the true end)
    $result = preg_replace('/^[' . JS_WHITESPACE_CLASS . ']+|[' . JS_WHITESPACE_CLASS . ']+$/uD', '', $s);
    // preg_replace returns null on invalid UTF-8; keep the input unchanged then
    return $result ?? $s;
}

/**
 * Emulate String(value) for JSON-decoded values (null -> "null", arrays -> comma join, objects -> "[object Object]").
 */
function jsString(mixed $value): string
{
    // Strings pass through unchanged
    if (is_string($value)) return $value;
    // JS null converts to the word "null"
    if ($value === null) return 'null';
    // Booleans become "true"/"false"
    if (is_bool($value)) return $value ? 'true' : 'false';
    // Numbers use the ECMAScript Number::toString algorithm
    if (is_int($value) || is_float($value)) return jsNumberToString($value);
    // JSON arrays (lists) join their elements with "," and render null as ""
    if (is_array($value) && array_is_list($value)) {
        // Convert each element the way Array.prototype.join does
        $parts = array_map(static fn($item) => $item === null ? '' : jsString($item), $value);
        return implode(',', $parts);
    }
    // Every other object converts to the default object tag
    return '[object Object]';
}

/**
 * Emulate Number.prototype.toString() for an int or float.
 */
function jsNumberToString(int|float $n): string
{
    // Integers beyond 2^53 lose precision in JS, so treat them as doubles
    if (is_int($n)) {
        if (abs($n) <= 9007199254740992) return (string) $n;
        $n = (float) $n;
    }
    // Special values
    if (is_nan($n)) return 'NaN';
    if (is_infinite($n)) return $n > 0 ? 'Infinity' : '-Infinity';
    // Both +0 and -0 print as "0"
    if ($n == 0.0) return '0';
    // Remember the sign and work with the magnitude
    $sign = $n < 0 ? '-' : '';
    $abs = abs($n);
    // Find the shortest digit string that round-trips (same as JS "shortest" formatting)
    $repr = '';
    for ($precision = 1; $precision <= 17; $precision++) {
        // Format with the given number of significant digits in exponent form
        $repr = sprintf('%.' . ($precision - 1) . 'e', $abs);
        if ((float) $repr === $abs) break;
    }
    // Split "d.ddde+X" into the digit string and the decimal exponent
    [$mantissa, $exponent] = explode('e', $repr);
    $digits = rtrim(str_replace('.', '', $mantissa), '0');
    // Guard against an all-zero mantissa (cannot happen for non-zero values)
    if ($digits === '') $digits = '0';
    // n is the position of the decimal point relative to the digit string (value = 0.digits * 10^n)
    $k = strlen($digits);
    $point = (int) $exponent + 1;
    // Apply the ECMAScript formatting rules
    if ($k <= $point && $point <= 21) return $sign . $digits . str_repeat('0', $point - $k);
    if (0 < $point && $point <= 21) return $sign . substr($digits, 0, $point) . '.' . substr($digits, $point);
    if (-6 < $point && $point <= 0) return $sign . '0.' . str_repeat('0', -$point) . $digits;
    // Exponent form for very large or very small magnitudes
    $e = $point - 1;
    $expText = ($e >= 0 ? '+' : '-') . abs($e);
    if ($k === 1) return $sign . $digits . 'e' . $expText;
    return $sign . $digits[0] . '.' . substr($digits, 1) . 'e' . $expText;
}

/**
 * Emulate Number(value) for JSON-decoded values (NAN for unconvertible input).
 */
function jsToNumber(mixed $value): float
{
    // null converts to 0
    if ($value === null) return 0.0;
    // Booleans convert to 1/0
    if (is_bool($value)) return $value ? 1.0 : 0.0;
    // Numbers pass through as doubles
    if (is_int($value) || is_float($value)) return (float) $value;
    // Arrays convert through their string form
    if (is_array($value) && array_is_list($value)) return jsToNumber(jsString($value));
    // Other objects are NaN
    if (!is_string($value)) return NAN;
    // Strings: trim, empty means 0
    $text = jsTrim($value);
    if ($text === '') return 0.0;
    // Signed decimal literal or Infinity
    if (preg_match('/^[+-]?(Infinity|([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?)$/D', $text)) {
        // Infinity needs explicit handling because PHP casts it to 0
        if (str_ends_with($text, 'Infinity')) return str_starts_with($text, '-') ? -INF : INF;
        return (float) $text;
    }
    // Unsigned hexadecimal, binary and octal literals
    if (preg_match('/^0[xX]([0-9a-fA-F]+)$/D', $text, $m)) return (float) hexdec($m[1]);
    if (preg_match('/^0[bB]([01]+)$/D', $text, $m)) return (float) bindec($m[1]);
    if (preg_match('/^0[oO]([0-7]+)$/D', $text, $m)) return (float) octdec($m[1]);
    // Anything else is not a number
    return NAN;
}

/**
 * JS truthiness of a JSON-decoded value (arrays/objects are always truthy).
 */
function jsTruthy(mixed $value): bool
{
    // Falsy primitives: null, false, 0, NaN and the empty string
    if ($value === null || $value === false || $value === '') return false;
    if (is_int($value)) return $value !== 0;
    if (is_float($value)) return !($value == 0.0 || is_nan($value));
    // Strings such as "0" and every array/object are truthy
    return true;
}

/**
 * Length of a UTF-8 string in UTF-16 code units (the value of JS String.prototype.length).
 */
function utf16Length(string $s): int
{
    // Count code points, then add one more unit per supplementary-plane character (surrogate pair)
    $codePoints = mb_strlen($s, 'UTF-8');
    $astral = preg_match_all('/[\x{10000}-\x{10FFFF}]/u', $s);
    return $codePoints + (int) $astral;
}

/**
 * Compare two strings the way JS relational operators do (UTF-16 code unit order). Returns -1, 0 or 1.
 */
function utf16Compare(string $a, string $b): int
{
    // Equal strings compare equal without conversion
    if ($a === $b) return 0;
    // Big-endian UTF-16 bytes sort in code unit order
    $ua = mb_convert_encoding($a, 'UTF-16BE', 'UTF-8');
    $ub = mb_convert_encoding($b, 'UTF-16BE', 'UTF-8');
    return strcmp($ua, $ub) <=> 0;
}

/**
 * Emulate Array.prototype.slice(start, end) for a list.
 */
function jsSlice(array $list, int $start, ?int $end = null): array
{
    // Work on a re-indexed list
    $list = array_values($list);
    $length = count($list);
    // Negative indices count from the end, then clamp to [0, length]
    $from = $start < 0 ? max($length + $start, 0) : min($start, $length);
    $to = $end === null ? $length : ($end < 0 ? max($length + $end, 0) : min($end, $length));
    // An empty range yields an empty list
    if ($to <= $from) return [];
    return array_slice($list, $from, $to - $from);
}

/**
 * Optional-chaining property access (a?.b?.c) over decoded JSON arrays and objects.
 */
function jsGet(mixed $value, string|int ...$keys): mixed
{
    // Walk each key, stopping at the first missing step (JS undefined -> PHP null)
    foreach ($keys as $key) {
        if (is_array($value)) {
            // Associative arrays use the key directly
            if (!array_key_exists($key, $value)) return null;
            $value = $value[$key];
        } elseif (is_object($value)) {
            // stdClass objects use properties
            if (!property_exists($value, (string) $key)) return null;
            $value = $value->{$key};
        } else {
            // Primitives have no own properties
            return null;
        }
    }
    return $value;
}

/**
 * NFKC normalisation with a safe fallback for strings intl cannot process.
 */
function nfkc(string $s): string
{
    // Normalizer returns false on invalid UTF-8; keep the input then
    $result = \Normalizer::normalize($s, \Normalizer::FORM_KC);
    return $result === false ? $s : $result;
}
