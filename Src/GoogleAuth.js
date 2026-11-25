// Service-account JWT signing and OAuth token exchange (Design §2-1).

// Read-only scopes (space separated): Sheets for the records, Drive for cell-linked attachments (Design §10-1).
// A leaked key still cannot modify anything, and Drive reach is limited to files shared with the account.
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
].join(" ");
import { createSingleFlight, withTimeout, INFLIGHT_MAX_AGE_MS } from "./SingleFlight.js";

// Google OAuth token endpoint
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
// Refresh this long before the token actually expires
const EXPIRY_MARGIN_MS = 60 * 1000;

/**
 * Encode bytes or text as base64url without padding.
 * @param {Uint8Array|string} input
 * @returns {string}
 */
export function base64UrlEncode(input) {
  // Turn text into UTF-8 bytes first
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  // Switch to the URL-safe alphabet and drop padding
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Convert a PEM private key into DER bytes.
 * @param {string} pem
 * @returns {Uint8Array}
 */
export function pemToDer(pem) {
  // Strip the armour lines and whitespace, then base64-decode
  const body = pem.replace(/-----BEGIN [^-]+-----/, "").replace(/-----END [^-]+-----/, "").replace(/\s+/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Build the JWT claim set signed by the service account (valid for one hour).
 * @param {string} clientEmail
 * @param {number} iat  issued-at in epoch seconds
 * @returns {{iss: string, scope: string, aud: string, iat: number, exp: number}}
 */
export function buildClaims(clientEmail, iat) {
  return { iss: clientEmail, scope: GOOGLE_SCOPES, aud: TOKEN_URL, iat, exp: iat + 3600 };
}

/**
 * Create a cached access-token provider for one service account.
 * @param {{saJson: string, fetchFn?: typeof fetch, now?: () => number, inflightMaxAgeMs?: number}} options
 * @returns {{getToken: () => Promise<string>}}
 */
export function createGoogleTokenProvider({ saJson, fetchFn = (...args) => fetch(...args), now = () => Date.now(), inflightMaxAgeMs = INFLIGHT_MAX_AGE_MS }) {
  // Cached token and its expiry (epoch ms)
  let token = null;
  let expiresAt = 0;
  // Shared in-flight exchange with a lifetime (an orphaned exchange is abandoned, see SingleFlight.js)
  const singleFlight = createSingleFlight({
    now,
    maxAgeMs: inflightMaxAgeMs,
    timeoutError: () => Object.assign(new Error("token exchange timed out"), { code: "sheet_unavailable", detail: "token_timeout" }),
  });

  /**
   * Sign a fresh assertion and exchange it for an access token.
   */
  async function exchange() {
    // Parse the key file lazily so a missing secret fails per request, not at startup
    let account;
    try {
      account = JSON.parse(saJson || "");
    } catch {
      throw Object.assign(new Error("service account json is invalid"), { code: "sheet_unavailable", detail: "sa_json_invalid" });
    }
    if (!account.client_email || !account.private_key) {
      throw Object.assign(new Error("service account json is incomplete"), { code: "sheet_unavailable", detail: "sa_json_incomplete" });
    }
    // Import the PKCS#8 key for RS256 signing
    const key = await crypto.subtle.importKey(
      "pkcs8",
      pemToDer(account.private_key),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    // Build the JWT claim set (valid for one hour)
    const iat = Math.floor(now() / 1000);
    const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = base64UrlEncode(JSON.stringify(buildClaims(account.client_email, iat)));
    // Sign "header.claims"
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claims}`));
    const assertion = `${header}.${claims}.${base64UrlEncode(new Uint8Array(signature))}`;
    // Exchange the assertion for an access token
    // Bounded by a deadline so a stalled exchange fails instead of hanging every waiting request
    const response = await fetchFn(TOKEN_URL, withTimeout({
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    }));
    if (!response.ok) {
      throw Object.assign(new Error("token exchange failed"), { code: "sheet_unavailable", httpStatus: response.status, detail: "token_http" });
    }
    const body = await response.json();
    // Remember the token until shortly before it expires
    token = body.access_token;
    expiresAt = now() + Number(body.expires_in || 3600) * 1000 - EXPIRY_MARGIN_MS;
    return token;
  }

  /**
   * Return a valid access token, exchanging only when needed.
   */
  async function getToken() {
    // Serve the cached token while valid
    if (token && now() < expiresAt) return token;
    // Share one exchange between concurrent callers
    return singleFlight("token", exchange);
  }

  return { getToken };
}
