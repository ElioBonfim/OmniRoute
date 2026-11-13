import assert from "node:assert/strict";
import test from "node:test";
import {
  processRtkText,
  applyRtkCompression,
} from "../../../open-sse/services/compression/engines/rtk/index.ts";

const document = JSON.stringify(
  {
    transactions: Array.from({ length: 40 }, (_, i) => ({
      transaction_id: `TX-${i}`,
      tenant: i === 19 ? "tenant-B" : "tenant-A",
      visibility: "private",
      audit_sequence: i,
    })),
    matrix: [[0], [0], [0], [0]],
    exact: 9007199254740993n.toString(),
  },
  null,
  2
);
for (const command of [
  null,
  "cat stage-01.json",
  "rtk bypass cat stage-01.json",
  "jq . stage-01.json",
]) {
  test(`structured JSON is preserved byte-for-byte for ${command}`, () => {
    const result = processRtkText(document, {
      command,
      config: {
        enabled: true,
        intensity: "minimal",
        maxLinesPerResult: 100000,
        maxCharsPerResult: 500000,
      },
    });
    assert.equal(result.text, document);
    assert.equal(result.compressed, false);
    assert.deepEqual(JSON.parse(result.text), JSON.parse(document));
  });
}
test("JSON remains intact even when smaller generic log limits are configured", () => {
  const result = processRtkText(document, {
    config: { enabled: true, maxLinesPerResult: 5, maxCharsPerResult: 100 },
  });
  assert.equal(result.text, document);
});
test("Anthropic Bash JSON tool results retain every transaction and metadata", () => {
  const body = {
    messages: [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "read-1", name: "Bash", input: { command: "cat stage-01.json" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "read-1", content: document, is_error: false },
        ],
      },
    ],
  };
  const result = applyRtkCompression(body, {
    stepConfig: {
      enabled: true,
      intensity: "minimal",
      maxLinesPerResult: 100000,
      maxCharsPerResult: 500000,
    },
  });
  assert.deepEqual(result.body, body);
});
test("JSON protection preserves number spelling and duplicate keys", () => {
  for (const value of [
    '{ "large":9007199254740993, "negative":-0, "x":1, "x":2 }',
    "[1, 1, 1, 1]",
  ]) {
    assert.equal(processRtkText(value, { command: "cat file.json" }).text, value);
  }
});
test("recognized command logs are still compressed", () => {
  const result = processRtkText(
    Array.from({ length: 300 }, (_, i) => `added package-${i}@1.0.0 to node_modules`).join("\n"),
    { command: "npm install", config: { maxLinesPerResult: 20 } }
  );
  assert.ok(result.compressed);
});
