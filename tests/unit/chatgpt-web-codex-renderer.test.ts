import assert from "node:assert/strict";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import { JSDOM } from "jsdom";
import type { Locator, Page } from "playwright-core";
import {
  ChatGptBrowserWorker,
  resolveChatGptToolConfirmation,
} from "../../open-sse/vendor/codex-chatgpt-web/adapters/chatgpt-web/browser-worker.ts";
import { chatGptAssistantTurnSelector } from "../../open-sse/vendor/codex-chatgpt-web/chatgpt-session.ts";
interface WorkerProbe {
  reconcileAssistantTurnBinding(
    page: unknown,
    baseline: unknown,
    binding: unknown
  ): Promise<{ identity: string }>;
  responseDomSnapshot(locator: unknown): Promise<{
    responsePresent: boolean;
    visibleText: string;
    completionActionVisible: boolean;
    markdownSegments: Array<{ text: string }>;
  }>;
  submissionDomState(
    page: unknown
  ): Promise<{ userIdentities: string[]; responseIdentities: string[] }>;
  captureSubmissionBaseline(
    page: unknown
  ): Promise<{ initialUserTurnIdentities: string[]; initialResponseTurnIdentities: string[] }>;
  currentSubmissionEvidence(page: unknown, baseline: unknown): Promise<string | undefined>;
}
function dom(html: string) {
  const window = new JSDOM(html).window;
  Object.defineProperty(window.HTMLElement.prototype, "innerText", {
    configurable: true,
    get() {
      return this.textContent;
    },
  });
  window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 10, height: 10 }) as DOMRect;
  const context = createContext({
    document: window.document,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    NodeFilter: window.NodeFilter,
    performance: { timeOrigin: 1 },
    getComputedStyle: window.getComputedStyle.bind(window),
    MutationObserver: window.MutationObserver,
    __name: (value: unknown) => value,
  });
  const worker = Object.create(ChatGptBrowserWorker.prototype) as WorkerProbe;
  const evaluate = (fn: Function, ...args: unknown[]) =>
    runInContext(`(${fn.toString()})`, context)(...args);
  return { window, worker, evaluate };
}
for (const modern of [false, true])
  test(`extracts final answer and footer from ${modern ? "grouped" : "classic"} ChatGPT renderer`, async () => {
    const html = modern
      ? '<section id="turn" data-turn-key="one"><div data-user-message-bubble>Question</div><div data-content-search-unit-key="answer"><h4 data-conversation-role="assistant">ChatGPT</h4><div data-markdown-text-style="assistant-message"><p>RESULT_42</p></div></div><div class="turn-action-controls"><button>Copy</button></div></section>'
      : '<section id="turn" data-testid="conversation-turn-2" data-turn="assistant"><div data-message-author-role="assistant"><div class="markdown"><p>RESULT_42</p></div></div><button data-testid="copy-turn-action-button">Copy</button></section>';
    const { window, worker, evaluate } = dom(html);
    try {
      const locator = {
        evaluate: async (fn: Function, options: unknown) =>
          evaluate(fn, window.document.getElementById("turn"), options),
        page: () => ({ isClosed: () => false }),
      };
      const snapshot = await worker.responseDomSnapshot(locator);
      assert.equal(snapshot.responsePresent, true);
      assert.equal(snapshot.visibleText, "RESULT_42");
      assert.equal(snapshot.completionActionVisible, true);
      assert(snapshot.markdownSegments.some((s) => s.text === "RESULT_42"));
    } finally {
      window.close();
    }
  });
test("grouped turns use separate role identities and rebind to the same stable container", async () => {
  const { window, worker, evaluate } = dom(
    '<section data-turn-key="one"><div data-user-message-bubble>Question</div><div data-conversation-role="assistant">Answer</div></section>'
  );
  try {
    const state = await worker.submissionDomState({
      evaluate: async (fn: Function, options: unknown) => evaluate(fn, options),
    });
    assert.deepEqual(Array.from(state.userIdentities), ["group:user:one"]);
    assert.deepEqual(Array.from(state.responseIdentities), ["group:assistant:one"]);
    assert.equal(
      window.document.querySelectorAll(chatGptAssistantTurnSelector(state.responseIdentities[0]))
        .length,
      1
    );
  } finally {
    window.close();
  }
});
test("remounting an old grouped turn cannot acknowledge a new submission", async () => {
  const { window, worker, evaluate } = dom('<section data-turn-key="old"></section>');
  try {
    const page = {
      locator: () => ({}),
      evaluate: async (fn: Function, options: unknown) => evaluate(fn, options),
    };
    const baseline = await worker.captureSubmissionBaseline(page);
    assert(baseline.initialUserTurnIdentities.includes("group:user:old"));
    assert(baseline.initialResponseTurnIdentities.includes("group:assistant:old"));
    window.document.querySelector("section")!.innerHTML =
      '<div data-user-message-bubble>old question</div><div data-conversation-role="assistant">old answer</div>';
    await Promise.resolve();
    assert.equal(await worker.currentSubmissionEvidence(page, baseline), undefined);
  } finally {
    window.close();
  }
});
test("a user footer cannot complete an assistant turn that is still starting", async () => {
  const { window, worker, evaluate } = dom(
    '<section id="turn" data-turn-key="one"><div data-user-message-bubble><div class="markdown">Human text</div></div><div class="turn-action-controls"><button>Copy user text</button></div><div data-chatgpt-agent-turn-start></div></section>'
  );
  try {
    const result = await worker.responseDomSnapshot({
      evaluate: async (fn: Function, options: unknown) =>
        evaluate(fn, window.document.getElementById("turn"), options),
      page: () => ({ isClosed: () => false }),
    });
    assert.equal(result.visibleText, "");
    assert.equal(result.completionActionVisible, false);
  } finally {
    window.close();
  }
});

test("rebinding requires the current broker token and rejects a foreign user group", async () => {
  const expected = "turn_" + "a".repeat(32);
  for (const matches of [true, false]) {
    const token = matches ? expected : "turn_" + "b".repeat(32);
    const { window, worker, evaluate } = dom(
      `<section data-turn-key="real"><div data-user-message-bubble><div data-search-result-target>${token}</div></div><div data-conversation-role="assistant">Answer</div></section>`
    );
    const locator = (nodes: Element[]) => ({
      count: async () => nodes.length,
      locator: (selector: string) =>
        locator(nodes.flatMap((n) => Array.from(n.querySelectorAll(selector)))),
      evaluate: async (fn: Function, options: unknown) => evaluate(fn, nodes[0], options),
    });
    const page = {
      locator: (selector: string) =>
        locator(Array.from(window.document.querySelectorAll(selector))),
      evaluate: async (fn: Function, options: unknown) => evaluate(fn, options),
    };
    const baseline = {
      initialUserTurnIdentities: [],
      initialResponseTurnIdentities: [],
      turnToken: expected,
      submittedText: expected,
    };
    const binding = {
      identity: "group:assistant:temporary",
      locator: { count: async () => 0 },
      acceptedUserTurnIdentities: [],
    };
    try {
      if (matches)
        assert.equal(
          (await worker.reconcileAssistantTurnBinding(page, baseline, binding)).identity,
          "group:assistant:real"
        );
      else
        await assert.rejects(
          worker.reconcileAssistantTurnBinding(page, baseline, binding),
          /another user turn/
        );
    } finally {
      window.close();
    }
  }
});

function approvalPage(html: string) {
  const window = new JSDOM(html).window;
  const pressed: string[] = [];
  function locator(elements: Element[]): Locator {
    return {
      filter: ({ hasText }: { hasText: string | RegExp }) =>
        locator(
          elements.filter((e) =>
            typeof hasText === "string"
              ? e.textContent?.includes(hasText)
              : hasText.test(e.textContent || "")
          )
        ),
      last: () => locator(elements.slice(-1)),
      isVisible: async () => elements.length > 0,
      getByText: (pattern: RegExp) =>
        locator(
          elements
            .flatMap((e) => Array.from(e.querySelectorAll("h3,aside")))
            .filter((e) => pattern.test(e.textContent || ""))
        ),
      getByRole: (_role: string, { name }: { name: RegExp | string }) =>
        locator(
          elements
            .flatMap((e) => Array.from(e.querySelectorAll("button")))
            .filter((e) =>
              typeof name === "string" ? e.textContent === name : name.test(e.textContent || "")
            )
        ),
      waitFor: async () => {
        assert(elements.length > 0, "expected a matching control");
      },
      press: async () => {
        pressed.push(elements[0]?.textContent || "");
      },
    } as unknown as Locator;
  }
  return {
    window,
    pressed,
    page: {
      locator: (selector: string) =>
        locator(Array.from(window.document.querySelectorAll(selector))),
    } as unknown as Page,
  };
}
test("Portuguese grouped approval allows only the current action", async () => {
  const probe = approvalPage(
    '<div class="@container/approval-card"><div role="alert">Permitir que o ChatGPT use OmniRoute Codex v2?</div><button>Permitir sempre</button><button>Permitir uma vez⏎</button></div>'
  );
  try {
    assert.equal(
      await resolveChatGptToolConfirmation(probe.page, "OmniRoute Codex v2", true),
      true
    );
    assert.deepEqual(probe.pressed, ["Permitir uma vez⏎"]);
  } finally {
    probe.window.close();
  }
});
test("English approval remains limited to the current action", async () => {
  const probe = approvalPage(
    '<div role="dialog">Allow ChatGPT to use OmniRoute Codex v2?<button>Always allow</button><button>Allow once</button></div>'
  );
  try {
    assert.equal(
      await resolveChatGptToolConfirmation(probe.page, "OmniRoute Codex v2", true),
      true
    );
    assert.deepEqual(probe.pressed, ["Allow once"]);
  } finally {
    probe.window.close();
  }
});
test("a suspicious-instruction warning requires human review without approving", async () => {
  const probe = approvalPage(
    '<div class="@container/approval-card"><div role="alert">Permitir que o ChatGPT use OmniRoute Codex v2?</div><aside><h3>Instrução suspeita</h3></aside><button>Permitir uma vez⏎</button></div>'
  );
  try {
    await assert.rejects(
      resolveChatGptToolConfirmation(probe.page, "OmniRoute Codex v2", true),
      /human review/i
    );
    assert.deepEqual(probe.pressed, []);
  } finally {
    probe.window.close();
  }
});
