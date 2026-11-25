// Unit tests for Src/Access.js with an RSA key generated in-test (Design §1-2(2))
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAccessVerifier, JWKS_TTL_MS } from "../../Src/Access.js";
import { base64UrlEncode } from "../../Src/GoogleAuth.js";

// Access settings used by every test
const TEAM = "unit-test.cloudflareaccess.com";
const AUD = "aud-tag-123";
const ENV = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };
// Fixed clock (seconds)
const NOW_MS = 1_800_000_000_000;
const NOW_S = NOW_MS / 1000;

// Generate an RSA signing key pair and its public JWK
async function makeKey(kid) {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { kid, privateKey: pair.privateKey, jwk: { kid, kty: "RSA", alg: "RS256", use: "sig", n: jwk.n, e: jwk.e } };
}

// Sign a JWT with the given key and claims
async function sign(key, claims, headerOverrides = {}) {
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", kid: key.kid, typ: "JWT", ...headerOverrides }));
  const payload = base64UrlEncode(JSON.stringify(claims));
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

// Standard valid claims
function claims(overrides = {}) {
  return { iss: `https://${TEAM}`, aud: [AUD], email: "staff@example.com", iat: NOW_S - 10, nbf: NOW_S - 10, exp: NOW_S + 3600, ...overrides };
}

// Build a request carrying the assertion header
function request(token) {
  const headers = token ? { "Cf-Access-Jwt-Assertion": token } : {};
  return new Request("https://vaccine.example.org/api/me", { headers });
}

// Fake JWKS endpoint returning successive key sets and counting calls
function jwksFetch(keySets) {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(String(url));
    const keys = keySets[Math.min(calls.length - 1, keySets.length - 1)];
    if (keys === "fail") return new Response("down", { status: 500 });
    return new Response(JSON.stringify({ keys: keys.map((k) => k.jwk) }), { status: 200 });
  };
  return { fetchFn, calls };
}

// Shared keys (generated once)
const keyA = await makeKey("kid-a");
const keyB = await makeKey("kid-b");

test("valid token is accepted and email comes from the claim", async () => {
  const { fetchFn, calls } = jwksFetch([[keyA]]);
  const verifier = createAccessVerifier({ fetchFn, now: () => NOW_MS });
  const result = await verifier.verify(request(await sign(keyA, claims())), ENV);
  assert.deepEqual(result, { ok: true, email: "staff@example.com" });
  assert.deepEqual(calls, [`https://${TEAM}/cdn-cgi/access/certs`]);
});

test("aud as a plain string is accepted", async () => {
  const { fetchFn } = jwksFetch([[keyA]]);
  const verifier = createAccessVerifier({ fetchFn, now: () => NOW_MS });
  const result = await verifier.verify(request(await sign(keyA, claims({ aud: AUD }))), ENV);
  assert.equal(result.ok, true);
});

test("aud mismatch is rejected", async () => {
  const { fetchFn } = jwksFetch([[keyA]]);
  const verifier = createAccessVerifier({ fetchFn, now: () => NOW_MS });
  const result = await verifier.verify(request(await sign(keyA, claims({ aud: ["other"] }))), ENV);
  assert.deepEqual(result, { ok: false, code: "unauthorized" });
});

test("expired token is rejected", async () => {
  const { fetchFn } = jwksFetch([[keyA]]);
  const verifier = createAccessVerifier({ fetchFn, now: () => NOW_MS });
  const result = await verifier.verify(request(await sign(keyA, claims({ exp: NOW_S }))), ENV);
  assert.equal(result.ok, false);
});

test("nbf/iat within 60 s skew pass, beyond fail", async () => {
  const { fetchFn } = jwksFetch([[keyA]]);
  const verifier = createAccessVerifier({ fetchFn, now: () => NOW_MS });
  assert.equal((await verifier.verify(request(await sign(keyA, claims({ nbf: NOW_S + 60, iat: NOW_S + 60 }))), ENV)).ok, true);
  assert.equal((await verifier.verify(request(await sign(keyA, claims({ nbf: NOW_S + 61 }))), ENV)).ok, false);
  assert.equal((await verifier.verify(request(await sign(keyA, claims({ iat: NOW_S + 61 }))), ENV)).ok, false);
});

test("issuer mismatch is rejected", async () => {
  const { fetchFn } = jwksFetch([[keyA]]);
  const verifier = createAccessVerifier({ fetchFn, now: () => NOW_MS });
  const result = await verifier.verify(request(await sign(keyA, claims({ iss: "https://evil.cloudflareaccess.com" }))), ENV);
  assert.equal(result.ok, false);
});

test("bad signature is rejected", async () => {
  const { fetchFn } = jwksFetch([[keyA]]);
  const verifier = createAccessVerifier({ fetchFn, now: () => NOW_MS });
  // Signed with key B but claims kid-a
  const forged = await sign({ ...keyB, kid: "kid-a" }, claims());
  assert.equal((await verifier.verify(request(forged), ENV)).ok, false);
  // Tampered payload
  const good = await sign(keyA, claims());
  const [h, , s] = good.split(".");
  const tampered = `${h}.${base64UrlEncode(JSON.stringify(claims({ email: "evil@example.com" })))}.${s}`;
  assert.equal((await verifier.verify(request(tampered), ENV)).ok, false);
});

test("non-RS256 alg and malformed tokens are rejected", async () => {
  const { fetchFn } = jwksFetch([[keyA]]);
  const verifier = createAccessVerifier({ fetchFn, now: () => NOW_MS });
  assert.equal((await verifier.verify(request(await sign(keyA, claims(), { alg: "HS256" })), ENV)).ok, false);
  assert.equal((await verifier.verify(request(await sign(keyA, claims(), { alg: "none" })), ENV)).ok, false);
  assert.equal((await verifier.verify(request("abc.def"), ENV)).ok, false);
  assert.equal((await verifier.verify(request("!!!.???.###"), ENV)).ok, false);
});

test("missing header is rejected (cookie is ignored)", async () => {
  const { fetchFn, calls } = jwksFetch([[keyA]]);
  const verifier = createAccessVerifier({ fetchFn, now: () => NOW_MS });
  const token = await sign(keyA, claims());
  const withCookie = new Request("https://vaccine.example.org/", { headers: { Cookie: `CF_Authorization=${token}` } });
  assert.deepEqual(await verifier.verify(withCookie, ENV), { ok: false, code: "unauthorized" });
  assert.equal(calls.length, 0);
});

test("missing email claim is forbidden", async () => {
  const { fetchFn } = jwksFetch([[keyA]]);
  const verifier = createAccessVerifier({ fetchFn, now: () => NOW_MS });
  const result = await verifier.verify(request(await sign(keyA, claims({ email: undefined }))), ENV);
  assert.deepEqual(result, { ok: false, code: "forbidden" });
});

test("unknown kid triggers exactly one JWKS refetch", async () => {
  // First key set lacks kid-b, the second one has it
  const { fetchFn, calls } = jwksFetch([[keyA], [keyA, keyB]]);
  const verifier = createAccessVerifier({ fetchFn, now: () => NOW_MS });
  assert.equal((await verifier.verify(request(await sign(keyA, claims())), ENV)).ok, true);
  assert.equal(calls.length, 1);
  assert.equal((await verifier.verify(request(await sign(keyB, claims())), ENV)).ok, true);
  assert.equal(calls.length, 2);
});

test("still-unknown kid after one refetch is rejected without further fetches", async () => {
  const { fetchFn, calls } = jwksFetch([[keyA]]);
  const verifier = createAccessVerifier({ fetchFn, now: () => NOW_MS });
  const token = await sign({ ...keyB, kid: "kid-z" }, claims());
  assert.equal((await verifier.verify(request(token), ENV)).ok, false);
  // Initial load + one forced refresh
  assert.equal(calls.length, 2);
  // Within the cooldown no more refreshes happen
  assert.equal((await verifier.verify(request(token), ENV)).ok, false);
  assert.equal(calls.length, 2);
});

test("JWKS is cached for one hour", async () => {
  let clock = NOW_MS;
  const { fetchFn, calls } = jwksFetch([[keyA]]);
  const verifier = createAccessVerifier({ fetchFn, now: () => clock });
  await verifier.verify(request(await sign(keyA, claims())), ENV);
  clock += JWKS_TTL_MS - 1;
  await verifier.verify(request(await sign(keyA, claims({ exp: Math.floor(clock / 1000) + 600 }))), ENV);
  assert.equal(calls.length, 1);
  clock += 1;
  await verifier.verify(request(await sign(keyA, claims({ exp: Math.floor(clock / 1000) + 600 }))), ENV);
  assert.equal(calls.length, 2);
});

test("JWKS fetch failure fails closed", async () => {
  const { fetchFn } = jwksFetch(["fail"]);
  const verifier = createAccessVerifier({ fetchFn, now: () => NOW_MS });
  const result = await verifier.verify(request(await sign(keyA, claims())), ENV);
  assert.deepEqual(result, { ok: false, code: "unauthorized" });
});

test("JWKS network error fails closed", async () => {
  const verifier = createAccessVerifier({ fetchFn: async () => { throw new Error("offline"); }, now: () => NOW_MS });
  const result = await verifier.verify(request(await sign(keyA, claims())), ENV);
  assert.equal(result.ok, false);
});
