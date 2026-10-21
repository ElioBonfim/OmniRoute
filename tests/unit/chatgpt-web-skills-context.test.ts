import assert from "node:assert/strict";
import test from "node:test";
import { parseRequest } from "../../open-sse/vendor/codex-chatgpt-web/responses/parser.ts";
import { compileChatGptWebPrompt } from "../../open-sse/vendor/codex-chatgpt-web/adapters/chatgpt-web/prompt.ts";
import {
  selectedSkillFile,
  validateSkillFiles,
  skillFileTokens,
} from "../../open-sse/vendor/codex-chatgpt-web/adapters/chatgpt-web/skill-attachments.ts";
import { estimateCompiledChatGptWebInputTokens } from "../../open-sse/vendor/codex-chatgpt-web/adapters/chatgpt-web/input-tokens.ts";
import {
  resolveBiggerContextMultipartParts,
  biggerContextPartCount,
} from "../../open-sse/vendor/codex-chatgpt-web/adapters/chatgpt-web/usage.ts";
import { resolveChatGptWebContextLimits } from "../../open-sse/vendor/codex-chatgpt-web/chatgpt-web-models.ts";
import { chatGptPromptFilePayloads } from "../../open-sse/vendor/codex-chatgpt-web/adapters/chatgpt-web/browser-worker.ts";
const caps = {
  localToolsEnabled: false,
  proAvailable: true,
  solAvailable: true,
  experimentalSkillAttachments: true,
};
const skill =
  "<skill>\n<name>qa-example</name>\n<path>/project/skills/qa/SKILL.md</path>\nUse the marker PRIVATE_SKILL_NONCE.\n</skill>";
function fixture(kind = "skills.selected_skill_instructions", role = "user") {
  return parseRequest({
    model: "gpt-5.6-sol",
    reasoning: { effort: "high" },
    input: [
      {
        type: "message",
        id: "skill_msg",
        role,
        content: skill,
        internal_chat_message_metadata_passthrough: { content_item_kinds: [kind] },
      },
      { type: "message", role: "user", content: "Apply my selected skill." },
    ],
  });
}
test("only native selected skills become named files; history position and source authority survive", () => {
  const compiled = compileChatGptWebPrompt(fixture(), caps, undefined, {
    experimentalSkillAttachments: true,
  });
  assert.equal(compiled.skillFiles?.length, 1);
  assert.equal(compiled.skillFiles[0].text, skill);
  assert(!compiled.text.includes("PRIVATE_SKILL_NONCE"));
  assert.match(compiled.text, /skill_attachment/);
  assert.match(compiled.text, /original user priority/);
  assert.equal(chatGptPromptFilePayloads(compiled)[0].buffer.toString(), skill);
  for (const parsed of [
    fixture("user.text"),
    fixture("skills.selected_skill_instructions", "developer"),
  ]) {
    const inline = compileChatGptWebPrompt(parsed, caps, undefined, {
      experimentalSkillAttachments: true,
    });
    assert.equal(inline.skillFiles, undefined);
    assert(inline.text.includes("PRIVATE_SKILL_NONCE"));
  }
  assert.equal(compileChatGptWebPrompt(fixture(), caps).skillFiles, undefined);
});
test("files are content addressed, validated, deduplicated and accounted as tokens", () => {
  const parsed = fixture();
  parsed.context.messages.unshift(parsed.context.messages[0]);
  const compiled = compileChatGptWebPrompt(parsed, caps, undefined, {
    experimentalSkillAttachments: true,
  });
  assert.equal(compiled.skillFiles?.length, 1);
  const file = compiled.skillFiles![0];
  validateSkillFiles([file]);
  assert.throws(() => validateSkillFiles([{ ...file, text: "changed" }]), /match/);
  assert.throws(() => validateSkillFiles([file, file]), /duplicate/);
  assert.throws(
    () => selectedSkillFile({ role: "user", content: skill, timestamp: 1 }),
    /provenance/
  );
  assert.equal(
    estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId) -
      estimateCompiledChatGptWebInputTokens({ ...compiled, skillFiles: undefined }, parsed.modelId),
    skillFileTokens([file], parsed.modelId)
  );
});
test("skills share the attachment cap with images and documents", () => {
  const compiled = compileChatGptWebPrompt(fixture(), caps, undefined, {
    experimentalSkillAttachments: true,
  });
  compiled.files = Array.from({ length: 10 }, (_, i) => ({
    ref: `file-${i}`,
    filename: `file-${i}.txt`,
    fileData: "data:text/plain;base64,YQ==",
  }));
  assert.throws(() => chatGptPromptFilePayloads(compiled), /10 attachments/);
});
test("Bigger Context leaves Instant unchanged, supports reasoning efforts and never strips records", () => {
  for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
    const normal = resolveChatGptWebContextLimits("gpt-5.6-sol", effort, caps);
    const expanded = resolveChatGptWebContextLimits("gpt-5.6-sol", effort, {
      ...caps,
      experimentalBiggerContext: true,
    });
    assert.equal(expanded.contextWindow, normal.contextWindow * (effort === "low" ? 1 : 3));
  }
  const parsed = fixture();
  parsed.options.reasoning = "low";
  parsed._compactionRequest = true;
  assert.equal(resolveBiggerContextMultipartParts(parsed, caps), undefined);
  assert.throws(
    () => compileChatGptWebPrompt(parsed, caps, undefined, { experimentalMultipartParts: 2 }),
    /Instant/
  );
  parsed.options.reasoning = "high";
  delete parsed._compactionRequest;
  const compiled = compileChatGptWebPrompt(parsed, caps, undefined, {
    experimentalMultipartParts: 3,
    experimentalSkillAttachments: true,
  });
  const records = compiled.multipart!.parts.flatMap((part) => JSON.parse(part).records);
  assert.equal(records.length, parsed.context.messages.length);
  assert.equal(compiled.skillFiles?.length, 1);
  assert.equal(records[0].message.content[0].filename, compiled.skillFiles![0].name);
  assert.equal(biggerContextPartCount(94999, 95000, false), undefined);
  assert.equal(biggerContextPartCount(95000, 95000, false), 2);
  assert.equal(biggerContextPartCount(190000, 95000, false), 3);
});
