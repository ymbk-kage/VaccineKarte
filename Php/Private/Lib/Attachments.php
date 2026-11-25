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

/**
 * Parse a URL string safely; only https URLs are returned (others are useless to every caller).
 * @return array{protocol:string, href:string, hostname:string, pathname:string, query:?string}|null
 */
function safeUrl(mixed $value): ?array
{
    // Only non-blank strings can be links
    if (!is_string($value) || jsTrim($value) === '') return null;
    // Parse the JS-trimmed text
    return parseHttpsUrl(jsTrim($value));
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
