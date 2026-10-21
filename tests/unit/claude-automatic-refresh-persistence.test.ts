import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-auto-refresh-"));
process.env.DATA_DIR = dir;
process.env.NODE_ENV = "test";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.OAUTH_REFRESH_SPACING_MS = "0";
const core = await import("../../src/lib/db/core.ts");
const db = await import("../../src/lib/db/providers.ts");
const health = await import("../../src/lib/tokenHealthCheck.ts");
const refresh = await import("../../open-sse/services/tokenRefresh.ts");
const rotation = await import("../../open-sse/services/tokenRefresh/rotationMap.ts");
const serializer = await import("../../open-sse/services/refreshSerializer.ts");
const { DefaultExecutor } = await import("../../open-sse/executors/default.ts");
const { refreshAndUpdateCredentialsWithResolver } =
  await import("../../src/lib/usage/providerLimits/credentialRefresh.ts");
const originalFetch = globalThis.fetch;
test.after(() => {
  globalThis.fetch = originalFetch;
  health.stopTokenHealthCheck();
  serializer.setRefreshLaneMaxMsForTest(null);
  core.resetDbInstance();
  fs.rmSync(dir, { recursive: true, force: true });
});
async function row(name: string) {
  return db.createProviderConnection({
    provider: "claude",
    authType: "oauth",
    name,
    isActive: true,
    testStatus: "active",
    healthCheckInterval: 60,
    accessToken: name + "-access-0",
    refreshToken: name + "-refresh-0",
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    tokenExpiresAt: new Date(Date.now() + 60000).toISOString(),
  });
}
test("automatic sweep saves each rotated refresh token and reuses it on the next renewal", async () => {
  const conn = await row("automatic");
  const used: string[] = [];
  globalThis.fetch = async (_url, opts) => {
    used.push(new URLSearchParams(String(opts?.body)).get("refresh_token") || "");
    const n = used.length;
    return new Response(
      JSON.stringify({
        access_token: "automatic-access-" + n,
        refresh_token: "automatic-refresh-" + n,
        expires_in: 28800,
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  await health.checkConnection(conn);
  let saved = await db.getProviderConnectionById(conn.id);
  assert.equal(saved.refreshToken, "automatic-refresh-1");
  assert.equal(saved.expiresAt, saved.tokenExpiresAt);
  assert.ok(saved.lastHealthCheckAt);
  const near = new Date(Date.now() + 60000).toISOString();
  await db.updateProviderConnection(conn.id, { expiresAt: near, tokenExpiresAt: near });
  await health.checkConnection(conn); // stale caller snapshot must be ignored
  saved = await db.getProviderConnectionById(conn.id);
  assert.deepEqual(used, ["automatic-refresh-0", "automatic-refresh-1"]);
  assert.equal(saved.refreshToken, "automatic-refresh-2");
  assert.equal(saved.testStatus, "active");
  assert.equal(saved.expiresAt, saved.tokenExpiresAt);
  assert.ok(Date.parse(saved.expiresAt) > Date.now() + 28000000);
});
test("a recent rotation cache cannot overwrite newer persisted credentials", async () => {
  const conn = await row("cache");
  rotation.recordRotation("claude", conn.refreshToken, {
    accessToken: "obsolete-access",
    refreshToken: "obsolete-refresh",
    expiresIn: 28800,
  });
  const future = new Date(Date.now() + 28800000).toISOString();
  await db.updateProviderConnection(conn.id, {
    accessToken: "newest-access",
    refreshToken: "newest-refresh",
    expiresAt: future,
    tokenExpiresAt: future,
  });
  globalThis.fetch = async () => {
    throw new Error("must not contact upstream with stale credentials");
  };
  const result = await refresh.getAccessToken(
    "claude",
    { ...conn, connectionId: conn.id },
    null,
    null,
    async (tokens) => {
      await db.updateProviderConnection(conn.id, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      });
    }
  );
  assert.equal(result.accessToken, "newest-access");
  assert.equal((await db.getProviderConnectionById(conn.id)).refreshToken, "newest-refresh");
});
test("quota refresh shares the automatic refresh and persists inside its mutex", async () => {
  const conn = await row("quota");
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 20));
    return new Response(
      JSON.stringify({
        access_token: "quota-new-access",
        refresh_token: "quota-new-refresh",
        expires_in: 28800,
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  serializer.setRefreshLaneMaxMsForTest(150);
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    const result = await refreshAndUpdateCredentialsWithResolver(
      conn,
      async () => new DefaultExecutor("claude"),
      { allowRotatingRefresh: true }
    );
    assert.equal(result.refreshed, true);
    assert.equal(calls, 1);
    const saved = await db.getProviderConnectionById(conn.id);
    assert.equal(saved.refreshToken, "quota-new-refresh");
    assert.equal(saved.expiresAt, saved.tokenExpiresAt);
    assert.equal(result.connection.refreshToken, saved.refreshToken);
  } finally {
    clearTimeout(keepAlive);
    serializer.setRefreshLaneMaxMsForTest(null);
  }
});
test("simultaneous quota and automatic renewal make one exchange and keep the rotated token", async () => {
  const conn = await row("concurrent");
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 25));
    return new Response(
      JSON.stringify({
        access_token: "concurrent-new-access",
        refresh_token: "concurrent-new-refresh",
        expires_in: 28800,
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  const [, quota] = await Promise.all([
    health.checkConnection(conn),
    refreshAndUpdateCredentialsWithResolver(conn, async () => new DefaultExecutor("claude"), {
      allowRotatingRefresh: true,
    }),
  ]);
  assert.equal(calls, 1);
  const saved = await db.getProviderConnectionById(conn.id);
  assert.equal(saved.refreshToken, "concurrent-new-refresh");
  assert.equal(quota.connection.refreshToken, saved.refreshToken);
  assert.equal(saved.expiresAt, saved.tokenExpiresAt);
  assert.ok(saved.lastHealthCheckAt);
});
