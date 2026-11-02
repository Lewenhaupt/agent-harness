import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * Plain-JS coverage for the durable-member panel's pure helpers and its render
 * composition (bd-186).
 *
 * panel.js defines a custom element extending HTMLElement at module scope, so the
 * browser globals are stubbed before the dynamic import (same pattern as the
 * proof-of-work panel test). `render()` is driven against a minimal fake shadow
 * DOM: the panel is the only place the read AC says streamed partials and live
 * per-tool-call output are actually *shown*, so that composition is asserted
 * here rather than only at the data layer.
 */

/** Minimal stand-in for a DOM node: only the members panel.js touches. */
class FakeNode {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.textContent = "";
    this.value = "";
    this.hidden = false;
    this.disabled = false;
    this.className = "";
  }

  append(...nodes) {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes) {
    this.children = [...nodes];
    if (nodes.length === 0) this.textContent = "";
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  /** Test-only: fire a listener the panel registered on this node. */
  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  querySelector() {
    return null;
  }

  querySelectorAll() {
    return [];
  }
}

/** Shadow root whose named regions are created on demand, so a selector drift cannot hide. */
function fakeShadowRoot() {
  const regions = new Map();
  const root = new FakeNode("#shadow-root");
  root.querySelector = (selector) => {
    if (!regions.has(selector)) regions.set(selector, new FakeNode(selector));
    return regions.get(selector);
  };
  // `render()` disables the control buttons, so the fake root has to expose the
  // same `button[data-kind]` set the real shadow markup has.
  root.kindButtons = ["steer", "followup", "abort", "compact", "configure", "reset"].map(
    (kind) => {
      const button = new FakeNode("button");
      button.setAttribute("data-kind", kind);
      return button;
    },
  );
  root.querySelectorAll = (selector) =>
    selector === "button[data-kind]" ? root.kindButtons : [];
  return root;
}

vi.stubGlobal(
  "HTMLElement",
  class {
    attachShadow() {
      return fakeShadowRoot();
    }
  },
);
vi.stubGlobal("document", { createElement: (tagName) => new FakeNode(tagName) });

const {
  EMPTY_CONVERSATION_MESSAGE,
  EMPTY_MEMBERS_MESSAGE,
  buildCommand,
  configureDraftError,
  defineDurableMemberPanelElement,
  durablePanelTagName,
  formatLiveBanner,
  summarizeEntry,
} = await import("./panel.js");
const { controlAvailability, formatTaskLine } = await import("./contract.js");

/**
 * Instantiate the panel through its real registration seam: the module keeps the
 * element class private and exports only `defineDurableMemberPanelElement`.
 */
function createPanel() {
  const registered = new Map();
  vi.stubGlobal("customElements", {
    get: (name) => registered.get(name),
    define: (name, ctor) => registered.set(name, ctor),
  });
  defineDurableMemberPanelElement();
  const Panel = registered.get(durablePanelTagName);
  if (Panel === undefined) throw new Error("panel did not register its element");
  return new Panel();
}

/** The fake shadow root's control button for one command kind. */
function kindButton(panel, kind) {
  const button = panel.root.kindButtons.find((item) => item.getAttribute("data-kind") === kind);
  if (button === undefined) throw new Error(`panel did not render a ${kind} button`);
  return button;
}

afterAll(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("summarizeEntry", () => {
  it("renders a message", () => {
    expect(
      summarizeEntry({
        id: "e1",
        kind: "message",
        role: "assistant",
        text: "reading the bead",
      }),
    ).toEqual({ kind: "message", headline: "assistant", body: "reading the bead" });
  });

  it("renders a tool call with its input", () => {
    expect(
      summarizeEntry({
        id: "e2",
        kind: "tool-call",
        role: "assistant",
        text: "",
        toolCall: { name: "read", input: { path: "src/index.ts" } },
      }),
    ).toEqual({
      kind: "tool-call",
      headline: "tool call · read",
      body: '{"path":"src/index.ts"}',
    });
  });

  it("renders a tool output and its details-bearing body", () => {
    expect(
      summarizeEntry({
        id: "e3",
        kind: "tool-output",
        role: "tool",
        text: "",
        toolOutput: { name: "bash", output: "12 passed" },
      }),
    ).toEqual({ kind: "tool-output", headline: "tool output · bash", body: "12 passed" });
  });

  it("renders retry and compaction markers inline", () => {
    expect(
      summarizeEntry({
        id: "e4",
        kind: "retry",
        role: "system",
        text: "",
        retry: { attempt: 2, maxAttempts: 3, reason: "rate limited" },
      }),
    ).toMatchObject({ headline: "retry 2 — rate limited" });
    expect(
      summarizeEntry({
        id: "e5",
        kind: "compaction",
        role: "system",
        text: "",
        compaction: { tokensBefore: 1200, tokensAfter: 400 },
      }),
    ).toMatchObject({ headline: "compaction 1200 → 400 tokens" });
  });

  it("renders a run failure", () => {
    expect(
      summarizeEntry({
        id: "e6",
        kind: "failure",
        role: "system",
        text: "",
        failure: { message: "provider exploded" },
      }),
    ).toEqual({ kind: "failure", headline: "run failed", body: "provider exploded" });
  });
});

describe("formatLiveBanner", () => {
  it("is empty when nothing is live", () => {
    expect(formatLiveBanner(null)).toBe("");
  });

  it("includes status, attempt, retry, compaction and runFailure", () => {
    expect(
      formatLiveBanner({
        status: "failed",
        attempt: 2,
        retry: { attempt: 2, maxAttempts: 3 },
        compaction: { tokensBefore: 10, tokensAfter: 5 },
        runFailure: { message: "boom" },
      }),
    ).toBe("failed · attempt 2 · retry 2/3 · compacting · failed: boom");
  });

  it("words a stale generation as the owner being gone, never as streaming", () => {
    // A crash never rewrites the committed live row, so `status` still says
    // "streaming"; the banner must not repeat that claim.
    expect(
      formatLiveBanner({
        status: "streaming",
        attempt: 2,
        stale: true,
        staleReason: "owner-gone",
        runFailure: { message: "boom" },
      }),
    ).toBe("owner gone · last known generation · attempt 2 · failed: boom");
    expect(
      formatLiveBanner({
        status: "streaming",
        attempt: 1,
        stale: true,
        staleReason: "no-heartbeat",
        retry: { attempt: 1, maxAttempts: 2 },
      }),
    ).toBe("owner gone (no heartbeat) · last known generation · attempt 1 · retry 1/2");
  });
});

describe("buildCommand", () => {
  const base = {
    memberId: "member-a",
    requestId: "req-1",
    issuedAt: 1000,
  };

  it("builds a panel-authority steer", () => {
    expect(buildCommand({ ...base, kind: "steer", text: "look first" })).toMatchObject({
      kind: "steer",
      requestId: "req-1",
      memberId: "member-a",
      authority: "panel-human",
      issuedAt: 1000,
      text: "look first",
    });
  });

  it("builds a write as a harness note", () => {
    expect(buildCommand({ ...base, kind: "write", text: "operator note" })).toMatchObject({
      kind: "write",
      entry: { role: "system", text: "operator note", kind: "note" },
    });
  });

  it("does not implement the configure/reset gate itself", () => {
    // The owner is the gate. The panel only blocks the button; a command that
    // reaches validation without confirmation is still well formed, and the
    // member's owner refuses it with `confirmation-required`.
    const command = buildCommand({ ...base, kind: "reset" });
    expect(command.error).toBeUndefined();
    expect(controlAvailability({ kind: "reset", memberId: "member-a" })).toEqual({
      available: false,
      requiresConfirmation: "missing",
    });
  });

  it("returns an error value instead of an invalid command", () => {
    expect(buildCommand({ ...base, kind: "steer", text: "" })).toMatchObject({
      code: "missing-text",
    });
    expect(buildCommand({ ...base, kind: "terminate" })).toMatchObject({ code: "unknown-kind" });
  });
});

describe("render", () => {
  it("shows committed entries, live partials and per-tool-call output", () => {
    const panel = createPanel();
    panel.members = [{ memberId: "member-a", live: true }];
    panel.selectedMemberId = "member-a";
    panel.status = "live";
    panel.view = {
      entries: [
        {
          id: "e1",
          kind: "tool-output",
          role: "tool",
          timestamp: 20,
          text: "",
          toolOutput: { name: "bash", output: "12 passed" },
        },
        {
          id: "e2",
          kind: "failure",
          role: "system",
          timestamp: 21,
          text: "",
          failure: { message: "provider exploded" },
        },
      ],
      live: {
        status: "streaming",
        attempt: 2,
        partialText: "working on the bead",
        retry: { attempt: 2, maxAttempts: 3 },
        runFailure: { message: "boom" },
        toolCalls: [
          { status: "running", name: "read", output: "src/index.ts" },
          { status: "pending", name: "bash" },
        ],
      },
      hasEarlier: true,
    };
    const task = {
      id: "task-1",
      title: "implement",
      status: "running",
      owner: { memberId: "member-a", edge: "child" },
      waitingOn: ["task-0"],
      background: false,
    };
    panel.tasks = [task];

    panel.render();

    expect(panel.memberSelect.children.map((option) => option.textContent)).toEqual([
      "(none)",
      "member-a (live)",
    ]);
    expect(panel.entriesEl.children.map((item) => item.getAttribute("data-entry-id"))).toEqual([
      "e1",
      "e2",
    ]);
    // Per-tool-call output is the entry body; a run failure is a headline plus
    // the failure message, not a bare role line.
    expect(panel.entriesEl.children[0].children.map((child) => child.textContent)).toEqual([
      expect.stringContaining("tool output · bash"),
      "12 passed",
    ]);
    expect(panel.entriesEl.children[1].children.map((child) => child.textContent)).toEqual([
      expect.stringContaining("run failed"),
      "provider exploded",
    ]);
    // Streamed partials, live tool calls and runFailure live in the live region.
    expect(panel.liveEl.hidden).toBe(false);
    expect(panel.liveEl.textContent).toBe(
      "streaming · attempt 2 · retry 2/3 · failed: boom\n" +
        "working on the bead\n[running] read: src/index.ts\n[pending] bash",
    );
    expect(panel.tasksEl.children.map((item) => item.textContent)).toEqual([formatTaskLine(task)]);
    expect(panel.emptyEl.hidden).toBe(true);
    expect(panel.loadEarlierButton.hidden).toBe(false);
  });

  // Read AC: "a crashed member's last committed state still renders after
  // restart". The multi-process crash is proved in
  // `test/durable-readonly-viewer.integration.test.ts`; here the panel side of
  // the same state is the committed window with no live banner.
  it("shows a crashed member's committed window with no live banner", () => {
    const panel = createPanel();
    panel.members = [{ memberId: "member-a", live: false }];
    panel.selectedMemberId = "member-a";
    panel.status = "idle";
    panel.view = {
      entries: [
        { id: "c-1", kind: "message", role: "assistant", timestamp: 1, text: "committed entry 1" },
      ],
      live: null,
      hasEarlier: false,
    };

    panel.render();

    expect(panel.liveEl.hidden).toBe(true);
    expect(panel.liveEl.textContent).toBe("");
    expect(panel.entriesEl.children.map((item) => item.getAttribute("data-entry-id"))).toEqual([
      "c-1",
    ]);
    expect(panel.memberSelect.children.map((option) => option.textContent)).toEqual([
      "(none)",
      "member-a (idle)",
    ]);
    expect(panel.emptyEl.hidden).toBe(true);
    expect(panel.loadEarlierButton.hidden).toBe(true);
  });

  // Read AC covers a crash *before* a live row was committed (above). This is
  // the case that used to slip through: the owner committed a live row and then
  // died, so the row still says `streaming` and the reduction marks it stale.
  it("shows a stale live generation as owner gone, not as streaming", () => {
    const panel = createPanel();
    panel.members = [{ memberId: "member-a", live: false }];
    panel.selectedMemberId = "member-a";
    panel.status = "idle";
    panel.view = {
      entries: [
        { id: "c-1", kind: "message", role: "assistant", timestamp: 1, text: "committed entry 1" },
      ],
      live: {
        status: "streaming",
        attempt: 1,
        partialText: "half a sentence",
        stale: true,
        staleReason: "owner-gone",
        toolCalls: [{ status: "running", name: "bash", output: "sleeping" }],
      },
      hasEarlier: false,
    };

    panel.render();

    expect(panel.liveEl.hidden).toBe(false);
    expect(panel.liveEl.textContent).toBe(
      "owner gone · last known generation · attempt 1\nhalf a sentence\n[running] bash: sleeping",
    );
    expect(panel.liveEl.textContent).not.toContain("streaming");
    expect(panel.memberSelect.children.map((option) => option.textContent)).toEqual([
      "(none)",
      "member-a (idle)",
    ]);
  });

  it("names the empty conversation state when a member has committed nothing", () => {
    const panel = createPanel();
    panel.members = [{ memberId: "member-a", live: false }];
    panel.selectedMemberId = "member-a";
    panel.view = { entries: [], live: null, hasEarlier: false };

    panel.render();

    expect(panel.emptyEl.textContent).toBe(EMPTY_CONVERSATION_MESSAGE);
    expect(panel.emptyEl.hidden).toBe(false);
    expect(panel.loadEarlierButton.hidden).toBe(true);
  });
});

describe("gated controls", () => {
  function panelWithMember() {
    const panel = createPanel();
    panel.members = [{ memberId: "member-a", live: true }];
    panel.selectedMemberId = "member-a";
    panel.status = "live";
    panel.render();
    return panel;
  }

  it("re-enables Configure as soon as the draft becomes valid, with no Refresh", () => {
    const panel = panelWithMember();
    const configure = kindButton(panel, "configure");
    expect(configure.disabled).toBe(true);

    // The confirmation alone is not enough: the configure draft still has no
    // model, so the guard keeps the button disabled.
    panel.confirmationInput.value = "member-a";
    panel.confirmationInput.dispatch("input");
    expect(configure.disabled).toBe(true);

    panel.modelInput.value = "anthropic/claude-sonnet";
    panel.modelInput.dispatch("input");
    expect(configure.disabled).toBe(false);

    // Editing the confirmation away re-disables it on the same tick.
    panel.confirmationInput.value = "member-b";
    panel.confirmationInput.dispatch("input");
    expect(configure.disabled).toBe(true);
  });

  it("re-evaluates the gated kinds on change as well as input", () => {
    const panel = panelWithMember();
    expect(kindButton(panel, "steer").disabled).toBe(false);
    expect(kindButton(panel, "abort").disabled).toBe(false);
    expect(kindButton(panel, "reset").disabled).toBe(true);

    panel.confirmationInput.value = "member-a";
    panel.confirmationInput.dispatch("change");

    expect(kindButton(panel, "reset").disabled).toBe(false);
    expect(kindButton(panel, "steer").disabled).toBe(false);
  });
});

describe("member switch", () => {
  it("clears the previous member's entry details and control result", () => {
    const panel = createPanel();
    panel.members = [{ memberId: "member-a" }, { memberId: "member-b" }];
    panel.selectedMemberId = "member-a";
    panel.status = "live";
    panel.detailEntryId = "fixture-4";
    panel.detailsEl.textContent = '{"entryId":"fixture-4"}';
    panel.detailsEl.hidden = false;
    panel.controlMessage = "steer delivered";
    panel.controlResultEl.textContent = "steer delivered";

    panel.selectMember("member-b");

    expect(panel.selectedMemberId).toBe("member-b");
    expect(panel.detailsEl.textContent).toBe("");
    expect(panel.detailsEl.hidden).toBe(true);
    expect(panel.detailEntryId).toBeUndefined();
    expect(panel.controlMessage).toBeUndefined();
    expect(panel.controlResultEl.textContent).toBe("");
  });
});

describe("empty state", () => {
  it("names the storage location so the panel is understandable with no member", () => {
    expect(EMPTY_MEMBERS_MESSAGE).toContain("No durable members");
    expect(EMPTY_MEMBERS_MESSAGE).toContain("members/<memberId>/store.sqlite");
  });
});

describe("configureDraftError", () => {
  it("names the missing field instead of letting an empty config through", () => {
    expect(configureDraftError({})).toContain("Configure needs a model");
    expect(configureDraftError({ model: "   " })).toContain("Configure needs a model");
  });

  it("accepts a model, tools or a system prompt", () => {
    expect(configureDraftError({ model: "anthropic/claude-sonnet" })).toBeUndefined();
    expect(configureDraftError({ tools: ["read"] })).toBeUndefined();
    expect(configureDraftError({ systemPrompt: "be brief" })).toBeUndefined();
  });

  it("still lets the validator refuse an empty config if the pre-check is bypassed", () => {
    expect(buildCommand({ memberId: "member-a", requestId: "req-1", issuedAt: 1, kind: "configure" })).toMatchObject(
      { code: "invalid-config" },
    );
  });
});
