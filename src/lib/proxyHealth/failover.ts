import { createHash } from "node:crypto";
import { fetch as proxyFetch } from "undici";
import {
  createProxyDispatcher,
  isRelayType,
  proxyConfigToUrl,
} from "@omniroute/open-sse/utils/proxyDispatcher";

export const PROXY_FAILOVER_INTERVAL_MS = 10_000;
const PROBE_TIMEOUT_MS = 5_000;
const STALE_AFTER_MS = 30_000;
const IDLE_AFTER_MS = 60_000;
const PROBE_CONCURRENCY = 2;
const PROBE_TARGET = "https://www.gstatic.com/generate_204";

export type FailoverProxy = Record<string, unknown>;
type Probe = (proxy: FailoverProxy) => Promise<boolean>;
type HealthEntry = {
  proxy: FailoverProxy;
  startedAt: number | null;
  checkedAt: number | null;
  lastUsedAt: number;
  initialized: boolean;
  healthy: boolean;
  failures: number;
  successes: number;
  inflight?: Promise<void>;
};

export class ProxyFailoverUnavailableError extends Error {
  readonly code = "PROXY_FAILOVER_UNAVAILABLE";
  readonly status = 503;

  constructor() {
    super("The assigned proxy failover pool is unavailable; direct egress is blocked.");
  }
}

/** Probe forwarding through the configured proxy, never through a direct fallback. */
export async function probeFailoverProxy(proxy: FailoverProxy): Promise<boolean> {
  try {
    if (isRelayType(String(proxy.type ?? ""))) return false;
    const url = proxyConfigToUrl(proxy);
    if (!url) return false;
    const response = await proxyFetch(PROBE_TARGET, {
      method: "HEAD",
      dispatcher: createProxyDispatcher(url),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      redirect: "error",
    });
    await response.body?.cancel();
    return response.status === 204;
  } catch {
    return false;
  }
}

/** Health is shared by endpoint; priority is always the caller's assignment order. */
export class ProxyFailoverMonitor {
  private readonly entries = new Map<string, HealthEntry>();
  private readonly probe: Probe;
  private readonly now: () => number;
  private readonly background: boolean;
  private timer?: ReturnType<typeof setInterval>;

  constructor(options: { probe?: Probe; now?: () => number; background?: boolean } = {}) {
    this.probe = options.probe ?? probeFailoverProxy;
    this.now = options.now ?? Date.now;
    this.background =
      options.background ??
      (process.env.NEXT_PHASE !== "phase-production-build" &&
        !/^(1|true|yes|on)$/i.test(process.env.OMNIROUTE_DISABLE_BACKGROUND_SERVICES ?? ""));
  }

  async select<T extends FailoverProxy>(proxies: T[]): Promise<T | null> {
    const tracked: Array<{ proxy: T; entry: HealthEntry }> = [];
    for (const proxy of proxies) {
      const entry = this.track(proxy);
      if (entry) tracked.push({ proxy, entry });
    }
    await this.probeEntries(tracked.map(({ entry }) => entry));
    this.start();
    const now = this.now();
    return (
      tracked.find(
        ({ entry }) =>
          entry.healthy && entry.checkedAt !== null && now - entry.checkedAt <= STALE_AFTER_MS
      )?.proxy ?? null
    );
  }

  async sweep(): Promise<void> {
    const now = this.now();
    const active = [...this.entries.values()].filter(
      (entry) => now - entry.lastUsedAt <= IDLE_AFTER_MS
    );
    if (active.length === 0) {
      this.stop();
      return;
    }
    await this.probeEntries(active);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private track(proxy: FailoverProxy): HealthEntry | null {
    let url: string | null;
    try {
      if (isRelayType(String(proxy.type ?? ""))) return null;
      url = proxyConfigToUrl(proxy);
    } catch {
      return null;
    }
    if (!url) return null;
    // A credential/family change gets fresh health; secrets never become log keys.
    const key = createHash("sha256").update(url).digest("hex");
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        proxy: { ...proxy },
        startedAt: null,
        checkedAt: null,
        lastUsedAt: this.now(),
        initialized: false,
        healthy: false,
        failures: 0,
        successes: 0,
      };
      this.entries.set(key, entry);
    }
    entry.lastUsedAt = this.now();
    return entry;
  }

  private async probeEntries(entries: HealthEntry[]): Promise<void> {
    for (let index = 0; index < entries.length; index += PROBE_CONCURRENCY) {
      await Promise.all(
        entries.slice(index, index + PROBE_CONCURRENCY).map((entry) => this.check(entry))
      );
    }
  }

  private async check(entry: HealthEntry): Promise<void> {
    if (entry.inflight) return entry.inflight;
    if (entry.startedAt !== null && this.now() - entry.startedAt < PROXY_FAILOVER_INTERVAL_MS)
      return;
    entry.startedAt = this.now();
    const probe = Promise.resolve()
      .then(() => this.probe(entry.proxy))
      .catch(() => false)
      .then((healthy) => {
        if (healthy) {
          entry.failures = 0;
          entry.successes++;
          if (!entry.initialized || entry.successes >= 3) entry.healthy = true;
        } else {
          entry.successes = 0;
          entry.failures++;
          if (entry.failures >= 2) entry.healthy = false;
        }
        entry.initialized = true;
        entry.checkedAt = this.now();
      });
    entry.inflight = probe;
    try {
      await probe;
    } finally {
      entry.inflight = undefined;
    }
  }

  private start(): void {
    if (!this.background || this.timer || this.entries.size === 0) return;
    this.timer = setInterval(() => {
      void this.sweep().catch(() => console.error("[ProxyFailover] Health sweep failed"));
    }, PROXY_FAILOVER_INTERVAL_MS);
    this.timer.unref();
  }
}

// Keep one monitor across Next.js route bundles and development reloads.
const shared = globalThis as typeof globalThis & { __proxyFailoverMonitor?: ProxyFailoverMonitor };
export function getProxyFailoverMonitor(): ProxyFailoverMonitor {
  return (shared.__proxyFailoverMonitor ??= new ProxyFailoverMonitor());
}

export function __setProxyFailoverMonitorForTesting(monitor: ProxyFailoverMonitor | null): void {
  shared.__proxyFailoverMonitor?.stop();
  shared.__proxyFailoverMonitor = monitor ?? undefined;
}
