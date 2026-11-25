<?php
// Cell link extraction and attachment list building (Design §10-2). PHP port of Src/Attachments.js. No I/O.
declare(strict_types=1);

namespace VaccinePortal;

require_once __DIR__ . '/JsCompat.php';
require_once __DIR__ . '/WhatwgUrl.php';

// Hosts whose file links are fetched through the server
const DRIVE_HOSTS = ['drive.google.com', 'docs.google.com'];
// Shape of a Drive file id (letters, digits, "_" and "-", at least 10 chars) as a PCRE pattern
const DRIVE_ID_RE = '/^[A-Za-z0-9_-]{10,}$/D';
// MIME types the attachment endpoint serves, mapped to the neutral file extension (Design §10-3)
const ATTACHMENT_TYPES = [
    'image/jpeg' => 'jpg',
    'image/png' => 'png',
    'image/webp' => 'webp',
    'application/pdf' => 'pdf',
];
// Largest file the endpoint serves (matches the Cloudflare Images input limit)
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
// Path form of a Drive file link: /file/d/<id> optionally followed by more segments
const FILE_PATH_RE = '/^\/file\/d\/([^\/]+)(?:\/.*)?$/D';

// RFC 3492 (Punycode) parameters used to decode "xn--" labels
const PUNY_BASE = 36;
const PUNY_TMIN = 1;
const PUNY_TMAX = 26;
const PUNY_SKEW = 38;
const PUNY_DAMP = 700;
const PUNY_INITIAL_BIAS = 72;
const PUNY_INITIAL_N = 128;

/**
 * RFC 3492 bias adaptation.
 */
function punyAdapt(int $delta, int $numPoints, bool $firstTime): int
{
    // Scale the delta down (more on the first pass) and spread it over the output length
    $d = $firstTime ? intdiv($delta, PUNY_DAMP) : intdiv($delta, 2);
    $d += intdiv($d, $numPoints);
    $k = 0;
    // Shrink the delta until it fits the threshold, counting the steps
    while ($d > intdiv((PUNY_BASE - PUNY_TMIN) * PUNY_TMAX, 2)) {
        $d = intdiv($d, PUNY_BASE - PUNY_TMIN);
        $k += PUNY_BASE;
    }
    return $k + intdiv((PUNY_BASE - PUNY_TMIN + 1) * $d, $d + PUNY_SKEW);
}

/**
 * Decode the part of an ACE label after "xn--" into code points (null when malformed).
 * @return int[]|null
 */
function punycodeDecode(string $input): ?array
{
    // The basic (ASCII) code points come before the last "-"
    $split = strrpos($input, '-');
    $split = $split === false ? -1 : $split;
    $output = [];
    for ($j = 0; $j < max($split, 0); $j++) $output[] = ord($input[$j]);
    $pos = $split > 0 ? $split + 1 : 0;
    $length = strlen($input);
    $n = PUNY_INITIAL_N;
    $i = 0;
    $bias = PUNY_INITIAL_BIAS;
    // Each pass decodes one generalized variable-length integer and inserts one code point
    while ($pos < $length) {
        $oldI = $i;
        $w = 1;
        for ($k = PUNY_BASE; ; $k += PUNY_BASE) {
            // Running out of digits mid-number is malformed
            if ($pos >= $length) return null;
            $c = ord($input[$pos++]);
            // Digits are a-z (0-25) then 0-9 (26-35); anything else is malformed
            $digit = ($c >= 97 && $c <= 122) ? $c - 97 : (($c >= 48 && $c <= 57) ? $c - 22 : -1);
            if ($digit < 0) return null;
            $i += $digit * $w;
            // Guard against overflow (well past any valid code point)
            if ($i > 0x7fffffff) return null;
            $t = $k <= $bias ? PUNY_TMIN : ($k >= $bias + PUNY_TMAX ? PUNY_TMAX : $k - $bias);
            if ($digit < $t) break;
            $w *= PUNY_BASE - $t;
        }
        $count = count($output) + 1;
        $bias = punyAdapt($i - $oldI, $count, $oldI === 0);
        $n += intdiv($i, $count);
        $i %= $count;
        // Beyond Unicode is malformed
        if ($n > 0x10FFFF) return null;
        array_splice($output, $i, 0, [$n]);
        $i++;
    }
    return $output;
}

/**
 * True when every "xn--" label of the host decodes to a usable Unicode label (same rule as Src/Attachments.js).
 */
function hasValidAceLabels(string $hostname): bool
{
    foreach (explode('.', strtolower($hostname)) as $label) {
        // Only ACE labels need checking
        if (!str_starts_with($label, 'xn--')) continue;
        $points = punycodeDecode(substr($label, 4));
        if ($points === null || $points === []) return false;
        $nonAscii = false;
        foreach ($points as $p) {
            // Allowed: ASCII letters, digits and "-", or non-surrogate code points from U+00A0 up
            $ascii = ($p >= 97 && $p <= 122) || ($p >= 48 && $p <= 57) || $p === 45;
            $wide = $p >= 0xA0 && ($p < 0xD800 || $p > 0xDFFF);
            if (!$ascii && !$wide) return false;
            if ($wide) $nonAscii = true;
        }
        // An ACE label must actually encode something beyond ASCII
        if (!$nonAscii) return false;
    }
    return true;
}

/**
 * Parse a URL string safely; only https URLs are returned (others are useless to every caller).
 * @return array{protocol:string, href:string, hostname:string, pathname:string, query:?string}|null
 */
function safeUrl(mixed $value): ?array
{
    // Only non-blank strings can be links
    if (!is_string($value) || jsTrim($value) === '') return null;
    // Parse the JS-trimmed text
    $parsed = parseHttpsUrl(jsTrim($value));
    // Malformed "xn--" labels are rejected by an explicit rule instead of relying on the ICU version
    return $parsed !== null && hasValidAceLabels($parsed['hostname']) ? $parsed : null;
}

/**
 * Extract the Drive file id from the three supported link shapes (or null).
 */
function parseDriveFileId(mixed $url): ?string
{
    $parsed = safeUrl($url);
    // Only https links on the Drive hosts qualify
    if ($parsed === null || $parsed['protocol'] !== 'https:' || !in_array($parsed['hostname'], DRIVE_HOSTS, true)) return null;
    $candidate = null;
    if (preg_match(FILE_PATH_RE, $parsed['pathname'], $pathMatch)) {
        // Shape 1: /file/d/<id>/...
        $candidate = $pathMatch[1];
    } elseif ($parsed['pathname'] === '/open' || $parsed['pathname'] === '/uc') {
        // Shapes 2 and 3: /open?id=<id> and /uc?id=<id>
        $candidate = urlSearchParamGet($parsed['query'], 'id');
    }
    // The id must look like a Drive id (Docs/Sheets/Slides paths never reach here)
    return $candidate !== null && $candidate !== '' && preg_match(DRIVE_ID_RE, $candidate) ? $candidate : null;
}

/**
 * Classify one link URI.
 * @return array{kind:string, url:string, fileId?:string}|null  ['kind'=>'drive','url','fileId'] or ['kind'=>'external','url']
 */
function classifyLink(mixed $uri): ?array
{
    $parsed = safeUrl($uri);
    // Drop anything that is not https (http:, mailto:, tel:, javascript: ...)
    if ($parsed === null || $parsed['protocol'] !== 'https:') return null;
    // Use the canonical form so whitespace and casing quirks do not leak through
    $url = $parsed['href'];
    $fileId = parseDriveFileId($url);
    if ($fileId !== null) return ['kind' => 'drive', 'url' => $url, 'fileId' => $fileId];
    // Everything else on https is an external link opened in a new tab
    return ['kind' => 'external', 'url' => $url];
}

/**
 * Collect the link URIs of one cell (hyperlink -> textFormatRuns -> chipRuns), each URI once.
 * @param mixed $cell  Sheets CellData as a decoded associative array
 * @return string[]
 */
function extractCellLinks(mixed $cell): array
{
    $result = [];
    // Add a URI once, ignoring non-strings and blanks
    $add = static function (mixed $uri) use (&$result): void {
        if (!is_string($uri) || jsTrim($uri) === '') return;
        $value = jsTrim($uri);
        if (!in_array($value, $result, true)) $result[] = $value;
    };
    // Only objects can carry links
    if (!is_array($cell) && !is_object($cell)) return $result;
    // Whole-cell link (Insert link or HYPERLINK())
    $add(jsGet($cell, 'hyperlink'));
    // Links on part of the text
    $runs = jsGet($cell, 'textFormatRuns');
    if (is_array($runs) && array_is_list($runs)) {
        foreach ($runs as $run) $add(jsGet($run, 'format', 'link', 'uri'));
    }
    // Smart chips (e.g. a Drive file inserted with @)
    $chips = jsGet($cell, 'chipRuns');
    if (is_array($chips) && array_is_list($chips)) {
        foreach ($chips as $run) $add(jsGet($run, 'chip', 'richLinkProperties', 'uri'));
    }
    return $result;
}

/**
 * Comparison key for de-duplicating external URLs (drop the fragment and one trailing slash).
 */
function externalKey(string $url): string
{
    // "." does not cross line terminators in JS; a serialised href never contains them
    $withoutFragment = preg_replace('/#.*$/sD', '', $url) ?? $url;
    return preg_replace('/\/$/D', '', $withoutFragment) ?? $withoutFragment;
}

/**
 * Build the attachment list of one row.
 * @param mixed $cells  the row's CellData list (up to 19 columns)
 * @param array<int, array{field:string, header:string}> $columns  column metadata in sheet order
 * @return array{attachments: array<int, array{index:int, field:string, label:string, kind:string, url:string}>, fileIds: array<int, ?string>}
 */
function buildAttachments(mixed $cells, array $columns): array
{
    $attachments = [];
    $fileIds = [];
    // Keys already kept in this row (first column / first kind wins)
    $seen = [];
    $list = is_array($cells) && array_is_list($cells) ? $cells : [];
    foreach (array_values($columns) as $col => $column) {
        // Number of links kept from this cell, for the "(2)" suffix
        $inCell = 0;
        foreach (extractCellLinks($list[$col] ?? null) as $uri) {
            $link = classifyLink($uri);
            if ($link === null) continue;
            // Drive links dedupe by file id, external links by normalised URL
            $key = $link['kind'] === 'drive' ? 'drive:' . $link['fileId'] : 'external:' . externalKey($link['url']);
            if (isset($seen[$key])) continue;
            $seen[$key] = true;
            $inCell += 1;
            // Label is the column header plus a counter for the 2nd and later links of the same cell
            $base = jsString(jsGet($column, 'header')) . 'のリンク';
            $attachments[] = [
                'index' => count($attachments),
                'field' => jsGet($column, 'field'),
                'label' => $inCell === 1 ? $base : $base . ' (' . $inCell . ')',
                'kind' => $link['kind'],
                'url' => $link['url'],
            ];
            // Server-only file id list aligned with attachments (null for external)
            $fileIds[] = $link['kind'] === 'drive' ? $link['fileId'] : null;
        }
    }
    return ['attachments' => $attachments, 'fileIds' => $fileIds];
}
