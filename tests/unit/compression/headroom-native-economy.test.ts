import assert from "node:assert/strict";
import test from "node:test";
import {
  headroomEngine,
  reconstructHeadroom,
} from "../../../open-sse/services/compression/engines/headroom/index.ts";
import { tryCompactJson } from "../../../open-sse/services/compression/engines/headroom/smartcrusher.ts";
const rows = Array.from({ length: 32 }, (_, id) => ({
  id,
  tenant: id === 19 ? "private-other" : "same",
  status: "active",
  amount: 100 + id,
}));
const text = JSON.stringify(rows, null, 2);
for (const nested of [false, true]) {
  test(`native Anthropic tool result compacts and reconstructs every row, nested=${nested}`, () => {
    const content = nested
      ? [
          { type: "text", text },
          { type: "image", source: { data: "preserve-pixels", type: "base64" } },
        ]
      : text;
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Keep this instruction" },
            { type: "tool_result", tool_use_id: "call1", is_error: false, content },
          ],
        },
      ],
    };
    const before = JSON.stringify(body);
    const result = headroomEngine.apply(body, { stepConfig: { minRows: 8 } });
    assert.equal(result.compressed, true);
    assert.equal(JSON.stringify(body), before);
    const restored = reconstructHeadroom(result.body) as typeof body;
    const resultContent = restored.messages[0].content[1].content;
    const restoredText = typeof resultContent === "string" ? resultContent : resultContent![0].text;
    assert.deepEqual(JSON.parse(restoredText!), rows);
    assert.equal(restored.messages[0].content[0].text, "Keep this instruction");
    assert.equal(restored.messages[0].content[1].tool_use_id, "call1");
    if (nested) assert.deepEqual(resultContent![1], content[1]);
  });
}
for (const location of ["message", "tool", "text"]) {
  test(`preserves cache breakpoint on ${location}`, () => {
    const part = {
      type: "text",
      text,
      ...(location === "text" ? { cache_control: { type: "ephemeral" } } : {}),
    };
    const block = {
      type: "tool_result",
      tool_use_id: "call1",
      content: [part],
      ...(location === "tool" ? { cache_control: { type: "ephemeral" } } : {}),
    };
    const msg = {
      role: "user",
      content: [block],
      ...(location === "message" ? { cache_control: { type: "ephemeral" } } : {}),
    };
    const body = { messages: [msg] };
    assert.deepEqual(headroomEngine.apply(body).body, body);
  });
}
test("existing marked text blocks stay byte-identical", () => {
  const body = {
    messages: [
      { role: "user", content: [{ type: "text", text, cache_control: { type: "ephemeral" } }] },
    ],
  };
  assert.deepEqual(headroomEngine.apply(body).body, body);
});
test("native Codex input_text blocks compact without changing execution metadata", () => {
  const prefix = "Script completed\nWall time 0.1 seconds\nOutput:\n";
  const body = {
    messages: [
      {
        role: "tool",
        content: [
          { type: "input_text", text: prefix },
          { type: "input_text", text },
        ],
      },
    ],
  };
  const result = headroomEngine.apply(body);
  assert.equal(result.compressed, true);
  const restored = reconstructHeadroom(result.body) as typeof body;
  assert.equal(restored.messages[0].content[0].text, prefix);
  assert.deepEqual(JSON.parse(restored.messages[0].content[1].text), rows);
});

for (const row of [
  '{"identifier":9007199254740993,"status":"active"}',
  '{"identifier":1,"identifier":2,"status":"active"}',
  '{"identifier":-0,"status":"active"}',
]) {
  test(`unsafe JSON representation remains unchanged: ${row}`, () => {
    const source = "[" + Array.from({ length: 32 }, () => row).join(",") + "]";
    assert.equal(tryCompactJson(source), null);
  });
}
