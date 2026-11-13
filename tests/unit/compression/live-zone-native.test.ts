import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  applyLiveZoneCompression,
  resetLiveZoneCache,
} from "../../../open-sse/services/compression/liveZone.ts";
import { adaptBodyForCompression } from "../../../open-sse/services/compression/bodyAdapter.ts";
import { applyRtkCompression } from "../../../open-sse/services/compression/engines/rtk/index.ts";
import type { CompressionResult } from "../../../open-sse/services/compression/types.ts";

const options = { principalId: "native-test", sessionId: "session", variant: { mode: "rtk" } };
const text = "Error: denied at /repo/security.ts:27:3\n" + "progress done\n".repeat(100);
const config = {
  enabled: true,
  intensity: "minimal" as const,
  rawOutputRetention: "never" as const,
};
const compress = async (body: Record<string, unknown>): Promise<CompressionResult> => {
  const adapter = adaptBodyForCompression(body);
  const result = applyRtkCompression(adapter.body, { config });
  return { ...result, body: adapter.restore(result.body) };
};
beforeEach(resetLiveZoneCache);

for (const field of ["input", "messages"] as const) {
  test(`native ${field} live result is compressed while the frozen prefix stays identical`, async () => {
    const prefix =
      field === "input"
        ? [
            { type: "message", role: "user", content: "inspect" },
            { type: "custom_tool_call", call_id: "one", name: "exec", input: "git status" },
          ]
        : [
            { role: "user", content: "inspect" },
            {
              role: "assistant",
              content: [
                { type: "tool_use", id: "one", name: "Bash", input: { command: "git status" } },
              ],
            },
          ];
    const first = {
      [field]: prefix,
      tools: [{ name: "inspect" }],
      instructions: "Never remove restrictions",
    };
    const frozen = await applyLiveZoneCompression(first, options, compress);
    const resultItem =
      field === "input"
        ? {
            type: "custom_tool_call_output",
            call_id: "one",
            output: [{ type: "input_text", text }],
          }
        : {
            role: "user",
            content: [
              { type: "text", text: "keep user note" },
              { type: "tool_result", tool_use_id: "one", is_error: true, content: text },
            ],
          };
    const body = { ...first, [field]: [...prefix, resultItem] };
    const raw = structuredClone(body);
    const result = await applyLiveZoneCompression(body, options, compress);
    assert.equal(result.compressed, true);
    const items = result.body[field] as unknown[];
    assert.deepEqual(items.slice(0, prefix.length), frozen.body[field]);
    assert.ok(JSON.stringify(items.at(-1)).length < JSON.stringify(resultItem).length);
    assert.ok(JSON.stringify(items.at(-1)).includes("/repo/security.ts:27:3"));
    assert.deepEqual(body, raw);
    const replay = await applyLiveZoneCompression(body, options, compress);
    assert.deepEqual(replay.body, result.body);
  });
}

type Item = Record<string, unknown>;
const seed: { messages: Item[] } = { messages: [{ role: "user", content: "inspect" }] };
const block = (id: string) => ({
  type: "tool_result",
  tool_use_id: id,
  is_error: true,
  content: [
    { type: "text", text },
    { type: "image", source: { type: "base64", data: "synthetic" } },
  ],
});
for (const mutation of [
  "link",
  "error",
  "image",
  "note",
  "cache",
  "swap",
  "missing",
  "duplicate",
] as const) {
  test(`nested Claude copy-back rejects ${mutation} corruption`, async () => {
    await applyLiveZoneCompression(seed, options, compress);
    const body = {
      messages: [
        ...seed.messages,
        {
          role: "user",
          content: [{ type: "text", text: "user note" }, block("one"), block("two")],
        },
      ],
    };
    const content = body.messages[1].content as Item[];
    if (mutation === "cache") Object.assign(content[1], { cache_control: { type: "ephemeral" } });
    if (mutation === "missing") delete content[2].tool_use_id;
    if (mutation === "duplicate") content[2].tool_use_id = "one";
    const result = await applyLiveZoneCompression(body, options, async (input) => {
      const next = structuredClone(input) as typeof body;
      const blocks = next.messages.at(-1)!.content as Record<string, unknown>[];
      (blocks[1].content as Record<string, unknown>[])[0].text = "short";
      if (mutation === "link") blocks[1].tool_use_id = "other";
      if (mutation === "error") blocks[1].is_error = false;
      if (mutation === "image") (blocks[1].content as Record<string, unknown>[])[1].source = {};
      if (mutation === "note") blocks[0].text = "changed";
      if (mutation === "swap") [blocks[1], blocks[2]] = [blocks[2], blocks[1]];
      return { body: next, compressed: true, stats: null };
    });
    assert.deepEqual(result.body, body);
  });
}

test("Claude cache breakpoint and multiple nested result metadata survive real RTK", async () => {
  await applyLiveZoneCompression(seed, options, compress);
  const cached = { ...block("cached"), cache_control: { type: "ephemeral", ttl: "1h" } };
  const body = {
    ...seed,
    messages: [...seed.messages, { role: "user", content: [block("fresh"), cached] }],
  };
  const result = await applyLiveZoneCompression(body, options, compress);
  const items = result.body.messages as typeof body.messages;
  const output = items[1].content as Item[];
  const original = body.messages[1].content as Item[];
  assert.deepEqual(output[1], cached);
  assert.notDeepEqual(output[0], original[0]);
});

for (const mutation of ["remove-image", "image", "type", "cache", "text-null"] as const) {
  test(`native Codex copy-back rejects ${mutation} corruption`, async () => {
    const prefix = [{ type: "message", role: "user", content: "inspect" }];
    await applyLiveZoneCompression({ input: prefix }, options, compress);
    const body = {
      input: [
        ...prefix,
        {
          type: "custom_tool_call_output",
          call_id: "one",
          output: [
            {
              type: "input_text",
              text,
              ...(mutation === "cache" ? { cache_control: { type: "ephemeral" } } : {}),
            },
            { type: "input_image", image_url: "data:image/png;base64,synthetic" },
          ],
        },
      ],
    };
    const result = await applyLiveZoneCompression(body, options, async (input) => {
      const next = structuredClone(input);
      const items = next.input as Record<string, unknown>[];
      const output = items.at(-1)!.output as Record<string, unknown>[];
      output[0].text = mutation === "text-null" ? null : "short";
      if (mutation === "remove-image") output.pop();
      if (mutation === "image") output[1].image_url = "changed";
      if (mutation === "type") output[0].type = "output_text";
      return { body: next, compressed: true, stats: null };
    });
    assert.deepEqual(result.body, body);
  });
}

for (const field of ["input", "messages"] as const) {
  test(`native ${field} refuses replacing string results with null`, async () => {
    const prefix = { [field]: [{ role: "user", content: "inspect" }] };
    await applyLiveZoneCompression(prefix, options, compress);
    const item =
      field === "input"
        ? { type: "custom_tool_call_output", call_id: "one", output: text }
        : { role: "user", content: [{ type: "tool_result", tool_use_id: "one", content: text }] };
    const body = { [field]: [...prefix[field], item] };
    const result = await applyLiveZoneCompression(body, options, async (input) => {
      const next = structuredClone(input);
      const last = (next[field] as Record<string, unknown>[]).at(-1)!;
      if (field === "input") last.output = null;
      else (last.content as Record<string, unknown>[])[0].content = null;
      return { body: next, compressed: true, stats: null };
    });
    assert.deepEqual(result.body, body);
  });
}
