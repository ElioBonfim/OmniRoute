export type ChatGptWebCodexEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ChatGptWebCodexModelRoute {
  id: string;
  backendModel: "gpt-5.6-sol" | "gpt-5.6-luna";
  effort: ChatGptWebCodexEffort;
  pro: boolean;
  sol: boolean;
  modelFamily?: "5.6" | "6";
  supportedEfforts?: readonly ChatGptWebCodexEffort[];
}

const ROUTES = new Map<string, ChatGptWebCodexModelRoute>([
  ["luna", { id: "luna", backendModel: "gpt-5.6-luna", effort: "low", pro: false, sol: false }],
  [
    "think",
    { id: "think", backendModel: "gpt-5.6-luna", effort: "medium", pro: false, sol: false },
  ],
  ["instant", { id: "instant", backendModel: "gpt-5.6-sol", effort: "low", pro: false, sol: true }],
  [
    "medium",
    { id: "medium", backendModel: "gpt-5.6-sol", effort: "medium", pro: false, sol: true },
  ],
  ["high", { id: "high", backendModel: "gpt-5.6-sol", effort: "high", pro: false, sol: true }],
  [
    "extra-high",
    { id: "extra-high", backendModel: "gpt-5.6-sol", effort: "xhigh", pro: true, sol: true },
  ],
  ["pro", { id: "pro", backendModel: "gpt-5.6-sol", effort: "max", pro: true, sol: true }],
]);

for (const modelFamily of ["5.6", "6"] as const) {
  for (const variant of ["sol", "sol-instant", "pro"] as const) {
    const id = `gpt-${modelFamily}-${variant}`;
    const effort = variant === "pro" ? "max" : variant === "sol-instant" ? "low" : "high";
    ROUTES.set(id, {
      id,
      // This is the shared browser transport/context profile. Exact model
      // identity is selected and verified separately in the browser.
      backendModel: "gpt-5.6-sol",
      modelFamily,
      effort,
      supportedEfforts: variant === "sol" ? ["medium", "high", "xhigh"] : [effort],
      pro: variant === "pro",
      sol: true,
    });
  }
}

export function requireChatGptWebCodexRoute(
  model: string,
  requestedEffort?: string
): ChatGptWebCodexModelRoute {
  const normalized = model.replace(/^chatgpt-web-codex\//, "");
  const route = ROUTES.get(normalized);
  if (!route) throw new Error(`Unsupported ChatGPT Web (Codex) model: ${model}`);
  const effort = !route.modelFamily && requestedEffort === "ultra" ? "max" : requestedEffort;
  const supported = route.supportedEfforts ?? [route.effort];
  if (effort && !supported.includes(effort as ChatGptWebCodexEffort)) {
    throw new Error(
      `Requested reasoning effort ${requestedEffort} is incompatible with model ${route.id}`
    );
  }
  return {
    ...route,
    effort: (effort ?? route.effort) as ChatGptWebCodexEffort,
    pro: route.pro || effort === "xhigh",
  };
}

export function reasoningEffortOf(body: Record<string, unknown>): string | undefined {
  const reasoning = body.reasoning;
  if (reasoning && typeof reasoning === "object" && !Array.isArray(reasoning)) {
    const effort = (reasoning as Record<string, unknown>).effort;
    return typeof effort === "string" ? effort : undefined;
  }
  const effort = body.reasoning_effort;
  return typeof effort === "string" ? effort : undefined;
}
