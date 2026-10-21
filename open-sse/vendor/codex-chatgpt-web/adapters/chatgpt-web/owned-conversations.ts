import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface OwnedConversation {
  version: 1;
  source: "omniroute-web-codex";
  id: string;
  title: string;
  traceId: string;
  finishedAt: string;
  status: "finished" | "deleted";
  deletedAt?: string;
}

export const OWNED_CHAT_PREFIX = "[OMNIROUTE] ";
const validId = (id: string) => /^[a-zA-Z0-9-]{1,100}$/.test(id);
export function ownedConversationDirectory(storageStatePath: string): string {
  return join(dirname(storageStatePath), "owned-conversations");
}

export function isOwnedConversation(value: unknown): value is OwnedConversation {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === 1 &&
    v.source === "omniroute-web-codex" &&
    typeof v.id === "string" &&
    validId(v.id) &&
    typeof v.title === "string" &&
    /^\[OMNIROUTE\] \d{4}-\d{2}-\d{2} \| [^|\r\n]+ \| sessão [^|\r\n]+$/.test(v.title) &&
    typeof v.traceId === "string" &&
    /^[a-zA-Z0-9_-]{6,128}$/.test(v.traceId) &&
    typeof v.finishedAt === "string" &&
    Number.isFinite(Date.parse(v.finishedAt)) &&
    (v.status === "finished" || v.status === "deleted")
  );
}

function save(directory: string, value: OwnedConversation): void {
  if (!isOwnedConversation(value)) throw new Error("Invalid owned conversation record");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${value.id}-${randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx" });
  renameSync(temporary, join(directory, `${value.id}.json`));
}

/** Called only after an OmniRoute browser turn has ended and its own chat was titled. */
export function recordFinishedOwnedConversation(
  storageStatePath: string,
  input: { id: string; title: string; traceId: string; finishedAt?: string }
): OwnedConversation {
  const record: OwnedConversation = {
    version: 1,
    source: "omniroute-web-codex",
    ...input,
    finishedAt: input.finishedAt ?? new Date().toISOString(),
    status: "finished",
  };
  save(ownedConversationDirectory(storageStatePath), record);
  return record;
}

export function readOwnedConversations(storageStatePath: string): OwnedConversation[] {
  const directory = ownedConversationDirectory(storageStatePath);
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const value: unknown = JSON.parse(readFileSync(join(directory, name), "utf8"));
      if (!isOwnedConversation(value) || name !== `${value.id}.json`) {
        throw new Error(`Invalid owned conversation file: ${name}`);
      }
      return value;
    });
}

export function eligibleOwnedConversations(
  records: OwnedConversation[],
  now = Date.now(),
  activeIds = new Set<string>()
): OwnedConversation[] {
  const cutoff = now - 12 * 60 * 60 * 1000;
  return records.filter(
    (record) =>
      isOwnedConversation(record) &&
      record.status === "finished" &&
      Date.parse(record.finishedAt) < cutoff &&
      !activeIds.has(record.id)
  );
}

export function markOwnedConversationDeleted(
  storageStatePath: string,
  record: OwnedConversation
): void {
  save(ownedConversationDirectory(storageStatePath), {
    ...record,
    status: "deleted",
    deletedAt: new Date().toISOString(),
  });
}
