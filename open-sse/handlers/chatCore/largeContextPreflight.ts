import { compressContext } from "../../services/contextManager.ts";
import { adaptBodyForCompression } from "../../services/compression/bodyAdapter.ts";
import { estimateFinalInputTokenBreakdown } from "./contextEstimation.ts";

// Optional language/regex engines are unsuitable for multi-megabyte transcripts.
// Structural context fitting is bounded and still honors the compression switch.
const MAX_OPTIONAL_COMPRESSION_INPUT_TOKENS = 128_000;

export function prepareLargeContext(
  body: Record<string, unknown>,
  options: { ceiling: number; allowCompaction: boolean; provider: string; model: string }
) {
  const breakdown = estimateFinalInputTokenBreakdown(body);
  const skipOptionalCompression = breakdown.total > MAX_OPTIONAL_COMPRESSION_INPUT_TOKENS;
  if (!skipOptionalCompression || !options.allowCompaction)
    return {
      body,
      skipOptionalCompression,
      originalTokens: breakdown.total,
      finalTokens: breakdown.total,
    };

  const adapter = adaptBodyForCompression(body);
  // Top-level instructions and tool schemas cannot be paid from the message budget.
  const overhead = breakdown.tools + breakdown.system + breakdown.instructions;
  const result = compressContext(adapter.body, {
    provider: options.provider,
    model: options.model,
    maxTokens: Math.max(1, Math.floor((options.ceiling - overhead - 1) * 0.7)),
    reserveTokens: 0,
  });
  const next =
    result.compressed && result.body
      ? adapter.adapted
        ? adapter.restore(result.body as Record<string, unknown>, { dropMissingMappedItems: true })
        : (result.body as Record<string, unknown>)
      : body;
  return {
    body: next,
    skipOptionalCompression,
    originalTokens: breakdown.total,
    finalTokens: estimateFinalInputTokenBreakdown(next).total,
  };
}
