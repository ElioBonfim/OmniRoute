import assert from "node:assert/strict";
import test from "node:test";
import { requireChatGptWebCodexRoute } from "../../open-sse/executors/chatgpt-web-codex/models.ts";

for (const family of ["5.6", "6"] as const) {
  test(`GPT-${family} routes keep family and requested Sol effort separate`, () => {
    for (const effort of ["medium", "high", "xhigh"] as const) {
      const route = requireChatGptWebCodexRoute(`gpt-${family}-sol`, effort);
      assert.equal(route.modelFamily, family);
      assert.equal(route.effort, effort);
      assert.equal(route.backendModel, "gpt-5.6-sol");
    }
    assert.equal(requireChatGptWebCodexRoute(`gpt-${family}-sol`).effort, "high");
  });
  test(`GPT-${family} Instant and Pro enforce their advertised efforts`, () => {
    const instant = requireChatGptWebCodexRoute(`gpt-${family}-sol-instant`, "low");
    assert.equal(instant.modelFamily, family);
    assert.equal(instant.effort, "low");
    const pro = requireChatGptWebCodexRoute(`chatgpt-web-codex/gpt-${family}-pro`, "max");
    assert.equal(pro.modelFamily, family);
    assert.equal(pro.effort, "max");
    assert.equal(pro.pro, true);
    assert.throws(() => requireChatGptWebCodexRoute(`gpt-${family}-sol`, "max"), /incompatible/i);
    assert.throws(() => requireChatGptWebCodexRoute(`gpt-${family}-pro`, "high"), /incompatible/i);
    assert.throws(
      () => requireChatGptWebCodexRoute(`gpt-${family}-sol-instant`, "high"),
      /incompatible/i
    );
  });
}
test("existing fixed aliases remain fixed and unsupported families fail closed", () => {
  assert.equal(requireChatGptWebCodexRoute("high", "high").effort, "high");
  assert.throws(() => requireChatGptWebCodexRoute("high", "medium"), /incompatible/i);
  assert.throws(() => requireChatGptWebCodexRoute("gpt-7-pro", "max"), /unsupported/i);
  assert.throws(() => requireChatGptWebCodexRoute("gpt-6-sol", "ultra"), /incompatible/i);
});

import { chatGptModelFamilyMatches } from "../../open-sse/vendor/codex-chatgpt-web/adapters/chatgpt-web/model-selection.ts";
test("browser identity rejects wrong family, vague Pro, and conflicting announcements", () => {
  assert(chatGptModelFamilyMatches(["6 High, 3 of 5."], "6", "high"));
  assert(chatGptModelFamilyMatches(["6 Pro, 5 of 5."], "6", "max"));
  assert(chatGptModelFamilyMatches(["GPT-5.6 Sol Pro、translated position"], "5.6", "max"));
  for (const descriptions of [
    [],
    ["Pro"],
    ["5.6 Pro, 5 of 5."],
    ["6.1 Pro, 5 of 5."],
    ["6 Sol Pro, 5 of 5."],
    ["6 Pro, 5 of 5.", "5.6 Pro, 5 of 5."],
  ]) {
    assert.equal(chatGptModelFamilyMatches(descriptions, "6", "max"), false);
  }
});

import { chatgpt_web_codexProvider } from "../../open-sse/config/providers/registry/chatgpt-web-codex/index.ts";
import { chatGptConversationKey } from "../../open-sse/vendor/codex-chatgpt-web/adapters/chatgpt-web/conversation-key.ts";
import type { CodexParsedRequest } from "../../open-sse/vendor/codex-chatgpt-web/types.ts";
test("registry exposes all six new models in addition to seven legacy aliases", () => {
  assert.equal(chatgpt_web_codexProvider.models.length, 13);
  for (const family of ["5.6", "6"])
    for (const variant of ["sol", "pro", "sol-instant"]) {
      assert(chatgpt_web_codexProvider.models.some((m) => m.id === `gpt-${family}-${variant}`));
    }
});
test("conversation cache identity isolates explicit model families while legacy keys stay stable", () => {
  const parsed = {
    modelId: "gpt-5.6-sol",
    options: { reasoning: "high" },
    context: { messages: [] },
    _rawBody: {
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: "same-thread", turn_id: "turn" }),
      },
    },
  } as unknown as CodexParsedRequest;
  const legacy = chatGptConversationKey(parsed, "same-account");
  const first = chatGptConversationKey({ ...parsed, _chatgptModelFamily: "5.6" }, "same-account");
  const second = chatGptConversationKey({ ...parsed, _chatgptModelFamily: "6" }, "same-account");
  assert(legacy);
  assert(first);
  assert(second);
  assert.notEqual(first, second);
  assert.notEqual(legacy, first);
  assert.equal(chatGptConversationKey(parsed, "same-account"), legacy);
  assert.equal(
    chatGptConversationKey({ ...parsed, _chatgptModelFamily: "6" }, "same-account"),
    second
  );
});

import { chatGptModelEvidenceMatches } from "../../open-sse/vendor/codex-chatgpt-web/adapters/chatgpt-web/model-selection.ts";
test("Portuguese effort-only announcements require an exact selected family radio", () => {
  assert(chatGptModelEvidenceMatches(["Pro, 5 de 5."], "GPT-6", "6", "max"));
  assert(chatGptModelEvidenceMatches(["Instant, 1 de 5."], "GPT-6", "6", "low"));
  assert(chatGptModelEvidenceMatches(["Alto, 3 de 5."], "GPT-6", "6", "high"));
  assert(chatGptModelEvidenceMatches(["Pro, 5 de 5."], "GPT-5.6 Sol", "5.6", "max"));
  for (const label of ["Latest", "GPT-7", "GPT-5.6 Sol", "GPT-6 Pro preview", ""]) {
    assert.equal(chatGptModelEvidenceMatches(["Pro, 5 de 5."], label, "6", "max"), false);
  }
  assert.equal(chatGptModelEvidenceMatches(["5.6 Pro, 5 of 5."], "GPT-6", "6", "max"), false);
  assert.equal(chatGptModelEvidenceMatches(["Pro, 5 de 5."], "GPT-6", "6", "high"), false);
  assert.equal(chatGptModelEvidenceMatches(["Instant, 1 de 5."], "GPT-6", "6", "max"), false);
});
