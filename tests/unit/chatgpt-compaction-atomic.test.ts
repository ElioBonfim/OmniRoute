import assert from "node:assert/strict";
import test from "node:test";
import { ChatGptMarkdownBuffer } from "../../open-sse/vendor/codex-chatgpt-web/adapters/chatgpt-web/markdown.ts";
const segment = (text: string) => ({
  key: "0",
  tag: "p",
  html: `<p>${text}</p>`,
  text,
  sourceStart: 0,
  sourceEnd: 1,
  streamable: true,
});
test("compaction permits revisions of an undelivered draft and emits only final summary", () => {
  const b = new ChatGptMarkdownBuffer(undefined, 0, "complete");
  assert.equal(b.observe([segment("draft")], 0), "");
  assert.equal(b.observe([segment("draft")], 1), "");
  assert.equal(b.observe([segment("verified checkpoint BLUE-17")], 2), "");
  assert.equal(b.finish().markdown, "verified checkpoint BLUE-17");
});
test("normal streaming still rejects revisions of delivered text", () => {
  const b = new ChatGptMarkdownBuffer(undefined, 0);
  b.observe([segment("draft")], 0);
  b.observe([segment("draft")], 1);
  b.observe([segment("changed")], 2);
  assert.throws(() => b.finish(), /already streamed/);
});

import {
  createChatGptWebAdapter,
  chatGptWebExecutionNamespace,
} from "../../open-sse/vendor/codex-chatgpt-web/adapters/chatgpt-web/index.ts";
import {
  chatGptTurnSessions,
  chatGptCompactionSourceExecutionKey,
} from "../../open-sse/vendor/codex-chatgpt-web/adapters/chatgpt-web/turn-execution.ts";
import { parseRequest } from "../../open-sse/vendor/codex-chatgpt-web/responses/parser.ts";

test("summary-only compaction retires the source tools namespace before browser submission", async () => {
  const provider = {
    adapter: "chatgpt-web" as const,
    baseUrl: "https://chatgpt.com",
    defaultModel: "gpt-5.6-sol",
    models: ["gpt-5.6-sol"],
    chatgptWeb: {
      localToolsEnabled: false,
      autoApproveToolCalls: false,
      solAvailable: true,
      proAvailable: true,
    },
  };
  const sourceNamespace = chatGptWebExecutionNamespace({
    ...provider,
    chatgptWeb: { ...provider.chatgptWeb, localToolsEnabled: true, autoApproveToolCalls: true },
  });
  assert.notEqual(sourceNamespace, chatGptWebExecutionNamespace(provider));
  const parsed = parseRequest({
    model: "gpt-5.6-sol",
    reasoning: { effort: "max" },
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        thread_id: "compact-namespace-test",
        turn_id: "compact-namespace-turn",
      }),
    },
    input: [
      {
        type: "message",
        id: "msg_source",
        role: "user",
        content: [{ type: "input_text", text: "Reconcile local records" }],
      },
    ],
  });
  parsed._compactionRequest = true;
  const original = chatGptTurnSessions.retireAndWait;
  let retired: string | undefined;
  chatGptTurnSessions.retireAndWait = async (key) => {
    retired = key;
    throw new Error("retirement-test-stop");
  };
  try {
    await assert.rejects(
      () =>
        createChatGptWebAdapter(provider, { compactionSourceNamespace: sourceNamespace }).runTurn(
          parsed,
          { headers: new Headers() },
          () => {}
        ),
      /retirement-test-stop/
    );
    assert.equal(retired, `${sourceNamespace}:${chatGptCompactionSourceExecutionKey(parsed)}`);
  } finally {
    chatGptTurnSessions.retireAndWait = original;
  }
});
