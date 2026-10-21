/* Adapted from miuuyy/codex-chatgpt-web commit 09877fa21ffdbf20979623ef501046fc02a750d7 (MIT). */
import type { Locator, Page } from "playwright-core";
import type { ChatGptWebAccountCapabilities } from "./chatgpt-web-models";

export const CHATGPT_TEMPORARY_CHAT_URL = "https://chatgpt.com/?temporary-chat=true";
export const CHATGPT_COMPOSER_SELECTOR = [
  '[data-testid="prompt-textarea"]',
  "#prompt-textarea",
  '[contenteditable="true"][role="textbox"]',
  '[contenteditable="true"][data-lexical-editor="true"]',
  '[contenteditable="true"][role="textbox"]',
  '[contenteditable="true"][role="textbox"].ProseMirror',
].join(", ");
export const CHATGPT_EFFORT_CONTROL_SELECTOR = [
  'button[data-codex-intelligence-trigger="true"]',
  'button[aria-haspopup="menu"][data-tone="neutral"]',
  'button[data-testid="model-switcher-dropdown-button"][aria-haspopup="menu"]',
].join(", ");
export const CHATGPT_EFFORT_MENU_SELECTOR = [
  '[data-testid="composer-intelligence-picker-content"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider])',
  '[role="menu"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider])',
  '[role="group"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider])',
  '[role="menu"]:has([data-model-picker-power-slider])',
].join(", ");
export const CHATGPT_EFFORT_ITEM_SELECTOR = '[role="menuitemradio"]';
export const CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR =
  "[data-model-reasoning-effort-slider], [data-model-picker-power-slider]";
export const CHATGPT_EFFORT_SLIDER_SELECTOR =
  '[data-model-reasoning-effort-slider] [role="slider"], [data-model-picker-power-slider] [role="slider"], [role="menuitem"][data-reasoning-slider="true"]';
export const CHATGPT_EFFORT_SLIDER_MAX_OPTIONS = 5;
const CHATGPT_STOP_ICON_PATH =
  "M4.5 5.75C4.5 5.05964 5.05964 4.5 5.75 4.5H14.25C14.9404 4.5 15.5 5.05964 15.5 5.75V14.25C15.5 14.9404 14.9404 15.5 14.25 15.5H5.75C5.05964 15.5 4.5 14.9404 4.5 14.25V5.75Z";
export const CHATGPT_STOP_BUTTON_SELECTOR =
  '[data-testid="stop-button"], ' +
  `form[data-chatgpt-composer] button[type="button"].size-token-button-composer:has(svg.icon-primary-action > path[d="${CHATGPT_STOP_ICON_PATH}"])`;
export const CHATGPT_COMPLETION_ACTION_SELECTOR =
  'button[data-testid="copy-turn-action-button"], [data-turn-key] .turn-action-controls button';
export const CHATGPT_ASSISTANT_TURN_SELECTOR = [
  '[data-chatgpt-search-unit-key$=":assistant"]:not([data-turn-key] *)',
  '[data-testid^="conversation-turn-"][data-turn="assistant"]:not([data-turn-key] *)',
  '[data-testid^="conversation-turn-"][data-message-author-role="assistant"]:not([data-turn-key] *)',
  '[data-testid^="conversation-turn-"]:has([data-message-author-role="assistant"]):not([data-turn-key] *)',
  '[data-turn-key]:has([data-conversation-role="assistant"], [data-chatgpt-agent-turn-start])',
].join(", ");
export const CHATGPT_USER_TURN_SELECTOR = [
  '[data-chatgpt-search-unit-key$=":user"]:not([data-turn-key] *)',
  '[data-testid^="conversation-turn-"][data-turn="user"]:not([data-turn-key] *)',
  '[data-testid^="conversation-turn-"][data-message-author-role="user"]:not([data-turn-key] *)',
  '[data-testid^="conversation-turn-"]:has([data-message-author-role="user"]):not([data-turn-key] *)',
  "[data-turn-key]:has([data-user-message-bubble])",
].join(", ");

/** Keep the established identity for classic turns and bind grouped turns by their stable key. */
export function chatGptAssistantTurnSelector(identity: string): string {
  const prefix = "group:assistant:";
  return identity.startsWith(prefix)
    ? `[data-turn-key=${JSON.stringify(identity.slice(prefix.length))}]:has([data-conversation-role="assistant"], [data-chatgpt-agent-turn-start])`
    : `[data-testid=${JSON.stringify(identity)}], [data-chatgpt-search-unit-key=${JSON.stringify(identity)}]`;
}

export interface ChatGptEffortSliderState {
  min: number;
  max: number;
  value: number;
}

/** Model identity precedes the localized slider position; punctuation is not language-specific. */
export function parseChatGptModelAnnouncement(text: string):
  | {
      version: string;
      name?: string;
      mode: string;
    }
  | undefined {
  const normalized = text
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  const match = /^(?:GPT[-\s]?)?(\d+(?:\.\d+)?)(?:\s+(Sol|Astra))?\s+([^\p{P}]+)(?:\p{P}|$)/iu.exec(
    normalized
  );
  if (!match) return undefined;
  return {
    version: match[1]!,
    ...(match[2] ? { name: match[2].toLowerCase() } : {}),
    mode: match[3]!.trim(),
  };
}

/** Read model evidence only from the slider's own active picker. */
export async function readChatGptModelAnnouncements(slider: Locator): Promise<string[]> {
  return slider.evaluate((element) => {
    const doc = element.ownerDocument;
    const descriptions = (
      element.closest('[role="menuitem"]')?.getAttribute("aria-describedby") ?? ""
    )
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => doc.getElementById(id)?.textContent ?? "");
    // Some accounts now announce only the effort ("Pro, 5 of 5"); the model
    // version is shown in the picker header as adjacent text nodes ("6" + "Pro").
    const menu = element.closest('[role="menu"]');
    const rendered = (node: Element): boolean => {
      for (let parent: Element | null = node; parent; parent = parent.parentElement) {
        if (parent.matches('[hidden], [inert], [aria-hidden="true"]')) return false;
        const style = getComputedStyle(parent);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")
          return false;
      }
      return true;
    };
    const headers = [
      ...(menu?.querySelectorAll('[data-model-picker-view-toggle="true"]') ?? []),
    ].filter((header) => header.closest('[role="menu"]') === menu && rendered(header));
    if (headers.length > 1)
      throw new Error("ChatGPT model picker exposes multiple active model headers");
    if (headers.length === 1) {
      const content = headers[0]!.querySelector("[data-menu-row-content]") ?? headers[0]!;
      const words: string[] = [];
      const walker = doc.createTreeWalker(content, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.parentElement && rendered(node.parentElement)) {
          const word = node.textContent?.trim();
          if (word) words.push(word);
        }
      }
      // New pickers show the base family beside a complete model/effort label,
      // e.g. "5.6 Sol" + "5.6 Pro". Do not concatenate two model identities.
      const fullEfforts = [...content.querySelectorAll('[data-effort-only="false"]')].filter(
        rendered
      );
      if (fullEfforts.length > 1)
        throw new Error("ChatGPT model picker exposes multiple effort labels");
      const fullEffort = fullEfforts[0]?.textContent?.trim();
      const versionPattern = /^(?:GPT[-\s]?)?(\d+(?:\.\d+)?)(?:\s|$)/i;
      const effortVersion = fullEffort?.match(versionPattern)?.[1];
      if (fullEffort && effortVersion) {
        const familyVersion = words.join(" ").match(versionPattern)?.[1];
        if (familyVersion !== effortVersion)
          throw new Error("ChatGPT model picker family and effort versions disagree");
        descriptions.push(fullEffort);
      } else {
        descriptions.push(words.join(" "));
      }
    }
    return descriptions;
  });
}

export interface ChatGptEffortActivation {
  method: "already-open" | "click" | "pointerdown";
  menu: Locator;
  sliderContainer: Locator;
  slider: Locator;
}

export function chatGptEffortSlider(page: Page): { sliderContainer: Locator; slider: Locator } {
  const sliderContainer = page
    .locator(CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR)
    .filter({ visible: true });
  // The current picker keeps ARIA values on a zero-width, aria-hidden semantic input.
  // Its visible container proves the active surface; the input proves the effort range.
  return { sliderContainer, slider: sliderContainer.locator('[role="slider"]') };
}

function effortMenuSelectorForId(menuId: string): string {
  return `[id=${JSON.stringify(menuId)}]`;
}

export async function chatGptEffortMenuForControl(page: Page, control: Locator): Promise<Locator> {
  const menuId = await control.getAttribute("aria-controls").catch(() => null);
  if (menuId) return page.locator(effortMenuSelectorForId(menuId));
  const controlId = await control.getAttribute("id").catch(() => null);
  if (controlId)
    return page
      .locator(`[role="menu"][aria-labelledby~=${JSON.stringify(controlId)}]`)
      .filter({ visible: true });
  return page.locator(CHATGPT_EFFORT_MENU_SELECTOR).filter({ visible: true });
}

async function visibleEffortSurface(
  page: Page,
  control: Locator
): Promise<Omit<ChatGptEffortActivation, "method"> | undefined> {
  // The exit animation keeps a closed menu's slider visible after Escape. Read the
  // owner state first: selecting that outgoing range races its removal from the DOM.
  const expanded = await control.getAttribute("aria-expanded").catch(() => null);
  const state = await control.getAttribute("data-state").catch(() => null);
  if (expanded === "false" || state === "closed") return undefined;
  const menu = await chatGptEffortMenuForControl(page, control);
  const surface = chatGptEffortSlider(page);
  if (
    (await menu.isVisible().catch(() => false)) ||
    (await surface.sliderContainer.isVisible().catch(() => false))
  ) {
    return { menu, ...surface };
  }
  return undefined;
}

async function waitForEffortSurface(
  page: Page,
  control: Locator,
  timeoutMs: number
): Promise<Omit<ChatGptEffortActivation, "method"> | undefined> {
  const deadline = Date.now() + timeoutMs;
  do {
    const surface = await visibleEffortSurface(page, control);
    if (surface) return surface;
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
  } while (true);
}

async function clearGhostEffortState(page: Page, control: Locator): Promise<void> {
  const expanded = await control.getAttribute("aria-expanded").catch(() => null);
  const state = await control.getAttribute("data-state").catch(() => null);
  if (expanded === "true" || state === "open") {
    await page.keyboard.press("Escape").catch(() => {});
  }
}

export async function activateChatGptEffortMenu(
  page: Page,
  control: Locator,
  options: { settleMs?: number } = {}
): Promise<ChatGptEffortActivation> {
  const openSurface = await visibleEffortSurface(page, control);
  if (openSurface) return { method: "already-open", ...openSurface };

  const settleMs = options.settleMs ?? 3_000;
  await clearGhostEffortState(page, control);
  // Let Playwright wait for stable layout and hit testing after navigation.
  // A forced click can be delivered before the new renderer's viewport is usable.
  await control.click({ timeout: Math.max(1, settleMs) });
  const clickedSurface = await waitForEffortSurface(page, control, settleMs);
  if (clickedSurface) return { method: "click", ...clickedSurface };

  await clearGhostEffortState(page, control);
  await control.dispatchEvent("pointerdown", {
    button: 0,
    buttons: 1,
    pointerType: "mouse",
    isPrimary: true,
  });
  const pointerSurface = await waitForEffortSurface(page, control, settleMs);
  if (pointerSurface) return { method: "pointerdown", ...pointerSurface };
  throw new Error(
    "ChatGPT effort control did not expose its owned menu or structural slider after click and primary pointerdown"
  );
}

function safeIntegerAttribute(value: string | null): number | undefined {
  if (value === null || !/^-?\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function parseChatGptEffortSliderState(
  rawMin: string | null,
  rawMax: string | null,
  rawValue: string | null
): ChatGptEffortSliderState | undefined {
  const min = safeIntegerAttribute(rawMin);
  const max = safeIntegerAttribute(rawMax);
  const value = safeIntegerAttribute(rawValue);
  if (min === undefined || max === undefined || value === undefined) return undefined;
  const optionCount = max - min + 1;
  if (optionCount < 1 || optionCount > CHATGPT_EFFORT_SLIDER_MAX_OPTIONS) return undefined;
  if (value < min || value > max) return undefined;
  return { min, max, value };
}

export async function readChatGptEffortSnapshot(
  sliderContainer: Locator,
  timeoutMs = 1_000
): Promise<ChatGptEffortSliderState & { available: boolean[] }> {
  const deadline = Date.now() + timeoutMs;
  do {
    // Read the range, selection and locks in one DOM revision. Separate Playwright
    // reads can straddle hydration and combine a five-step range with four ticks.
    const snapshot = await sliderContainer.evaluate((container) => {
      const sliders = container.querySelectorAll('[role="slider"]');
      const slider = sliders.length === 1 ? sliders[0] : undefined;
      const power =
        container.hasAttribute("data-model-picker-power-slider") &&
        Boolean(container.querySelector('[data-orientation="horizontal"][aria-disabled="false"]'));
      return {
        min: slider?.getAttribute("aria-valuemin") ?? null,
        max: slider?.getAttribute("aria-valuemax") ?? null,
        value: slider?.getAttribute("aria-valuenow") ?? null,
        locks: Array.from(
          container.querySelectorAll("[data-selected]"),
          (tick) => tick.getAttribute("data-locked") ?? (power ? "false" : null)
        ),
      };
    });
    const state = parseChatGptEffortSliderState(snapshot.min, snapshot.max, snapshot.value);
    if (!state) throw new Error("ChatGPT effort slider exposed an invalid ARIA range");
    if (snapshot.locks.some((lock) => lock !== "true" && lock !== "false")) break;
    if (snapshot.locks.length === state.max - state.min + 1) {
      return { ...state, available: snapshot.locks.map((lock) => lock === "false") };
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (true);
  throw new Error("ChatGPT effort availability could not be verified from its slider ticks");
}

/** Current ChatGPT renders the effort control as a keyboard stepper with a live status label. */
export function parseChatGptEffortStepperState(
  statusText: string | null
): ChatGptEffortSliderState | undefined {
  const match = statusText?.match(/(?:^|\D)(\d+)\s+(?:of|de)\s+(\d+)(?:\D|$)/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  const max = Number(match[2]);
  if (!Number.isSafeInteger(value) || !Number.isSafeInteger(max)) return undefined;
  if (max < 1 || max > CHATGPT_EFFORT_SLIDER_MAX_OPTIONS || value < 1 || value > max)
    return undefined;
  return { min: 1, max, value };
}

async function anyVisible(locator: Locator): Promise<boolean> {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    if (
      await locator
        .nth(index)
        .isVisible()
        .catch(() => false)
    )
      return true;
  }
  return false;
}

export async function assertAuthenticatedChatGptPage(page: Page): Promise<void> {
  const accountChooser = page
    .locator('[role="dialog"]:has([data-testid="close-button"]):has([role="button"]:has(button))')
    .filter({ visible: true });
  if ((await accountChooser.count()) > 0) {
    throw new Error(
      "ChatGPT authentication could not be verified: the account chooser requires sign-in"
    );
  }
  const composer = page.locator(CHATGPT_COMPOSER_SELECTOR);
  if (!(await anyVisible(composer))) {
    throw new Error("ChatGPT authentication could not be verified: no visible composer is present");
  }
}

export async function assertTemporaryChatPage(page: Page): Promise<void> {
  const url = new URL(page.url());
  const expected = new URL(CHATGPT_TEMPORARY_CHAT_URL);
  if (
    url.origin !== expected.origin ||
    url.pathname !== expected.pathname ||
    url.searchParams.get("temporary-chat") !== "true"
  ) {
    throw new Error(`ChatGPT left the isolated Temporary Chat surface (${page.url()})`);
  }
}

export async function detectChatGptAccountCapabilities(
  page: Page,
  options: { selectorTimeoutMs?: number; stableAbsenceMs?: number } = {}
): Promise<ChatGptWebAccountCapabilities> {
  const composers = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true });
  const composer = composers.last();
  const composerForm = composer.locator("xpath=ancestor::form[1]");
  const effortButton = composerForm.locator(CHATGPT_EFFORT_CONTROL_SELECTOR).last();
  const deadline = Date.now() + (options.selectorTimeoutMs ?? 30_000);
  const stableAbsenceMs = options.stableAbsenceMs ?? 12_000;
  let absenceSince: number | undefined;
  let presenceObservations = 0;
  while (true) {
    const effortVisible = await effortButton.isVisible().catch(() => false);
    if (effortVisible) {
      presenceObservations += 1;
      absenceSince = undefined;
      if (presenceObservations >= 2) break;
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
      continue;
    }
    presenceObservations = 0;
    const composerReady = await composers
      .count()
      .then((count) => count === 1)
      .catch(() => false);
    const formReady = await composerForm
      .count()
      .then((count) => count === 1)
      .catch(() => false);
    const documentReady = await page
      .evaluate(() => document.readyState === "complete")
      .catch(() => false);
    if (composerReady && formReady && documentReady) {
      absenceSince ??= Date.now();
      if (Date.now() - absenceSince >= stableAbsenceMs) {
        return { solAvailable: false, proAvailable: false };
      }
    } else {
      absenceSince = undefined;
    }
    if (Date.now() >= deadline) {
      throw new Error("ChatGPT account capability probe did not reach a stable composer state");
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
  }
  console.info("[ChatGPT validation] effort control ready");
  const menu = page.locator(CHATGPT_EFFORT_MENU_SELECTOR).last();
  const menuVisible = await menu.isVisible().catch(() => false);
  const menuExpanded = await effortButton.getAttribute("aria-expanded").catch(() => null);
  if (!menuVisible && menuExpanded !== "true") {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (attempt % 2 === 0) await effortButton.click({ force: true });
      else await effortButton.press("Enter");
      for (let tick = 0; tick < 10; tick += 1) {
        if ((await effortButton.getAttribute("aria-expanded")) === "true") break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if ((await effortButton.getAttribute("aria-expanded")) === "true") break;
    }
    if ((await effortButton.getAttribute("aria-expanded")) !== "true") {
      throw new Error("ChatGPT model selector did not open; wait for the page to finish loading");
    }
  }
  console.info("[ChatGPT validation] effort menu requested");
  try {
    const efforts = menu.locator(CHATGPT_EFFORT_ITEM_SELECTOR);
    const slider = page.locator(CHATGPT_EFFORT_SLIDER_SELECTOR).filter({ visible: true }).last();
    const stepperStatuses = menu.locator('[role="status"]');
    const waitAbort = new AbortController();
    try {
      const ready = await Promise.race([
        efforts
          .first()
          .waitFor({ state: "visible", timeout: 70_000, signal: waitAbort.signal })
          .then(() => "items" as const),
        slider
          .waitFor({ state: "visible", timeout: 70_000, signal: waitAbort.signal })
          .then(() => "slider" as const),
        stepperStatuses
          .first()
          .waitFor({ state: "attached", timeout: 70_000, signal: waitAbort.signal })
          .then(() => "stepper" as const),
      ]);
      const sliderVisible = await slider.isVisible().catch(() => false);
      const stepperState = (await stepperStatuses.allTextContents().catch(() => []))
        .map((text) => parseChatGptEffortStepperState(text))
        .find((state) => state !== undefined);
      if (ready === "stepper" || stepperState) {
        if (!stepperState) throw new Error("ChatGPT effort stepper exposed an invalid status");
        return { solAvailable: true, proAvailable: stepperState.max >= 5 };
      }
      if (!sliderVisible) {
        return { solAvailable: true, proAvailable: (await efforts.count()) >= 5 };
      }
      const state = parseChatGptEffortSliderState(
        await slider.getAttribute("aria-valuemin"),
        await slider.getAttribute("aria-valuemax"),
        await slider.getAttribute("aria-valuenow")
      );
      if (!state) throw new Error("ChatGPT effort slider exposed an invalid ARIA range");
      return { solAvailable: true, proAvailable: state.max - state.min + 1 >= 5 };
    } finally {
      waitAbort.abort();
    }
  } finally {
    await page.keyboard.press("Escape").catch(() => {});
  }
}
