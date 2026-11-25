<?php
// Minimal WHATWG URL parser for absolute "https:" URLs, reproducing what `new URL(s)` yields in the Worker
// (href, hostname, pathname, search params). Other schemes are reported as null because the callers
// (Attachments.php) drop every non-https link anyway. Pure functions, no I/O. Requires intl and mbstring.
declare(strict_types=1);

namespace VaccinePortal;

require_once __DIR__ . '/JsCompat.php';

// Extra ASCII characters of each percent-encode set (the C0 control set is always applied on top)
const URL_FRAGMENT_SET = " \"<>`";
const URL_SPECIAL_QUERY_SET = " \"#<>'";
const URL_PATH_SET = " \"#<>?^`{}";
const URL_USERINFO_SET = " \"#<>?^`{}/:;=@[\\]|";
// Default port of the https scheme (omitted from the serialisation)
const URL_HTTPS_DEFAULT_PORT = 443;

/**
 * Parse an absolute https URL. Returns null when the string is not https or fails to parse.
 * @return array{protocol:string, href:string, hostname:string, pathname:string, query:?string}|null
 */
function parseHttpsUrl(string $input): ?array
{
    // Strip leading/trailing C0 controls and spaces, then remove every ASCII tab or newline
    $input = preg_replace('/^[\x00-\x20]+|[\x00-\x20]+$/D', '', $input) ?? $input;
    $input = str_replace(["\t", "\n", "\r"], '', $input);
    // Read the scheme; without one an absolute URL cannot be parsed (there is no base)
    if (!preg_match('/^([A-Za-z][A-Za-z0-9+\-.]*):/', $input, $schemeMatch)) return null;
    // Only https matters to the callers
    if (strtolower($schemeMatch[1]) !== 'https') return null;
    // Split the rest into code points
    $chars = preg_split('//u', substr($input, strlen($schemeMatch[0])), -1, PREG_SPLIT_NO_EMPTY);
    if ($chars === false) return null;
    $count = count($chars);
    $pointer = 0;
    // Special authority (ignore) slashes: skip any run of "/" and "\"
    while ($pointer < $count && ($chars[$pointer] === '/' || $chars[$pointer] === '\\')) $pointer++;
    // Authority: everything up to "/", "\", "?", "#" or the end
    $authorityStart = $pointer;
    while ($pointer < $count && !in_array($chars[$pointer], ['/', '\\', '?', '#'], true)) $pointer++;
    $authority = array_slice($chars, $authorityStart, $pointer - $authorityStart);
    // The last "@" separates credentials from host:port
    $lastAt = array_search('@', array_reverse($authority, true), true);
    $username = '';
    $password = '';
    if ($lastAt !== false) {
        // Credentials before the last "@"; the first ":" splits username and password
        $credentials = array_slice($authority, 0, $lastAt);
        $passwordSeen = false;
        foreach ($credentials as $ch) {
            // The first ":" is the separator, later ones are encoded
            if ($ch === ':' && !$passwordSeen) {
                $passwordSeen = true;
                continue;
            }
            // Encode with the userinfo set ("@" becomes %40)
            if ($passwordSeen) $password .= percentEncodeChar($ch, URL_USERINFO_SET);
            else $username .= percentEncodeChar($ch, URL_USERINFO_SET);
        }
        // Host and port follow the last "@"
        $authority = array_slice($authority, $lastAt + 1);
        // "@" without a host is a failure
        if (count($authority) === 0) return null;
    }
    // Host state: the first ":" outside brackets starts the port
    $hostBuffer = '';
    $portBuffer = null;
    $insideBrackets = false;
    foreach ($authority as $index => $ch) {
        if ($ch === ':' && !$insideBrackets) {
            // Everything after the colon is the port text
            $portBuffer = implode('', array_slice($authority, $index + 1));
            break;
        }
        // Track IPv6 brackets so their colons are not port separators
        if ($ch === '[') $insideBrackets = true;
        if ($ch === ']') $insideBrackets = false;
        $hostBuffer .= $ch;
    }
    // Special URLs require a non-empty host
    if ($hostBuffer === '') return null;
    $host = parseUrlHost($hostBuffer);
    if ($host === null) return null;
    // Port: ASCII digits only, at most 65535, default port omitted
    $port = null;
    if ($portBuffer !== null && $portBuffer !== '') {
        // A non-digit in the port is a failure
        if (!preg_match('/^[0-9]+$/D', $portBuffer)) return null;
        // Drop leading zeros and reject values above 65535
        $digits = ltrim($portBuffer, '0');
        if (strlen($digits) > 5 || (int) $digits > 65535) return null;
        $port = (int) $digits === URL_HTTPS_DEFAULT_PORT ? null : (int) $digits;
    }
    // Path start state: consume one leading "/" or "\"
    if ($pointer < $count && ($chars[$pointer] === '/' || $chars[$pointer] === '\\')) $pointer++;
    // Path state: collect segments, resolving "." and ".." (including percent-encoded dots)
    $path = [];
    $buffer = '';
    $query = null;
    $fragment = null;
    while (true) {
        $ch = $pointer < $count ? $chars[$pointer] : null;
        // A segment ends at EOF, "/", "\", "?" or "#"
        if ($ch === null || $ch === '/' || $ch === '\\' || $ch === '?' || $ch === '#') {
            $isSlash = $ch === '/' || $ch === '\\';
            $lower = strtolower($buffer);
            if (in_array($lower, ['..', '.%2e', '%2e.', '%2e%2e'], true)) {
                // Double-dot removes the last segment; at the end it leaves an empty segment
                array_pop($path);
                if (!$isSlash) $path[] = '';
            } elseif (in_array($lower, ['.', '%2e'], true)) {
                // Single-dot is dropped; at the end it leaves an empty segment
                if (!$isSlash) $path[] = '';
            } else {
                // Ordinary segment
                $path[] = $buffer;
            }
            $buffer = '';
            // Continue in the query or fragment state, or finish
            if ($ch === '?' || $ch === '#' || $ch === null) break;
            $pointer++;
            continue;
        }
        // Encode the code point with the path percent-encode set
        $buffer .= percentEncodeChar($ch, URL_PATH_SET);
        $pointer++;
    }
    // Query state: everything up to "#", encoded with the special-query set
    if ($pointer < $count && $chars[$pointer] === '?') {
        $pointer++;
        $query = '';
        while ($pointer < $count && $chars[$pointer] !== '#') {
            $query .= percentEncodeChar($chars[$pointer], URL_SPECIAL_QUERY_SET);
            $pointer++;
        }
    }
    // Fragment state: the rest, encoded with the fragment set
    if ($pointer < $count && $chars[$pointer] === '#') {
        $pointer++;
        $fragment = '';
        while ($pointer < $count) {
            $fragment .= percentEncodeChar($chars[$pointer], URL_FRAGMENT_SET);
            $pointer++;
        }
    }
    // Serialise the path ("/" before every segment)
    $pathname = '';
    foreach ($path as $segment) $pathname .= '/' . $segment;
    // Serialise credentials only when present
    $userinfo = '';
    if ($username !== '' || $password !== '') {
        $userinfo = $username . ($password !== '' ? ':' . $password : '') . '@';
    }
    // Assemble href exactly like the URL serializer
    $href = 'https://' . $userinfo . $host . ($port !== null ? ':' . $port : '') . $pathname
        . ($query !== null ? '?' . $query : '') . ($fragment !== null ? '#' . $fragment : '');
    return ['protocol' => 'https:', 'href' => $href, 'hostname' => $host, 'pathname' => $pathname, 'query' => $query];
}

/**
 * UTF-8 percent-encode one code point if it is in the C0 control set or the given extra set.
 */
function percentEncodeChar(string $ch, string $extraSet): string
{
    // Printable ASCII outside the extra set stays as is
    if (strlen($ch) === 1) {
        $byte = ord($ch);
        if ($byte >= 0x20 && $byte <= 0x7E && !str_contains($extraSet, $ch)) return $ch;
    }
    // Everything else becomes %XX per UTF-8 byte (upper-case hex)
    $out = '';
    foreach (str_split($ch) as $b) $out .= sprintf('%%%02X', ord($b));
    return $out;
}

/**
 * Percent-decode a string into raw bytes ("%" not followed by two hex digits stays literal).
 */
function percentDecode(string $s): string
{
    // Replace each valid %XX with its byte
    return preg_replace_callback('/%([0-9A-Fa-f]{2})/', static fn(array $m): string => chr((int) hexdec($m[1])), $s) ?? $s;
}

/**
 * UTF-8 decode bytes, replacing invalid sequences with U+FFFD.
 */
function utf8DecodeLossy(string $bytes): string
{
    // Valid input needs no work
    if (mb_check_encoding($bytes, 'UTF-8')) return $bytes;
    // Substitute invalid sequences with the replacement character
    $previous = mb_substitute_character();
    mb_substitute_character(0xFFFD);
    $result = mb_convert_encoding($bytes, 'UTF-8', 'UTF-8');
    mb_substitute_character($previous);
    return $result;
}

/**
 * Host parser for special URLs (IPv6, domain to ASCII, IPv4). Returns the serialised host or null.
 */
function parseUrlHost(string $input): ?string
{
    // Bracketed input is an IPv6 address
    if (str_starts_with($input, '[')) {
        if (!str_ends_with($input, ']')) return null;
        $pieces = parseIpv6(substr($input, 1, -1));
        return $pieces === null ? null : '[' . serializeIpv6($pieces) . ']';
    }
    // Percent-decode and UTF-8 decode the domain
    $domain = utf8DecodeLossy(percentDecode($input));
    // Map to ASCII (UTS #46, non-transitional, no STD3 rules, no DNS length checks)
    $ascii = domainToAscii($domain);
    if ($ascii === null) return null;
    // Forbidden domain code points are a failure
    if (preg_match('/[\x00-\x20#%\/:<>?@\[\\\\\]^|\x7F]/', $ascii)) return null;
    // A trailing numeric label means the whole host must be an IPv4 address
    if (endsInNumber($ascii)) return parseIpv4($ascii);
    return $ascii;
}

/**
 * Domain to ASCII with beStrict = false.
 */
function domainToAscii(string $domain): ?string
{
    // ASCII-only domains without "xn--" labels only need lower-casing
    $hasAceLabel = false;
    foreach (explode('.', $domain) as $label) {
        if (stripos($label, 'xn--') === 0) $hasAceLabel = true;
    }
    if (!preg_match('/[\x80-\xFF]/', $domain) && !$hasAceLabel) {
        $result = strtolower($domain);
    } else {
        // Run UTS #46 ToASCII through ICU
        $info = [];
        $flags = IDNA_NONTRANSITIONAL_TO_ASCII | IDNA_CHECK_BIDI | IDNA_CHECK_CONTEXTJ;
        idn_to_ascii($domain, $flags, INTL_IDNA_VARIANT_UTS46, $info);
        // ICU returns the mapped result together with an error bit set
        if (!isset($info['result']) || !is_string($info['result'])) return null;
        // Hyphen and DNS-length errors are ignored (CheckHyphens = false, VerifyDnsLength = false)
        $ignored = IDNA_ERROR_EMPTY_LABEL | IDNA_ERROR_LABEL_TOO_LONG | IDNA_ERROR_DOMAIN_NAME_TOO_LONG
            | IDNA_ERROR_LEADING_HYPHEN | IDNA_ERROR_TRAILING_HYPHEN | IDNA_ERROR_HYPHEN_3_4;
        if ((($info['errors'] ?? 0) & ~$ignored) !== 0) return null;
        $result = $info['result'];
    }
    // An empty result is a failure
    return $result === '' ? null : $result;
}

/**
 * The "ends in a number" checker of the host parser.
 */
function endsInNumber(string $host): bool
{
    // Split on dots, ignoring one trailing empty label
    $parts = explode('.', $host);
    if (end($parts) === '') {
        if (count($parts) === 1) return false;
        array_pop($parts);
    }
    $last = (string) end($parts);
    // All-digit labels and valid IPv4 numbers (e.g. 0x1f) count as numbers
    if ($last !== '' && preg_match('/^[0-9]+$/D', $last)) return true;
    return parseIpv4Number($last) !== null;
}

/**
 * Parse one IPv4 part (decimal, 0x hex or 0-prefixed octal). Values above 2^40 are capped.
 */
function parseIpv4Number(string $input): ?int
{
    // Empty input is a failure
    if ($input === '') return null;
    // Detect the radix from the prefix
    $radix = 10;
    if (strlen($input) >= 2 && ($input[0] === '0') && ($input[1] === 'x' || $input[1] === 'X')) {
        $input = substr($input, 2);
        $radix = 16;
    } elseif (strlen($input) >= 2 && $input[0] === '0') {
        $input = substr($input, 1);
        $radix = 8;
    }
    // A bare prefix means zero
    if ($input === '') return 0;
    // Every character must be a digit of the radix
    $pattern = ['10' => '/^[0-9]+$/D', '16' => '/^[0-9A-Fa-f]+$/D', '8' => '/^[0-7]+$/D'][(string) $radix];
    if (!preg_match($pattern, $input)) return null;
    // Accumulate with a cap so huge values cannot overflow
    $value = 0;
    foreach (str_split($input) as $digit) {
        $value = min($value * $radix + (int) hexdec($digit), 1 << 40);
    }
    return $value;
}

/**
 * Parse a host that ends in a number as IPv4 and serialise it (dotted quad), or null.
 */
function parseIpv4(string $input): ?string
{
    // Split into parts, dropping one trailing empty part
    $parts = explode('.', $input);
    if (end($parts) === '' && count($parts) > 1) array_pop($parts);
    // At most four parts
    if (count($parts) > 4) return null;
    // Every part must be a number
    $numbers = [];
    foreach ($parts as $part) {
        $number = parseIpv4Number($part);
        if ($number === null) return null;
        $numbers[] = $number;
    }
    // All but the last part must fit in a byte; the last fills the remaining bytes
    $n = count($numbers);
    for ($i = 0; $i < $n - 1; $i++) {
        if ($numbers[$i] > 255) return null;
    }
    if ($numbers[$n - 1] >= 256 ** (5 - $n)) return null;
    // Combine into one 32-bit value
    $ipv4 = $numbers[$n - 1];
    for ($i = 0; $i < $n - 1; $i++) $ipv4 += $numbers[$i] * (256 ** (3 - $i));
    // Serialise as four decimal bytes
    return implode('.', [($ipv4 >> 24) & 255, ($ipv4 >> 16) & 255, ($ipv4 >> 8) & 255, $ipv4 & 255]);
}

/**
 * IPv6 parser of the URL standard. Returns eight 16-bit pieces or null.
 * @return int[]|null
 */
function parseIpv6(string $input): ?array
{
    $address = array_fill(0, 8, 0);
    $pieceIndex = 0;
    $compress = null;
    $pointer = 0;
    $length = strlen($input);
    // Current character or null at the end
    $c = static fn(int $p): ?string => $p < $length ? $input[$p] : null;
    // A leading "::" starts compressed
    if ($c($pointer) === ':') {
        if ($c($pointer + 1) !== ':') return null;
        $pointer += 2;
        $pieceIndex++;
        $compress = $pieceIndex;
    }
    while ($c($pointer) !== null) {
        // Too many pieces
        if ($pieceIndex === 8) return null;
        // "::" marks the compressed run (only once)
        if ($c($pointer) === ':') {
            if ($compress !== null) return null;
            $pointer++;
            $pieceIndex++;
            $compress = $pieceIndex;
            continue;
        }
        // Read up to four hex digits
        $value = 0;
        $digits = 0;
        while ($digits < 4 && $c($pointer) !== null && ctype_xdigit((string) $c($pointer))) {
            $value = $value * 16 + (int) hexdec((string) $c($pointer));
            $pointer++;
            $digits++;
        }
        if ($c($pointer) === '.') {
            // Embedded IPv4 in the last 32 bits
            if ($digits === 0) return null;
            $pointer -= $digits;
            if ($pieceIndex > 6) return null;
            $numbersSeen = 0;
            while ($c($pointer) !== null) {
                $ipv4Piece = null;
                // Parts after the first must follow a dot
                if ($numbersSeen > 0) {
                    if ($c($pointer) === '.' && $numbersSeen < 4) $pointer++;
                    else return null;
                }
                // Each part needs at least one digit
                if ($c($pointer) === null || !ctype_digit((string) $c($pointer))) return null;
                while ($c($pointer) !== null && ctype_digit((string) $c($pointer))) {
                    $number = (int) $c($pointer);
                    // No leading zeros, no value above 255
                    if ($ipv4Piece === null) $ipv4Piece = $number;
                    elseif ($ipv4Piece === 0) return null;
                    else $ipv4Piece = $ipv4Piece * 10 + $number;
                    if ($ipv4Piece > 255) return null;
                    $pointer++;
                }
                $address[$pieceIndex] = $address[$pieceIndex] * 0x100 + $ipv4Piece;
                $numbersSeen++;
                if ($numbersSeen === 2 || $numbersSeen === 4) $pieceIndex++;
            }
            if ($numbersSeen !== 4) return null;
            break;
        } elseif ($c($pointer) === ':') {
            // A single colon must be followed by more input
            $pointer++;
            if ($c($pointer) === null) return null;
        } elseif ($c($pointer) !== null) {
            // Any other character is invalid
            return null;
        }
        $address[$pieceIndex] = $value;
        $pieceIndex++;
    }
    if ($compress !== null) {
        // Move the pieces after "::" to the end
        $swaps = $pieceIndex - $compress;
        $pieceIndex = 7;
        while ($pieceIndex !== 0 && $swaps > 0) {
            $tmp = $address[$pieceIndex];
            $address[$pieceIndex] = $address[$compress + $swaps - 1];
            $address[$compress + $swaps - 1] = $tmp;
            $pieceIndex--;
            $swaps--;
        }
    } elseif ($pieceIndex !== 8) {
        // Without compression all eight pieces are required
        return null;
    }
    return $address;
}

/**
 * Serialise eight IPv6 pieces, compressing the first longest run of two or more zeros.
 * @param int[] $pieces
 */
function serializeIpv6(array $pieces): string
{
    // Find the first longest zero run
    $bestStart = null;
    $bestLength = 1;
    for ($i = 0; $i < 8; $i++) {
        if ($pieces[$i] !== 0) continue;
        $j = $i;
        while ($j < 8 && $pieces[$j] === 0) $j++;
        if ($j - $i > $bestLength) {
            $bestStart = $i;
            $bestLength = $j - $i;
        }
        $i = $j;
    }
    // Emit lower-case hex pieces with "::" for the compressed run
    $output = '';
    $ignoreZero = false;
    for ($i = 0; $i < 8; $i++) {
        if ($ignoreZero && $pieces[$i] === 0) continue;
        $ignoreZero = false;
        if ($bestStart === $i) {
            $output .= $i === 0 ? '::' : ':';
            $ignoreZero = true;
            continue;
        }
        $output .= dechex($pieces[$i]);
        if ($i !== 7) $output .= ':';
    }
    return $output;
}

/**
 * URLSearchParams(query).get(name): application/x-www-form-urlencoded lookup of the first value.
 */
function urlSearchParamGet(?string $query, string $name): ?string
{
    // No query means no parameters
    if ($query === null || $query === '') return null;
    foreach (explode('&', $query) as $sequence) {
        // Skip empty sequences
        if ($sequence === '') continue;
        // Split at the first "=" (a missing "=" means an empty value)
        $eq = strpos($sequence, '=');
        $rawName = $eq === false ? $sequence : substr($sequence, 0, $eq);
        $rawValue = $eq === false ? '' : substr($sequence, $eq + 1);
        // "+" is a space, then percent-decode and UTF-8 decode
        $decodedName = utf8DecodeLossy(percentDecode(str_replace('+', ' ', $rawName)));
        if ($decodedName === $name) return utf8DecodeLossy(percentDecode(str_replace('+', ' ', $rawValue)));
    }
    return null;
}
