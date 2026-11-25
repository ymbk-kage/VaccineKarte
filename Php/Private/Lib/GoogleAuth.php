<?php
// Service-account JWT signing and OAuth token exchange (PHP port of Src/GoogleAuth.js, Design §2-1).
declare(strict_types=1);

namespace VaccinePortal;

require_once __DIR__ . '/HttpClient.php';
require_once __DIR__ . '/SecureCache.php';

// Read-only scopes: Sheets for the records, Drive for cell-linked attachments (a leaked key cannot modify anything)
const GOOGLE_SCOPES = 'https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/drive.readonly';
// Google OAuth token endpoint
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
// Refresh this long before the token actually expires
const TOKEN_EXPIRY_MARGIN_SECONDS = 60;

/**
 * Encode bytes as base64url without padding.
 */
function base64UrlEncode(string $bytes): string
{
    return rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
}

/**
 * Build the JWT claim set signed by the service account (valid for one hour).
 * @return array{iss:string,scope:string,aud:string,iat:int,exp:int}
 */
function buildClaims(string $clientEmail, int $iat): array
{
    return ['iss' => $clientEmail, 'scope' => GOOGLE_SCOPES, 'aud' => TOKEN_URL, 'iat' => $iat, 'exp' => $iat + 3600];
}

/**
 * Cached access-token provider for one service account. The token is kept in the encrypted file cache
 * so concurrent PHP requests share it instead of each signing a new assertion.
 */
final class GoogleTokenProvider
{
    /**
     * @param array{client_email?:string,private_key?:string}|null $account Decoded key file (null when unreadable)
     * @param callable():int $now Clock in epoch seconds (injectable for tests)
     */
    public function __construct(
        private ?array $account,
        private SecureCache $cache,
        private $now = null,
    ) {
        $this->now ??= static fn (): int => time();
    }

    /**
     * Return a valid access token, exchanging only when needed.
     * @throws UpstreamError
     */
    public function getToken(): string
    {
        // Serve the cached token while valid
        $cached = $this->cache->get('Token');
        if (is_array($cached) && ($cached['expiresAt'] ?? 0) > ($this->now)()) {
            return (string) $cached['token'];
        }
        // Only one process exchanges at a time; the others wait and reuse its result
        [$acquired, $token] = $this->cache->withLock('Token', function (): string {
            // Another process may have refreshed while we waited for the lock
            $again = $this->cache->get('Token');
            if (is_array($again) && ($again['expiresAt'] ?? 0) > ($this->now)()) {
                return (string) $again['token'];
            }
            return $this->exchange();
        }, true);
        if (!$acquired) {
            throw new UpstreamError('sheet_unavailable', null, null, 'token_timeout');
        }
        return $token;
    }

    /**
     * Sign a fresh assertion and exchange it for an access token.
     * @throws UpstreamError
     */
    private function exchange(): string
    {
        // The key file must exist and be complete
        if ($this->account === null) {
            throw new UpstreamError('sheet_unavailable', null, null, 'sa_json_invalid');
        }
        if (empty($this->account['client_email']) || empty($this->account['private_key'])) {
            throw new UpstreamError('sheet_unavailable', null, null, 'sa_json_incomplete');
        }
        // Build "header.claims" for RS256
        $iat = ($this->now)();
        $header = base64UrlEncode(json_encode(['alg' => 'RS256', 'typ' => 'JWT']));
        $claims = base64UrlEncode(json_encode(buildClaims($this->account['client_email'], $iat), JSON_UNESCAPED_SLASHES));
        // Sign with the PKCS#8 private key
        $key = openssl_pkey_get_private($this->account['private_key']);
        if ($key === false || !openssl_sign("{$header}.{$claims}", $signature, $key, OPENSSL_ALGO_SHA256)) {
            throw new UpstreamError('sheet_unavailable', null, null, 'sa_key_invalid');
        }
        $assertion = "{$header}.{$claims}." . base64UrlEncode($signature);
        // Exchange the assertion for an access token
        $response = httpRequest('POST', TOKEN_URL, ['Content-Type: application/x-www-form-urlencoded'], http_build_query([
            'grant_type' => 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            'assertion' => $assertion,
        ]));
        if ($response['status'] < 200 || $response['status'] >= 300) {
            throw new UpstreamError('sheet_unavailable', $response['status'], null, 'token_http');
        }
        $body = json_decode($response['body'], true);
        if (!is_array($body) || empty($body['access_token'])) {
            throw new UpstreamError('sheet_unavailable', $response['status'], null, 'token_body');
        }
        // Remember the token until shortly before it expires
        $token = (string) $body['access_token'];
        $expiresAt = ($this->now)() + (int) ($body['expires_in'] ?? 3600) - TOKEN_EXPIRY_MARGIN_SECONDS;
        $this->cache->put('Token', ['token' => $token, 'expiresAt' => $expiresAt]);
        return $token;
    }
}
