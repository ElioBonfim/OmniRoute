import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chatGptWebStorageStateFromCookieHeader,
  normalizeChatGptWebStorageState,
} from "../../open-sse/utils/chatgptWebExecutorAdapter.ts";
test("Cookie headers preserve host-only semantics for __Host cookies", () => {
  const state = chatGptWebStorageStateFromCookieHeader(
    "__Host-next-auth.csrf-token=fixture; __Secure-next-auth.session-token=fixture"
  );
  assert.equal(state.cookies[0].domain, "chatgpt.com");
  assert.equal(state.cookies[0].path, "/");
  assert.equal(state.cookies[0].secure, true);
  assert.equal(state.cookies[1].domain, ".chatgpt.com");
});
test("normalization repairs previously imported __Host domains without changing the stored input", () => {
  const cookie = {
    name: "__Host-next-auth.csrf-token",
    value: "fixture",
    domain: ".chatgpt.com",
    path: "/",
    expires: -1,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  };
  const source = { cookies: [cookie], origins: [] };
  const normalized = normalizeChatGptWebStorageState(source);
  assert.equal(normalized.cookies[0].domain, "chatgpt.com");
  assert.equal(source.cookies[0].domain, ".chatgpt.com");
});
