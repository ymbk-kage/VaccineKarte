<?php
// Header validation, colour classification and row mapping (Design §2-3). PHP port of Src/Records.js. No I/O.
declare(strict_types=1);

namespace VaccinePortal;

require_once __DIR__ . '/JsCompat.php';
require_once __DIR__ . '/Normalize.php';
require_once __DIR__ . '/Attachments.php';

// Expected first 19 headers of the 患者管理 sheet (formerly シート1; must match SheetGateway.HEADERS; 左右 added 2026-10-26)
const HEADERS = ['区分', '管理番号', '種別', '受診日', '氏名', 'ふりがな', '生年月日', '性別', '年齢', '左右', '保護者署名',
    '郵便番号', '住所', '電話番号', '希望ワクチン', '体温', 'LOT No.', '60～64歳の方', '自己負担免除対象者'];

// Record field names in the same order as HEADERS
const FIELDS = ['category', 'managementNumber', 'kind', 'visitDate', 'name', 'furigana', 'birthDate', 'gender',
    'age', 'side', 'guardianName', 'postalCode', 'address', 'phone', 'desiredVaccine', 'temperature', 'lotNumber', 'disability6064',
    'copayExemption'];

// Header of the optional human-maintained 20th column (column T)
const NOTE_HEADER = '備考';

// All 20 columns (19 fixed + 備考) whose cell links become attachments (Design §10-2)
const ATTACHMENT_COLUMNS = [
    ['field' => 'category', 'header' => '区分'],
    ['field' => 'managementNumber', 'header' => '管理番号'],
    ['field' => 'kind', 'header' => '種別'],
    ['field' => 'visitDate', 'header' => '受診日'],
    ['field' => 'name', 'header' => '氏名'],
    ['field' => 'furigana', 'header' => 'ふりがな'],
    ['field' => 'birthDate', 'header' => '生年月日'],
    ['field' => 'gender', 'header' => '性別'],
    ['field' => 'age', 'header' => '年齢'],
    ['field' => 'side', 'header' => '左右'],
    ['field' => 'guardianName', 'header' => '保護者署名'],
    ['field' => 'postalCode', 'header' => '郵便番号'],
    ['field' => 'address', 'header' => '住所'],
    ['field' => 'phone', 'header' => '電話番号'],
    ['field' => 'desiredVaccine', 'header' => '希望ワクチン'],
    ['field' => 'temperature', 'header' => '体温'],
    ['field' => 'lotNumber', 'header' => 'LOT No.'],
    ['field' => 'disability6064', 'header' => '60～64歳の方'],
    ['field' => 'copayExemption', 'header' => '自己負担免除対象者'],
    ['field' => 'note', 'header' => NOTE_HEADER],
];

// Severity order used to pick the worst flag of a row
const FLAG_RANK = ['red' => 3, 'orange' => 2, 'yellow' => 1];

/**
 * Extract the display text of one grid cell ("" when absent).
 */
function cellText(mixed $cell): string
{
    // Absent cells and cells without a value are empty strings
    $value = jsGet($cell, 'formattedValue');
    if ($value === null) return '';
    // Convert like String(value)
    return jsString($value);
}

/**
 * Check that the first row has exactly the expected 19 headers.
 * @param mixed $firstRow  list of header texts (trimmed or untrimmed)
 * @return array{ok:true, hasNote:bool}|array{ok:false, reason:string}
 */
function validateHeader(mixed $firstRow): array
{
    // A missing header row is a layout change
    if (!is_array($firstRow) || !array_is_list($firstRow)) return ['ok' => false, 'reason' => 'header_missing'];
    // Compare each of the 19 cells after trimming
    foreach (HEADERS as $i => $expected) {
        $actual = jsTrim(jsString($firstRow[$i] ?? ''));
        if ($actual !== $expected) return ['ok' => false, 'reason' => 'header_mismatch_at_' . ($i + 1)];
    }
    // The 20th column counts as 備考 only when titled exactly so
    $hasNote = jsTrim(jsString($firstRow[count(HEADERS)] ?? '')) === NOTE_HEADER;
    return ['ok' => true, 'hasNote' => $hasNote];
}

/**
 * Classify a Sheets backgroundColor (0-1 RGB, missing components = 0).
 * @return string|null  "red" | "yellow" | "orange" | null
 */
function classifyColor(mixed $bg): ?string
{
    // No colour information means no flag
    if (!is_array($bg) && !is_object($bg)) return null;
    // The Sheets API omits zero components, so default them to 0
    $r = jsToNumber(jsGet($bg, 'red') ?? 0);
    $g = jsToNumber(jsGet($bg, 'green') ?? 0);
    $b = jsToNumber(jsGet($bg, 'blue') ?? 0);
    // All flags need a strong red channel and a weak blue channel (NaN compares false like JS)
    if ($r < 0.9 || $b > 0.25) return null;
    // Distinguish by the green channel
    if ($g <= 0.25) return 'red';
    if ($g >= 0.9) return 'yellow';
    if ($g >= 0.45 && $g <= 0.75) return 'orange';
    return null;
}

/**
 * Pick the worst flag level among a row's flags (red > orange > yellow).
 * @param array|object $flags  field => level (associative array or stdClass)
 */
function worstFlag(array|object $flags): ?string
{
    // Walk every flag and keep the highest rank
    $worst = null;
    foreach ((array) $flags as $level) {
        // Unknown levels have no rank (JS undefined comparisons are false)
        $levelRank = is_string($level) ? (FLAG_RANK[$level] ?? null) : null;
        $worstRank = is_string($worst) ? (FLAG_RANK[$worst] ?? null) : null;
        if (!jsTruthy($worst) || ($levelRank !== null && $worstRank !== null && $levelRank > $worstRank)) $worst = $level;
    }
    return $worst;
}

/**
 * Map Sheets rowData (header row first) into VaccineRecord associative arrays.
 * Rows whose 19 data cells are all blank are skipped; rowNumber keeps the sheet row.
 * "flags" is a stdClass so json_encode emits {} for an empty set, like JSON.stringify.
 * @param mixed $gridRows  rowData list as decoded with json_decode($body, true)
 * @return array<int, array<string, mixed>>
 */
function mapRows(mixed $gridRows): array
{
    // Nothing to map without rows
    if (!is_array($gridRows) || count($gridRows) === 0) return [];
    $gridRows = array_values($gridRows);
    // Decide whether column 20 is the 備考 column from the header row
    $headerValues = jsGet($gridRows[0], 'values');
    $headerTexts = is_array($headerValues) ? array_map(__NAMESPACE__ . '\\cellText', array_values($headerValues)) : [];
    $hasNote = jsTrim($headerTexts[count(HEADERS)] ?? '') === NOTE_HEADER;
    $records = [];
    // Data rows start at sheet row 2 (index 1)
    for ($index = 1; $index < count($gridRows); $index += 1) {
        $values = jsGet($gridRows[$index], 'values');
        $cells = jsTruthy($values) && is_array($values) ? $values : [];
        $record = ['rowNumber' => $index + 1];
        $flags = [];
        $anyValue = false;
        // Copy the 19 fixed columns and their colour flags
        foreach (FIELDS as $col => $field) {
            $cell = $cells[$col] ?? null;
            $text = jsTrim(cellText($cell));
            $record[$field] = $text;
            if ($text !== '') $anyValue = true;
            $level = classifyColor(jsGet($cell, 'effectiveFormat', 'backgroundColor'));
            if ($level !== null) $flags[$field] = $level;
        }
        // Skip completely blank rows (colour alone does not make a record)
        if (!$anyValue) continue;
        // Take 備考 only when the header says so; its colour is ignored
        $record['note'] = $hasNote ? jsTrim(cellText($cells[count(HEADERS)] ?? null)) : null;
        // Derived values used for range filters and sorting
        $record['visitDateIso'] = parseDate($record['visitDate']);
        $record['birthDateIso'] = parseDate($record['birthDate']);
        $record['ageNumber'] = parseAge($record['age']);
        $record['flags'] = (object) $flags;
        $record['flagLevel'] = worstFlag($flags);
        // Normalised haystack for free-word search (19 columns + note)
        $parts = array_map(static fn(string $field): string => normalizeText($record[$field]), FIELDS);
        $parts[] = normalizeText($record['note']);
        $record['searchText'] = implode('|', $parts);
        // Cell links of all 20 columns (links are never part of searchText)
        $built = buildAttachments($cells, ATTACHMENT_COLUMNS);
        $record['attachments'] = $built['attachments'];
        // Server-only Drive ids aligned with attachments; dropped by toDetail
        $record['attachmentFileIds'] = $built['fileIds'];
        $records[] = $record;
    }
    return $records;
}
