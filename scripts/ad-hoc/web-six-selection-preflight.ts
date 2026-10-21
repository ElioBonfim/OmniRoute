import { writeFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { ChatGptBrowserWorker } from "../../open-sse/vendor/codex-chatgpt-web/adapters/chatgpt-web/browser-worker.ts";
import { connectionRuntimePaths } from "../../open-sse/executors/chatgpt-web-codex/storageState.ts";
const output = "/Users/primage/.omniroute/operator/web-codex-six-models-20261021/selection-preflight.json";
const paths = connectionRuntimePaths("2458f5b4-85be-4297-8026-e4ea9c50df46");
const records: object[] = [];
async function main() {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
  const context = await browser.newContext({ storageState: paths.storageStatePath });
  try {
    await context.addInitScript("globalThis.__name = (target) => target;");
    const page = await context.newPage();
    await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded" });
    const worker = ChatGptBrowserWorker.forProvider({ adapter: "chatgpt-web", baseUrl: "https://chatgpt.com", models: ["gpt-5.6-sol"], defaultModel: "gpt-5.6-sol", chatgptWeb: { cdpEndpoint: "http://127.0.0.1:9223", storageStatePath: paths.storageStatePath } } as never);
    for (const family of ["6", "5.6"] as const) for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      try {
        const mode = await (worker as any).selectModelAndEffort(page, "gpt-5.6-sol", effort, { solAvailable: true, proAvailable: true }, undefined, family);
        records.push({ family, effort, ok: true, label: mode.selection?.label });
      } catch (error) { records.push({ family, effort, ok: false, error: String(error) }); }
      writeFileSync(output, JSON.stringify({ state: "running", records }, null, 2));
    }
  } finally { await context.close(); }
  writeFileSync(output, JSON.stringify({ state: "done", ok: records.length === 10 && records.every((r: any) => r.ok), records }, null, 2));
}
main().then(() => process.exit(0)).catch(error => { writeFileSync(output, JSON.stringify({ state: "failed", error: String(error), records }, null, 2)); process.exit(1); });
