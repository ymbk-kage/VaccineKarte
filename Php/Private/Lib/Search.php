<?php
// Query parsing, matching, sorting and response shaping (Design §3-2, §4). PHP port of Src/Search.js. No I/O.
declare(strict_types=1);

namespace VaccinePortal;

require_once __DIR__ . '/JsCompat.php';
require_once __DIR__ . '/Normalize.php';

// Allowed values of the exact-match filters
const KINDS = ['インフルエンザ', 'コロナ'];
const CATEGORIES = ['任意', '公費'];
// Allowed sort orders (first one is the default)
const SORTS = ['visitDesc', 'visitAsc', 'furigana', 'rowDesc'];
// Paging limits
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
// Longest accepted text condition in UTF-16 code units (guards against oversized bodies)
const MAX_TEXT_LENGTH = 200;

// Text conditions mapped to the record field they search
const TEXT_FIELDS = [
    'name' => 'name',
    'furigana' => 'furigana',
    'phone' => 'phone',
    'address' => 'address',
    'managementNumber' => 'managementNumber',
    'lotNumber' => 'lotNumber',
    'vaccine' => 'desiredVaccine',
];

// Date range conditions mapped to the ISO field they compare
const DATE_FIELDS = ['visitFrom' => 'visitDateIso', 'visitTo' => 'visitDateIso', 'birthFrom' => 'birthDateIso', 'birthTo' => 'birthDateIso'];

/**
 * Validate a decoded JSON request body and turn it into a Query.
 * Accepts json_decode($raw, true) output (an empty array is treated as {}; a non-empty list as a JSON array)
 * or json_decode($raw) output (stdClass) with $objectDecoded = true, which distinguishes [] from {} exactly.
 * @param mixed $body  decoded JSON request body
 * @param bool $objectDecoded  true when $body came from json_decode($raw) without the associative flag
 * @return array<string, mixed>  Query, or ['error' => string] on invalid input
 */
function parseQuery(mixed $body, bool $objectDecoded = false): array
{
    // Missing body means "no conditions"
    if ($body === null) $body = new \stdClass();
    // With object decoding every PHP array is a JSON array, which is rejected
    if ($objectDecoded && is_array($body)) return ['error' => 'body_not_object'];
    if ($body instanceof \stdClass) {
        // A stdClass body is a JSON object whatever its keys are; read it through its properties
        $body = get_object_vars($body);
    } elseif (!is_array($body) || ($body !== [] && array_is_list($body))) {
        // Only plain objects are accepted (JSON arrays and primitives are rejected)
        return ['error' => 'body_not_object'];
    }
    $query = [];
    // Free words: keep the raw string, AND-split later
    $q = readText($body['q'] ?? null, 'q');
    if (isset($q['error'])) return $q;
    if ($q['value'] !== '') $query['q'] = $q['value'];
    // Per-field partial-match conditions
    foreach (array_keys(TEXT_FIELDS) as $key) {
        $result = readText($body[$key] ?? null, $key);
        if (isset($result['error'])) return $result;
        if ($result['value'] !== '') $query[$key] = $result['value'];
    }
    // Exact-match selections must be one of the known values
    foreach ([['kind', KINDS], ['category', CATEGORIES]] as [$key, $allowed]) {
        $result = readText($body[$key] ?? null, $key);
        if (isset($result['error'])) return $result;
        if ($result['value'] !== '') {
            if (!in_array($result['value'], $allowed, true)) return ['error' => 'invalid_' . $key];
            $query[$key] = $result['value'];
        }
    }
    // Date ranges must be strict YYYY-MM-DD
    foreach (array_keys(DATE_FIELDS) as $key) {
        $result = readText($body[$key] ?? null, $key);
        if (isset($result['error'])) return $result;
        if ($result['value'] !== '') {
            if (!preg_match('/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/D', $result['value']) || parseDate($result['value']) !== $result['value']) {
                return ['error' => 'invalid_' . $key];
            }
            $query[$key] = $result['value'];
        }
    }
    // Age bounds must be integers in a human range
    foreach (['ageMin', 'ageMax'] as $key) {
        $result = readInteger($body[$key] ?? null, $key, 0, 150);
        if (isset($result['error'])) return $result;
        if ($result['value'] !== null) $query[$key] = $result['value'];
    }
    // Flagged-only switch must be a real boolean
    $flagged = $body['flagged'] ?? null;
    if ($flagged !== null) {
        if (!is_bool($flagged)) return ['error' => 'invalid_flagged'];
        if ($flagged) $query['flagged'] = true;
    }
    // Sort order defaults to newest visit first
    $sort = $body['sort'] ?? null;
    if ($sort !== null && $sort !== '') {
        if (!in_array($sort, SORTS, true)) return ['error' => 'invalid_sort'];
        $query['sort'] = $sort;
    } else {
        $query['sort'] = SORTS[0];
    }
    // Paging defaults and limits
    $page = readInteger($body['page'] ?? null, 'page', 1, 1000000);
    if (isset($page['error'])) return $page;
    $query['page'] = $page['value'] ?? 1;
    $pageSize = readInteger($body['pageSize'] ?? null, 'pageSize', 1, MAX_PAGE_SIZE);
    if (isset($pageSize['error'])) return $pageSize;
    $query['pageSize'] = $pageSize['value'] ?? DEFAULT_PAGE_SIZE;
    return $query;
}

/**
 * Read an optional text condition (string or number), trimmed.
 * @return array{value:string}|array{error:string}
 */
function readText(mixed $raw, string $key): array
{
    // Absent values become empty strings
    if ($raw === null) return ['value' => ''];
    // Accept numbers so a numeric phone/management number still works (formatted like String(n))
    if ((is_int($raw) || is_float($raw)) && is_finite((float) $raw)) return ['value' => jsNumberToString($raw)];
    if (!is_string($raw)) return ['error' => 'invalid_' . $key];
    // Reject oversized conditions (length counted in UTF-16 units like JS)
    if (utf16Length($raw) > MAX_TEXT_LENGTH) return ['error' => 'too_long_' . $key];
    return ['value' => jsTrim($raw)];
}

/**
 * Read an optional integer condition within [min, max].
 * @return array{value:?int}|array{error:string}
 */
function readInteger(mixed $raw, string $key, int $min, int $max): array
{
    // Absent or empty means "no condition"
    if ($raw === null || $raw === '') return ['value' => null];
    // Accept numeric strings as well as numbers (full-width digits too)
    $value = NAN;
    if (is_string($raw)) {
        // NFKC + trim, then ASCII digits only
        $text = jsTrim(nfkc($raw));
        if (preg_match('/^[0-9]+$/D', $text)) {
            // Very long digit strings are far above any max; avoid integer overflow
            $digits = ltrim($text, '0');
            $value = strlen($digits) > 15 ? INF : (float) ($digits === '' ? '0' : $digits);
        }
    } elseif (is_int($raw) || is_float($raw)) {
        $value = (float) $raw;
    } elseif (preg_match('/^[0-9]+$/D', jsString($raw))) {
        // JS RegExp.test() coerces other values to strings, so e.g. [5] passes and Number([5]) is 5
        $value = jsToNumber($raw);
    }
    // Must be an integral finite number inside the range (Number.isInteger semantics)
    if (!is_finite($value) || floor($value) !== $value || $value < $min || $value > $max) return ['error' => 'invalid_' . $key];
    return ['value' => (int) $value];
}

/**
 * Split the free-word condition into normalised AND terms.
 * @return string[]
 */
function splitTerms(mixed $q): array
{
    // Falsy conditions produce no terms
    if (!jsTruthy($q)) return [];
    // NFKC first so full-width spaces also separate words
    $pieces = preg_split('/[' . JS_WHITESPACE_CLASS . ']+/u', nfkc(jsString($q))) ?: [];
    // Normalise each word and drop empty ones
    $terms = array_map(__NAMESPACE__ . '\\normalizeText', $pieces);
    return array_values(array_filter($terms, static fn(string $term): bool => $term !== ''));
}

/**
 * Evaluate every condition of a query against one record (AND; empty conditions are ignored).
 */
function matches(array $record, array $query): bool
{
    // Free words must all appear in the haystack
    foreach (splitTerms($query['q'] ?? null) as $term) {
        if (!str_contains(jsString($record['searchText'] ?? ''), $term)) return false;
    }
    // Field conditions are normalised partial matches
    foreach (TEXT_FIELDS as $key => $field) {
        $needle = normalizeText($query[$key] ?? null);
        if ($needle !== '' && !str_contains(normalizeText($record[$field] ?? null), $needle)) return false;
    }
    // Exact-match selections
    if (jsTruthy($query['kind'] ?? null) && ($record['kind'] ?? null) !== $query['kind']) return false;
    if (jsTruthy($query['category'] ?? null) && ($record['category'] ?? null) !== $query['category']) return false;
    // Date ranges (inclusive); unparsable dates are excluded once a bound is set
    foreach (DATE_FIELDS as $key => $field) {
        $bound = $query[$key] ?? null;
        if (!jsTruthy($bound)) continue;
        $value = $record[$field] ?? null;
        if (!jsTruthy($value)) return false;
        // ISO strings compare in UTF-16 code unit order like JS "<" / ">"
        $order = utf16Compare(jsString($value), jsString($bound));
        if (str_ends_with($key, 'From') && $order < 0) return false;
        if (str_ends_with($key, 'To') && $order > 0) return false;
    }
    // Age range (inclusive); unknown ages are excluded once a bound is set
    $ageMin = $query['ageMin'] ?? null;
    $ageMax = $query['ageMax'] ?? null;
    $hasMin = is_int($ageMin) || is_float($ageMin);
    $hasMax = is_int($ageMax) || is_float($ageMax);
    if ($hasMin || $hasMax) {
        $age = $record['ageNumber'] ?? null;
        if ($age === null) return false;
        if ($hasMin && $age < $ageMin) return false;
        if ($hasMax && $age > $ageMax) return false;
    }
    // Flagged-only switch
    if (jsTruthy($query['flagged'] ?? null) && !jsTruthy($record['flagLevel'] ?? null)) return false;
    return true;
}

/**
 * Compare two ISO dates with nulls last; direction 1 = ascending, -1 = descending.
 */
function compareDates(mixed $a, mixed $b, int $direction): int
{
    // Unparsable dates always go to the end
    if (!jsTruthy($a) && !jsTruthy($b)) return 0;
    if (!jsTruthy($a)) return 1;
    if (!jsTruthy($b)) return -1;
    if ($a === $b) return 0;
    return utf16Compare(jsString($a), jsString($b)) < 0 ? -$direction : $direction;
}

/**
 * Compare two row numbers ascending (sign of a.rowNumber - b.rowNumber).
 */
function compareRowNumbers(array $a, array $b): int
{
    return ($a['rowNumber'] ?? 0) <=> ($b['rowNumber'] ?? 0);
}

/**
 * Return a new list sorted by the given order (stable, like Array.prototype.sort).
 * @param array<int, array<string, mixed>> $records
 * @return array<int, array<string, mixed>>
 */
function sortRecords(array $records, mixed $sort): array
{
    // Never mutate the caller's array (PHP arrays are copied on write; re-index for a clean list)
    $copy = array_values($records);
    switch ($sort) {
        case 'visitAsc':
            // Oldest visit first, then sheet order
            usort($copy, static fn(array $a, array $b): int => compareDates($a['visitDateIso'] ?? null, $b['visitDateIso'] ?? null, 1) ?: compareRowNumbers($a, $b));
            return $copy;
        case 'furigana':
            // Normalised reading ascending in UTF-16 code unit order (plain "<", not localeCompare), then sheet order
            usort($copy, static function (array $a, array $b): int {
                $fa = normalizeText($a['furigana'] ?? null);
                $fb = normalizeText($b['furigana'] ?? null);
                if ($fa !== $fb) return utf16Compare($fa, $fb) < 0 ? -1 : 1;
                return compareRowNumbers($a, $b);
            });
            return $copy;
        case 'rowDesc':
            // Most recently appended row first
            usort($copy, static fn(array $a, array $b): int => compareRowNumbers($b, $a));
            return $copy;
        case 'visitDesc':
        default:
            // Newest visit first, then newest row
            usort($copy, static fn(array $a, array $b): int => compareDates($a['visitDateIso'] ?? null, $b['visitDateIso'] ?? null, -1) ?: compareRowNumbers($b, $a));
            return $copy;
    }
}

/**
 * Filter, sort and page records.
 * @param array<int, array<string, mixed>> $records
 * @param array<string, mixed> $query  output of parseQuery
 * @return array{total:int, page:int, pageSize:int, sort:string, items:array<int, array<string, mixed>>}
 */
function searchRecords(array $records, array $query): array
{
    // Fill defaults so raw arrays work too
    $sort = jsTruthy($query['sort'] ?? null) ? $query['sort'] : SORTS[0];
    $page = jsTruthy($query['page'] ?? null) ? $query['page'] : 1;
    $pageSize = jsTruthy($query['pageSize'] ?? null) ? $query['pageSize'] : DEFAULT_PAGE_SIZE;
    // Filter then sort
    $hits = sortRecords(array_values(array_filter(array_values($records), static fn(array $record): bool => matches($record, $query))), $sort);
    // Cut out the requested page
    $start = ((int) $page - 1) * (int) $pageSize;
    return ['total' => count($hits), 'page' => $page, 'pageSize' => $pageSize, 'sort' => $sort, 'items' => jsSlice($hits, $start, $start + (int) $pageSize)];
}

/**
 * Reduce a record to the list fields (Design §4-1). Missing keys are omitted like JS undefined.
 * @return array<string, mixed>
 */
function toSummary(array $record): array
{
    $summary = [];
    // Copy the list fields in the JS key order, skipping keys the record does not have
    foreach (['rowNumber', 'name', 'furigana', 'visitDate', 'kind', 'category', 'age', 'flagLevel', 'managementNumber'] as $key) {
        if (array_key_exists($key, $record)) $summary[$key] = $record[$key];
    }
    // Number of cell links (Design §10-2); ids and URLs stay in the detail only
    $attachments = $record['attachments'] ?? null;
    $summary['attachmentCount'] = is_array($attachments) && array_is_list($attachments) ? count($attachments) : 0;
    return $summary;
}

/**
 * Build the detail payload: all fields except searchText/attachmentFileIds plus sameNumberCount (Design §4-2).
 * "flags" and each attachment are stdClass so json_encode always emits objects.
 * @param array<string, mixed> $record
 * @param array<int, array<string, mixed>> $records  all records, for counting shared management numbers
 * @return array<string, mixed>
 */
function toDetail(array $record, array $records): array
{
    // Drop the internal haystack and the server-only Drive ids (key order of the rest is kept)
    $detail = $record;
    unset($detail['searchText'], $detail['attachmentFileIds']);
    // Count rows sharing the management number (blank numbers count as 0)
    $number = $record['managementNumber'] ?? null;
    $sameNumberCount = 0;
    if (jsTruthy($number)) {
        foreach ($records as $other) {
            if (array_key_exists('managementNumber', $other) && $other['managementNumber'] === $number) $sameNumberCount++;
        }
    }
    // Copy attachments as objects so callers cannot mutate the cached record
    $attachments = [];
    $source = $record['attachments'] ?? null;
    if (is_array($source) && jsTruthy($source)) {
        foreach (array_values($source) as $item) {
            $attachments[] = is_array($item) ? (object) $item : (is_object($item) ? clone $item : new \stdClass());
        }
    }
    // Spread order: existing keys keep their position, new keys are appended
    $flags = $record['flags'] ?? null;
    $detail['flags'] = is_array($flags) || is_object($flags) ? (object) (array) $flags : new \stdClass();
    $detail['attachments'] = $attachments;
    $detail['sameNumberCount'] = $sameNumberCount;
    return $detail;
}

/**
 * Summarise the data set for GET /api/meta (Design §4-3).
 * @param array<int, array<string, mixed>> $records
 * @return array{total:int, flagged:int, kinds:string[], categories:string[], visitDateRange:array{min:?string, max:?string}}
 */
function computeMeta(array $records): array
{
    // Count flagged rows and find the visit date range
    $flagged = 0;
    $min = null;
    $max = null;
    foreach ($records as $record) {
        if (jsTruthy($record['flagLevel'] ?? null)) $flagged += 1;
        $iso = $record['visitDateIso'] ?? null;
        if (jsTruthy($iso) && ($min === null || utf16Compare($iso, $min) < 0)) $min = $iso;
        if (jsTruthy($iso) && ($max === null || utf16Compare($iso, $max) > 0)) $max = $iso;
    }
    return [
        'total' => count($records),
        'flagged' => $flagged,
        'kinds' => KINDS,
        'categories' => CATEGORIES,
        'visitDateRange' => ['min' => $min, 'max' => $max],
    ];
}
