import assert from "node:assert/strict";
import { test } from "node:test";
import { requireChatGptWebAuthenticatedUrl } from "../../open-sse/utils/chatgptWebUiTurn.ts";
import { ChatGptWebExecutor } from "../../open-sse/executors/chatgpt-web.ts";
test("clean-room detects login redirects without probing private bundles", () => {
  assert.throws(
    () => requireChatGptWebAuthenticatedUrl("https://chatgpt.com/auth/login?next=%2F"),
    /reauthentication/
  );
  assert.doesNotThrow(() =>
    requireChatGptWebAuthenticatedUrl("https://chatgpt.com/?temporary-chat=true")
  );
  assert.throws(() => requireChatGptWebAuthenticatedUrl("https://example.com/"), /first-party/);
});

test("expired Clean Room sessions return HTTP 401 instead of a module error", async () => {
  const executor = new ChatGptWebExecutor({
    createSession: async () => {
      throw new Error(
        "ChatGPT Web session requires reauthentication; reconnect this account in Providers"
      );
    },
  });
  const result = await executor.execute({
    model: "gpt-5-6",
    body: { messages: [{ role: "user", content: "probe" }] },
    stream: false,
    credentials: {
      connectionId: "test",
      providerSpecificData: { storageState: { cookies: [], origins: [] } },
    },
  } as Parameters<ChatGptWebExecutor["execute"]>[0]);
  assert.equal(result.response.status, 401);
  assert.match(await result.response.text(), /reauthentication/);
});
