import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import type { Browser, Page } from "playwright-core";
import {
  eligibleOwnedConversations,
  markOwnedConversationDeleted,
  readOwnedConversations,
  type OwnedConversation,
} from "../../open-sse/vendor/codex-chatgpt-web/adapters/chatgpt-web/owned-conversations.ts";

interface Config {
  version: 1;
  retentionHours: 12;
  timeZone: "America/Sao_Paulo";
  storageStatePath: string;
  expectedAccountId: string;
  servicePlist: string;
  routerHealthUrl: string;
  auditPath: string;
}

function audit(config: Config, event: Record<string, unknown>): void {
  appendFileSync(
    config.auditPath,
    JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n",
    { mode: 0o600 }
  );
}

async function routerIdle(config: Config): Promise<boolean> {
  const response = await fetch(config.routerHealthUrl, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error("Cannot verify active OmniRoute requests");
  const body = (await response.json()) as { active?: number };
  if (typeof body.active !== "number" || !Number.isFinite(body.active) || body.active < 0) {
    throw new Error("OmniRoute health has no valid active request count");
  }
  return body.active === 0;
}

async function assertAccount(page: Page, config: Config): Promise<void> {
  const id = await page.evaluate(async () => {
    const response = await fetch("/api/auth/session");
    if (!response.ok) return undefined;
    const session = await response.json();
    return session.user?.id as string | undefined;
  });
  if (!id || id !== config.expectedAccountId)
    throw new Error("ChatGPT account mismatch or expired login; no deletion allowed");
}

function conversationId(url: string): string | undefined {
  const value = new URL(url);
  if (value.origin !== "https://chatgpt.com") return undefined;
  return /^\/c\/([A-Za-z0-9-]{1,100})\/?$/.exec(value.pathname)?.[1];
}

async function assertTarget(page: Page, record: OwnedConversation): Promise<void> {
  if (conversationId(page.url()) !== record.id)
    throw new Error("Conversation URL changed; refusing deletion");
  const title = await page.title();
  if (title !== record.title && title !== record.title + " - ChatGPT") {
    throw new Error("Conversation title no longer matches its ownership record; refusing deletion");
  }
}

async function openDeleteDialog(page: Page, record: OwnedConversation): Promise<void> {
  await page.goto(`https://chatgpt.com/c/${record.id}`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.locator('[contenteditable="true"]').first().waitFor({ timeout: 30000 });
  await assertTarget(page, record);
  const more = page.getByRole("button", { name: /^(More|Mais)$/ }).filter({ visible: true });
  if ((await more.count()) !== 1) throw new Error("Expected one conversation menu");
  await more.click({ timeout: 5000 });
  await page.getByRole("menuitem", { name: /^(Delete|Excluir)$/ }).click({ timeout: 5000 });
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ timeout: 5000 });
  if (!(await dialog.innerText()).includes(record.title)) {
    await dialog.getByRole("button", { name: /^(Cancel|Cancelar)$/ }).click();
    throw new Error("Delete dialog did not identify the owned conversation");
  }
  await assertTarget(page, record);
}

function mutationTargets(
  response: { url(): string; request(): { method(): string; postData(): string | null } },
  id: string
): boolean {
  const url = new URL(response.url());
  const request = response.request();
  return (
    url.origin === "https://chatgpt.com" &&
    ["PATCH", "DELETE"].includes(request.method()) &&
    (url.pathname.split("/").includes(id) || Boolean(request.postData()?.includes(id)))
  );
}

async function run(): Promise<void> {
  const arg = process.argv.indexOf("--config");
  if (arg < 0 || !process.argv[arg + 1])
    throw new Error("Use --config <private config.json> [--apply | --verify-ui]");
  const config = JSON.parse(readFileSync(process.argv[arg + 1]!, "utf8")) as Config;
  if (
    config.version !== 1 ||
    config.retentionHours !== 12 ||
    config.timeZone !== "America/Sao_Paulo" ||
    !config.expectedAccountId ||
    !config.storageStatePath ||
    !config.auditPath ||
    !config.routerHealthUrl.startsWith("http://127.0.0.1:")
  )
    throw new Error("Invalid cleanup configuration");
  const apply = process.argv.includes("--apply"),
    verify = process.argv.includes("--verify-ui");
  if (apply && verify) throw new Error("UI verification cannot delete conversations");
  mkdirSync(dirname(config.auditPath), { recursive: true, mode: 0o700 });
  const lock = join(dirname(config.auditPath), "cleanup.lock");
  if (existsSync(lock)) {
    const previous = Number(readFileSync(lock, "utf8").trim());
    if (!Number.isSafeInteger(previous) || previous <= 0)
      throw new Error("Invalid cleanup lock; inspect it before retrying");
    try {
      process.kill(previous, 0);
      console.log(JSON.stringify({ skipped: "already-running" }));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      unlinkSync(lock);
    }
  }
  const fd = openSync(lock, "wx", 0o600);
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
  let browser: Browser | undefined;
  try {
    const records = readOwnedConversations(config.storageStatePath);
    const eligible = eligibleOwnedConversations(records);
    audit(config, {
      event: "started",
      apply,
      registered: records.length,
      eligible: eligible.length,
    });
    if (!(await routerIdle(config))) {
      audit(config, { event: "skipped", reason: "active-requests" });
      console.log(JSON.stringify({ skipped: "active-requests", deleted: 0 }));
      return;
    }
    if ((!apply && !verify) || (!eligible.length && !verify)) {
      console.log(
        JSON.stringify({
          dryRun: !apply,
          registered: records.length,
          eligible: eligible.length,
          deleted: 0,
        })
      );
      return;
    }
    const service = JSON.parse(
      execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", config.servicePlist], {
        encoding: "utf8",
      })
    );
    const require = createRequire(join(service.WorkingDirectory, "package.json"));
    const { chromium } = require("playwright-core") as typeof import("playwright-core");
    browser = await chromium.connectOverCDP(service.EnvironmentVariables.CHATGPT_WEB_CODEX_CDP_URL);
    const openIds = new Set(
      browser
        .contexts()
        .flatMap((context) => context.pages())
        .flatMap((page) => {
          try {
            const id = conversationId(page.url());
            return id ? [id] : [];
          } catch {
            return [];
          }
        })
    );
    // Never use the default/operator browser context or its pages.
    const context = await browser.newContext({ storageState: config.storageStatePath });
    let deleted = 0,
      skipped = 0,
      failed = 0;
    try {
      const page = await context.newPage();
      await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.locator('[contenteditable="true"]').first().waitFor({ timeout: 30000 });
      await assertAccount(page, config);
      const targets = verify ? records.filter((r) => r.status === "finished").slice(-1) : eligible;
      if (verify && !targets.length)
        throw new Error("No registered conversation available for UI verification");
      for (const record of targets) {
        if (openIds.has(record.id)) {
          skipped++;
          audit(config, { event: "skipped", id: record.id, reason: "open-browser-page" });
          continue;
        }
        if (!(await routerIdle(config))) {
          audit(config, { event: "deferred", reason: "active-requests" });
          skipped += targets.length - deleted - failed - skipped;
          break;
        }
        try {
          await openDeleteDialog(page, record);
          await assertAccount(page, config);
          if (!apply) {
            await page
              .getByRole("dialog")
              .getByRole("button", { name: /^(Cancel|Cancelar)$/ })
              .click();
            audit(config, { event: "verified-dialog-without-deletion", id: record.id });
            continue;
          }
          // Recheck the persisted age and activity immediately before confirmation.
          const current = readOwnedConversations(config.storageStatePath).find(
            (r) => r.id === record.id
          );
          if (
            !current ||
            current.title !== record.title ||
            !eligibleOwnedConversations([current]).length ||
            !(await routerIdle(config))
          ) {
            await page
              .getByRole("dialog")
              .getByRole("button", { name: /^(Cancel|Cancelar)$/ })
              .click();
            skipped++;
            audit(config, { event: "skipped", id: record.id, reason: "eligibility-changed" });
            continue;
          }
          await assertTarget(page, record);
          const mutation = page.waitForResponse(
            (response) => mutationTargets(response, record.id),
            { timeout: 15000 }
          );
          const [, response] = await Promise.all([
            page
              .getByRole("dialog")
              .getByRole("button", { name: /^(Delete(?: chat)?|Excluir(?: chat)?)$/ })
              .click(),
            mutation,
          ]);
          if (!response.ok())
            throw new Error(`ChatGPT deletion returned HTTP ${response.status()}`);
          await page.waitForURL((url) => conversationId(url.href) !== record.id, {
            timeout: 15000,
          });
          markOwnedConversationDeleted(config.storageStatePath, record);
          deleted++;
          audit(config, { event: "deleted", id: record.id });
        } catch (error) {
          failed++;
          audit(config, {
            event: "failed",
            id: record.id,
            error: error instanceof Error ? error.message : String(error),
          });
          await page.keyboard.press("Escape").catch(() => {});
        }
      }
      audit(config, { event: "finished", deleted, skipped, failed, verify });
      console.log(
        JSON.stringify({
          registered: records.length,
          eligible: eligible.length,
          deleted,
          skipped,
          failed,
          verify,
        })
      );
      if (failed) process.exitCode = 1;
    } finally {
      await context.close();
    }
  } catch (error) {
    audit(config, {
      event: "aborted",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    try {
      if (browser) await browser.close();
    } finally {
      unlinkSync(lock);
    }
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
