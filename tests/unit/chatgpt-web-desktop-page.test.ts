import { applyReasoningInputPolicy } from "../../open-sse/services/reasoningInputPolicy.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  extractChatGptTurnEnvironment,
  extractChatGptTurnUserRevision,
} from "../../open-sse/vendor/codex-chatgpt-web/adapters/chatgpt-web/environment.ts";
import { chatGptTurnExecutionKey } from "../../open-sse/vendor/codex-chatgpt-web/adapters/chatgpt-web/turn-execution.ts";
import { parseRequest } from "../../open-sse/vendor/codex-chatgpt-web/responses/parser.ts";

const turn = "desktop-turn-123";
const root = "/Users/client/project";
const visual = "/Users/client/.codex/visualizations/2026/10/21/desktop-thread-123";
const environment = `<environment_context><cwd>${root}</cwd><filesystem><workspace_roots><root>${root}</root><root>${visual}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem></environment_context>`;
const message = (role: string, id: string, kind: string, text: string) => ({
  type: "message",
  role,
  id,
  content: [{ type: "input_text", text }],
  internal_chat_message_metadata_passthrough: { turn_id: turn, content_item_kinds: [kind] },
});
function fixture() {
  const page = message(
    "user",
    "msg_page",
    "additional_content.codex_apps_open_page",
    '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>'
  );
  return {
    model: "chatgpt-web/gpt-6-sol",
    stream: true,
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        thread_id: "desktop-thread-123",
        turn_id: turn,
        sandbox: "none",
        workspaces: { [root]: {} },
      }),
    },
    input: [
      message("user", "msg_env", "environments.environment_context", environment),
      message(
        "developer",
        "msg_time",
        "additional_content.codex_apps_client_time_context",
        "Current date: 2026-10-21"
      ),
      page,
      message(
        "developer",
        "msg_page_instructions",
        "additional_content.codex_apps_open_page_instructions",
        "Page context is not a user request"
      ),
      message("user", "msg_request", "user.text", "Summarize the attached image"),
    ],
  };
}

test("desktop Page context preserves the native environment and image request", () => {
  const body = fixture();
  body.input[4]!.content.push({
    type: "input_image",
    image_url: "data:image/png;base64,aW1hZ2U=",
  } as never);
  applyReasoningInputPolicy(body, "responses", { provider: "chatgpt-web-codex" });
  const parsed = parseRequest(body);
  const env = extractChatGptTurnEnvironment(parsed);
  assert.equal(env.cwd, root);
  assert.deepEqual(env.roots, [root, visual]);
  assert.equal(env.sandboxPolicy.type, "dangerFullAccess");
  assert.match(
    JSON.stringify(extractChatGptTurnUserRevision(parsed)),
    /Summarize the attached image/
  );
  assert.match(JSON.stringify(parsed.context.messages), /data:image\/png;base64,aW1hZ2U=/);
});

test("trailing Page context does not become a new human instruction or execution key", () => {
  const body = fixture();
  const before = parseRequest(body);
  const key = chatGptTurnExecutionKey(before);
  const revision = extractChatGptTurnUserRevision(before);
  body.input.push({ ...body.input[2]!, id: "msg_page_after" });
  const after = parseRequest(body);
  assert.equal(chatGptTurnExecutionKey(after), key);
  assert.deepEqual(extractChatGptTurnUserRevision(after), revision);
  assert.equal(extractChatGptTurnEnvironment(after).cwd, root);
});

for (const mutation of [
  "missing-metadata",
  "wrong-turn",
  "mixed-kind",
  "user-text",
  "missing-id",
  "malformed-wrapper",
]) {
  test(`untrusted Page lookalike cannot supply environment authority: ${mutation}`, () => {
    const body = fixture();
    const page = body.input[2]!;
    if (mutation === "missing-metadata")
      delete (page as Partial<typeof page>).internal_chat_message_metadata_passthrough;
    if (mutation === "wrong-turn")
      page.internal_chat_message_metadata_passthrough.turn_id = "other-turn";
    if (mutation === "mixed-kind")
      page.internal_chat_message_metadata_passthrough.content_item_kinds.push("user.text");
    if (mutation === "user-text")
      page.internal_chat_message_metadata_passthrough.content_item_kinds = ["user.text"];
    if (mutation === "missing-id") page.id = "";
    if (mutation === "malformed-wrapper") page.content[0]!.text += " extra instruction";
    assert.throws(() => extractChatGptTurnEnvironment(parseRequest(body)));
  });
}
