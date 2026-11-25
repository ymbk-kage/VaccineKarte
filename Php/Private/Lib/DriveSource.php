<?php
// Google Drive file access for the attachment endpoint (PHP port of Src/DriveSource.js, Design §10-3).
// Reads only metadata (mimeType, size) and media; never the file name (no PII is kept).
declare(strict_types=1);

namespace VaccinePortal;

require_once __DIR__ . '/HttpClient.php';

// Drive v3 files endpoint
const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files/';

/**
 * Drive loader authorised by the service account.
 */
final class DriveFileLoader
{
    /**
     * @param callable():string $getToken
     */
    public function __construct(private $getToken)
    {
    }

    /**
     * Fetch the file's mimeType and size.
     * @return array{mimeType:string,size:mixed}
     * @throws UpstreamError
     */
    public function getMeta(string $fileId): array
    {
        $body = json_decode($this->call($fileId, ['fields' => 'mimeType,size', 'supportsAllDrives' => 'true'], FETCH_TIMEOUT_SECONDS), true);
        return ['mimeType' => (string) ($body['mimeType'] ?? ''), 'size' => $body['size'] ?? null];
    }

    /**
     * Download the file content (bounded by MAX_ATTACHMENT_BYTES upstream, so buffering is safe).
     * @throws UpstreamError
     */
    public function openMedia(string $fileId): string
    {
        return $this->call($fileId, ['alt' => 'media', 'supportsAllDrives' => 'true'], MEDIA_TIMEOUT_SECONDS);
    }

    /**
     * Call one Drive URL with the service-account token.
     * 403/404 mean "not shared or gone" (attachment_unavailable); anything else is an upstream outage.
     * @param array<string,string> $params
     * @throws UpstreamError
     */
    private function call(string $fileId, array $params, int $timeout): string
    {
        $token = ($this->getToken)();
        $url = DRIVE_FILES_URL . rawurlencode($fileId) . '?' . http_build_query($params);
        $response = httpRequest('GET', $url, ['Authorization: Bearer ' . $token], null, $timeout);
        if ($response['status'] < 200 || $response['status'] >= 300) {
            // Only the status is kept; the error body is discarded
            $code = in_array($response['status'], [403, 404], true) ? 'attachment_unavailable' : 'sheet_unavailable';
            throw new UpstreamError($code, $response['status']);
        }
        return $response['body'];
    }
}
