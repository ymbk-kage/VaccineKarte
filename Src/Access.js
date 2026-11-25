// Cloudflare Access JWT verification (Design §1-2(2)). JWKS fetch is injected for tests.

import { createSingleFlight, withTimeout } from "./SingleFlight.js";

// JWKS cache lifetime and clock skew tolerance
export const JWKS_TTL_MS = 60 * 60 * 1000;
export const CLOCK_SKEW_SECONDS = 60;
// Minimum gap between forced JWKS refreshes triggered by unknown key ids
export const FORCED_REFRESH_COOLDOWN_MS = 30 * 1000;

/**
 * Decode base64url text into bytes.
 * @param {string} text
 * @returns {Uint8Array}
 */
export function base64UrlToBytes(text) {
  // Restore the standard alphabet and padding
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  const binary = atob(base64);
  // Copy each char code into a byte array
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Decode a base64url JSON segment.
 * @param {string} segment
 * @returns {any}
 */
function decodeJsonSegment(segment) {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)));
}

/**
 * Create a verifier holding its own JWKS cache.
 * @param {{fetchFn?: typeof fetch, now?: () => number}} [deps]
 * @returns {{verify: (request: Request, env: object) => Promise<{ok:true,email:string}|{ok:false,code:string}>}}
 */
export function createAccessVerifier({ fetchFn = (...args) => fetch(...args), now = () => Date.now() } = {}) {
  // Cached key set: {teamDomain, keys: Map<kid, CryptoKey>, fetchedAt}
  let cache = null;
  // Shared in-flight JWKS request with a lifetime (an orphaned download is abandoned, see SingleFlight.js)
  const singleFlight = createSingleFlight({ now, timeoutError: () => new Error("jwks_timeout") });
  // Time of the last forced refresh
  let lastForcedAt = -Infinity;

  /**
   * Download and import the team's signing keys.
   */
  async function loadKeys(teamDomain) {
    // Reuse an in-flight download for the same team
    return singleFlight(teamDomain, async () => {
      // Fetch the public certificates published by Access (bounded by a deadline)
      const response = await fetchFn(`https://${teamDomain}/cdn-cgi/access/certs`, withTimeout());
      if (!response.ok) throw new Error(`jwks_http_${response.status}`);
      const body = await response.json();
      const keys = new Map();
      // Import each RSA key that has a key id
      for (const jwk of body.keys || []) {
        if (!jwk.kid || jwk.kty !== "RSA") continue;
        const key = await crypto.subtle.importKey(
          "jwk",
          { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["verify"],
        );
        keys.set(jwk.kid, key);
      }
      // Store the fresh key set
      cache = { teamDomain, keys, fetchedAt: now() };
      return cache;
    });
  }

  /**
   * Find the key for a kid, refreshing the JWKS once if it is unknown.
   */
  async function findKey(teamDomain, kid) {
    // Load or refresh an expired/foreign cache
    if (!cache || cache.teamDomain !== teamDomain || now() - cache.fetchedAt >= JWKS_TTL_MS) {
      await loadKeys(teamDomain);
    }
    let key = cache.keys.get(kid);
    // Unknown kid: refetch once (keys may have rotated), rate-limited
    if (!key && now() - lastForcedAt >= FORCED_REFRESH_COOLDOWN_MS) {
      lastForcedAt = now();
      await loadKeys(teamDomain);
      key = cache.keys.get(kid);
    }
    return key || null;
  }

  /**
   * Verify the Cf-Access-Jwt-Assertion header of a request.
   */
  async function verify(request, env) {
    const teamDomain = env.ACCESS_TEAM_DOMAIN;
    const audience = env.ACCESS_AUD;
    // Only the header proves the request passed through Access (cookie is ignored)
    const token = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!token) return { ok: false, code: "unauthorized" };
    const parts = token.split(".");
    if (parts.length !== 3) return { ok: false, code: "unauthorized" };
    let header;
    let payload;
    try {
      // Decode the header and claims
      header = decodeJsonSegment(parts[0]);
      payload = decodeJsonSegment(parts[1]);
    } catch {
      return { ok: false, code: "unauthorized" };
    }
    // Only RS256 tokens with a key id are accepted
    if (header.alg !== "RS256" || typeof header.kid !== "string") return { ok: false, code: "unauthorized" };
    let key;
    try {
      // Resolve the signing key (JWKS failure means fail-closed)
      key = await findKey(teamDomain, header.kid);
    } catch {
      return { ok: false, code: "unauthorized" };
    }
    if (!key) return { ok: false, code: "unauthorized" };
    // Check the signature over "header.payload"
    let valid = false;
    try {
      const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
      valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64UrlToBytes(parts[2]), data);
    } catch {
      valid = false;
    }
    if (!valid) return { ok: false, code: "unauthorized" };
    // Issuer must be this team
    if (payload.iss !== `https://${teamDomain}`) return { ok: false, code: "unauthorized" };
    // Audience (string or array) must include this application
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(audience)) return { ok: false, code: "unauthorized" };
    // Time claims with 60 s tolerance on nbf/iat
    const seconds = Math.floor(now() / 1000);
    if (typeof payload.exp !== "number" || payload.exp <= seconds) return { ok: false, code: "unauthorized" };
    if (typeof payload.nbf === "number" && payload.nbf > seconds + CLOCK_SKEW_SECONDS) return { ok: false, code: "unauthorized" };
    if (typeof payload.iat === "number" && payload.iat > seconds + CLOCK_SKEW_SECONDS) return { ok: false, code: "unauthorized" };
    // The user identity comes from the signed email claim only
    if (typeof payload.email !== "string" || payload.email === "") return { ok: false, code: "forbidden" };
    return { ok: true, email: payload.email };
  }

  return { verify };
}
