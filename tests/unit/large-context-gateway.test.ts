import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-large-context-gateway-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { setModelCapabilityOverride } = await import("../../src/lib/db/modelCapabilityOverrides.ts");
const { updateCompressionSettings } = await import("../../src/lib/db/compression.ts");
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.ts");

const TEST_PROVIDER = "test-large-context-prov";
const TEST_MODEL = "test-large-context-model";
const ENV_CONTEXT_LIMIT = "CONTEXT_LENGTH_TEST_LARGE_CONTEXT_PROV";

const originalFetch = globalThis.fetch;
const originalEnvContext = process.env[ENV_CONTEXT_LIMIT];

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.before(async () => {
  await resetStorage();
  // Window is 8000 tokens, but input-only cap is 4000 tokens
  process.env[ENV_CONTEXT_LIMIT] = "8000";

  await updateCompressionSettings({
    enabled: true,
    defaultMode: "standard",
  });

  setModelCapabilityOverride(`${TEST_PROVIDER}/${TEST_MODEL}`, "max_input_tokens", 4000);

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: Date.now(),
        model: TEST_MODEL,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok from upstream" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 3000, completion_tokens: 5, total_tokens: 3005 },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );
});

test.after(async () => {
  globalThis.fetch = originalFetch;
  if (originalEnvContext === undefined) {
    delete process.env[ENV_CONTEXT_LIMIT];
  } else {
    process.env[ENV_CONTEXT_LIMIT] = originalEnvContext;
  }
  await new Promise((r) => setTimeout(r, 200));
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function runRequest(messages: { role: string; content: string }[], info: string[]) {
  return handleChatCore({
    body: { model: TEST_MODEL, messages, stream: false },
    modelInfo: { provider: TEST_PROVIDER, model: TEST_MODEL, extendedContext: false },
    credentials: {
      apiKey: "test-key",
      providerSpecificData: { baseUrl: "https://test-compaction.example.test" },
    },
    clientRawRequest: {
      endpoint: "/v1/chat/completions",
      body: { model: TEST_MODEL, messages, stream: false },
      headers: new Headers({ accept: "application/json" }),
    },
    userAgent: "unit-test",
    isCombo: false,
    log: {
      debug() {},
      info(_tag: string, message: string) {
        info.push(message);
      },
      warn() {},
      error() {},
    },
  });
}

test("multi-megabyte packed context reaches upstream compacted without running optional engines", async () => {
  let upstreamBody = "";
  const fakeFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    upstreamBody = String(init?.body ?? "");
    return fakeFetch(url, init);
  };
  const info: string[] = [];
  const started = performance.now();
  const result = await runRequest(
    [
      { role: "system", content: "You are helpful" },
      {
        role: "user",
        content: "BEGIN_HISTORY " + "historical output\n".repeat(400_000) + " FINAL_TASK",
      },
    ],
    info
  );
  assert.equal(result.success, true, String((result as { error?: string }).error));
  assert.ok(
    upstreamBody.length < 32_000,
    `expected compact upstream payload, got ${upstreamBody.length}`
  );
  assert.match(upstreamBody, /FINAL_TASK/);
  assert.ok(info.some((message) => message.includes("optional compression engines bypassed")));
  assert.ok(performance.now() - started < 5_000);
  globalThis.fetch = fakeFetch;
});

test("oversized immutable instructions reject promptly before calling upstream", async () => {
  let calls = 0;
  const fakeFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("must not reach upstream");
  };
  const started = performance.now();
  const result = await runRequest(
    [
      { role: "system", content: "immutable instruction ".repeat(300_000) },
      { role: "user", content: "hi" },
    ],
    []
  );
  assert.equal(result.success, false);
  assert.equal(result.response.status, 400);
  assert.equal(calls, 0);
  assert.ok(performance.now() - started < 5_000);
  globalThis.fetch = fakeFetch;
});
