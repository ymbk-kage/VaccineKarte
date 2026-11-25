// WebP delivery variant selection via the Cloudflare Images binding (Design §10-4).
// The transformer is injected so the decision logic stays testable without the binding.
import { MAX_ATTACHMENT_BYTES, ATTACHMENT_TYPES } from "./Attachments.js";

// Source types that may be converted to WebP
export const WEBP_SOURCE_TYPES = ["image/jpeg", "image/png"];
// Encoder quality passed to the Images binding
export const WEBP_QUALITY = 80;
// Give up on the conversion after this long and serve the original
export const WEBP_TIMEOUT_MS = 8000;

/**
 * True when the Accept header explicitly lists image/webp (with a non-zero q).
 * @param {string|null|undefined} acceptHeader
 * @returns {boolean}
 */
export function acceptsWebp(acceptHeader) {
  if (typeof acceptHeader !== "string" || acceptHeader === "") return false;
  // Look at each media range separately
  return acceptHeader.split(",").some((part) => {
    const [type, ...params] = part.split(";").map((piece) => piece.trim().toLowerCase());
    if (type !== "image/webp") return false;
    // q=0 means "not acceptable"
    const q = params.find((param) => param.startsWith("q="));
    return !q || Number(q.slice(2)) > 0;
  });
}

/**
 * Wrap an Images binding as a transformer: bytes -> WebP bytes.
 * @param {any} images  env.IMAGES
 * @returns {((bytes: ArrayBuffer) => Promise<ArrayBuffer>)|null}
 */
export function createImagesTransform(images) {
  // No binding means no conversion (the caller logs binding_missing)
  if (!images || typeof images.input !== "function") return null;
  return async (bytes) => {
    // Feed the buffered original as a stream
    const result = await images.input(new Blob([bytes]).stream()).output({ format: "image/webp", quality: WEBP_QUALITY });
    // The binding only exposes the result as a Response or stream, so read it back into bytes
    return result.response().arrayBuffer();
  };
}

/**
 * Choose between the original image and a smaller WebP variant. Never throws.
 * @param {{bytes: ArrayBuffer, mimeType: string, accept?: string|null,
 *          transform: ((bytes: ArrayBuffer) => Promise<ArrayBuffer>)|null,
 *          log?: (entry: object) => void, timeoutMs?: number}} options
 * @returns {Promise<{body: ArrayBuffer, mimeType: string, ext: string, format: "webp"|"original"}>}
 */
export async function chooseImageVariant({ bytes, mimeType, accept, transform, log = () => {}, timeoutMs = WEBP_TIMEOUT_MS }) {
  // The untouched original response
  const original = { body: bytes, mimeType, ext: ATTACHMENT_TYPES[mimeType] || "bin", format: "original" };
  // Only JPEG/PNG are converted, and only for clients that accept WebP
  if (!WEBP_SOURCE_TYPES.includes(mimeType) || !acceptsWebp(accept)) return original;
  // Fixed-reason log line: never ids, sizes or row numbers
  const skip = (reason) => {
    log({ event: "webp_skipped", reason });
    return original;
  };
  // Images refuses inputs above its limit
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) return skip("over_input_limit");
  // Binding absent (fixture mode or an account without Images)
  if (typeof transform !== "function") return skip("binding_missing");
  let timer = null;
  try {
    // Race the conversion against the timeout
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const outcome = await Promise.race([Promise.resolve().then(() => transform(bytes)), timeout]);
    if (outcome === "timeout") return skip("timeout");
    // Anything that is not a non-empty buffer counts as a failed conversion
    if (!(outcome instanceof ArrayBuffer) || outcome.byteLength === 0) return skip("transform_error");
    // Serve WebP only when it is actually smaller (a larger result is normal and not logged)
    if (outcome.byteLength < bytes.byteLength) return { body: outcome, mimeType: "image/webp", ext: "webp", format: "webp" };
    return original;
  } catch {
    return skip("transform_error");
  } finally {
    // Do not keep the isolate busy with a pending timer
    if (timer !== null) clearTimeout(timer);
  }
}
