<?php
// WebP delivery variant selection with GD (PHP port of Src/ImageVariant.js, Design §10-4).
// The Worker used the Cloudflare Images binding; the shared host's PHP has GD with WebP support instead.
declare(strict_types=1);

namespace VaccinePortal;

require_once __DIR__ . '/Attachments.php';

// Source types that may be converted to WebP
const WEBP_SOURCE_TYPES = ['image/jpeg', 'image/png'];
// Encoder quality (same as the Worker)
const WEBP_QUALITY = 80;

/**
 * True when the Accept header explicitly lists image/webp (with a non-zero q).
 */
function acceptsWebp(?string $acceptHeader): bool
{
    if ($acceptHeader === null || $acceptHeader === '') {
        return false;
    }
    // Look at each media range separately
    foreach (explode(',', $acceptHeader) as $part) {
        $pieces = array_map(static fn ($piece) => strtolower(trim($piece)), explode(';', $part));
        if ($pieces[0] !== 'image/webp') {
            continue;
        }
        // q=0 means "not acceptable"
        $q = null;
        foreach (array_slice($pieces, 1) as $param) {
            if (str_starts_with($param, 'q=')) {
                $q = $param;
                break;
            }
        }
        if ($q === null || (float) substr($q, 2) > 0) {
            return true;
        }
    }
    return false;
}

/**
 * Convert JPEG/PNG bytes to WebP with GD; null when GD cannot do it.
 */
function gdToWebp(string $bytes): ?string
{
    // GD must be present and built with WebP
    if (!function_exists('imagewebp') || !function_exists('imagecreatefromstring')) {
        return null;
    }
    $image = @imagecreatefromstring($bytes);
    if ($image === false) {
        return null;
    }
    try {
        // Keep PNG transparency: true colour, no blending, save alpha
        if (!imageistruecolor($image)) {
            imagepalettetotruecolor($image);
        }
        imagealphablending($image, false);
        imagesavealpha($image, true);
        // Encode into a buffer
        ob_start();
        $ok = imagewebp($image, null, WEBP_QUALITY);
        $webp = (string) ob_get_clean();
        return $ok && $webp !== '' ? $webp : null;
    } finally {
        imagedestroy($image);
    }
}

/**
 * Choose between the original image and a smaller WebP variant. Never throws.
 * @param callable(string):?string|null $transform Converter (null = conversion disabled, e.g. fixture mode)
 * @param callable(array):void $log
 * @return array{body:string,mimeType:string,ext:string,format:string}
 */
function chooseImageVariant(string $bytes, string $mimeType, ?string $accept, ?callable $transform, callable $log): array
{
    // The untouched original response
    $original = ['body' => $bytes, 'mimeType' => $mimeType, 'ext' => ATTACHMENT_TYPES[$mimeType] ?? 'bin', 'format' => 'original'];
    // Only JPEG/PNG are converted, and only for clients that accept WebP
    if (!in_array($mimeType, WEBP_SOURCE_TYPES, true) || !acceptsWebp($accept)) {
        return $original;
    }
    // Fixed-reason log line: never ids, sizes or row numbers
    $skip = static function (string $reason) use ($log, $original): array {
        $log(['event' => 'webp_skipped', 'reason' => $reason]);
        return $original;
    };
    if (strlen($bytes) > MAX_ATTACHMENT_BYTES) {
        return $skip('over_input_limit');
    }
    if ($transform === null) {
        return $skip('binding_missing');
    }
    try {
        $webp = $transform($bytes);
    } catch (\Throwable) {
        return $skip('transform_error');
    }
    // Anything that is not a non-empty buffer counts as a failed conversion
    if (!is_string($webp) || $webp === '') {
        return $skip('transform_error');
    }
    // Serve WebP only when it is actually smaller
    if (strlen($webp) < strlen($bytes)) {
        return ['body' => $webp, 'mimeType' => 'image/webp', 'ext' => 'webp', 'format' => 'webp'];
    }
    return $original;
}
