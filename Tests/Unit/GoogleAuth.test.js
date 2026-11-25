// Unit tests for the Google OAuth scopes (Design §10-1, §10-8)
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildClaims, GOOGLE_SCOPES, TOKEN_URL } from "../../Src/GoogleAuth.js";

test("claims request exactly spreadsheets.readonly and drive.readonly", () => {
  const claims = buildClaims("unit@test.iam.gserviceaccount.com", 1_800_000_000);
  const scopes = claims.scope.split(" ");
  assert.deepEqual(scopes, [
    "https://www.googleapis.com/auth/spreadsheets.readonly",
    "https://www.googleapis.com/auth/drive.readonly",
  ]);
  assert.equal(claims.scope, GOOGLE_SCOPES);
  // Every scope is read-only; no write scope sneaks in
  for (const scope of scopes) assert.match(scope, /\.readonly$/);
  assert.ok(!scopes.includes("https://www.googleapis.com/auth/spreadsheets"));
  assert.ok(!scopes.includes("https://www.googleapis.com/auth/drive"));
  assert.ok(!scopes.includes("https://www.googleapis.com/auth/drive.file"));
  // The rest of the claim set is unchanged
  assert.equal(claims.aud, TOKEN_URL);
  assert.equal(claims.iss, "unit@test.iam.gserviceaccount.com");
  assert.equal(claims.exp - claims.iat, 3600);
});
