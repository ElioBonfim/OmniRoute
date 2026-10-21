import assert from "node:assert/strict";
import test from "node:test";
import { parseRequest } from "../../open-sse/vendor/codex-chatgpt-web/responses/parser.ts";
import {
  extractChatGptTurnEnvironment,
  extractChatGptTurnUserRevision,
} from "../../open-sse/vendor/codex-chatgpt-web/adapters/chatgpt-web/environment.ts";
const root = "/Users/client/project";
const turn = "skill-current-turn";
function fixture() {
  const message = (id: string, kind: string, text: string) => ({
    type: "message",
    role: "user",
    id,
    content: [{ type: "input_text", text }],
    internal_chat_message_metadata_passthrough: { turn_id: turn, content_item_kinds: [kind] },
  });
  return {
    model: "gpt-5.6-sol",
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        thread_id: "skill-thread",
        turn_id: turn,
        sandbox: "none",
        workspaces: { [root]: {} },
      }),
    },
    input: [
      message(
        "msg_env",
        "environments.environment_context",
        `<environment_context><cwd>${root}</cwd><filesystem><workspace_roots><root>${root}</root><root>/Users/client/.codex/visualizations/thread</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem></environment_context>`
      ),
      message("msg_request", "user.text", "Execute the local test."),
      message(
        "msg_skill",
        "skills.selected_skill_instructions",
        "<skill>\n<name>qa</name>\n<path>/project/skills/qa/SKILL.md</path>\nInstructions\n</skill>"
      ),
    ],
  };
}
test("a selected skill appended after the human prompt preserves environment and task revision", () => {
  const body = fixture();
  const parsed = parseRequest(body);
  assert.equal(extractChatGptTurnEnvironment(parsed).cwd, root);
  assert.deepEqual(extractChatGptTurnUserRevision(parsed), body.input[1].content);
});
for (const invalid of ["foreign-turn", "missing-id", "user-text", "mixed-kinds", "malformed"]) {
  test(`selected-skill lookalike cannot be hidden as trusted context: ${invalid}`, () => {
    const body = fixture();
    const skill = body.input[2];
    if (invalid === "foreign-turn")
      skill.internal_chat_message_metadata_passthrough.turn_id = "foreign";
    if (invalid === "missing-id") skill.id = "";
    if (invalid === "user-text")
      skill.internal_chat_message_metadata_passthrough.content_item_kinds = ["user.text"];
    if (invalid === "mixed-kinds")
      skill.internal_chat_message_metadata_passthrough.content_item_kinds.push("user.text");
    if (invalid === "malformed") skill.content[0].text = "An ordinary user request";
    const parsed = parseRequest(body);
    if (invalid === "foreign-turn")
      assert.throws(() => extractChatGptTurnUserRevision(parsed), /conflict|different|turn/i);
    else assert.deepEqual(extractChatGptTurnUserRevision(parsed), skill.content);
  });
}
