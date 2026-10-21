import type { Page } from "playwright";
import { chatGptHtmlToMarkdown } from "../vendor/codex-chatgpt-web/adapters/chatgpt-web/markdown.ts";
import {
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_EFFORT_CONTROL_SELECTOR,
  CHATGPT_EFFORT_MENU_SELECTOR,
  CHATGPT_EFFORT_ITEM_SELECTOR,
  CHATGPT_EFFORT_SLIDER_SELECTOR,
  CHATGPT_ASSISTANT_TURN_SELECTOR,
  CHATGPT_COMPLETION_ACTION_SELECTOR,
  CHATGPT_STOP_BUTTON_SELECTOR,
  parseChatGptEffortSliderState,
} from "../vendor/codex-chatgpt-web/chatgpt-session.ts";
import type { ChatGptWebFirstPartyRequest } from "./chatgptWebFirstParty.ts";

export function requireChatGptWebAuthenticatedUrl(value: string): void {
  const url = new URL(value);
  if (url.origin !== "https://chatgpt.com")
    throw new Error("ChatGPT Web requires the first-party chatgpt.com origin");
  if (/^\/(?:auth|login)(?:\/|$)/.test(url.pathname)) {
    throw new Error(
      "ChatGPT Web session requires reauthentication; reconnect this account in Providers"
    );
  }
}

async function selectModel(page: Page, input: ChatGptWebFirstPartyRequest): Promise<void> {
  const form = page
    .locator(CHATGPT_COMPOSER_SELECTOR)
    .filter({ visible: true })
    .last()
    .locator("xpath=ancestor::form[1]");
  const control = form.locator(CHATGPT_EFFORT_CONTROL_SELECTOR).filter({ visible: true }).last();
  if (input.selection.kind === "free") {
    // Luna-only accounts expose a Think toggle rather than a paid model picker.
    if (await control.count())
      throw new Error("ChatGPT Web requested free model is not available on this account surface");
    const think = form.getByRole("button", { name: /^(Think|Pensar)$/i });
    if (!(await think.count())) {
      if (input.selection.thinkEnabled)
        throw new Error("ChatGPT Web reasoning control is unavailable");
      return;
    }
    const pressed = await think.getAttribute("aria-pressed");
    if (pressed !== "true" && pressed !== "false")
      throw new Error("ChatGPT Web reasoning control has no confirmed state");
    if ((pressed === "true") !== input.selection.thinkEnabled) await think.click();
    return;
  }
  await control.waitFor({ state: "visible", timeout: 20_000 });
  await control.click();
  try {
    const toggle = page
      .locator('[data-model-picker-view-toggle="true"]:not([aria-hidden="true"])')
      .filter({ visible: true });
    let family = page.getByRole("menuitemradio", { name: input.selection.modelLabel, exact: true });
    if (!(await family.isVisible()) && (await toggle.count())) await toggle.click();
    if (await family.isVisible()) {
      await family.click();
      family = page.getByRole("menuitemradio", {
        name: input.selection.modelLabel,
        exact: true,
        includeHidden: true,
      });
      if ((await family.getAttribute("aria-checked")) !== "true")
        throw new Error("ChatGPT Web did not confirm the requested model family");
    } else if (
      (await toggle.count()) ||
      !(await control.innerText()).includes(input.selection.modelLabel)
    ) {
      throw new Error("ChatGPT Web requested model family is unavailable");
    }
    const slider = page.locator(CHATGPT_EFFORT_SLIDER_SELECTOR).filter({ visible: true }).last();
    if (await slider.isVisible()) {
      const read = async () =>
        parseChatGptEffortSliderState(
          await slider.getAttribute("aria-valuemin"),
          await slider.getAttribute("aria-valuemax"),
          await slider.getAttribute("aria-valuenow")
        );
      let state = await read();
      if (!state) throw new Error("ChatGPT Web effort slider has an invalid ARIA range");
      const target = state.min + input.selection.effortIndex;
      if (target > state.max)
        throw new Error("ChatGPT Web requested reasoning effort is unavailable");
      const keys = slider.locator("xpath=ancestor::*[@role='menuitem'][1]");
      for (let steps = 0; state.value !== target && steps < 5; steps++) {
        const previous = state.value;
        await keys.press(target > previous ? "ArrowRight" : "ArrowLeft");
        const deadline = Date.now() + 3000;
        do {
          state = await read();
          if (!state) throw new Error("ChatGPT Web effort slider lost its ARIA state");
          if (state.value !== previous) break;
          await page.waitForTimeout(50);
        } while (Date.now() < deadline);
      }
      if (state.value !== target)
        throw new Error("ChatGPT Web did not confirm the requested reasoning effort");
    } else {
      const choice = page
        .locator(CHATGPT_EFFORT_MENU_SELECTOR)
        .last()
        .locator(CHATGPT_EFFORT_ITEM_SELECTOR)
        .nth(input.selection.effortIndex);
      await choice.waitFor({ state: "visible", timeout: 10_000 });
      const checked = await choice.getAttribute("aria-checked");
      if (checked !== "true" && checked !== "false")
        throw new Error("ChatGPT Web effort item has no confirmed state");
      if (checked !== "true") {
        await choice.click();
        if (!(await choice.isVisible())) await control.click();
        if ((await choice.getAttribute("aria-checked")) !== "true")
          throw new Error("ChatGPT Web did not confirm the requested reasoning effort");
      }
    }
  } finally {
    await page.keyboard.press("Escape").catch(() => {});
  }
}

async function checkUiFailure(page: Page): Promise<void> {
  const alerts = await page
    .locator('[role="alert"], [role="dialog"]')
    .filter({ visible: true })
    .allTextContents();
  const text = alerts.join(" ");
  if (/session has expired|sessão expirou|sessão expirada/i.test(text))
    throw new Error(
      "ChatGPT Web session requires reauthentication; reconnect this account in Providers"
    );
  if (/too many requests|rate limit|usage limit|limite de uso|muitas solicitações/i.test(text))
    throw new Error("ChatGPT Web rate limit reached; retry after the account quota resets");
  if (/Failed to load subscription|Something went wrong/i.test(text))
    throw new Error("ChatGPT Web browser reported an upstream failure");
}

/** Use ChatGPT's own composer and completed assistant turn; do not load private module exports. */
export async function executeChatGptWebUiTurn(
  page: Page,
  input: ChatGptWebFirstPartyRequest,
  options: { signal?: AbortSignal | null } = {}
): Promise<string> {
  const check = () => {
    options.signal?.throwIfAborted();
    requireChatGptWebAuthenticatedUrl(page.url());
  };
  check();
  const composer = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true }).last();
  try {
    await composer.waitFor({ state: "visible", timeout: 20_000 });
  } catch {
    check();
    throw new Error(
      "ChatGPT Web session could not be authenticated; reconnect this account in Providers"
    );
  }
  check();
  await checkUiFailure(page);
  const onboarding = page
    .locator('[role="dialog"]')
    .filter({ hasText: "Not in history" })
    .filter({ hasText: "No model training" })
    .filter({ hasText: "Memory off" })
    .last();
  if (await onboarding.isVisible())
    await onboarding.getByRole("button", { name: "Continue", exact: true }).click();
  await selectModel(page, input);
  check();
  await composer.fill(input.prompt);
  for (const kind of ["image", "file"] as const) {
    const files = input.attachments
      .filter((x) => x.kind === kind)
      .map((x) => ({ name: x.name, mimeType: x.mimeType, buffer: Buffer.from(x.data) }));
    if (!files.length) continue;
    const fileInput = page.locator(
      kind === "image"
        ? 'input[data-testid="upload-photos-input"]'
        : 'input[type="file"]#upload-files'
    );
    await fileInput.setInputFiles(files);
    const form = composer.locator("xpath=ancestor::form[1]");
    for (const file of files)
      await form
        .getByRole("group", { name: file.name, exact: true })
        .waitFor({ state: "visible", timeout: 60_000 });
  }
  const turns = page.locator(CHATGPT_ASSISTANT_TURN_SELECTOR);
  const before = await turns.count();
  const send = composer
    .locator("xpath=ancestor::form[1]")
    .locator('[data-testid="send-button"], button[type="submit"]')
    .last();
  const readyDeadline = Date.now() + 60_000;
  while (!(await send.isEnabled())) {
    check();
    if (Date.now() > readyDeadline)
      throw new Error("ChatGPT Web composer did not become ready to send");
    await page.waitForTimeout(100);
  }
  check();
  await send.click();
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    check();
    await checkUiFailure(page);
    if ((await turns.count()) > before) {
      const turn = turns.last();
      const modernActions = turn.locator(
        'xpath=ancestor::*[.//button[@aria-label="Gerar resposta novamente" or @aria-label="Regenerate response"]][1]'
      );
      const complete =
        (await turn.locator(CHATGPT_COMPLETION_ACTION_SELECTOR).isVisible()) ||
        (await modernActions
          .getByRole("button", { name: /^(Gerar resposta novamente|Regenerate response)$/ })
          .isVisible());
      const stillStreaming = (await turn.locator('[class*="AdaptiveStreaming-"]').count()) > 0;
      const stopping = await page.locator(CHATGPT_STOP_BUTTON_SELECTOR).isVisible();
      if (complete && !stopping && !stillStreaming) {
        const content = turn
          .locator(
            '.markdown, [data-markdown-text-style="assistant-message"], [class*="MarkdownRoot-"]'
          )
          .last();
        const text = chatGptHtmlToMarkdown(await content.innerHTML());
        if (!text) throw new Error("ChatGPT Web completed an empty assistant response");
        // Internal normalized event for the existing clean-room decoder. Text is the real DOM answer.
        return (
          'event: delta_encoding\ndata: "v1"\n\nevent: delta\ndata: ' +
          JSON.stringify({
            p: "",
            o: "add",
            v: {
              message: {
                author: { role: "assistant" },
                content: { content_type: "text", parts: [text] },
                status: "finished_successfully",
                end_turn: true,
              },
            },
          }) +
          "\n\ndata: [DONE]\n\n"
        );
      }
    }
    await page.waitForTimeout(200);
  }
  throw new Error("ChatGPT Web browser turn timed out");
}
