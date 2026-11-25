<?php
// Outbound HTTPS calls (Google OAuth, Sheets, Drive) and the tagged error type shared by the I/O layer.
declare(strict_types=1);

namespace VaccinePortal;

// Deadline for every outbound call (same 15 s as the Worker's FETCH_TIMEOUT_MS)
const FETCH_TIMEOUT_SECONDS = 15;
// Media downloads may be up to 20 MB, so they get a longer deadline
const MEDIA_TIMEOUT_SECONDS = 60;

/**
 * Failure tagged with a public error code (never carries response bodies or patient data).
 */
final class UpstreamError extends \RuntimeException
{
    public function __construct(
        public readonly string $errorCode,
        public readonly ?int $httpStatus = null,
        public readonly ?string $googleStatus = null,
        public readonly ?string $detail = null,
    ) {
        parent::__construct($errorCode . ($detail !== null ? ':' . $detail : ''));
    }
}

/**
 * Perform one HTTP request with curl.
 * @param array<int,string> $headers Raw header lines ("Name: value")
 * @return array{status:int,body:string}
 * @throws UpstreamError on network failure or timeout (detail "network")
 */
function httpRequest(string $method, string $url, array $headers = [], ?string $body = null, int $timeout = FETCH_TIMEOUT_SECONDS): array
{
    // Configure a single bounded request with certificate checks left on
    $curl = curl_init($url);
    curl_setopt_array($curl, [
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT => $timeout,
        CURLOPT_ENCODING => '',
    ]);
    // Attach the request body when present
    if ($body !== null) {
        curl_setopt($curl, CURLOPT_POSTFIELDS, $body);
    }
    $response = curl_exec($curl);
    $status = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
    curl_close($curl);
    // A transport failure has no HTTP status at all
    if ($response === false) {
        throw new UpstreamError('sheet_unavailable', null, null, 'network');
    }
    return ['status' => $status, 'body' => (string) $response];
}

/**
 * Perform several GET requests concurrently with curl_multi (same headers and deadline for all).
 * The answers keep the order of $urls.
 * @param array<int,string> $urls
 * @param array<int,string> $headers Raw header lines ("Name: value")
 * @return array<int,array{status:int,body:string}>
 * @throws UpstreamError when any transfer fails at the network level (detail "network")
 */
function httpGetMany(array $urls, array $headers = [], int $timeout = FETCH_TIMEOUT_SECONDS): array
{
    $multi = curl_multi_init();
    $handles = [];
    // One handle per URL with the same options as httpRequest
    foreach (array_values($urls) as $index => $url) {
        $curl = curl_init($url);
        curl_setopt_array($curl, [
            CURLOPT_HTTPGET => true,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_CONNECTTIMEOUT => 10,
            CURLOPT_TIMEOUT => $timeout,
            CURLOPT_ENCODING => '',
        ]);
        curl_multi_add_handle($multi, $curl);
        $handles[$index] = $curl;
    }
    // Drive all transfers until every one has finished (each handle enforces its own timeout)
    do {
        $state = curl_multi_exec($multi, $running);
        if ($running > 0) {
            curl_multi_select($multi, 1.0);
        }
    } while ($running > 0 && $state === CURLM_OK);
    // Collect the answers in request order, then release every handle
    $answers = [];
    $failed = $state !== CURLM_OK;
    foreach ($handles as $index => $curl) {
        if (curl_errno($curl) !== 0) {
            $failed = true;
        }
        $answers[$index] = ['status' => (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE), 'body' => (string) curl_multi_getcontent($curl)];
        curl_multi_remove_handle($multi, $curl);
        curl_close($curl);
    }
    curl_multi_close($multi);
    // A transport failure on any band makes the whole refresh unusable
    if ($failed) {
        throw new UpstreamError('sheet_unavailable', null, null, 'network');
    }
    return $answers;
}
