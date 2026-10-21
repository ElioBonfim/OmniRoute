import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-retest-"));
process.env.DATA_DIR = dir;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.OMNIROUTE_DISABLE_CREDENTIAL_HEALTH_CHECK = "true";
const core = await import("../../src/lib/db/core.ts");
const { createProviderConnection, getProviderConnectionById } =
  await import("../../src/lib/db/providers.ts");
const { testOAuthConnection, testSingleConnection } =
  await import("../../src/app/api/providers/[id]/test/route.ts");
test.after(() => {
  core.resetDbInstance();
  fs.rmSync(dir, { recursive: true, force: true });
});
test("expired rotating credentials are not validated just because a refresh token exists", async () => {
  const result = await testOAuthConnection({
    provider: "claude",
    accessToken: "synthetic",
    refreshToken: "synthetic",
    expiresAt: "2020-01-01T00:00:00Z",
  });
  assert.equal(result.valid, false);
  assert.match(result.error || "", /expired/i);
});
test("retest persists valid state and preserves synchronized expiry across reloads", async () => {
  const expiry = new Date(Date.now() + 3600000).toISOString();
  const row = await createProviderConnection({
    provider: "claude",
    authType: "oauth",
    name: "regression",
    accessToken: "synthetic",
    expiresAt: expiry,
    tokenExpiresAt: expiry,
    isActive: true,
    testStatus: "expired",
    errorCode: "expired",
  });
  const result = await testSingleConnection(row.id);
  assert.equal(result.valid, true);
  const saved = await getProviderConnectionById(row.id);
  assert.equal(saved.testStatus, "active");
  assert.equal(saved.errorCode ?? null, null);
  assert.equal(saved.expiresAt, expiry);
  assert.equal(saved.tokenExpiresAt, expiry);
  assert.ok(saved.lastTested);
});
test("expired credentials remain failed after retest and database reload", async () => {
  const row = await createProviderConnection({
    provider: "claude",
    authType: "oauth",
    name: "expired",
    accessToken: "synthetic",
    refreshToken: "synthetic",
    expiresAt: "2020-01-01T00:00:00Z",
    isActive: false,
    testStatus: "expired",
  });
  const result = await testSingleConnection(row.id);
  assert.equal(result.valid, false);
  const saved = await getProviderConnectionById(row.id);
  assert.notEqual(saved.testStatus, "active");
  assert.equal(saved.isActive, false);
});
test("explicit Claude retest rotates and saves both expiry fields before returning", async () => {
  const row = await createProviderConnection({
    provider: "claude",
    authType: "oauth",
    name: "refresh",
    accessToken: "synthetic-old",
    refreshToken: "synthetic-refresh",
    expiresAt: "2020-01-01T00:00:00Z",
    tokenExpiresAt: "2020-01-01T00:00:00Z",
    isActive: true,
    testStatus: "expired",
  });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        access_token: "synthetic-new",
        refresh_token: "synthetic-rotated",
        expires_in: 3600,
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  try {
    const result = await testSingleConnection(row.id, undefined, { allowClaudeRefresh: true });
    assert.equal(result.valid, true);
    assert.equal(result.refreshed, true);
    const saved = await getProviderConnectionById(row.id);
    assert.equal(saved.accessToken, "synthetic-new");
    assert.equal(saved.refreshToken, "synthetic-rotated");
    assert.equal(saved.testStatus, "active");
    assert.equal(saved.expiresAt, saved.tokenExpiresAt);
    assert.ok(Date.parse(saved.expiresAt) > Date.now() + 3500000);
    assert.equal("newTokens" in result, false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
test("a consumed refresh token cannot be reactivated by manual retest", async () => {
  const row = await createProviderConnection({
    provider: "claude",
    authType: "oauth",
    name: "consumed",
    accessToken: "synthetic-consumed-access",
    refreshToken: "synthetic-consumed-refresh",
    expiresAt: "2020-01-01T00:00:00Z",
    isActive: false,
    testStatus: "expired",
  });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "invalid_grant" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  try {
    const result = await testSingleConnection(row.id, undefined, { allowClaudeRefresh: true });
    assert.equal(result.valid, false);
    const saved = await getProviderConnectionById(row.id);
    assert.equal(saved.isActive, false);
    assert.notEqual(saved.testStatus, "active");
  } finally {
    globalThis.fetch = previousFetch;
  }
});
