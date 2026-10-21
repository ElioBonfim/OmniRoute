import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-context-manager-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = TEST_DATA_DIR;

const { compressContext, estimateTokens, getTokenLimit } =
  await import("../../open-sse/services/contextManager.ts");
const core = await import("../../src/lib/db/core.ts");
const { prepareLargeContext } =
  await import("../../open-sse/handlers/chatCore/largeContextPreflight.ts");

test.after(() => {
  core.resetDbInstance();
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("compressContext: oversized two-message context fits without discarding instructions or task endpoints", () => {
  const task = "BEGIN_TASK\n" + "historical output\n".repeat(400_000) + "\nFINAL_TASK";
  const body = {
    messages: [
      { role: "system", content: "Always preserve this instruction." },
      { role: "user", content: task },
    ],
  };
  const started = performance.now();
  const result = compressContext(body, { maxTokens: 80_000, reserveTokens: 0 });
  assert.ok(estimateTokens(result.body.messages) <= 80_000);
  assert.ok(result.compressed);
  assert.equal(result.body.messages[0].content, body.messages[0].content);
  const text = String(result.body.messages[1].content);
  assert.ok(text.startsWith("BEGIN_TASK"));
  assert.ok(text.endsWith("FINAL_TASK"));
  assert.match(text, /context compacted/i);
  assert.equal(body.messages[1].content, task);
  assert.ok(
    performance.now() - started < 3_000,
    "multi-megabyte context must compact in bounded time"
  );
});

test("compressContext: compacts text blocks while preserving media and tool argument JSON", () => {
  const image = { type: "image_url", image_url: { url: "https://example.com/image.png" } };
  const call = {
    id: "tool-1",
    type: "function",
    function: { name: "read", arguments: JSON.stringify({ key: "x".repeat(1000) }) },
  };
  const body = {
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "start " + 'á😀\\"\n'.repeat(80_000) + " end" }, image],
        tool_calls: [call],
      },
      { role: "tool", tool_call_id: "tool-1", content: "done" },
    ],
  };
  const result = compressContext(body, { maxTokens: 4_000, reserveTokens: 0 });
  assert.ok(estimateTokens(result.body.messages) <= 4_000);
  const assistant = result.body.messages.find((message) => message.role === "assistant");
  assert.deepEqual(assistant.content[1], image);
  assert.deepEqual(assistant.tool_calls, [call]);
});

test("compressContext: cannot fit immutable instructions and does not report fictitious savings", () => {
  const body = {
    messages: [
      { role: "developer", content: "instruction ".repeat(10_000) },
      { role: "user", content: "go" },
    ],
  };
  const result = compressContext(body, { maxTokens: 100, reserveTokens: 0 });
  assert.equal(result.body.messages[0].content, body.messages[0].content);
  assert.ok(estimateTokens(result.body.messages) > 100);
  assert.equal(result.compressed, false);
});

test("large-context preflight: fits packed history before optional engines and reserves tool schemas", () => {
  const body = {
    messages: [
      { role: "system", content: "preserve" },
      { role: "user", content: "BEGIN " + "log output\n".repeat(620_000) + " FINAL_TASK" },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "read",
          parameters: { type: "object", description: "schema ".repeat(2000) },
        },
      },
    ],
  };
  const result = prepareLargeContext(body, {
    ceiling: 872_000,
    allowCompaction: true,
    provider: "codex",
    model: "gpt-5.6-sol-high",
  });
  assert.equal(result.skipOptionalCompression, true);
  assert.ok(result.finalTokens < 872_000);
  assert.ok(result.finalTokens < result.originalTokens);
  assert.deepEqual(result.body.tools, body.tools);
});

test("large-context preflight: honors compression opt-out and preserves normal requests", () => {
  for (const size of [100, 600_000]) {
    const body = { messages: [{ role: "user", content: "a".repeat(size) }] };
    const result = prepareLargeContext(body, {
      ceiling: 1000,
      allowCompaction: false,
      provider: "codex",
      model: "gpt-5.6-sol-high",
    });
    assert.equal(result.body, body);
    assert.equal(result.skipOptionalCompression, size > 512_000);
  }
});

test("large-context preflight: Responses input restores compacted text and top-level instructions", () => {
  const body = {
    instructions: "Keep this instruction",
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: "history ".repeat(100_000) + " FINAL_TASK" }],
      },
    ],
  };
  const result = prepareLargeContext(body, {
    ceiling: 8000,
    allowCompaction: true,
    provider: "openai",
    model: "gpt-5",
  });
  assert.equal(result.skipOptionalCompression, true);
  assert.ok(result.finalTokens < 8000);
  assert.equal(result.body.instructions, body.instructions);
  assert.ok(Array.isArray(result.body.input));
  assert.match(JSON.stringify(result.body.input), /FINAL_TASK/);
});

// ─── estimateTokens ─────────────────────────────────────────────────────────

test("estimateTokens: estimates from string", () => {
  assert.equal(estimateTokens("hello"), 2); // 5/4 = 2
  assert.ok(estimateTokens("a".repeat(100)) === 25);
});

test("estimateTokens: handles null", () => {
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens(""), 0);
});

// ─── getTokenLimit ──────────────────────────────────────────────────────────

test("getTokenLimit: detects claude", () => {
  assert.equal(getTokenLimit("claude", "claude-sonnet-4"), 200000);
});

test("getTokenLimit: detects gemini", () => {
  assert.equal(getTokenLimit("gemini", "gemini-2.5-pro"), 1048576);
});

test("getTokenLimit: uses GPT-5.5 Codex model context", () => {
  assert.equal(getTokenLimit("codex", "gpt-5.5"), 400000);
});

test("getTokenLimit: default fallback", () => {
  assert.equal(getTokenLimit("unknown"), 128000);
});

// Regression for #8496: hyperagent Claude-family agents (fable/opus/sonnet) must
// resolve to the 1M context window for every fallback model id, driven solely by
// the registry's `defaultContextLength` (open-sse/config/providers/registry/hyperagent) —
// not by a provider-unscoped model-name substring match, which previously collided
// with unrelated providers serving the same Claude model ids (see
// "getTokenLimit: does not force 1M onto non-hyperagent providers" below).
const HYPERAGENT_FALLBACK_MODEL_IDS = [
  "fable-latest",
  "claude-fable-5",
  "opus-latest",
  "claude-opus-4-8",
  "sonnet-latest",
  "claude-sonnet-5",
];

for (const modelId of HYPERAGENT_FALLBACK_MODEL_IDS) {
  test(`getTokenLimit: hyperagent/${modelId} resolves to 1M context`, () => {
    assert.equal(getTokenLimit("hyperagent", modelId), 1_000_000);
  });

  test(`getTokenLimit: ha (alias)/${modelId} resolves to 1M context`, () => {
    assert.equal(getTokenLimit("ha", modelId), 1_000_000);
  });
}

test("getTokenLimit: does not force 1M onto non-hyperagent providers serving the same model ids", () => {
  // windsurf used to pin this exact id at 200000, but its built-in provider entry was
  // retired (#8228 — replaced by devin-desktop). With no per-provider source left,
  // #11034 resolves the effort-suffixed variant via its BASE model (`claude-opus-4.7-max`
  // → `claude-opus-4.7` → canonical `claude-opus-4-7`), whose real catalog window IS 1M.
  // This is a legitimate base-model resolution, not the forbidden hyperagent default leak:
  // it comes from the shared model catalog, never from the hyperagent registry scope.
  assert.equal(getTokenLimit("windsurf", "claude-opus-4.7-max"), 1_000_000);
  // bluesminds still pins its own claude-opus-4-5 entry to 200000, and that pin must win
  // over both the name heuristic and any 1M window from sibling providers/catalogs.
  assert.equal(getTokenLimit("bluesminds", "claude-opus-4-5"), 200000);
});

// ─── compressContext ────────────────────────────────────────────────────────

test("compressContext: returns unchanged if fits", () => {
  const body = {
    model: "claude-sonnet-4",
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ],
  };
  const result = compressContext(body);
  assert.equal(result.compressed, false);
});

test("compressContext: default reserve scales down for smaller context windows", () => {
  const body = {
    model: "gpt-4",
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ],
  };

  const result = compressContext(body, { provider: "openai", maxTokens: 8192 });
  assert.equal(result.compressed, false);
  assert.equal(result.stats.final, result.stats.original);
});

test("compressContext: handles null/empty body", () => {
  assert.equal(compressContext(null).compressed, false);
  assert.equal(compressContext({}).compressed, false);
  assert.equal(compressContext({ messages: null }).compressed, false);
});

test("compressContext: Layer 1 — trims long tool messages", () => {
  const longContent = "x".repeat(10000);
  const body = {
    model: "test",
    messages: [
      { role: "user", content: "run tool" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "t1", type: "function", function: { name: "test_tool" } }],
      },
      { role: "tool", content: longContent, tool_call_id: "t1" },
      { role: "user", content: "done?" },
    ],
  };
  // Use target limit that allows the truncated tool message (~1000 tokens) to survive
  const result = compressContext(body, { maxTokens: 2000, reserveTokens: 100 });
  assert.ok(result.compressed);
  const toolMsg = (result.body.messages as Record<string, unknown>[]).find(
    (m) => m.role === "tool"
  );
  assert.ok(String(toolMsg.content).length < longContent.length);
  assert.ok(String(toolMsg.content).includes("[truncated]"));
});

test("compressContext: Layer 2 — compresses thinking in old messages", () => {
  const body = {
    model: "test",
    messages: [
      { role: "user", content: "q1" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "lots of thinking here ".repeat(500) },
          { type: "text", text: "answer1" },
        ],
      },
      { role: "user", content: "q2" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "more thinking" },
          { type: "text", text: "answer2" },
        ],
      },
    ],
  };
  const result = compressContext(body, { maxTokens: 2000, reserveTokens: 500 });
  // First assistant should have thinking removed
  const firstAssistant = (result.body.messages as Record<string, unknown>[]).find(
    (m) => m.role === "assistant"
  );
  if (Array.isArray(firstAssistant.content)) {
    const hasThinking = firstAssistant.content.some(
      (b: Record<string, unknown>) => b.type === "thinking"
    );
    assert.equal(hasThinking, false);
  }
});

test("compressContext: Layer 2 preserves prompt-format thinking tags in string content", () => {
  const body = {
    model: "test",
    messages: [
      { role: "user", content: "q1" },
      {
        role: "assistant",
        content: "<thinking>visible prompt protocol</thinking><content>answer1</content>",
      },
      { role: "user", content: "q2" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "lots of structured thinking here ".repeat(500) },
          { type: "text", text: "answer2" },
        ],
      },
      { role: "user", content: "q3" },
      { role: "assistant", content: "answer3" },
    ],
  };
  const result = compressContext(body, { maxTokens: 2000, reserveTokens: 500 });
  const firstAssistant = (result.body.messages as Record<string, unknown>[]).find(
    (m: Record<string, unknown>) => m.role === "assistant" && typeof m.content === "string"
  );

  assert.equal(
    firstAssistant.content,
    "<thinking>visible prompt protocol</thinking><content>answer1</content>"
  );
});

test("compressContext: Layer 3 — drops old messages to fit", () => {
  const messages = [
    { role: "system", content: "You are helpful" },
    ...Array.from({ length: 100 }, (_, i) => [
      { role: "user", content: `Message ${i}: ${"content ".repeat(50)}` },
      { role: "assistant", content: `Response ${i}: ${"answer ".repeat(50)}` },
    ]).flat(),
  ];
  const body = { model: "test", messages };
  const result = compressContext(body, { maxTokens: 3000, reserveTokens: 500 });
  assert.ok(result.compressed);
  assert.ok((result.body.messages as unknown[]).length < messages.length);
  assert.equal(result.body.messages[0].role, "system");
});

// ─── fixToolPairs (Layer 3 tool pair integrity) ─────────────────────────────

test("Layer 3: removes orphaned tool_result (OpenAI format) when tool_use is dropped", () => {
  const messages = [
    { role: "system", content: "system" },
    ...Array.from({ length: 40 }, (_, i) => [
      { role: "user", content: `User ${i}: ${"x".repeat(200)}` },
      { role: "assistant", content: `Asst ${i}: ${"y".repeat(200)}` },
    ]).flat(),
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_kept", type: "function", function: { name: "read_file" } }],
    },
    { role: "tool", tool_call_id: "call_kept", content: "file contents" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_dropped", type: "function", function: { name: "search" } }],
    },
    { role: "tool", tool_call_id: "call_dropped", content: "search results" },
    { role: "user", content: "Summarize" },
    { role: "assistant", content: "Here is the summary" },
  ];
  const body = { model: "test", messages };
  const result = compressContext(body, { maxTokens: 800, reserveTokens: 200 });
  assert.ok(result.compressed);

  const toolCallIds = new Set();
  for (const msg of result.body.messages) {
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) toolCallIds.add(tc.id);
    }
  }
  for (const msg of result.body.messages) {
    if (msg.role === "tool" && msg.tool_call_id) {
      assert.ok(
        toolCallIds.has(msg.tool_call_id),
        `tool_result "${msg.tool_call_id}" has no matching tool_use`
      );
    }
  }
});

test("Layer 3: removes orphaned tool_result (Claude format) when tool_use is dropped", () => {
  const messages = [
    { role: "system", content: "system" },
    ...Array.from({ length: 40 }, (_, i) => [
      { role: "user", content: `User ${i}: ${"x".repeat(200)}` },
      { role: "assistant", content: `Asst ${i}: ${"y".repeat(200)}` },
    ]).flat(),
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_kept", name: "read", input: {} }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_kept", content: "file" }],
    },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_orphaned", name: "search", input: {} }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_orphaned", content: "results" }],
    },
    { role: "user", content: "Final question" },
  ];
  const body = { model: "test", messages };
  const result = compressContext(body, { maxTokens: 800, reserveTokens: 200 });
  assert.ok(result.compressed);

  const toolUseIds = new Set();
  for (const msg of result.body.messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_use" && block.id) toolUseIds.add(block.id);
      }
    }
  }
  for (const msg of result.body.messages) {
    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_result" && block.tool_use_id) {
          assert.ok(
            toolUseIds.has(block.tool_use_id),
            `Claude tool_result "${block.tool_use_id}" has no matching tool_use`
          );
        }
      }
    }
  }
});

test("Layer 3: preserves intact tool_use/tool_result pairs after compression", () => {
  const messages = [
    { role: "system", content: "system" },
    { role: "user", content: "Read file" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "read" } }],
    },
    { role: "tool", tool_call_id: "call_1", content: "file data" },
    { role: "user", content: "What does it say?" },
    { role: "assistant", content: "It says hello" },
  ];
  const body = { model: "test", messages };
  const result = compressContext(body, { maxTokens: 50000, reserveTokens: 10000 });
  const toolMsg = (result.body.messages as Record<string, unknown>[]).find(
    (m: Record<string, unknown>) => m.role === "tool" && m.tool_call_id === "call_1"
  );
  assert.ok(toolMsg, "tool_result for call_1 should survive compression");
});
