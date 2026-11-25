<?php
// Replay Golden.json (made by GenerateGolden.mjs) against the PHP port and compare JSON byte for byte.
// Usage: php Php/Tests/Parity/RunParity.php [--max-diffs=N]
// Exit code: 0 = every case matches, 1 = at least one mismatch, 2 = setup error.
declare(strict_types=1);

namespace VaccinePortal\Parity;

use function VaccinePortal\{normalizeText, parseDate, parseAge, parseDriveFileId, classifyLink, extractCellLinks, buildAttachments,
    cellText, validateHeader, classifyColor, worstFlag, mapRows, parseQuery, splitTerms, matches, sortRecords, searchRecords,
    toSummary, toDetail, computeMeta};

// Re-launch with intl/mbstring when the CLI runs without a php.ini (e.g. the WinGet PHP build)
if (!extension_loaded('intl') || !extension_loaded('mbstring')) {
    // Avoid an endless relaunch loop
    if (getenv('VACCINE_PARITY_RELAUNCHED') === '1') {
        fwrite(STDERR, "intl and mbstring extensions are required.\n");
        exit(2);
    }
    // Load the bundled extensions from the PHP installation directory
    $extDir = dirname(PHP_BINARY) . DIRECTORY_SEPARATOR . 'ext';
    $command = escapeshellarg(PHP_BINARY) . ' -d ' . escapeshellarg('extension_dir=' . $extDir)
        . ' -d extension=intl -d extension=mbstring ' . escapeshellarg(__FILE__);
    // Forward the original arguments
    foreach (array_slice($argv, 1) as $arg) $command .= ' ' . escapeshellarg($arg);
    putenv('VACCINE_PARITY_RELAUNCHED=1');
    passthru($command, $exitCode);
    exit($exitCode);
}

// Load the library under test
$libDir = dirname(__DIR__, 2) . '/Private/Lib';
require_once $libDir . '/Normalize.php';
require_once $libDir . '/Attachments.php';
require_once $libDir . '/Records.php';
require_once $libDir . '/Search.php';

// Number of mismatches printed in detail
$maxDiffs = 20;
foreach (array_slice($argv, 1) as $arg) {
    if (preg_match('/^--max-diffs=(\d+)$/D', $arg, $m)) $maxDiffs = (int) $m[1];
}

// Read the golden file twice: associative (the I/O contract) and as objects (exact {} vs [])
$goldenPath = __DIR__ . '/Golden.json';
if (!is_file($goldenPath)) {
    fwrite(STDERR, "Golden.json not found. Run: node Php/Tests/Parity/GenerateGolden.mjs\n");
    exit(2);
}
$raw = (string) file_get_contents($goldenPath);
$golden = json_decode($raw, true, 4096, JSON_THROW_ON_ERROR);
$goldenObjects = json_decode($raw, false, 4096, JSON_THROW_ON_ERROR);
$refs = $golden['refs'];

// The output encoding required by the I/O layer
const JSON_FLAGS = JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES;

/**
 * Encode a PHP result exactly as the I/O layer will.
 */
function encode(mixed $value): string
{
    return json_encode($value, JSON_FLAGS | JSON_THROW_ON_ERROR);
}

/**
 * Replace {"$ref": ...} markers with the shared fixture data.
 */
function resolveArg(mixed $arg, array $refs): mixed
{
    // Only associative arrays can be markers
    if (is_array($arg) && isset($arg['$ref']) && is_string($arg['$ref'])) {
        $base = $refs[$arg['$ref']];
        return array_key_exists('index', $arg) ? $base[$arg['index']] : $base;
    }
    return $arg;
}

/**
 * Run one case and return the PHP result for comparison.
 * @param array<int, mixed> $args  resolved arguments
 */
function runCase(string $fn, array $args): mixed
{
    switch ($fn) {
        case 'constant':
            // Exported constants are compared by value
            return constant('VaccinePortal\\' . $args[0]);
        case 'normalizeText': return normalizeText($args[0]);
        case 'parseDate': return parseDate($args[0]);
        case 'parseAge': return parseAge($args[0]);
        case 'parseDriveFileId': return parseDriveFileId($args[0]);
        case 'classifyLink': return classifyLink($args[0]);
        case 'extractCellLinks': return extractCellLinks($args[0]);
        case 'buildAttachments': return buildAttachments($args[0], $args[1]);
        case 'cellText': return cellText($args[0]);
        case 'validateHeader': return validateHeader($args[0]);
        case 'classifyColor': return classifyColor($args[0]);
        case 'worstFlag': return worstFlag($args[0]);
        case 'mapRows': return mapRows($args[0]);
        case 'parseQuery': return parseQuery($args[0]);
        case 'splitTerms': return splitTerms($args[0]);
        case 'matches': return matches($args[0], $args[1]);
        case 'sortRecords':
            // Compared by the resulting row order
            return array_map(static fn(array $r) => $r['rowNumber'], sortRecords($args[0], $args[1]));
        case 'searchSummary':
            // Full POST /api/search path: parseQuery -> searchRecords -> toSummary
            $result = searchRecords($args[0], parseQuery($args[1]));
            $result['items'] = array_map('VaccinePortal\\toSummary', $result['items']);
            return $result;
        case 'searchRecords':
            // Raw query objects straight into searchRecords
            $result = searchRecords($args[0], $args[1]);
            $result['items'] = array_map('VaccinePortal\\toSummary', $result['items']);
            return $result;
        case 'toSummary': return toSummary($args[0]);
        case 'toDetail': return toDetail($args[0], $args[1]);
        case 'computeMeta': return computeMeta($args[0]);
        case 'pipeline':
            // Grid -> records -> search, keeping the full records (flags objects, private fields)
            return searchRecords(mapRows($args[0]), parseQuery($args[1]));
        default:
            throw new \RuntimeException("Unknown fn: {$fn}");
    }
}

// Per-group statistics and collected mismatches
$stats = [];
$failures = [];

/**
 * Compare one result against the expected JSON and record the outcome.
 */
function check(string $group, int $index, mixed $input, string $expected, callable $produce, array &$stats, array &$failures): void
{
    $stats[$group] ??= ['pass' => 0, 'fail' => 0];
    try {
        // Produce and encode the PHP result
        $actual = encode($produce());
    } catch (\Throwable $e) {
        // Exceptions count as mismatches
        $actual = 'EXCEPTION ' . get_class($e) . ': ' . $e->getMessage() . ' @' . basename($e->getFile()) . ':' . $e->getLine();
    }
    if ($actual === $expected) {
        $stats[$group]['pass']++;
        return;
    }
    $stats[$group]['fail']++;
    $failures[] = ['group' => $group, 'index' => $index, 'input' => $input, 'expected' => $expected, 'actual' => $actual];
}

foreach ($golden['cases'] as $index => $case) {
    $fn = $case['fn'];
    $args = array_map(static fn($arg) => resolveArg($arg, $refs), $case['input']);
    // Inputs with {"0":..} objects are lists after json_decode($x, true); report them, never fail on them
    if ($fn !== 'parseQuery' && !empty($case['assocAmbiguous'])) {
        $stats[$fn] ??= ['pass' => 0, 'fail' => 0];
        $stats[$fn]['ambiguous'] = ($stats[$fn]['ambiguous'] ?? 0) + 1;
        continue;
    }
    // Main comparison with associative decoding (the documented I/O contract)
    if ($fn !== 'parseQuery') {
        check($fn, $index, $case['input'], $case['output'], static fn() => runCase($fn, $args), $stats, $failures);
        continue;
    }
    // parseQuery: exact comparison with object decoding (distinguishes [] from {})
    $objectBody = $goldenObjects->cases[$index]->input[0];
    check('parseQuery', $index, $case['input'], $case['output'], static fn() => parseQuery($objectBody, true), $stats, $failures);
    // parseQuery with associative decoding: identical except a top-level empty JSON array, which reads as {}
    if ((is_array($objectBody) && $objectBody === []) || !empty($case['assocAmbiguous'])) {
        $stats['parseQuery[assoc]']['excluded'] = ($stats['parseQuery[assoc]']['excluded'] ?? 0) + 1;
        continue;
    }
    check('parseQuery[assoc]', $index, $case['input'], $case['output'], static fn() => parseQuery($args[0]), $stats, $failures);
}

// Print the per-group summary
$totalPass = 0;
$totalFail = 0;
echo str_pad('function', 22) . str_pad('pass', 7, ' ', STR_PAD_LEFT) . str_pad('fail', 7, ' ', STR_PAD_LEFT) . "\n";
foreach ($stats as $group => $s) {
    $pass = $s['pass'] ?? 0;
    $fail = $s['fail'] ?? 0;
    $totalPass += $pass;
    $totalFail += $fail;
    // Explain cases that the associative-array contract cannot represent
    $note = isset($s['excluded']) ? "  (excluded {$s['excluded']}: [] / {\"0\":..} bodies are ambiguous after json_decode(\$x, true); checked exactly in object mode)" : '';
    $note .= isset($s['ambiguous']) ? "  (excluded {$s['ambiguous']}: input has a {\"0\":..} object, which json_decode(\$x, true) turns into a list)" : '';
    echo str_pad($group, 22) . str_pad((string) $pass, 7, ' ', STR_PAD_LEFT) . str_pad((string) $fail, 7, ' ', STR_PAD_LEFT) . ($fail > 0 ? '  NG' : '  OK') . $note . "\n";
}
$total = $totalPass + $totalFail;
printf("TOTAL %d/%d passed (%.2f%%)\n", $totalPass, $total, $total > 0 ? 100 * $totalPass / $total : 0);

// Print the first mismatches in detail
foreach (array_slice($failures, 0, $maxDiffs) as $f) {
    echo "\n--- #{$f['index']} {$f['group']}\n";
    echo 'input:    ' . mb_strimwidth(encode($f['input']), 0, 400, '...') . "\n";
    echo 'expected: ' . mb_strimwidth($f['expected'], 0, 600, '...') . "\n";
    echo 'actual:   ' . mb_strimwidth($f['actual'], 0, 600, '...') . "\n";
}
exit($totalFail === 0 ? 0 : 1);
