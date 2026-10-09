import assert from "node:assert/strict";
import test from "node:test";

import { providerModelMutationSchema } from "../../src/shared/validation/schemas/provider.ts";

test("provider model mutations accept video and persist canonical operation endpoints", () => {
  const parsed = providerModelMutationSchema.parse({
    provider: "example",
    modelId: "media-model",
    apiFormat: "video",
    supportedEndpoints: ["video", "audio"],
  });

  assert.equal(parsed.apiFormat, "video");
  assert.deepEqual(parsed.supportedEndpoints, ["videos", "audio-speech", "audio-transcriptions"]);
});

// Codex discovery advertises Responses as a supported endpoint.
test("provider model mutations accept discovered Codex Responses endpoint metadata", () => {
  const parsed = providerModelMutationSchema.parse({
    provider: "codex",
    modelId: "gpt-6.1-sol",
    apiFormat: "responses",
    supportedEndpoints: ["responses"],
  });

  assert.equal(parsed.apiFormat, "responses");
  assert.deepEqual(parsed.supportedEndpoints, ["responses"]);
});
