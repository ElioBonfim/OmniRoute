import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  eligibleOwnedConversations,
  isOwnedConversation,
  markOwnedConversationDeleted,
  ownedConversationDirectory,
  readOwnedConversations,
  recordFinishedOwnedConversation,
  type OwnedConversation,
} from "../../open-sse/vendor/codex-chatgpt-web/adapters/chatgpt-web/owned-conversations.ts";

const now = Date.parse("2026-10-22T08:00:00Z");
const record = (hours: number): OwnedConversation => ({
  version: 1,
  source: "omniroute-web-codex",
  id: "qa-owned-123",
  title: "[OMNIROUTE] 2026-10-21 | projeto | sessão qa-session",
  traceId: "qa-trace-123",
  status: "finished",
  finishedAt: new Date(now - hours * 3600000).toISOString(),
});

test("only registered chats finished strictly more than twelve hours ago qualify", () => {
  assert.deepEqual(eligibleOwnedConversations([record(13)], now), [record(13)]);
  for (const hours of [12, 11.999, 0, -1])
    assert.deepEqual(eligibleOwnedConversations([record(hours)], now), []);
});

test("active and already deleted conversations never qualify", () => {
  assert.deepEqual(eligibleOwnedConversations([record(24)], now, new Set([record(24).id])), []);
  assert.deepEqual(eligibleOwnedConversations([{ ...record(24), status: "deleted" }], now), []);
});

test("a prefix alone, malformed ownership or an arbitrary path is insufficient", () => {
  for (const override of [
    { source: "personal" },
    { version: 2 },
    { id: "../../personal" },
    { title: "Personal chat" },
    { title: "[OMNIROUTE] personal chat" },
    { finishedAt: "invalid" },
    { traceId: "" },
    { status: "running" },
  ]) {
    const candidate = { ...record(24), ...override };
    assert.equal(isOwnedConversation(candidate), false);
    assert.deepEqual(eligibleOwnedConversations([candidate as OwnedConversation], now), []);
  }
});

test("ownership survives concurrent separate IDs and deletion preserves the audit record", () => {
  const root = mkdtempSync(join(tmpdir(), "omni-cleanup-test-"));
  const state = join(root, "storage-state.json");
  try {
    const first = recordFinishedOwnedConversation(state, record(24));
    recordFinishedOwnedConversation(state, { ...record(13), id: "qa-owned-456" });
    const directory = ownedConversationDirectory(state);
    assert.equal(readOwnedConversations(state).length, 2);
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(join(directory, first.id + ".json")).mode & 0o777, 0o600);
    markOwnedConversationDeleted(state, first);
    const stored = JSON.parse(readFileSync(join(directory, first.id + ".json"), "utf8"));
    assert.equal(stored.status, "deleted");
    assert.equal(stored.finishedAt, first.finishedAt);
    assert.ok(stored.deletedAt);
    assert.equal(eligibleOwnedConversations(readOwnedConversations(state), now).length, 1);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a later registration postpones cleanup instead of using a stale finish timestamp", () => {
  const root = mkdtempSync(join(tmpdir(), "omni-cleanup-test-"));
  const state = join(root, "storage-state.json");
  try {
    recordFinishedOwnedConversation(state, record(24));
    recordFinishedOwnedConversation(state, record(1));
    assert.deepEqual(eligibleOwnedConversations(readOwnedConversations(state), now), []);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("missing registry is empty; corrupt or mismatched files fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "omni-cleanup-test-"));
  const state = join(root, "storage-state.json");
  try {
    assert.deepEqual(readOwnedConversations(state), []);
    recordFinishedOwnedConversation(state, record(24));
    const directory = ownedConversationDirectory(state);
    writeFileSync(join(directory, "other-id.json"), JSON.stringify(record(24)));
    assert.throws(() => readOwnedConversations(state), /Invalid owned conversation file/);
    rmSync(join(directory, "other-id.json"));
    writeFileSync(join(directory, record(24).id + ".json"), "invalid json");
    assert.throws(() => readOwnedConversations(state));
  } finally {
    rmSync(root, { recursive: true });
  }
});
