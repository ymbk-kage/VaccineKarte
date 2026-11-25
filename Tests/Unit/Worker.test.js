// Unit tests for Src/Worker.js, Src/SheetSource.js and Src/GoogleAuth.js with injected fetch/clock (Design §7-1)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp, DEV_EMAIL } from "../../Src/App.js";
import worker from "../../Src/Worker.js";
import { createSheetSource, createSheetsGridLoader, buildSheetUrl, CACHE_TTL_MS, STALE_LIMIT_MS, RETRY_BACKOFF_MS } from "../../Src/SheetSource.js";
import { createGoogleTokenProvider, base64UrlEncode, TOKEN_URL, GOOGLE_SCOPES } from "../../Src/GoogleAuth.js";
import { FIXTURE_GRID, FIXTURE_EXPECTATIONS as EX } from "../../Src/Fixture.js";
import { HEADERS } from "../../Src/Records.js";
import { SECURITY_HEADERS } from "../../Src/Http.js";

// Hostnames used by the tests
const LOCAL = "http://localhost:8798";
const PROD = "https://vaccine.example.org";
// Fake static asset binding
const ASSETS = { fetch: async () => new Response("<!doctype html><title>x</title>", { status: 200, headers: { "Content-Type": "text/html", "Cache-Control": "public, max-age=3600" } }) };
// Local development environment (bypass + fixture)
const DEV_ENV = { DEV_BYPASS_ACCESS: "1", FIXTURE_MODE: "1", ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "", SHEET_ID: "sheet", SHEET_NAME: "シート1", ASSETS };

// Build an app with a captured log and a controllable clock
function makeApp(options = {}) {
  const logs = [];
  let clock = options.start ?? 1_800_000_000_000;
  const app = createApp({
    fetchFn: options.fetchFn ?? (async () => { throw new Error("network disabled in tests"); }),
    now: () => clock,
    log: (entry) => logs.push(entry),
    loadFixture: options.loadFixture,
  });
  return { app, logs, advance: (ms) => { clock += ms; } };
}

// POST a JSON search body
function searchRequest(base, body, headers = {}) {
  return new Request(`${base}/api/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// Assert the security headers on a response
function assertSecurityHeaders(response) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(response.headers.get(name), value, name);
}

// ---------- fail-closed configuration ----------

test("ACCESS_* unset: static and API are 503 access_not_configured", async () => {
  const { app } = makeApp();
  const env = { ...DEV_ENV, DEV_BYPASS_ACCESS: undefined };
  const page = await app.fetch(new Request(`${PROD}/`), env);
  assert.equal(page.status, 503);
  assert.match(page.headers.get("Content-Type"), /text\/html/);
  const html = await page.text();
  assert.ok(!/<script/i.test(html));
  assert.ok(!html.includes("山田"));
  assertSecurityHeaders(page);
  const api = await app.fetch(new Request(`${PROD}/api/meta`), env);
  assert.equal(api.status, 503);
  assert.equal((await api.json()).error.code, "access_not_configured");
  // Also on localhost without the bypass flag
  const local = await app.fetch(new Request(`${LOCAL}/api/meta`), env);
  assert.equal(local.status, 503);
});

test("only one of ACCESS_TEAM_DOMAIN / ACCESS_AUD set is still 503", async () => {
  const { app } = makeApp();
  const env = { ...DEV_ENV, DEV_BYPASS_ACCESS: undefined, ACCESS_TEAM_DOMAIN: "x.cloudflareaccess.com" };
  assert.equal((await app.fetch(new Request(`${PROD}/api/me`), env)).status, 503);
});

test("DEV_BYPASS_ACCESS=1 is ignored on the production hostname", async () => {
  const { app } = makeApp();
  // Without Access config -> 503
  const unconfigured = await app.fetch(new Request(`${PROD}/api/me`), DEV_ENV);
  assert.equal(unconfigured.status, 503);
  // With Access config but no JWT -> 401
  const env = { ...DEV_ENV, ACCESS_TEAM_DOMAIN: "x.cloudflareaccess.com", ACCESS_AUD: "aud" };
  const noJwt = await app.fetch(new Request(`${PROD}/api/me`), env);
  assert.equal(noJwt.status, 401);
  assert.equal((await noJwt.json()).error.code, "unauthorized");
  // A spoofed email header is not trusted
  const spoofed = await app.fetch(new Request(`${PROD}/api/me`, { headers: { "Cf-Access-Authenticated-User-Email": "a@b.c" } }), env);
  assert.equal(spoofed.status, 401);
});

test("FIXTURE_MODE is ignored on the production hostname", async () => {
  // Valid Access JWT path is covered in Access.test.js; here we check the source choice via a passing verifier stub
  const key = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", key.publicKey);
  const team = "t.cloudflareaccess.com";
  const fetched = [];
  const fetchFn = async (url) => {
    fetched.push(String(url));
    if (String(url).includes("/cdn-cgi/access/certs")) return new Response(JSON.stringify({ keys: [{ kid: "k", kty: "RSA", n: jwk.n, e: jwk.e }] }));
    return new Response(JSON.stringify({ error: { status: "UNAUTHENTICATED" } }), { status: 401 });
  };
  const { app } = makeApp({ fetchFn });
  const nowS = 1_800_000_000;
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", kid: "k" }));
  const payload = base64UrlEncode(JSON.stringify({ iss: `https://${team}`, aud: ["aud"], email: "staff@example.com", exp: nowS + 600, iat: nowS }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, new TextEncoder().encode(`${header}.${payload}`));
  const token = `${header}.${payload}.${base64UrlEncode(new Uint8Array(sig))}`;
  const env = { ...DEV_ENV, ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: "aud", GOOGLE_SA_JSON: "" };
  // /api/me works with Access
  const me = await app.fetch(new Request(`${PROD}/api/me`, { headers: { "Cf-Access-Jwt-Assertion": token } }), env);
  assert.deepEqual(await me.json(), { email: "staff@example.com", mode: "access" });
  // /api/meta must NOT come from the fixture: with no SA key it is 503 sheet_unavailable
  const meta = await app.fetch(new Request(`${PROD}/api/meta`, { headers: { "Cf-Access-Jwt-Assertion": token } }), env);
  assert.equal(meta.status, 503);
  assert.equal((await meta.json()).error.code, "sheet_unavailable");
});

// ---------- API shapes (dev bypass + fixture) ----------

test("GET /api/me returns the dev user", async () => {
  const { app } = makeApp();
  const response = await app.fetch(new Request(`${LOCAL}/api/me`), DEV_ENV);
  assert.equal(response.status, 200);
  assertSecurityHeaders(response);
  assert.deepEqual(await response.json(), { email: DEV_EMAIL, mode: "dev" });
  // 127.0.0.1 is local too
  const ip = await app.fetch(new Request("http://127.0.0.1:8798/api/me"), DEV_ENV);
  assert.equal(ip.status, 200);
});

test("GET /api/meta returns totals and ranges", async () => {
  const { app } = makeApp();
  const response = await app.fetch(new Request(`${LOCAL}/api/meta`), DEV_ENV);
  assert.equal(response.status, 200);
  const meta = await response.json();
  assert.equal(meta.total, EX.total);
  assert.equal(meta.flagged, EX.flagged);
  assert.equal(meta.stale, false);
  assert.match(meta.fetchedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(meta.kinds, ["インフルエンザ", "コロナ"]);
  assert.deepEqual(meta.categories, ["任意", "公費"]);
  assert.deepEqual(meta.visitDateRange, EX.visitDateRange);
  // No ATTACHMENT_FOLDER_NAME configured -> empty string
  assert.equal(meta.attachmentFolder, "");
});

test("ATTACHMENT_FOLDER_NAME reaches /api/meta and the attachment_unavailable message", async () => {
  const { app } = makeApp();
  const env = { ...DEV_ENV, ATTACHMENT_FOLDER_NAME: " FormFiles " };
  // /api/meta reports the trimmed folder name for the UI
  const meta = await (await app.fetch(new Request(`${LOCAL}/api/meta`), env)).json();
  assert.equal(meta.attachmentFolder, "FormFiles");
  // The unshared fixture file names the folder in the error body
  const missing = await app.fetch(attachmentRequest(EX.attachments.unavailable.rowNumber, 0), env);
  assert.equal(missing.status, 404);
  const body = await missing.json();
  assert.equal(body.error.code, "attachment_unavailable");
  assert.ok(body.error.message.includes("「FormFiles」フォルダ"));
});

test("POST /api/search returns summaries", async () => {
  const { app } = makeApp();
  const response = await app.fetch(searchRequest(LOCAL, { q: "ヤマダ" }, { Origin: LOCAL }), DEV_ENV);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "application/json; charset=utf-8");
  assertSecurityHeaders(response);
  const body = await response.json();
  assert.equal(body.total, 1);
  assert.equal(body.page, 1);
  assert.equal(body.pageSize, 50);
  assert.equal(body.sort, "visitDesc");
  assert.equal(body.items[0].rowNumber, EX.yamada.rowNumber);
  assert.equal(body.items[0].name, EX.yamada.name);
  assert.equal(body.items[0].searchText, undefined);
  assert.equal(body.items[0].phone, undefined);
  assert.equal(body.meta.stale, false);
});

test("POST /api/search with an empty body returns the newest 50", async () => {
  const { app } = makeApp();
  const response = await app.fetch(searchRequest(LOCAL, ""), DEV_ENV);
  const body = await response.json();
  assert.equal(body.total, EX.total);
  assert.equal(body.items[0].visitDate, "2026/10/15");
});

test("POST /api/search with known filters matches the fixture count", async () => {
  const { app } = makeApp();
  const { kind, category, ageMin, ageMax, count } = EX.coronaPublicAge65to100;
  const body = await (await app.fetch(searchRequest(LOCAL, { kind, category, ageMin, ageMax }), DEV_ENV)).json();
  assert.equal(body.total, count);
});

test("POST /api/search rejects non-JSON content types", async () => {
  const { app } = makeApp();
  for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data", ""]) {
    const request = new Request(`${LOCAL}/api/search`, { method: "POST", headers: type ? { "Content-Type": type } : {}, body: "{}" });
    const response = await app.fetch(request, DEV_ENV);
    assert.equal(response.status, 400, type);
    assert.equal((await response.json()).error.code, "bad_request");
  }
  // charset parameter is fine
  const ok = await app.fetch(searchRequest(LOCAL, {}, { "Content-Type": "application/json; charset=utf-8" }), DEV_ENV);
  assert.equal(ok.status, 200);
});

test("POST /api/search rejects a foreign Origin", async () => {
  const { app } = makeApp();
  const response = await app.fetch(searchRequest(LOCAL, {}, { Origin: "https://evil.example" }), DEV_ENV);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "forbidden");
  // Same origin is accepted, missing Origin is accepted
  assert.equal((await app.fetch(searchRequest(LOCAL, {}, { Origin: LOCAL }), DEV_ENV)).status, 200);
  assert.equal((await app.fetch(searchRequest(LOCAL, {}), DEV_ENV)).status, 200);
});

test("POST /api/search rejects bad JSON, bad conditions and oversized bodies", async () => {
  const { app } = makeApp();
  for (const body of ["{not json", "[]", JSON.stringify({ visitFrom: "2026/10/01" }), JSON.stringify({ pageSize: 500 }), JSON.stringify({ q: "x".repeat(17000) })]) {
    const response = await app.fetch(searchRequest(LOCAL, body), DEV_ENV);
    assert.equal(response.status, 400, body.slice(0, 40));
  }
});

test("GET /api/records/:n returns the detail with sameNumberCount", async () => {
  const { app } = makeApp();
  const response = await app.fetch(new Request(`${LOCAL}/api/records/${EX.sharedManagementNumber.rowNumbers[0]}`), DEV_ENV);
  assert.equal(response.status, 200);
  const record = await response.json();
  assert.equal(record.rowNumber, EX.sharedManagementNumber.rowNumbers[0]);
  assert.equal(record.sameNumberCount, 2);
  assert.equal(record.searchText, undefined);
  assert.equal(typeof record.flags, "object");
  // Yamada detail
  const yamada = await (await app.fetch(new Request(`${LOCAL}/api/records/${EX.yamada.rowNumber}`), DEV_ENV)).json();
  assert.equal(yamada.phone, EX.yamada.phone);
  assert.deepEqual(yamada.flags, { address: "yellow" });
  assert.equal(yamada.sameNumberCount, 1);
});

test("GET /api/records/:n is 404 for blank, missing and malformed rows", async () => {
  const { app } = makeApp();
  for (const path of [`/api/records/${EX.blankRowNumber}`, "/api/records/1", "/api/records/999", "/api/records/abc", "/api/records/"]) {
    const response = await app.fetch(new Request(`${LOCAL}${path}`), DEV_ENV);
    assert.equal(response.status, 404, path);
    assert.equal((await response.json()).error.code, "not_found");
  }
});

test("unknown /api/* is 404, wrong methods are 405", async () => {
  const { app } = makeApp();
  assert.equal((await app.fetch(new Request(`${LOCAL}/api/nothing`), DEV_ENV)).status, 404);
  // GET on the search route
  const getSearch = await app.fetch(new Request(`${LOCAL}/api/search?q=山田`), DEV_ENV);
  assert.equal(getSearch.status, 405);
  assert.equal(getSearch.headers.get("Allow"), "POST");
  // POST elsewhere
  for (const path of ["/api/meta", "/api/me", "/api/records/2", "/"]) {
    const response = await app.fetch(new Request(`${LOCAL}${path}`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } }), DEV_ENV);
    assert.equal(response.status, 405, path);
  }
  // DELETE / PUT
  assert.equal((await app.fetch(new Request(`${LOCAL}/api/records/2`, { method: "DELETE" }), DEV_ENV)).status, 405);
  assert.equal((await app.fetch(new Request(`${LOCAL}/api/search`, { method: "PUT", body: "{}" }), DEV_ENV)).status, 405);
});

test("static assets are served with overwritten security headers", async () => {
  const { app } = makeApp();
  const response = await app.fetch(new Request(`${LOCAL}/`), DEV_ENV);
  assert.equal(response.status, 200);
  assertSecurityHeaders(response);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("Worker.js default export only exposes fetch", () => {
  assert.equal(typeof worker.fetch, "function");
});

// ---------- logging ----------

test("one log line per request without query text, patient fields or row numbers", async () => {
  const { app, logs } = makeApp();
  await app.fetch(searchRequest(LOCAL, { q: "ヤマダ", phone: "09000000001" }), DEV_ENV);
  await app.fetch(new Request(`${LOCAL}/api/records/${EX.yamada.rowNumber}`), DEV_ENV);
  await app.fetch(new Request(`${LOCAL}/api/meta`), DEV_ENV);
  assert.equal(logs.length, 3);
  const [search, detail, meta] = logs;
  assert.deepEqual(Object.keys(search).sort(), ["cacheHit", "email", "method", "ms", "resultCount", "route", "status"]);
  assert.equal(search.route, "/api/search");
  assert.equal(search.status, 200);
  assert.equal(search.email, DEV_EMAIL);
  assert.equal(search.resultCount, 1);
  assert.equal(search.cacheHit, false);
  assert.equal(detail.route, "/api/records/:rowNumber");
  assert.equal(detail.cacheHit, true);
  assert.equal(meta.route, "/api/meta");
  const text = logs.map((entry) => JSON.stringify(entry)).join("\n");
  for (const forbidden of ["ヤマダ", "やまだ", "山田", "09000000001", "090-0000-0001", `/api/records/${EX.yamada.rowNumber}`]) {
    assert.ok(!text.includes(forbidden), forbidden);
  }
});

test("default logger writes JSON to console.log without the query", async () => {
  // Swap console.log to capture the real default logger
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(line);
  try {
    const app = createApp({ fetchFn: async () => { throw new Error("offline"); } });
    await app.fetch(searchRequest(LOCAL, { q: "山田太郎" }), DEV_ENV);
  } finally {
    console.log = original;
  }
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.route, "/api/search");
  assert.ok(!lines[0].includes("山田"));
});

test("unknown paths are logged as a generic route label", async () => {
  const { app, logs } = makeApp();
  await app.fetch(new Request(`${LOCAL}/api/${encodeURIComponent("山田")}`), DEV_ENV);
  assert.equal(logs[0].route, "api_unknown");
  assert.ok(!JSON.stringify(logs[0]).includes("%E5"));
});

// ---------- SheetSource cache / single-flight / stale ----------

// Grid loader stub with a controllable result and call counter
function gridStub() {
  const state = { calls: 0, fail: false, grid: FIXTURE_GRID, delay: null };
  const loadGrid = async () => {
    state.calls += 1;
    if (state.delay) await state.delay;
    if (state.fail) throw Object.assign(new Error("down"), { code: "sheet_unavailable", httpStatus: 503, googleStatus: "UNAVAILABLE" });
    return structuredClone(state.grid);
  };
  return { state, loadGrid };
}

// Collects promises handed to ctx.waitUntil so a test can wait for background work
function waitUntilSink() {
  const promises = [];
  return { waitUntil: (promise) => promises.push(promise), promises, settle: () => Promise.all(promises.splice(0)) };
}

test("SheetSource caches for 60 s, then answers from cache while refreshing in the background", async () => {
  let clock = 0;
  const { state, loadGrid } = gridStub();
  const sink = waitUntilSink();
  const source = createSheetSource({ loadGrid, now: () => clock });
  const first = await source.load({ waitUntil: sink.waitUntil });
  assert.equal(first.cacheHit, false);
  assert.equal(first.records.length, EX.total);
  clock = CACHE_TTL_MS - 1;
  const second = await source.load({ waitUntil: sink.waitUntil });
  assert.equal(second.cacheHit, true);
  assert.equal(state.calls, 1);
  // After the TTL the old snapshot is returned at once (stale-while-revalidate)
  clock = CACHE_TTL_MS;
  const third = await source.load({ waitUntil: sink.waitUntil });
  assert.equal(third.cacheHit, true);
  assert.equal(third.stale, false);
  assert.equal(third.fetchedAt, 0);
  // The refresh it started was handed to waitUntil and replaces the snapshot when done
  await sink.settle();
  assert.equal(state.calls, 2);
  const fourth = await source.load({ waitUntil: sink.waitUntil });
  assert.equal(fourth.fetchedAt, CACHE_TTL_MS);
  assert.equal(state.calls, 2);
});

test("SheetSource does not make the caller wait for a slow background refresh", async () => {
  let clock = 0;
  const { state, loadGrid } = gridStub();
  const source = createSheetSource({ loadGrid, now: () => clock });
  await source.load();
  // The next refresh never settles (e.g. Google stalls)
  state.delay = new Promise(() => {});
  clock = CACHE_TTL_MS;
  const result = await source.load();
  assert.equal(result.records.length, EX.total);
  assert.equal(state.calls, 2);
});

test("SheetSource registers a blocking first refresh with waitUntil (a cancelled request must not orphan it)", async () => {
  const { loadGrid } = gridStub();
  const sink = waitUntilSink();
  const source = createSheetSource({ loadGrid, now: () => 0 });
  await source.load({ waitUntil: sink.waitUntil });
  assert.equal(sink.promises.length, 1);
  await sink.settle();
});

test("SheetSource shares one in-flight refresh between concurrent callers", async () => {
  const { state, loadGrid } = gridStub();
  let release;
  state.delay = new Promise((resolve) => { release = resolve; });
  const source = createSheetSource({ loadGrid, now: () => 0 });
  const pending = [source.load(), source.load(), source.load()];
  release();
  const results = await Promise.all(pending);
  assert.equal(state.calls, 1);
  assert.ok(results.every((r) => r.records.length === EX.total));
});

test("SheetSource abandons an orphaned refresh that never settles (cancelled request, 2026-10-16 hang)", async () => {
  let clock = 0;
  const logs = [];
  let calls = 0;
  // First refresh never settles (its request was cancelled); the second one succeeds
  const loadGrid = async () => {
    calls += 1;
    if (calls === 1) return new Promise(() => {});
    return structuredClone(FIXTURE_GRID);
  };
  const source = createSheetSource({ loadGrid, now: () => clock, log: (e) => logs.push(e), inflightMaxAgeMs: 30 });
  // A caller that joined the orphan gets an error after the lifetime instead of waiting forever
  await assert.rejects(source.load(), (error) => error.code === "sheet_unavailable" && error.detail === "inflight_timeout");
  assert.equal(logs[0].detail, "inflight_timeout");
  // Once the orphan is older than the lifetime, the next request starts a fresh refresh
  clock = 30;
  const result = await source.load();
  assert.equal(result.records.length, EX.total);
  assert.equal(calls, 2);
});

test("token exchange abandons an orphaned exchange and passes an abort deadline to fetch", async () => {
  const sa = await makeServiceAccount();
  let clock = 0;
  const signals = [];
  let exchanges = 0;
  // First exchange hangs forever, later ones answer normally
  const fetchFn = async (url, init) => {
    exchanges += 1;
    signals.push(init?.signal);
    if (exchanges === 1) return new Promise(() => {});
    return new Response(JSON.stringify({ access_token: "t2", expires_in: 3600 }));
  };
  const tokens = createGoogleTokenProvider({ saJson: sa.json, fetchFn, now: () => clock, inflightMaxAgeMs: 30 });
  const first = tokens.getToken();
  // Let the first exchange reach fetch, then age it past the lifetime
  await new Promise((resolve) => setTimeout(resolve, 10));
  clock = 30;
  assert.equal(await tokens.getToken(), "t2");
  assert.equal(exchanges, 2);
  // Every outbound call carries an AbortSignal so a stalled socket cannot hang the request
  assert.ok(signals.every((s) => s instanceof AbortSignal));
  // The first caller gives up with the timeout code instead of waiting forever
  await assert.rejects(first, (error) => error.detail === "token_timeout");
});

test("SheetSource logs the reason id of failures that happen before any HTTP call", async () => {
  const logs = [];
  // A broken service-account JSON fails inside GoogleAuth with no HTTP status at all
  const loadGrid = async () => {
    throw Object.assign(new Error("bad key"), { code: "sheet_unavailable", detail: "sa_json_invalid" });
  };
  const source = createSheetSource({ loadGrid, now: () => 0, log: (e) => logs.push(e) });
  await assert.rejects(source.load());
  // Without the detail the log would read httpStatus:null only and the cause would be invisible
  assert.equal(logs[0].detail, "sa_json_invalid");
  assert.equal(logs[0].httpStatus, null);
});

test("SheetSource serves stale data up to 10 min after the last success, then 503", async () => {
  let clock = 0;
  const logs = [];
  const { state, loadGrid } = gridStub();
  const sink = waitUntilSink();
  const source = createSheetSource({ loadGrid, now: () => clock, log: (e) => logs.push(e) });
  await source.load({ waitUntil: sink.waitUntil });
  state.fail = true;
  // Just after the TTL the snapshot is served while the background refresh runs (failure not known yet)
  clock = CACHE_TTL_MS;
  assert.equal((await source.load({ waitUntil: sink.waitUntil })).stale, false);
  await sink.settle();
  // Failure logging carries only status values
  assert.deepEqual(logs[0], { event: "sheet_refresh_failed", code: "sheet_unavailable", httpStatus: 503, googleStatus: "UNAVAILABLE", detail: null });
  // Once the refresh is known to fail, the old data is flagged stale
  const stale = await source.load({ waitUntil: sink.waitUntil });
  assert.equal(stale.stale, true);
  assert.equal(stale.fetchedAt, 0);
  // Exactly at the 10 min boundary it is still served
  clock = STALE_LIMIT_MS;
  assert.equal((await source.load({ waitUntil: sink.waitUntil })).stale, true);
  await sink.settle();
  // Beyond 10 min -> error (the caller has to wait for the refresh, which fails)
  clock = STALE_LIMIT_MS + RETRY_BACKOFF_MS;
  await assert.rejects(source.load({ waitUntil: sink.waitUntil }), (error) => error.code === "sheet_unavailable");
});

test("SheetSource backs off after a failure and recovers", async () => {
  let clock = 0;
  const { state, loadGrid } = gridStub();
  const sink = waitUntilSink();
  const source = createSheetSource({ loadGrid, now: () => clock });
  await source.load({ waitUntil: sink.waitUntil });
  state.fail = true;
  clock = CACHE_TTL_MS;
  await source.load({ waitUntil: sink.waitUntil });
  await sink.settle();
  const callsAfterFailure = state.calls;
  // Within the backoff no new upstream call happens
  clock += RETRY_BACKOFF_MS - 1;
  assert.equal((await source.load({ waitUntil: sink.waitUntil })).stale, true);
  assert.equal(state.calls, callsAfterFailure);
  // After the backoff a background refresh runs again; once it succeeds the stale flag clears
  state.fail = false;
  clock += 1;
  await source.load({ waitUntil: sink.waitUntil });
  await sink.settle();
  assert.equal(state.calls, callsAfterFailure + 1);
  const fresh = await source.load({ waitUntil: sink.waitUntil });
  assert.equal(fresh.stale, false);
  assert.equal(fresh.cacheHit, true);
});

test("SheetSource without any snapshot fails immediately", async () => {
  const { state, loadGrid } = gridStub();
  state.fail = true;
  const source = createSheetSource({ loadGrid, now: () => 0 });
  await assert.rejects(source.load(), (error) => error.code === "sheet_unavailable");
});

test("SheetSource refuses a changed header layout", async () => {
  const { state, loadGrid } = gridStub();
  const shifted = structuredClone(FIXTURE_GRID);
  shifted[0].values.unshift({ formattedValue: "挿入列" });
  state.grid = shifted;
  const source = createSheetSource({ loadGrid, now: () => 0 });
  await assert.rejects(source.load(), (error) => error.code === "sheet_layout_changed");
});

test("SheetSource refuses the old 17-column layout without 性別", async () => {
  const { state, loadGrid } = gridStub();
  const old = structuredClone(FIXTURE_GRID);
  // Drop column H (性別) from every row to rebuild the previous layout
  for (const gridRow of old) if (Array.isArray(gridRow.values)) gridRow.values.splice(7, 1);
  state.grid = old;
  const source = createSheetSource({ loadGrid, now: () => 0 });
  await assert.rejects(source.load(), (error) => error.code === "sheet_layout_changed" && error.reason === "header_mismatch_at_8");
});

test("Worker maps a layout change to 503 sheet_layout_changed", async () => {
  const shifted = structuredClone(FIXTURE_GRID);
  shifted[0].values[4] = { formattedValue: "名前" };
  const { app } = makeApp({ loadFixture: async () => structuredClone(shifted) });
  const response = await app.fetch(new Request(`${LOCAL}/api/meta`), DEV_ENV);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "sheet_layout_changed");
});

test("Worker returns stale=true in meta while serving old data", async () => {
  let fail = false;
  const { app, advance } = makeApp({
    loadFixture: async () => {
      if (fail) throw Object.assign(new Error("down"), { code: "sheet_unavailable" });
      return structuredClone(FIXTURE_GRID);
    },
  });
  const sink = waitUntilSink();
  await app.fetch(new Request(`${LOCAL}/api/meta`), DEV_ENV, sink);
  fail = true;
  advance(CACHE_TTL_MS + 1);
  // The first request after the TTL is answered from cache and hands the refresh to ctx.waitUntil
  assert.equal((await app.fetch(new Request(`${LOCAL}/api/meta`), DEV_ENV, sink)).status, 200);
  assert.ok(sink.promises.length >= 1);
  await sink.settle();
  const meta = await (await app.fetch(new Request(`${LOCAL}/api/meta`), DEV_ENV, sink)).json();
  assert.equal(meta.stale, true);
  const search = await (await app.fetch(searchRequest(LOCAL, {}), DEV_ENV, sink)).json();
  assert.equal(search.meta.stale, true);
  advance(STALE_LIMIT_MS);
  assert.equal((await app.fetch(new Request(`${LOCAL}/api/meta`), DEV_ENV, sink)).status, 503);
});

// ---------- Sheets loader + Google token exchange ----------

// Make a throwaway service-account JSON with an in-test RSA key
async function makeServiceAccount() {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const b64 = Buffer.from(der).toString("base64").replace(/(.{64})/g, "$1\n");
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
  return { json: JSON.stringify({ client_email: "unit@test.iam.gserviceaccount.com", private_key: pem }), publicKey: pair.publicKey };
}

test("buildSheetUrl requests values and colours for A1:T in one call", () => {
  const url = new URL(buildSheetUrl("SHEET123", "シート1"));
  assert.equal(url.origin + url.pathname, "https://sheets.googleapis.com/v4/spreadsheets/SHEET123");
  assert.equal(url.searchParams.get("ranges"), "'シート1'!A1:T");
  assert.equal(url.searchParams.get("includeGridData"), "true");
  // Compact JSON: the indented default is ~4x larger for the same grid
  assert.equal(url.searchParams.get("prettyPrint"), "false");
  assert.match(url.searchParams.get("fields"), /formattedValue,effectiveFormat\(backgroundColor\)/);
  // The three kinds of cell links come in the same call (Design §10-2)
  const fields = url.searchParams.get("fields");
  assert.ok(fields.includes("hyperlink"));
  assert.ok(fields.includes("textFormatRuns(format(link(uri)))"));
  assert.ok(fields.includes("chipRuns(chip(richLinkProperties(uri,mimeType)))"));
});

test("token provider signs a readonly JWT, caches the token and the loader uses it", async () => {
  const sa = await makeServiceAccount();
  let clock = 1_800_000_000_000;
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url) === TOKEN_URL) {
      const form = new URLSearchParams(init.body);
      assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
      const [h, p, s] = form.get("assertion").split(".");
      const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
      assert.equal(claims.scope, GOOGLE_SCOPES);
      assert.equal(claims.aud, TOKEN_URL);
      assert.equal(claims.iss, "unit@test.iam.gserviceaccount.com");
      assert.equal(claims.exp - claims.iat, 3600);
      // Signature verifies with the matching public key
      const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", sa.publicKey, Buffer.from(s, "base64url"), new TextEncoder().encode(`${h}.${p}`));
      assert.ok(ok);
      return new Response(JSON.stringify({ access_token: `tok-${calls.length}`, expires_in: 3600 }));
    }
    assert.equal(init.headers.Authorization, "Bearer tok-1");
    return new Response(JSON.stringify({ sheets: [{ properties: { title: "シート1" }, data: [{ rowData: FIXTURE_GRID }] }] }));
  };
  const tokens = createGoogleTokenProvider({ saJson: sa.json, fetchFn, now: () => clock });
  const loadGrid = createSheetsGridLoader({ fetchFn, getToken: tokens.getToken, sheetId: "S", sheetName: "シート1" });
  const rows = await loadGrid();
  assert.equal(rows.length, FIXTURE_GRID.length);
  await loadGrid();
  // One token exchange, two sheet reads
  assert.equal(calls.filter((c) => c.url === TOKEN_URL).length, 1);
  // Token refreshes 60 s before expiry
  clock += (3600 - 60) * 1000;
  await tokens.getToken();
  assert.equal(calls.filter((c) => c.url === TOKEN_URL).length, 2);
});

test("token exchange is single-flight", async () => {
  const sa = await makeServiceAccount();
  let exchanges = 0;
  const fetchFn = async () => {
    exchanges += 1;
    return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }));
  };
  const tokens = createGoogleTokenProvider({ saJson: sa.json, fetchFn, now: () => 0 });
  await Promise.all([tokens.getToken(), tokens.getToken(), tokens.getToken()]);
  assert.equal(exchanges, 1);
});

test("Sheets errors surface only HTTP status and Google status", async () => {
  const loadGrid = createSheetsGridLoader({
    fetchFn: async () => new Response(JSON.stringify({ error: { code: 403, status: "PERMISSION_DENIED", message: "secret detail" } }), { status: 403 }),
    getToken: async () => "t",
    sheetId: "S",
    sheetName: "シート1",
  });
  await assert.rejects(loadGrid(), (error) => error.code === "sheet_unavailable" && error.httpStatus === 403 && error.googleStatus === "PERMISSION_DENIED" && !String(error.message).includes("secret"));
});

test("empty sheet response yields no rows and a layout error", async () => {
  const loadGrid = createSheetsGridLoader({ fetchFn: async () => new Response(JSON.stringify({ sheets: [{ data: [{}] }] })), getToken: async () => "t", sheetId: "S", sheetName: "x" });
  assert.deepEqual(await loadGrid(), []);
  const source = createSheetSource({ loadGrid, now: () => 0 });
  await assert.rejects(source.load(), (error) => error.code === "sheet_layout_changed");
});

test("invalid service-account JSON is sheet_unavailable", async () => {
  const tokens = createGoogleTokenProvider({ saJson: "not json", fetchFn: async () => new Response("{}"), now: () => 0 });
  await assert.rejects(tokens.getToken(), (error) => error.code === "sheet_unavailable");
  const incomplete = createGoogleTokenProvider({ saJson: JSON.stringify({ client_email: "x" }), fetchFn: async () => new Response("{}"), now: () => 0 });
  await assert.rejects(incomplete.getToken(), (error) => error.code === "sheet_unavailable");
});

test("HEADERS used by the fixture match Records.HEADERS", () => {
  const texts = FIXTURE_GRID[0].values.map((v) => v.formattedValue);
  assert.deepEqual(texts.slice(0, 19), HEADERS);
  assert.equal(texts[19], "備考");
});

// ---------- attachments (Design §10-3, §10-8) ----------

// Synthetic Drive ids of the fixture links
const PNG_ID = "FixturePng0000000000000000000001";
const PDF_ID = "FixturePdf0000000000000000000002";
const MISSING_ID = "FixtureMissing00000000000000003";
const ATTACHMENT_ROUTE_TEMPLATE = "/api/records/:rowNumber/attachments/:index";
// Browser-like image Accept header
const IMG_ACCEPT = "image/avif,image/webp,image/apng,image/*,*/*;q=0.8";

// Fake Google: token endpoint, Sheets (fixture grid) and Drive files keyed by id
async function makeGoogleApp({ drive = {}, transformSize = null, transformThrows = false } = {}) {
  const sa = await makeServiceAccount();
  const calls = [];
  const transformCalls = [];
  const fetchFn = async (url) => {
    const text = String(url);
    calls.push(text);
    if (text === TOKEN_URL) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }));
    if (text.startsWith("https://sheets.googleapis.com/")) {
      return new Response(JSON.stringify({ sheets: [{ properties: { title: "患者管理" }, data: [{ rowData: FIXTURE_GRID }] }] }));
    }
    const match = text.match(/^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/([^?]+)\?(.*)$/);
    if (match) {
      const entry = drive[decodeURIComponent(match[1])];
      const params = new URLSearchParams(match[2]);
      if (!entry) return new Response(JSON.stringify({ error: { status: "NOT_FOUND" } }), { status: 404 });
      if (entry.status) return new Response("{}", { status: entry.status });
      if (params.get("alt") === "media") return new Response(entry.bytes);
      assert.equal(params.get("fields"), "mimeType,size");
      assert.equal(params.get("supportsAllDrives"), "true");
      return new Response(JSON.stringify({ mimeType: entry.mimeType, size: entry.size ?? String(entry.bytes.byteLength) }));
    }
    throw new Error(`unexpected fetch ${text}`);
  };
  const logs = [];
  let clock = 1_800_000_000_000;
  const app = createApp({
    fetchFn,
    now: () => clock,
    log: (entry) => logs.push(entry),
    makeTransform: (images) => (images ? async (bytes) => {
      transformCalls.push(bytes.byteLength);
      if (transformThrows) throw new Error("boom");
      return new Uint8Array(transformSize).buffer;
    } : null),
  });
  // Local + bypass, but real Google path (no FIXTURE_MODE)
  const env = { DEV_BYPASS_ACCESS: "1", ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "", SHEET_ID: "S", SHEET_NAME: "患者管理", GOOGLE_SA_JSON: sa.json, ASSETS, IMAGES: {} };
  const driveCalls = () => calls.filter((c) => c.startsWith("https://www.googleapis.com/drive/"));
  return { app, env, logs, calls, driveCalls, transformCalls, advance: (ms) => { clock += ms; } };
}

// A JPEG-typed buffer of the given size
function jpegBytes(size) {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff]);
  return bytes;
}

// Attachment request helper
function attachmentRequest(row, index, init = {}) {
  return new Request(`${LOCAL}/api/records/${row}/attachments/${index}`, init);
}

test("attachments: missing row, out-of-range index and external links are 404 not_found without Drive calls", async () => {
  const g = await makeGoogleApp({ drive: { [PNG_ID]: { mimeType: "image/png", bytes: jpegBytes(10) } } });
  for (const [row, index] of [[EX.blankRowNumber, 0], [999, 0], [EX.attachments.image.rowNumber, 1], [EX.attachments.image.rowNumber, 99], [3, 0], [EX.attachments.external.rowNumber, 0]]) {
    const response = await g.app.fetch(attachmentRequest(row, index), g.env);
    assert.equal(response.status, 404, `${row}/${index}`);
    assert.equal((await response.json()).error.code, "not_found");
  }
  assert.equal(g.driveCalls().length, 0);
  // Malformed paths fall through to the generic 404
  for (const path of ["/api/records/2/attachments/abc", "/api/records/2/attachments/123", "/api/records/2/attachments/", `/api/records/2/attachments/0/${PNG_ID}`]) {
    assert.equal((await g.app.fetch(new Request(`${LOCAL}${path}`), g.env)).status, 404, path);
  }
  assert.equal(g.driveCalls().length, 0);
});

test("attachments: client-supplied ids in the query or path are ignored", async () => {
  const g = await makeGoogleApp({ drive: { [PNG_ID]: { mimeType: "image/png", bytes: jpegBytes(10) }, OtherSecretFile000000001: { mimeType: "image/png", bytes: jpegBytes(5) } } });
  // ?id= on an external attachment: still 404 and no Drive call at all
  const ext = await g.app.fetch(new Request(`${LOCAL}/api/records/${EX.attachments.external.rowNumber}/attachments/0?id=OtherSecretFile000000001`), g.env);
  assert.equal(ext.status, 404);
  assert.equal(g.driveCalls().length, 0);
  // ?id= on a Drive attachment: the server-side id is used
  const ok = await g.app.fetch(new Request(`${LOCAL}/api/records/2/attachments/0?id=OtherSecretFile000000001&fileId=OtherSecretFile000000001`), g.env);
  assert.equal(ok.status, 200);
  assert.ok(g.driveCalls().every((c) => c.includes(PNG_ID) && !c.includes("OtherSecretFile")));
});

test("attachments: unsupported type 415, too large 413, non-numeric size 415", async () => {
  for (const [entry, status, code] of [
    [{ mimeType: "image/heic", bytes: jpegBytes(10) }, 415, "attachment_unsupported"],
    [{ mimeType: "application/vnd.google-apps.document", bytes: jpegBytes(10) }, 415, "attachment_unsupported"],
    [{ mimeType: "text/html", bytes: jpegBytes(10) }, 415, "attachment_unsupported"],
    [{ mimeType: "image/png", bytes: jpegBytes(10), size: String(20 * 1024 * 1024 + 1) }, 413, "attachment_too_large"],
    [{ mimeType: "image/png", bytes: jpegBytes(10), size: "abc" }, 415, "attachment_unsupported"],
  ]) {
    const g = await makeGoogleApp({ drive: { [PNG_ID]: entry } });
    const response = await g.app.fetch(attachmentRequest(2, 0), g.env);
    assert.equal(response.status, status, entry.mimeType);
    assert.equal((await response.json()).error.code, code);
    // Metadata only: the media is never downloaded
    assert.ok(g.driveCalls().every((c) => !c.includes("alt=media")));
  }
});

test("attachments: Drive 403/404 -> 404 attachment_unavailable, Drive 500 -> 503 sheet_unavailable", async () => {
  for (const [status, expected, code] of [[403, 404, "attachment_unavailable"], [404, 404, "attachment_unavailable"], [500, 503, "sheet_unavailable"]]) {
    const g = await makeGoogleApp({ drive: { [PNG_ID]: { status } } });
    const response = await g.app.fetch(attachmentRequest(2, 0), g.env);
    assert.equal(response.status, expected, String(status));
    assert.equal((await response.json()).error.code, code);
    // upstreamStatus is logged on failure only
    const entry = g.logs.find((e) => e.route === ATTACHMENT_ROUTE_TEMPLATE);
    assert.equal(entry.upstreamStatus, status);
  }
  // The fixture row 31 id is absent in this fake Drive -> 404 from Drive -> attachment_unavailable
  const g = await makeGoogleApp();
  assert.equal((await (await g.app.fetch(attachmentRequest(31, 0), g.env)).json()).error.code, "attachment_unavailable");
});

test("attachments: 200 image response has every designed header", async () => {
  const g = await makeGoogleApp({ drive: { [PNG_ID]: { mimeType: "IMAGE/PNG; charset=binary", bytes: jpegBytes(64) } }, transformSize: 1000 });
  const response = await g.app.fetch(attachmentRequest(2, 0, { headers: { Accept: IMG_ACCEPT } }), g.env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "image/png");
  assert.equal(response.headers.get("Content-Length"), "64");
  assert.equal(response.headers.get("Content-Disposition"), 'inline; filename="attachment.png"');
  assert.equal(response.headers.get("Content-Security-Policy"), "default-src 'none'; frame-ancestors 'self'; sandbox");
  assert.equal(response.headers.get("Vary"), "Accept");
  // WebP came out larger -> original
  assert.equal(response.headers.get("X-Attachment-Format"), "original");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  assert.equal((await response.arrayBuffer()).byteLength, 64);
  assert.equal(g.transformCalls.length, 1);
});

test("attachments: smaller WebP is served as image/webp", async () => {
  const g = await makeGoogleApp({ drive: { [PNG_ID]: { mimeType: "image/jpeg", bytes: jpegBytes(500) } }, transformSize: 120 });
  const response = await g.app.fetch(attachmentRequest(2, 0, { headers: { Accept: IMG_ACCEPT } }), g.env);
  assert.equal(response.headers.get("Content-Type"), "image/webp");
  assert.equal(response.headers.get("X-Attachment-Format"), "webp");
  assert.equal(response.headers.get("Content-Length"), "120");
  assert.equal(response.headers.get("Content-Disposition"), 'inline; filename="attachment.webp"');
  assert.equal((await response.arrayBuffer()).byteLength, 120);
  // Without image/webp in Accept the transformer is not called
  const plain = await g.app.fetch(attachmentRequest(2, 0, { headers: { Accept: "*/*" } }), g.env);
  assert.equal(plain.headers.get("X-Attachment-Format"), "original");
  assert.equal(plain.headers.get("Content-Type"), "image/jpeg");
  assert.equal(g.transformCalls.length, 1);
});

test("attachments: missing IMAGES binding or a throwing transform serve the original and log webp_skipped", async () => {
  const g = await makeGoogleApp({ drive: { [PNG_ID]: { mimeType: "image/jpeg", bytes: jpegBytes(50) } } });
  const response = await g.app.fetch(attachmentRequest(2, 0, { headers: { Accept: IMG_ACCEPT } }), { ...g.env, IMAGES: undefined });
  assert.equal(response.headers.get("X-Attachment-Format"), "original");
  assert.ok(g.logs.some((e) => e.event === "webp_skipped" && e.reason === "binding_missing"));
  const t = await makeGoogleApp({ drive: { [PNG_ID]: { mimeType: "image/jpeg", bytes: jpegBytes(50) } }, transformThrows: true });
  const failed = await t.app.fetch(attachmentRequest(2, 0, { headers: { Accept: IMG_ACCEPT } }), t.env);
  assert.equal(failed.status, 200);
  assert.equal(failed.headers.get("X-Attachment-Format"), "original");
  assert.ok(t.logs.some((e) => e.event === "webp_skipped" && e.reason === "transform_error"));
});

test("attachments: PDF streams through without sandbox and without conversion", async () => {
  const pdf = new TextEncoder().encode("%PDF-1.4 test");
  const g = await makeGoogleApp({ drive: { [PDF_ID]: { mimeType: "application/pdf", bytes: pdf } }, transformSize: 1 });
  const response = await g.app.fetch(attachmentRequest(EX.attachments.pdf.rowNumber, 0, { headers: { Accept: IMG_ACCEPT } }), g.env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "application/pdf");
  assert.equal(response.headers.get("Content-Security-Policy"), "default-src 'none'; frame-ancestors 'self'");
  assert.equal(response.headers.get("Content-Disposition"), 'inline; filename="attachment.pdf"');
  assert.equal(response.headers.get("X-Attachment-Format"), "original");
  assert.equal(new TextDecoder().decode(await response.arrayBuffer()), "%PDF-1.4 test");
  assert.equal(g.transformCalls.length, 0);
});

test("attachments: HEAD is 200 with no body, no media download and no conversion", async () => {
  const g = await makeGoogleApp({ drive: { [PNG_ID]: { mimeType: "image/jpeg", bytes: jpegBytes(300) } }, transformSize: 10 });
  const response = await g.app.fetch(attachmentRequest(2, 0, { method: "HEAD", headers: { Accept: IMG_ACCEPT } }), g.env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "image/jpeg");
  assert.equal(response.headers.get("Content-Length"), "300");
  assert.equal(response.headers.get("X-Attachment-Format"), null);
  assert.equal(response.headers.get("Content-Security-Policy"), "default-src 'none'; frame-ancestors 'self'; sandbox");
  assert.equal(response.body, null);
  assert.ok(g.driveCalls().every((c) => !c.includes("alt=media")));
  assert.equal(g.transformCalls.length, 0);
  // HEAD keeps the same error mapping
  const missing = await g.app.fetch(attachmentRequest(31, 0, { method: "HEAD" }), g.env);
  assert.equal(missing.status, 404);
});

test("attachments: other methods are 405 with Allow: GET, HEAD", async () => {
  const g = await makeGoogleApp();
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const response = await g.app.fetch(attachmentRequest(2, 0, { method, body: method === "DELETE" ? undefined : "{}" }), g.env);
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get("Allow"), "GET, HEAD");
  }
  // HEAD is still refused on the other API routes
  assert.equal((await g.app.fetch(new Request(`${LOCAL}/api/records/2`, { method: "HEAD" }), g.env)).status, 405);
  assert.equal(g.driveCalls().length, 0);
});

test("attachments: Drive metadata is cached for 60 s (HEAD then GET = one files.get)", async () => {
  const g = await makeGoogleApp({ drive: { [PNG_ID]: { mimeType: "image/png", bytes: jpegBytes(20) } } });
  await g.app.fetch(attachmentRequest(2, 0, { method: "HEAD" }), g.env);
  await g.app.fetch(attachmentRequest(2, 0), g.env);
  const metaCalls = () => g.driveCalls().filter((c) => c.includes("fields=")).length;
  assert.equal(metaCalls(), 1);
  assert.equal(g.driveCalls().filter((c) => c.includes("alt=media")).length, 1);
  // After the TTL the metadata is fetched again
  g.advance(61 * 1000);
  await g.app.fetch(attachmentRequest(2, 0, { method: "HEAD" }), g.env);
  assert.equal(metaCalls(), 2);
});

test("attachments: fixture mode calls neither fetch nor transform and serves PNG/PDF bytes", async () => {
  let transformCalled = 0;
  const logs = [];
  const app = createApp({
    fetchFn: async () => { throw new Error("network disabled in tests"); },
    log: (entry) => logs.push(entry),
    makeTransform: () => async () => { transformCalled += 1; return new ArrayBuffer(1); },
  });
  const env = { ...DEV_ENV, IMAGES: {} };
  // PNG
  const png = await app.fetch(attachmentRequest(EX.attachments.image.rowNumber, 0, { headers: { Accept: IMG_ACCEPT } }), env);
  assert.equal(png.status, 200);
  assert.equal(png.headers.get("Content-Type"), EX.attachments.image.mimeType);
  assert.equal(png.headers.get("X-Attachment-Format"), EX.attachments.image.format);
  const pngBytes = new Uint8Array(await png.arrayBuffer());
  assert.deepEqual([...pngBytes.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.headers.get("Content-Length"), String(pngBytes.byteLength));
  // PDF
  const pdf = await app.fetch(attachmentRequest(EX.attachments.pdf.rowNumber, 0), env);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get("Content-Type"), "application/pdf");
  const pdfText = new TextDecoder().decode(await pdf.arrayBuffer());
  assert.ok(pdfText.startsWith("%PDF-1.4"));
  assert.ok(pdfText.trimEnd().endsWith("%%EOF"));
  // xref offset points at the xref keyword
  const startxref = Number(pdfText.match(/startxref\n(\d+)/)[1]);
  assert.equal(pdfText.slice(startxref, startxref + 4), "xref");
  // HEAD on the fixture
  const head = await app.fetch(attachmentRequest(EX.attachments.pdf.rowNumber, 0, { method: "HEAD" }), env);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("Content-Length"), String(new TextEncoder().encode(pdfText).byteLength));
  // Unshared fixture file -> attachment_unavailable
  const missing = await app.fetch(attachmentRequest(EX.attachments.unavailable.rowNumber, 0), env);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, "attachment_unavailable");
  // Never converted in fixture mode
  assert.equal(transformCalled, 0);
});

test("attachments: detail JSON lists attachments without file ids, search lists attachmentCount", async () => {
  const { app } = makeApp();
  const detail = await (await app.fetch(new Request(`${LOCAL}/api/records/${EX.attachments.image.rowNumber}`), DEV_ENV)).json();
  assert.equal(detail.attachmentFileIds, undefined);
  assert.deepEqual(detail.attachments.map((a) => [a.index, a.field, a.label, a.kind]), [[0, "name", "氏名のリンク", "drive"]]);
  const external = await (await app.fetch(new Request(`${LOCAL}/api/records/${EX.attachments.external.rowNumber}`), DEV_ENV)).json();
  assert.equal(external.attachments[0].url, EX.attachments.external.url);
  const search = await (await app.fetch(searchRequest(LOCAL, { pageSize: 200 }), DEV_ENV)).json();
  const withIcon = search.items.filter((item) => item.attachmentCount > 0).map((item) => item.rowNumber).sort((a, b) => a - b);
  assert.deepEqual(withIcon, EX.attachments.rowNumbers);
  // The summaries never carry ids or URLs
  const text = JSON.stringify(search);
  assert.ok(!text.includes("Fixture") && !text.includes("drive.google.com"));
});

test("attachments: log lines use the route template and never contain ids, row numbers or indexes", async () => {
  const g = await makeGoogleApp({ drive: { [PNG_ID]: { mimeType: "image/png", bytes: jpegBytes(20) }, [PDF_ID]: { status: 403 } } });
  await g.app.fetch(attachmentRequest(2, 0, { headers: { Accept: IMG_ACCEPT } }), { ...g.env, IMAGES: undefined });
  await g.app.fetch(attachmentRequest(15, 0, { method: "HEAD" }), g.env);
  await g.app.fetch(attachmentRequest(31, 0), g.env);
  const routeLines = g.logs.filter((e) => e.route !== undefined && e.event === undefined);
  assert.equal(routeLines.length, 3);
  for (const entry of routeLines) assert.equal(entry.route, ATTACHMENT_ROUTE_TEMPLATE);
  const text = g.logs.map((e) => JSON.stringify(e)).join("\n");
  for (const forbidden of [PNG_ID, PDF_ID, MISSING_ID, "/api/records/2", "/api/records/15", "/api/records/31", "attachments/0", "drive.google.com", '"size"', "filename"]) {
    assert.ok(!text.includes(forbidden), forbidden);
  }
});
