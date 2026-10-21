import { writeFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { ChatGptBrowserWorker } from "../../open-sse/vendor/codex-chatgpt-web/adapters/chatgpt-web/browser-worker.ts";
import { connectionRuntimePaths } from "../../open-sse/executors/chatgpt-web-codex/storageState.ts";
import { CHATGPT_ASSISTANT_TURN_SELECTOR, CHATGPT_STOP_BUTTON_SELECTOR } from "../../open-sse/vendor/codex-chatgpt-web/chatgpt-session.ts";
const output = "/Users/primage/.omniroute/operator/web-codex-six-models-20261021/renderer-preflight.json";
async function main() {
 const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
 const state = connectionRuntimePaths("2458f5b4-85be-4297-8026-e4ea9c50df46");
 const context = await browser.newContext({ storageState: state.storageStatePath });
 try {
  await context.addInitScript("globalThis.__name = (target) => target;");
  const page = await context.newPage();await page.goto("https://chatgpt.com/c/6ad8505a-5294-83e9-a13a-8081a7c62ba9", { waitUntil: "domcontentloaded" });
  const turn = page.locator(CHATGPT_ASSISTANT_TURN_SELECTOR).last();await turn.waitFor({ state: "attached", timeout: 30000 });
  const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
  const snapshot = await worker.responseDomSnapshot(turn);
  writeFileSync(output, JSON.stringify({ ok: snapshot.responsePresent, assistantContainers: await page.locator(CHATGPT_ASSISTANT_TURN_SELECTOR).count(), responsePresent: snapshot.responsePresent, textChars: snapshot.visibleText.length, completionActionVisible: snapshot.completionActionVisible, running: await page.locator(CHATGPT_STOP_BUTTON_SELECTOR).filter({ visible: true }).count(), traceBlocks: snapshot.traceBlocks.length }, null, 2));
 } finally { await context.close(); }
}
main().then(() => process.exit(0)).catch(error => { writeFileSync(output, JSON.stringify({ ok: false, error: String(error) }));process.exit(1); });
