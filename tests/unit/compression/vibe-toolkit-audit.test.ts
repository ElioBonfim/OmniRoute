import { test } from "node:test";
import assert from "node:assert/strict";
import {
  processRtkText,
  applyRtkCompression,
} from "../../../open-sse/services/compression/engines/rtk/index.ts";

const config = {
  enabled: true,
  intensity: "minimal" as const,
  maxLinesPerResult: 100000,
  maxCharsPerResult: 500000,
  customFiltersEnabled: false,
  rawOutputRetention: "never" as const,
};

test("git status keeps untracked paths when mixed with tracked changes", () => {
  const text =
    'On branch main\nChanges not staged for commit:\n  (use "git add" to update)\n\tmodified: src/app.ts\nUntracked files:\n  (use "git add" to include)\n\tsrc/security-policy.ts\n';
  const result = processRtkText(text, { command: "git status", config });
  assert.ok(result.text.includes("src/security-policy.ts"), result.text);
  assert.ok(result.text.includes("modified: src/app.ts"));
});

test("webpack keeps multiline warning details, restrictions and diagnostic locations", () => {
  const text =
    "asset main.js 10 KiB\ncacheable modules 500 KiB\nWARNING in ./src/auth.ts 27:3\nDo not deploy unless the tenant check passes.\nOnly administrators may bypass this check.\nModule not found: Cannot resolve ./policy\n  at /repo/src/auth.ts:27:3\nwebpack 5 compiled with 1 warning\n";
  const result = processRtkText(text, { command: "webpack", config });
  for (const line of text.split("\n").filter((x) => x && !x.startsWith("cacheable"))) {
    assert.ok(result.text.includes(line), `Missing ${line}\n${result.text}`);
  }
});

test("OpenAI and Anthropic tool envelopes preserve failure metadata and identifiers", () => {
  const text = "Error: failed at /repo/src/app.ts:12:4\n" + "progress completed\n".repeat(50);
  const openai = {
    messages: [
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "bash", arguments: '{"command":"webpack"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", exit_code: 7, content: text },
    ],
  };
  const anthropic = {
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "use_1", name: "Bash", input: { command: "webpack" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "use_1", is_error: true, content: text }],
      },
    ],
  };
  const resultA = applyRtkCompression(openai, { config });
  const resultB = applyRtkCompression(anthropic, { config });
  assert.equal(resultA.compressed, true);
  assert.equal(resultB.compressed, true);
  assert.notDeepEqual(resultA.body, openai);
  assert.notDeepEqual(resultB.body, anthropic);
  const a = resultA.body as typeof openai;
  const b = resultB.body as typeof anthropic;
  assert.equal(a.messages[1].exit_code, 7);
  assert.equal(a.messages[1].tool_call_id, "call_1");
  assert.equal(b.messages[1].content?.[0].is_error, true);
  assert.equal(b.messages[1].content?.[0].tool_use_id, "use_1");
  assert.ok(JSON.stringify(a).includes("/repo/src/app.ts:12:4"));
  assert.ok(JSON.stringify(b).includes("/repo/src/app.ts:12:4"));
});

// The line cap must not let verbose asset listings push diagnostics out of the middle.
test("webpack retains warning context beyond the per-filter line budget", () => {
  const details = [
    "WARNING in ./src/auth.ts 27:3",
    "The module requested by this import cannot be resolved.",
    "  27 | import policy from './policy'",
    "Do not deploy unless the tenant check passes.",
  ];
  const text = [
    ...Array.from({ length: 150 }, (_, i) => `asset before${i}.js 12 KiB`),
    ...details,
    ...Array.from({ length: 150 }, (_, i) => `asset after${i}.js 12 KiB`),
  ].join("\n");
  const result = processRtkText(text, { command: "webpack", config });
  assert.equal(result.compressed, true);
  for (const detail of details) assert.ok(result.text.includes(detail), `Missing ${detail}`);
});

test("the built-in RTK benchmark exercises tool-output compression", async () => {
  const { engineToCompressFn } =
    await import("../../../open-sse/services/compression/harness/benchmark.ts");
  const text = "Error: denied at /repo/auth.ts:27:3\n" + "repeated progress line\n".repeat(100);
  const compressed = await engineToCompressFn("rtk")(text);
  assert.ok(
    compressed.length < text.length,
    "benchmark must exercise RTK instead of a user-message no-op"
  );
  assert.ok(compressed.includes("Error: denied at /repo/auth.ts:27:3"));
});

test("offline audit does not export supplied fixture metadata or raw content", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-audit-export-"));
  try {
    const marker = "PRIVATE_FIXTURE_SENTINEL_7f28";
    const fixture = path.join(dir, "fixtures.json");
    const output = path.join(dir, "measurements.json");
    fs.writeFileSync(
      fixture,
      JSON.stringify(
        Array.from({ length: 8 }, () => ({
          name: marker,
          command: marker,
          origin: marker,
          critical: [marker],
          text: marker + "\n" + "noise\n".repeat(80),
        }))
      )
    );
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx/esm",
        "scripts/compression/vibe-toolkit-audit.ts",
        "--fixtures",
        fixture,
        "--out",
        output,
      ],
      { encoding: "utf8" }
    );
    assert.equal(child.status, 0, child.stderr);
    assert.ok(!fs.readFileSync(output, "utf8").includes(marker));
    assert.ok(!(child.stdout + child.stderr).includes(marker));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
