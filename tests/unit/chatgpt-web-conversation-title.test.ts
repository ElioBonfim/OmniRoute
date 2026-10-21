import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChatGptConversationTitle,
  savedChatGptConversationId,
} from "../../open-sse/vendor/codex-chatgpt-web/adapters/chatgpt-web/conversation-title.ts";

test("labels chats with Sao Paulo creation date, project basename and full session", () => {
  assert.equal(
    buildChatGptConversationTitle({
      cwd: "/Users/dev/Projeto Alpha/",
      sessionId: "01a15b6a-ac57-79e2-81de-f9102c2c45e5",
      createdAt: new Date("2026-10-21T01:30:00Z"),
    }),
    "[OMNIROUTE] 2026-10-20 | Projeto Alpha | sessão 01a15b6a-ac57-79e2-81de-f9102c2c45e5"
  );
});
test("client Windows paths work on a Unix server and unsafe title characters are removed", () => {
  const title = buildChatGptConversationTitle({
    cwd: "C:\\work\\Projeto | Beta\\",
    sessionId: "sess\n123",
    createdAt: new Date("2026-10-20T12:00:00Z"),
  });
  assert.equal(title, "[OMNIROUTE] 2026-10-20 | Projeto - Beta | sessão sess 123");
  assert(!title.includes("C:"));
});
test("missing project and session stay explicit and labels have bounded lengths", () => {
  assert.match(
    buildChatGptConversationTitle({ createdAt: new Date("2026-10-20T12:00:00Z") }),
    /\| sem-projeto \| sessão sem-sessao$/
  );
  assert(
    buildChatGptConversationTitle({ cwd: "/" + "x".repeat(2000), sessionId: "s".repeat(2000) })
      .length <= 180
  );
});
test("renaming is confined to saved conversations on the exact ChatGPT origin", () => {
  assert.equal(
    savedChatGptConversationId("https://chatgpt.com/c/6ad7ea33-3384-83e8-9de0-46271ef2b142"),
    "6ad7ea33-3384-83e8-9de0-46271ef2b142"
  );
  for (const url of [
    "https://chatgpt.com/",
    "https://chatgpt.com/?temporary-chat=true",
    "https://chatgpt.com/c/abc?temporary-chat=true",
    "https://chatgpt.com.evil.invalid/c/abc",
    "http://chatgpt.com/c/abc",
    "https://chatgpt.com/c/a/other",
    "not a URL",
  ])
    assert.equal(savedChatGptConversationId(url), undefined, url);
});
