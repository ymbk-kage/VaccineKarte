<?php
// Encrypted, lock-protected file cache shared by all PHP requests.
// Replaces the Worker's in-isolate memory: every PHP request is a new process, so the sheet snapshot and the
// access token have to live on disk. They are encrypted (AES-256-GCM) so that patient data is never readable
// even if the Private/.htaccess deny rule were lost.
declare(strict_types=1);

namespace VaccinePortal;

final class SecureCache
{
    /** @var string 32-byte AES key */
    private string $key;

    /**
     * @param string $dir Cache directory (created on demand, never web-readable)
     * @param string $secret Key material (the service-account private key or a fixed dev value)
     */
    public function __construct(private string $dir, string $secret)
    {
        // Derive a dedicated key so the cache key is never the raw secret
        $this->key = hash('sha256', 'vaccine-portal-cache|' . $secret, true);
    }

    /**
     * Read and decrypt one entry; null when missing, corrupt or written with another key.
     */
    public function get(string $name): mixed
    {
        // Missing file = no entry
        $path = $this->path($name);
        $raw = @file_get_contents($path);
        if ($raw === false || strlen($raw) < 28) {
            return null;
        }
        // Layout: 12-byte IV, 16-byte tag, ciphertext
        $iv = substr($raw, 0, 12);
        $tag = substr($raw, 12, 16);
        $plain = openssl_decrypt(substr($raw, 28), 'aes-256-gcm', $this->key, OPENSSL_RAW_DATA, $iv, $tag);
        if ($plain === false) {
            return null;
        }
        // Stored values are PHP-serialized so stdClass ({} in JSON) survives the round trip;
        // only stdClass may be instantiated, never arbitrary classes
        $value = @unserialize($plain, ['allowed_classes' => [\stdClass::class]]);
        return $value === false && $plain !== serialize(false) ? null : $value;
    }

    /**
     * Encrypt and atomically replace one entry.
     */
    public function put(string $name, mixed $value): void
    {
        $this->ensureDir();
        // Fresh IV per write
        $iv = random_bytes(12);
        $tag = '';
        $cipher = openssl_encrypt(
            serialize($value),
            'aes-256-gcm',
            $this->key,
            OPENSSL_RAW_DATA,
            $iv,
            $tag,
        );
        if ($cipher === false) {
            throw new \RuntimeException('cache encryption failed');
        }
        // Write a temp file then rename, so readers never see a half-written entry
        $path = $this->path($name);
        $tmp = $path . '.' . bin2hex(random_bytes(6)) . '.tmp';
        file_put_contents($tmp, $iv . $tag . $cipher, LOCK_EX);
        @chmod($tmp, 0600);
        rename($tmp, $path);
    }

    /**
     * Run $work while holding an exclusive lock named $name.
     * With $wait=false, returns [false, null] immediately when another process holds the lock.
     * With $wait=true, waits up to $timeoutSeconds and returns [false, null] on timeout.
     * @return array{0:bool,1:mixed} [acquired, result]
     */
    public function withLock(string $name, callable $work, bool $wait, float $timeoutSeconds = 20.0): array
    {
        $this->ensureDir();
        // One lock file per name
        $handle = fopen($this->path($name) . '.lock', 'c');
        if ($handle === false) {
            throw new \RuntimeException('cache lock unavailable');
        }
        try {
            // Poll a non-blocking lock so the wait is bounded (flock has no timeout of its own)
            $deadline = microtime(true) + $timeoutSeconds;
            while (!flock($handle, LOCK_EX | LOCK_NB)) {
                if (!$wait || microtime(true) >= $deadline) {
                    return [false, null];
                }
                usleep(100_000);
            }
            try {
                return [true, $work()];
            } finally {
                flock($handle, LOCK_UN);
            }
        } finally {
            fclose($handle);
        }
    }

    /**
     * Create the cache directory with owner-only permissions.
     */
    private function ensureDir(): void
    {
        if (!is_dir($this->dir)) {
            @mkdir($this->dir, 0700, true);
        }
    }

    /**
     * Map an entry name to a file path (names are fixed identifiers, never user input).
     */
    private function path(string $name): string
    {
        return $this->dir . DIRECTORY_SEPARATOR . preg_replace('/[^A-Za-z0-9_-]/', '_', $name) . '.bin';
    }
}
