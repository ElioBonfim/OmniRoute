import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as flush } from "node:timers/promises";
import { ProxyFailoverMonitor } from "../../src/lib/proxyHealth/failover.ts";

const primary = { type: "http", host: "127.0.0.1", port: 9311 };
const backup = { type: "http", host: "127.0.0.1", port: 9312 };

function fixture() {
  let now = 0;
  const online = new Map([
    [primary.port, true],
    [backup.port, true],
  ]);
  const calls: number[] = [];
  const monitor = new ProxyFailoverMonitor({
    now: () => now,
    background: false,
    probe: async (proxy) => {
      calls.push(Number(proxy.port));
      return online.get(Number(proxy.port)) === true;
    },
  });
  return {
    monitor,
    online,
    calls,
    tick: async () => {
      now += 10_000;
      await monitor.sweep();
    },
    advance: (ms: number) => {
      now += ms;
    },
    select: () => monitor.select([primary, backup]),
  };
}

test("failover keeps the first healthy member across requests and elapsed rotation windows", async () => {
  const f = fixture();
  assert.equal(await f.select(), primary);
  for (let i = 0; i < 20; i++) assert.equal(await f.select(), primary);
  assert.equal(f.calls.length, 2, "fresh verdicts are shared across requests");
  f.advance(3_600_000);
  assert.equal(await f.select(), primary);
});

test("two consecutive failed probes select backup; three successes restore primary", async () => {
  const f = fixture();
  assert.equal(await f.select(), primary);
  f.online.set(primary.port, false);
  await f.tick();
  assert.equal(await f.select(), primary, "one failure must not flap the selection");
  await f.tick();
  assert.equal(await f.select(), backup);
  f.online.set(primary.port, true);
  await f.tick();
  assert.equal(await f.select(), backup);
  await f.tick();
  assert.equal(await f.select(), backup);
  await f.tick();
  assert.equal(await f.select(), primary);
});

test("both proxies down produce no selection, including a cold start", async () => {
  const f = fixture();
  f.online.set(primary.port, false);
  f.online.set(backup.port, false);
  assert.equal(await f.select(), null);
  assert.equal(await f.select(), null);
  assert.equal(f.calls.length, 2, "failed probes are not repeated per request");
});

test("interrupted recovery does not count non-consecutive successes", async () => {
  const f = fixture();
  await f.select();
  f.online.set(primary.port, false);
  await f.tick();
  await f.tick();
  f.online.set(primary.port, true);
  await f.tick();
  await f.tick();
  f.online.set(primary.port, false);
  await f.tick();
  f.online.set(primary.port, true);
  await f.tick();
  await f.tick();
  assert.equal(await f.select(), backup);
  await f.tick();
  assert.equal(await f.select(), primary);
});

test("concurrent cold requests share the same probes", async () => {
  const f = fixture();
  const selected = await Promise.all(Array.from({ length: 20 }, () => f.select()));
  assert.ok(selected.every((value) => value === primary));
  assert.equal(f.calls.length, 2);
});

test("probe latency does not skip the next ten-second check", async () => {
  let now = 0;
  let calls = 0;
  const monitor = new ProxyFailoverMonitor({
    background: false,
    now: () => now,
    probe: async () => {
      calls++;
      now += 100;
      return true;
    },
  });
  await monitor.select([primary, backup]);
  now = 10_200;
  await monitor.sweep();
  now = 20_200;
  await monitor.sweep();
  assert.equal(calls, 6);
});

test("a throwing probe is unavailable and never causes a direct request", async () => {
  const monitor = new ProxyFailoverMonitor({
    background: false,
    probe: async () => {
      throw new Error("unreachable");
    },
  });
  assert.equal(await monitor.select([primary, backup]), null);
});

test("the background timer detects failures without traffic and stops cleanly", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
  let primaryOnline = true;
  let calls = 0;
  const monitor = new ProxyFailoverMonitor({
    background: true,
    now: () => Date.now(),
    probe: async (proxy) => {
      calls++;
      return proxy.port === backup.port || primaryOnline;
    },
  });
  t.after(() => {
    monitor.stop();
    t.mock.timers.reset();
  });
  assert.equal(await monitor.select([primary, backup]), primary);
  primaryOnline = false;
  t.mock.timers.tick(10_000);
  await flush();
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(await monitor.select([primary, backup]), backup);
  monitor.stop();
  const before = calls;
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(calls, before);
});
