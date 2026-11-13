/* Family verification ported from the locally validated codex-chatgpt-web 6.1.12 (MIT). */
import {
  activateChatGptEffortMenu,
  parseChatGptEffortSliderState,
  parseChatGptModelAnnouncement,
  readChatGptModelAnnouncements,
} from "../../chatgpt-session";
import type { ChatGptWebAdapterEffort, ChatGptWebModelFamily } from "../../chatgpt-web-models";
import { ChatGptWebAdapterError } from "./adapter-error";

type EffortMenu = Awaited<ReturnType<typeof activateChatGptEffortMenu>>;

function familyError(family: ChatGptWebModelFamily, _cause?: unknown): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    `ChatGPT model ${family} could not be selected and verified. The pending message was not sent. Check the model in the browser; if ChatGPT uses an unsupported language, select English in Settings → General → Language and reload it.`,
    {
      status: 400,
      errorType: "invalid_request_error",
      code: "model_version_unavailable",
      retryable: false,
    }
  );
}

function familyOption(menu: EffortMenu, family: ChatGptWebModelFamily) {
  return menu.menu.getByRole("menuitemradio", {
    name:
      family === "5.6"
        ? /^GPT[-\s]?5\.6\s+Sol(?:\s+Pro)?$/i
        : // Simplified/Traditional Chinese and Japanese share 最新; Korean uses 최신.
          /^(?:Latest|最新|최신|(?:GPT[-\s]?)?6(?:\s+Astra)?(?:\s+Pro)?)$/i,
    exact: true,
    includeHidden: true,
  });
}

/** Model and effort are separate browser controls; a generic Pro label proves neither family. */
export async function selectChatGptModelFamily(
  menu: EffortMenu,
  family: ChatGptWebModelFamily,
  activate: () => Promise<EffortMenu>
): Promise<EffortMenu> {
  try {
    const option = familyOption(menu, family);
    if ((await option.count()) > 1) throw familyError(family);
    if ((await option.count()) === 1 && (await option.getAttribute("aria-checked")) === "true")
      return menu;
    // The attached radio rows are inert while this composer-owned advanced view is collapsed.
    const powerView = menu.menu.locator("[data-model-picker-view]");
    if ((await powerView.count()) === 1) {
      const view = await powerView.getAttribute("data-model-picker-view");
      if (view === "simple") {
        const trigger = powerView
          .locator('[data-model-picker-view-toggle="true"]:not([aria-hidden="true"])')
          .filter({ visible: true });
        if ((await trigger.count()) !== 1) throw familyError(family);
        await trigger.click({ timeout: 5_000 });
      } else if (view !== "advanced") throw familyError(family);
    } else {
      const trigger = menu.menu.locator('[role="menuitem"][aria-expanded][aria-hidden="false"]');
      if ((await powerView.count()) !== 0 || (await trigger.count()) !== 1)
        throw familyError(family);
      if ((await trigger.getAttribute("aria-expanded")) === "false")
        await trigger.click({ timeout: 5_000 });
    }
    await option.waitFor({ state: "visible", timeout: 5_000 });
    await option.click({ timeout: 5_000 });
    // Choosing a family returns the open picker to its slider. Keep that surface:
    // Escape followed by an immediate reopen races the outgoing menu's cleanup.
    // Activation reuses the open menu and verifies its owner before returning it.
    const selected = await activate();
    const deadline = Date.now() + 1_000;
    do {
      const current = familyOption(selected, family);
      if ((await current.count()) > 1) throw familyError(family);
      if ((await current.count()) === 1 && (await current.getAttribute("aria-checked")) === "true")
        return selected;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    throw familyError(family);
  } catch (cause) {
    if (cause instanceof ChatGptWebAdapterError) throw cause;
    throw familyError(family, cause);
  }
}

export function chatGptModelFamilyMatches(
  descriptions: readonly string[],
  family: ChatGptWebModelFamily,
  effort: ChatGptWebAdapterEffort
): boolean {
  // GPT-6 uses Sol below Pro and Astra at Pro. An old Latest picker can still use
  // 5.6 at lower efforts; that is not proof of an explicitly requested GPT-6 turn.
  const expectedName = family === "6" && effort === "max" ? "astra" : "sol";
  const states = descriptions.flatMap((text) => {
    const state = parseChatGptModelAnnouncement(text);
    return state ? [state] : [];
  });
  return (
    states.length > 0 &&
    states.every(
      (state) =>
        state.version === family &&
        (!state.name || state.name === expectedName) &&
        (effort === "max" ? /^Pro$/i.test(state.mode) : !/^Pro$/i.test(state.mode))
    )
  );
}

/** Localized effort-only text is valid only alongside the exact checked family radio.
 * The caller independently verifies the slider position in this same owned menu.
 * A generic Latest radio cannot establish a version, and contradictory version text wins.
 */
export function chatGptModelEvidenceMatches(
  descriptions: readonly string[],
  selectedRadioLabel: string,
  family: ChatGptWebModelFamily,
  effort: ChatGptWebAdapterEffort
): boolean {
  if (chatGptModelFamilyMatches(descriptions, family, effort)) return true;
  if (
    descriptions.some(
      (text) => parseChatGptModelAnnouncement(text) || /^(?:GPT[-\s]?)?\d/u.test(text.trim())
    )
  )
    return false;
  const label = selectedRadioLabel.normalize("NFKC").trim();
  const exact = family === "6" ? /^GPT[-\s]?6$/i : /^GPT[-\s]?5\.6\s+Sol$/i;
  if (!exact.test(label)) return false;
  const names: Record<ChatGptWebAdapterEffort, RegExp> = {
    low: /^(?:Instant|Instantâneo)$/i,
    medium: /^(?:Medium|Médio)$/i,
    high: /^(?:High|Alto)$/i,
    xhigh: /^(?:Extra High|Extra alto|Muito alto)$/i,
    max: /^Pro$/i,
  };
  return descriptions.some((text) =>
    names[effort].test(
      text
        .normalize("NFKC")
        .split(/[,、，،؛：—。;]/u)[0]!
        .trim()
    )
  );
}

export async function assertChatGptModelFamily(
  menu: EffortMenu,
  family: ChatGptWebModelFamily,
  effort: ChatGptWebAdapterEffort,
  effortIndex: number,
  settleMs = 0
): Promise<void> {
  const deadline = Date.now() + settleMs;
  do {
    const option = familyOption(menu, family);
    const checked =
      (await option.count()) === 1 && (await option.getAttribute("aria-checked")) === "true";
    const state = parseChatGptEffortSliderState(
      await menu.slider.getAttribute("aria-valuemin"),
      await menu.slider.getAttribute("aria-valuemax"),
      await menu.slider.getAttribute("aria-valuenow")
    );
    const descriptions = await readChatGptModelAnnouncements(menu.slider);
    if (
      checked &&
      state &&
      state.value === state.min + effortIndex &&
      chatGptModelEvidenceMatches(descriptions, await option.innerText(), family, effort)
    )
      return;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (true);
  throw familyError(family);
}

/** Only a disabled requested model and its newly displayed tooltip establish a limit. */
export function throwIfChatGptProUsageLimitedEvidence(
  disabled: boolean,
  tooltipText: string
): void {
  if (!disabled || !/^(?:Limite atingido\.|Limit reached\.)/i.test(tooltipText.trim())) return;
  throw new ChatGptWebAdapterError("ChatGPT reports a usage limit for the requested Pro model.", {
    status: 429,
    errorType: "rate_limit_error",
    code: "usage_limit_reached",
    retryable: false,
  });
}

export async function throwIfChatGptProUsageLimited(
  menu: EffortMenu,
  family: ChatGptWebModelFamily
): Promise<void> {
  const selectedFamily = familyOption(menu, family);
  if (
    (await selectedFamily.count()) !== 1 ||
    (await selectedFamily.getAttribute("aria-checked")) !== "true"
  )
    return;
  const pro = menu.menu.getByRole("menuitemradio", {
    name: "Pro",
    exact: true,
    includeHidden: true,
  });
  if ((await pro.count()) !== 1 || (await pro.getAttribute("aria-disabled")) !== "true") return;
  const view = menu.menu.locator("[data-model-picker-view]");
  if ((await view.count()) !== 1) return;
  if ((await view.getAttribute("data-model-picker-view")) === "simple") {
    const toggle = view
      .locator('[data-model-picker-view-toggle="true"]:not([aria-hidden="true"])')
      .filter({ visible: true });
    if ((await toggle.count()) !== 1) return;
    await toggle.click({ timeout: 5_000 });
  }
  const tooltip = menu.menu.page().getByRole("tooltip").filter({ visible: true });
  // Do not attribute an already-open, unrelated tooltip to this control.
  if ((await tooltip.count()) !== 0) return;
  await pro.hover({ timeout: 5_000 });
  try {
    await tooltip.waitFor({ state: "visible", timeout: 2_000 });
  } catch {
    return;
  }
  if ((await tooltip.count()) === 1) {
    throwIfChatGptProUsageLimitedEvidence(true, await tooltip.innerText());
  }
}
