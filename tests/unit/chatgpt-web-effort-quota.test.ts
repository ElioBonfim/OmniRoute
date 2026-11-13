import assert from "node:assert/strict";
import test from "node:test";
import { throwIfChatGptProUsageLimitedEvidence } from "../../open-sse/vendor/codex-chatgpt-web/adapters/chatgpt-web/model-selection.ts";
import { buildResponseJSON } from "../../open-sse/vendor/codex-chatgpt-web/bridge.ts";

test("unavailable Pro with explicit Portuguese usage limit is nonretryable quota", () => {
  let failure;
  try {
    throwIfChatGptProUsageLimitedEvidence(
      true,
      "Limite atingido. Tente novamente após 27 de out. de 2026."
    );
    assert.fail("must reject");
  } catch (error) {
    failure = error;
  }
  assert.equal(failure.status, 429);
  assert.equal(failure.code, "usage_limit_reached");
  assert.equal(failure.retryable, false);
  const response = buildResponseJSON(
    [
      {
        type: "error",
        message: failure.message,
        status: failure.status,
        errorType: failure.errorType,
        code: failure.code,
        retryable: failure.retryable,
      },
    ],
    "chatgpt-web/gpt-6-pro"
  );
  assert.equal(response.error.code, "usage_limit_reached");
  assert.equal(response.retryable, false);
});

test("does not infer quota from missing Pro, upgrade lock, or available selection", () => {
  for (const label of [
    "Medium, 2 of 4. GPT-6 Pro",
    "Locked, upgrade to Pro",
    "Limite de uso atingido GPT-6 Pro",
    "",
  ]) {
    assert.doesNotThrow(() => throwIfChatGptProUsageLimitedEvidence(false, label));
  }
  assert.doesNotThrow(() =>
    throwIfChatGptProUsageLimitedEvidence(false, "Limite atingido. Tente novamente.")
  );
});

test("recognizes explicit English usage limit without exposing menu contents", () => {
  assert.throws(
    () => throwIfChatGptProUsageLimitedEvidence(true, "Limit reached. PRIVATE_MARKER"),
    (error) => error.code === "usage_limit_reached" && !error.message.includes("PRIVATE_MARKER")
  );
});
