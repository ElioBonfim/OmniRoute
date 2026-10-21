import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import {
  renameOwnedChatGptConversation,
  settleOwnedChatGptConversationId,
} from "../../open-sse/vendor/codex-chatgpt-web/adapters/chatgpt-web/conversation-title.ts";

const browserTest = process.env.RUN_CHATGPT_TITLE_BROWSER_TESTS === "1" ? test : test.skip;

function fixture(pt: boolean, navigateOnInput = false): string {
  const more = pt ? "Mais" : "More",
    rename = pt ? "Renomear" : "Rename",
    title = pt ? "Título do chat" : "Chat title";
  return (
    '<html><head><meta charset="utf-8"><title>Original</title></head><body><button aria-label="' +
    more +
    '" onclick="document.querySelector(\'#menu\').hidden=false">...</button><div id="menu" role="menu" hidden><button role="menuitem" onclick="document.querySelector(\'#rename\').hidden=false;document.querySelector(\'#menu\').hidden=true">' +
    rename +
    '</button></div><div id="rename" role="dialog" aria-label="' +
    (pt ? "Renomear chat" : "Rename chat") +
    '" hidden><input aria-label="' +
    title +
    '" ' +
    (navigateOnInput ? "oninput=\"history.pushState({},'','/c/different')\"" : "") +
    "><button onclick=\"document.title=document.querySelector('input').value;document.body.dataset.saves=String(Number(document.body.dataset.saves||0)+1);document.querySelector('#rename').hidden=true\">" +
    (pt ? "Salvar" : "Save") +
    "</button><button onclick=\"document.querySelector('#rename').hidden=true\">" +
    (pt ? "Cancelar" : "Cancel") +
    "</button></div></body></html>"
  );
}

browserTest(
  "title UI persists only the title, in Portuguese and English, without sending a prompt",
  async () => {
    const browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.CHATGPT_WEB_CHROME_PATH ||
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    });
    try {
      for (const pt of [true, false]) {
        const page = await browser.newPage();
        await page.route("**/*", (r) => r.fulfill({ contentType: "text/html", body: fixture(pt) }));
        await page.goto("https://chatgpt.com/c/owned-conversation");
        assert.equal(
          await renameOwnedChatGptConversation(
            page,
            "[OMNIROUTE] 2026-10-20 | Projeto | sessão 123",
            "owned-conversation"
          ),
          true
        );
        assert.equal(await page.title(), "[OMNIROUTE] 2026-10-20 | Projeto | sessão 123");
        assert.equal(await page.locator("body").getAttribute("data-saves"), "1");
        assert.equal(
          await renameOwnedChatGptConversation(page, await page.title(), "owned-conversation"),
          true
        );
        assert.equal(await page.locator("body").getAttribute("data-saves"), "1");
        await page.close();
      }
    } finally {
      await browser.close();
    }
  }
);

browserTest("temporary chats and other origins never open a title editor", async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHATGPT_WEB_CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  try {
    const page = await browser.newPage();
    await page.route("**/*", (r) => r.fulfill({ contentType: "text/html", body: fixture(true) }));
    for (const url of [
      "https://chatgpt.com/?temporary-chat=true",
      "https://chatgpt.com.evil.invalid/c/other",
      "https://chatgpt.com/c/personal",
    ]) {
      await page.goto(url);
      assert.equal(
        await renameOwnedChatGptConversation(page, "must not apply", "owned-conversation"),
        false
      );
      assert.equal(await page.title(), "Original");
      assert.equal(await page.locator("body").getAttribute("data-saves"), null);
    }
  } finally {
    await browser.close();
  }
});

browserTest("navigation to another conversation before Save prevents the write", async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHATGPT_WEB_CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  try {
    const page = await browser.newPage();
    await page.route("**/*", (r) =>
      r.fulfill({ contentType: "text/html", body: fixture(true, true) })
    );
    await page.goto("https://chatgpt.com/c/owned-conversation");
    await assert.rejects(
      renameOwnedChatGptConversation(page, "must not apply", "owned-conversation"),
      /conversation changed/
    );
    assert.equal(await page.locator("body").getAttribute("data-saves"), null);
    assert.equal(await page.title(), "Original");
  } finally {
    await browser.close();
  }
});

browserTest("a submitted local ChatGPT draft settles to its saved ID before renaming", async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHATGPT_WEB_CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  try {
    const page = await browser.newPage();
    await page.route("**/*", (r) => r.fulfill({ contentType: "text/html", body: fixture(true) }));
    await page.goto("https://chatgpt.com/c/local-chatgpt%3A849c6fa9-2996-4a73-972f-abccc5b98de1");
    const submittedUrl = page.url();
    await page.evaluate(() => history.replaceState({}, "", "/c/saved-own-conversation"));
    assert.equal(
      await settleOwnedChatGptConversationId(page, submittedUrl),
      "saved-own-conversation"
    );
    assert.equal(
      await renameOwnedChatGptConversation(page, "[OMNIROUTE] settled", "saved-own-conversation"),
      true
    );
    await page.goto("https://chatgpt.com/c/personal-conversation");
    await assert.rejects(
      settleOwnedChatGptConversationId(page, "https://chatgpt.com/c/other-saved-conversation"),
      /conversation changed/
    );
    assert.equal(await page.locator("body").getAttribute("data-saves"), null);
  } finally {
    await browser.close();
  }
});
