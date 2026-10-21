import { setCredentialHealth } from "@/lib/credentialHealth/cache";
import { recoverKeyHealth } from "@omniroute/open-sse/services/apiKeyRotator.ts";
import { applyDetectedControlUpdate, type ApiKeyValidationResult } from "./apiKeyTestResult";

interface ConnectionHealthSnapshot {
  testStatus?: unknown;
  lastError?: unknown;
  lastErrorAt?: unknown;
  lastErrorType?: unknown;
  lastErrorSource?: unknown;
  errorCode?: unknown;
  rateLimitedUntil?: string | number | null;
  apiKey?: unknown;
  accessToken?: unknown;
  providerSpecificData?: unknown;
}

interface ConnectionProbeResult extends ApiKeyValidationResult {
  error?: string | null;
  refreshed?: boolean;
  newTokens?: {
    accessToken?: string;
    refreshToken?: string;
    expiresIn?: number;
  };
}

interface HealthUpdateOptions {
  connectionId: string;
  provider: string;
  connection: ConnectionHealthSnapshot;
  latest: ConnectionHealthSnapshot;
  result: ConnectionProbeResult;
  diagnosis: { type?: string; source?: string; code?: string | number | null };
  operatorDisabled: boolean;
  clearErrorState: boolean;
  now: string;
  persist: (connectionId: string, update: Record<string, unknown>) => Promise<unknown>;
}

/** Commit probe state before advertising recovered credentials; quota policy stays with the caller. */
export async function persistConnectionTestHealth({
  connectionId,
  provider,
  connection,
  latest,
  result,
  diagnosis,
  operatorDisabled,
  clearErrorState,
  now,
  persist,
}: HealthUpdateOptions): Promise<void> {
  const terminalTestStatuses = new Set(["banned", "expired", "credits_exhausted"]);
  const isTerminalFailure =
    !result.valid &&
    (terminalTestStatuses.has(String(diagnosis.code ?? "").toLowerCase()) ||
      terminalTestStatuses.has(String(diagnosis.type ?? "").toLowerCase()));
  const updateData: Record<string, unknown> = {
    testStatus: clearErrorState
      ? "active"
      : result.valid
        ? latest.testStatus
        : isTerminalFailure
          ? diagnosis.type
          : "error",
    ...(result.valid && !operatorDisabled ? { isActive: true } : {}),
    ...(!result.valid && isTerminalFailure ? { isActive: false } : {}),
    lastError: clearErrorState ? null : result.valid ? connection.lastError : result.error,
    lastErrorAt: clearErrorState ? null : result.valid ? connection.lastErrorAt : now,
    lastTested: now,
    lastErrorType: clearErrorState
      ? null
      : result.valid
        ? connection.lastErrorType
        : diagnosis.type,
    lastErrorSource: clearErrorState
      ? null
      : result.valid
        ? connection.lastErrorSource
        : diagnosis.source,
    errorCode: clearErrorState
      ? null
      : result.valid
        ? connection.errorCode
        : diagnosis.code || result.statusCode || null,
    rateLimitedUntil: clearErrorState
      ? null
      : isTerminalFailure || result.valid
        ? connection.rateLimitedUntil || null
        : new Date(Date.now() + 30_000).toISOString(),
  };
  if (clearErrorState) updateData.backoffLevel = 0;
  if (result.valid && (connection.apiKey || connection.accessToken)) {
    const recovered = recoverKeyHealth(connectionId, "primary", latest.providerSpecificData);
    if (recovered) updateData.providerSpecificData = recovered;
  }
  applyDetectedControlUpdate(updateData, latest.providerSpecificData, result);
  // refreshOAuthToken persists rotating credentials while holding its mutex.
  // Replaying the returned pair here can overwrite a newer concurrent refresh.
  const saved = await persist(connectionId, updateData);
  // A connection deleted mid-test (persist → null) keeps the release flow (no throw), but it
  // must not advertise recovered credentials.
  if (saved === null) return;
  if (result.valid) setCredentialHealth(connectionId, provider, "active");
}
