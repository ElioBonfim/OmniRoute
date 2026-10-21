import type { Page } from "playwright-core";

export const OMNIROUTE_CHAT_TITLE_PREFIX = "[OMNIROUTE]";

function label(value: string | undefined, fallback: string): string {
  return (
    value
      ?.normalize("NFKC")
      .replaceAll("|", "-")
      .replace(/[\p{Cc}\p{Cf}]/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 64) || fallback
  );
}

export function buildChatGptConversationTitle(input: {
  cwd?: string;
  sessionId?: string;
  createdAt?: Date;
}): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(input.createdAt ?? new Date());
  const part = (type: string) => parts.find((item) => item.type === type)!.value;
  const date = [part("year"), part("month"), part("day")].join("-");
  const project = input.cwd?.replace(/\\/g, "/").split("/").filter(Boolean).at(-1);
  return (
    OMNIROUTE_CHAT_TITLE_PREFIX +
    " " +
    date +
    " | " +
    label(project, "sem-projeto") +
    " | sessão " +
    label(input.sessionId, "sem-sessao")
  );
}

export function savedChatGptConversationId(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.origin !== "https://chatgpt.com" || url.searchParams.get("temporary-chat") === "true")
      return undefined;
    return /^\/c\/([a-zA-Z0-9-]{1,100})\/?$/.exec(url.pathname)?.[1];
  } catch {
    return undefined;
  }
}

/** The caller owns this page for a newly created OmniRoute turn, never a personal tab. */
export async function renameOwnedChatGptConversation(
  page: Page,
  title: string,
  expectedConversationId: string
): Promise<boolean> {
  const conversationId = savedChatGptConversationId(page.url());
  if (!conversationId || conversationId !== expectedConversationId) return false;
  if ((await page.title()) === title) return true;
  const assertSameConversation = async () => {
    if (savedChatGptConversationId(await page.evaluate(() => location.href)) !== conversationId) {
      throw new Error("ChatGPT conversation changed before its title could be saved");
    }
  };
  const dialog = page.getByRole("dialog", { name: /^(Rename chat|Renomear chat)$/ });
  try {
    const more = page.getByRole("button", { name: /^(More|Mais)$/ }).filter({ visible: true });
    if ((await more.count()) !== 1)
      throw new Error("ChatGPT did not expose one conversation title menu");
    await more.click({ timeout: 5_000 });
    await page.getByRole("menuitem", { name: /^(Rename|Renomear)$/ }).click({ timeout: 5_000 });
    await assertSameConversation();
    await dialog
      .getByRole("textbox", { name: /^(Chat title|Título do chat)$/ })
      .fill(title, { timeout: 5_000 });
    await assertSameConversation();
    await dialog.getByRole("button", { name: /^(Save|Salvar)$/ }).click({ timeout: 5_000 });
    await dialog.waitFor({ state: "hidden", timeout: 5_000 });
    await page.waitForFunction(
      (expected) => document.title === expected || document.title === expected + " - ChatGPT",
      title,
      { timeout: 5_000 }
    );
    await assertSameConversation();
    return true;
  } finally {
    if (await dialog.isVisible()) {
      await dialog.getByRole("button", { name: /^(Cancel|Cancelar)$/ }).click({ timeout: 2_000 });
    }
  }
}

/** A new page may use a local draft URL until ChatGPT persists the submitted conversation. */
export async function settleOwnedChatGptConversationId(
  page: Page,
  submittedUrl: string
): Promise<string | undefined> {
  const firstId = savedChatGptConversationId(submittedUrl);
  if (!firstId) {
    let url: URL;
    try {
      url = new URL(submittedUrl);
    } catch {
      return undefined;
    }
    if (url.origin !== "https://chatgpt.com" || url.searchParams.get("temporary-chat") === "true")
      return undefined;
    const pendingPath = decodeURIComponent(url.pathname);
    if (pendingPath !== "/" && !/^\/c\/local-chatgpt:[a-f0-9-]{36}\/?$/i.test(pendingPath))
      return undefined;
  }
  await page.waitForURL((url) => savedChatGptConversationId(url.href) !== undefined, {
    timeout: 10_000,
  });
  const currentId = savedChatGptConversationId(await page.evaluate(() => location.href));
  if (firstId && currentId !== firstId)
    throw new Error("ChatGPT conversation changed after its submission");
  return currentId;
}
