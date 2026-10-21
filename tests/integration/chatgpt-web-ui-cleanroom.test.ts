import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { executeChatGptWebUiTurn } from "../../open-sse/utils/chatgptWebUiTurn.ts";
import {
  parseChatGptWebDirectConversation,
  PlaywrightChatGptWebBrowserSession,
  runChatGptWebBrowserTurn,
} from "../../open-sse/utils/chatgptWebBrowserSession.ts";
const fixture = `<html><body><form><div id="prompt-textarea" contenteditable="true" role="textbox"></div><button type="button" data-testid="model-switcher-dropdown-button" aria-haspopup="menu" onclick="document.querySelector('[role=menu]').hidden=false">Model</button><button type="submit" data-testid="send-button">Send</button></form><div role="menu" hidden><button role="menuitemradio" aria-checked="true">GPT-5.6 Sol</button><div role="menuitem" onkeydown="if(!['ArrowRight','ArrowLeft'].includes(event.key))return;let s=this.querySelector('[role=slider]');s.setAttribute('aria-valuenow',Number(s.getAttribute('aria-valuenow'))+(event.key==='ArrowRight'?1:-1))" tabindex="0"><span data-model-reasoning-effort-slider><span role="slider" aria-valuemin="0" aria-valuemax="4" aria-valuenow="2">Effort</span></span></div></div><article data-testid="conversation-turn-0" data-turn="assistant"><div data-message-author-role="assistant"><div class="markdown">STALE</div></div><button data-testid="copy-turn-action-button">Copy</button></article><script>document.querySelector('form').onsubmit=e=>{e.preventDefault();window.sent=document.querySelector('#prompt-textarea').textContent;document.body.insertAdjacentHTML('beforeend','<article data-testid="conversation-turn-1" data-turn="assistant"><div data-message-author-role="assistant"><div class="markdown">FIXTUREUIOK<pre><code class="language-js">const n = 1;</code></pre></div></div><button data-testid="copy-turn-action-button">Copy</button></article>')};</script></body></html>`;
test(
  "UI transport selects effort, sends one prompt, and reads only the new completed assistant",
  { skip: process.env.RUN_CLEANROOM_BROWSER_TESTS !== "1" },
  async () => {
    const browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.CHATGPT_WEB_CHROME_PATH ||
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.route("**/*", (route) =>
        route.fulfill({ contentType: "text/html", body: fixture })
      );
      await page.goto("https://chatgpt.com/?temporary-chat=true");
      const result = await executeChatGptWebUiTurn(page, {
        prompt: "fixture prompt",
        attachments: [],
        selection: { kind: "picker", modelLabel: "GPT-5.6 Sol", effortIndex: 0 },
      });
      assert.match(
        parseChatGptWebDirectConversation(result).text,
        /FIXTUREUIOK[\s\S]*```js\nconst n = 1;/
      );
      assert.equal(await page.evaluate(() => window["sent"]), "fixture prompt");
      assert.equal(await page.locator('[role="slider"]').getAttribute("aria-valuenow"), "0");
      const cancelled = AbortSignal.abort();
      await assert.rejects(
        executeChatGptWebUiTurn(
          page,
          {
            prompt: "do not send",
            attachments: [],
            selection: { kind: "free", thinkEnabled: false },
          },
          { signal: cancelled }
        ),
        /abort/i
      );
      assert.equal(await page.evaluate(() => window["sent"]), "fixture prompt");
      const session = new PlaywrightChatGptWebBrowserSession(page, {
        selection: { kind: "picker", modelLabel: "GPT-5.6 Sol", effortIndex: 0 },
        closePageOnCleanup: true,
      });
      const answer = await runChatGptWebBrowserTurn(session, {
        prompt: "full session",
        timeoutMs: 5000,
      });
      assert.match(answer.text, /FIXTUREUIOK[\s\S]*```js\nconst n = 1;/);
      assert.equal(page.isClosed(), true);
    } finally {
      await browser.close();
    }
  }
);

test(
  "modern ChatGPT completion outside the assistant search unit is returned",
  { skip: process.env.RUN_CLEANROOM_BROWSER_TESTS !== "1" },
  async () => {
    const browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.CHATGPT_WEB_CHROME_PATH ||
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    });
    try {
      const modern = fixture
        .replace(
          /<article[^>]*data-turn="assistant">/g,
          '<section><div data-chatgpt-search-unit-key="fixture:assistant">'
        )
        .replace(
          /<\/article>/g,
          '</div><button aria-label="Gerar resposta novamente">Retry</button></section>'
        )
        .replace(/class="markdown"/g, 'class="MarkdownRoot-fixture"')
        .replace(/<button data-testid="copy-turn-action-button">Copy<\/button>/g, "");
      const page = await browser.newPage();
      await page.route("**/*", (r) => r.fulfill({ contentType: "text/html", body: modern }));
      await page.goto("https://chatgpt.com/?temporary-chat=true");
      const session = new PlaywrightChatGptWebBrowserSession(page, {
        selection: { kind: "picker", modelLabel: "GPT-5.6 Sol", effortIndex: 0 },
        closePageOnCleanup: true,
      });
      const result = await runChatGptWebBrowserTurn(session, {
        prompt: "modern fixture",
        timeoutMs: 2000,
      });
      assert.match(result.text, /FIXTUREUIOK[\s\S]*const n = 1;/);
      assert.equal(page.isClosed(), true);
    } finally {
      await browser.close();
    }
  }
);
