import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-pool-failover-"));
process.env.DATA_DIR = dir;
process.env.OMNIROUTE_DISABLE_BACKGROUND_SERVICES = "true";
process.env.API_KEY_SECRET = "test-secret";

const core = await import("../../src/lib/db/core.ts");
const proxies = await import("../../src/lib/db/proxies.ts");
const providers = await import("../../src/lib/db/providers.ts");
const settings = await import("../../src/lib/db/settings.ts");
const { proxyRotationStrategySchema } =
  await import("../../src/shared/validation/schemas/proxy.ts");
const failover = await import("../../src/lib/proxyHealth/failover.ts");
const { safeResolveProxy } = await import("../../src/sse/handlers/chatHelpers.ts");
const { resolveProxyForCredentials } = await import("../../src/sse/services/tokenRefresh.ts");

let now = 0;
const online = new Map<number, boolean>();
let monitor: InstanceType<typeof failover.ProxyFailoverMonitor>;

test.beforeEach(() => {
  core.resetDbInstance();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  settings.bumpProxyConfigGeneration();
  now = 0;
  online.clear();
  monitor = new failover.ProxyFailoverMonitor({
    background: false,
    now: () => now,
    probe: async (proxy) => online.get(Number(proxy.port)) === true,
  });
  failover.__setProxyFailoverMonitorForTesting(monitor);
});

test.after(() => {
  failover.__setProxyFailoverMonitorForTesting(null);
  core.resetDbInstance();
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.PROXY_FAIL_OPEN;
});

async function setup() {
  const connection = await providers.createProviderConnection({
    provider: "agy",
    authType: "oauth",
    name: "Test account",
    accessToken: "test-token",
  });
  const primary = await proxies.createProxy({
    name: "Primary",
    type: "https",
    host: "127.0.0.1",
    port: 9431,
  });
  const backup = await proxies.createProxy({
    name: "Backup",
    type: "http",
    host: "127.0.0.1",
    port: 9432,
  });
  online.set(9431, true);
  online.set(9432, true);
  const id = String(connection.id);
  await proxies.addProxyToScopePool("account", id, primary.id);
  await proxies.addProxyToScopePool("account", id, backup.id);
  await proxies.setScopeRotationStrategy("account", id, "failover");
  return { id, primary, backup };
}

async function tick() {
  now += 10_000;
  await monitor.sweep();
}

test("API schema accepts failover and rejects unknown strategies", () => {
  assert.equal(
    proxyRotationStrategySchema.safeParse({
      scope: "global",
      strategy: "failover",
    }).success,
    true
  );
  assert.equal(
    proxyRotationStrategySchema.safeParse({
      scope: "global",
      strategy: "unknown",
    }).success,
    false
  );
});

test("chat resolution keeps primary, switches to backup and returns after recovery", async () => {
  const { id } = await setup();
  assert.equal((await settings.resolveProxyForConnection(id)).proxy?.port, 9431);
  assert.equal((await settings.resolveProxyForConnection(id)).strategy, "failover");
  online.set(9431, false);
  await tick();
  await tick();
  assert.equal((await settings.resolveProxyForConnection(id)).proxy?.port, 9432);
  online.set(9431, true);
  await tick();
  await tick();
  assert.equal((await settings.resolveProxyForConnection(id)).proxy?.port, 9432);
  await tick();
  assert.equal((await settings.resolveProxyForConnection(id)).proxy?.port, 9431);
});

test("exhausted account pool blocks chat and refresh despite a healthy global proxy", async () => {
  const { id } = await setup();
  const global = await proxies.createProxy({
    name: "Other global",
    type: "http",
    host: "127.0.0.1",
    port: 9433,
  });
  await proxies.addProxyToScopePool("global", null, global.id);
  online.set(9431, false);
  online.set(9432, false);
  online.set(9433, true);
  process.env.PROXY_FAIL_OPEN = "true";
  for (const resolve of [
    () => safeResolveProxy(id),
    () => resolveProxyForCredentials("agy", { connectionId: id }),
    () => proxies.resolveProxyForConnectionFromRegistry(id),
  ]) {
    await assert.rejects(resolve, { code: "PROXY_FAILOVER_UNAVAILABLE" });
  }
});

test("disabled members never revive through failover probing", async () => {
  const { id, primary, backup } = await setup();
  await proxies.updateProxy(primary.id, { status: "disabled" });
  assert.equal((await settings.resolveProxyForConnection(id)).proxy?.port, 9432);
  await proxies.updateProxy(backup.id, { status: "disabled" });
  await assert.rejects(() => settings.resolveProxyForConnection(id), {
    code: "PROXY_FAILOVER_UNAVAILABLE",
  });
});

test("a configured but empty failover scope preserves explicit unassignment", async () => {
  await proxies.setScopeRotationStrategy("global", null, "failover");
  assert.equal(await proxies.resolveProxyForScopeFromRegistry("global"), null);
});

test("a failed global failover proxy never retries provider usage directly", async () => {
  const { fetchAndPersistProviderLimits } = await import("../../src/lib/usage/providerLimits.ts");
  const connection = await providers.createProviderConnection({
    provider: "github",
    authType: "oauth",
    name: "Test usage account",
    accessToken: "test-access-token",
    refreshToken: "test-refresh-token",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const proxy = await proxies.createProxy({
    name: "Probe passed before transport failed",
    type: "http",
    host: "127.0.0.1",
    port: 1,
  });
  online.set(1, true);
  await proxies.addProxyToScopePool("global", null, proxy.id);
  await proxies.setScopeRotationStrategy("global", null, "failover");
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Promise<Response>(() => {});
  };
  try {
    await assert.rejects(
      () => fetchAndPersistProviderLimits(String(connection.id), "manual"),
      /Proxy unreachable|fetch failed|ECONNREFUSED|UND_ERR_CONNECT_TIMEOUT/i
    );
    assert.ok(calls <= 1, "a failed optimistic request must never be retried directly");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
