import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

/**
 * Cross-module seam test: the real `server-plugin.js` publish path feeding the
 * real `panel.js` consume path (bd-186).
 *
 * The panel was shipped broken because each half was only ever tested against a
 * fixture it invented: the server published a *reduced view* (`frame.entries`)
 * while `panel.js` reduced the payload again and read `frame.entriesWindow`,
 * so the first watch frame threw `TypeError: frame.entriesWindow is not
 * iterable` and rendered nothing. Unit tests on both sides stayed green.
 *
 * So this file does not hand-write a frame. It opens the peer's `watch` channel,
 * captures the exact envelope the host would deliver, and pushes it into the
 * panel's `handleChannelData`. `load-earlier` and `entry-details` are driven
 * through the panel's own `call()` path against the same peer, so a shape drift
 * in any operation the panel consumes fails here.
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

  querySelector() {
    return null;
  }

  querySelectorAll() {
    return [];
  }
}

function fakeShadowRoot() {
  const regions = new Map();
  const root = new FakeNode("#shadow-root");
  root.querySelector = (selector) => {
    if (!regions.has(selector)) regions.set(selector, new FakeNode(selector));
    return regions.get(selector);
  };
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

const { createDurableMemberPeer } = await import("./server-plugin.js");
const { defineDurableMemberPanelElement, durablePanelTagName } = await import("./panel.js");

const testDir = dirname(fileURLToPath(import.meta.url));
const seedScript = join(testDir, "fixtures", "seed-member.mjs");
const MEMBER_ID = "member-a";
const dirs = [];

/** Seed the documented fixture store (7 entries, a live row, 3 tasks). */
function seededDataDirectory() {
  const dataDirectory = mkdtempSync(join(tmpdir(), "belayd-durable-wire-seam-"));
  dirs.push(dataDirectory);
  const membersRoot = join(dataDirectory, "members");
  execFileSync(process.execPath, [seedScript, membersRoot, MEMBER_ID]);
  return dataDirectory;
}

function peer(dataDirectory) {
  return createDurableMemberPeer({
    dataDirectory,
    settings: {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
}

/** Instantiate the panel through its real registration seam. */
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

/**
 * A panel wired to the real peer exactly as the host does it: the panel's
 * `call()` reaches `peer.request`, so no response shape is fabricated here.
 */
function panelFor(dataDirectory) {
  const durablePeer = peer(dataDirectory);
  const panel = createPanel();
  panel.contextValue = {
    backend: {
      forScope: () => ({
        request: (operation, input) => durablePeer.request({ operation, input }),
      }),
    },
  };
  panel.members = [{ memberId: MEMBER_ID, live: true }];
  panel.selectedMemberId = MEMBER_ID;
  return { panel, durablePeer };
}

/** Capture the first watch frame the server module actually publishes. */
async function firstWatchFrame(durablePeer) {
  const controller = new AbortController();
  const envelopes = [];
  const channel = await durablePeer.openChannel({
    operation: "watch",
    input: { memberId: MEMBER_ID, intervalMs: 25 },
    signal: controller.signal,
    send: (envelope) => envelopes.push(envelope),
  });
  channel.close();
  controller.abort();
  expect(envelopes).toHaveLength(1);
  return envelopes[0];
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("durable-member wire seam: server publish → panel render", () => {
  it("renders the server's raw watch frame end to end, with no adapter", async () => {
    const dataDirectory = seededDataDirectory();
    const { panel, durablePeer } = panelFor(dataDirectory);
    const envelope = await firstWatchFrame(durablePeer);

    // The wire contract is the `ConversationWatchFrame` the panel reduces. A
    // pre-reduced `entries` payload here is the defect this pins.
    expect(envelope).toMatchObject({ type: "frame" });
    expect(envelope.frame).not.toHaveProperty("entries");
    expect(Array.isArray(envelope.frame.entriesWindow)).toBe(true);
    expect(envelope.frame.entriesWindow).toHaveLength(7);
    expect(envelope.frame).toMatchObject({
      conversationId: `${MEMBER_ID}:main`,
      cursor: "1",
      hasEarlier: false,
      emittedAt: expect.any(Number),
    });

    // The real panel path that used to throw `frame.entriesWindow is not
    // iterable`; if it regresses, this call rejects the test with that error.
    expect(() => panel.handleChannelData(envelope)).not.toThrow();

    expect(panel.entriesEl.children.map((item) => item.getAttribute("data-entry-id"))).toEqual([
      "fixture-1",
      "fixture-2",
      "fixture-3",
      "fixture-4",
      "fixture-5",
      "fixture-6",
      "fixture-7",
    ]);
    // Per-tool-call output, retry and compaction markers all survive the single
    // reduction (the panel renders them from the entry bodies).
    const bodies = panel.entriesEl.children.map((item) => item.children[1].textContent);
    expect(bodies).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Read 812 lines"),
        expect.stringContaining("provider rate limited"),
        expect.stringContaining("compacted the transcript"),
      ]),
    );

    // Live generation and task graph travel on the same envelope.
    expect(panel.liveEl.hidden).toBe(false);
    expect(panel.liveEl.textContent).toContain("Writing the contract parity test…");
    expect(panel.liveEl.textContent).toContain("[running] write");
    expect(panel.tasksEl.children).toHaveLength(3);
    expect(panel.tasksEl.children.map((item) => item.textContent)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "bd-186-implement [running] child:member-a · waiting on bd-186-scout",
        ),
      ]),
    );
    expect(panel.emptyEl.hidden).toBe(true);
  });

  it("keeps the load-earlier response shape the panel merges", async () => {
    const dataDirectory = seededDataDirectory();
    const { panel, durablePeer } = panelFor(dataDirectory);
    panel.handleChannelData(await firstWatchFrame(durablePeer));

    // The window the panel holds is the store's tail page: the view is trimmed
    // to what a capped window would contain, then the panel itself asks the
    // real server module for the older page and merges it.
    const all = panel.view?.entries ?? [];
    const tail = all.slice(-3);
    expect(tail.map((entry) => entry.id)).toEqual(["fixture-5", "fixture-6", "fixture-7"]);
    panel.view = {
      conversationId: `${MEMBER_ID}:main`,
      entries: tail,
      cursor: "5",
      hasEarlier: true,
      live: panel.view?.live ?? null,
    };

    const page = await durablePeer.request({
      operation: "load-earlier",
      input: { memberId: MEMBER_ID, cursor: "5" },
    });
    // Exactly the keys `panel.loadEarlier()` reads.
    expect(Array.isArray(page.entries)).toBe(true);
    expect(page.cursor).toBe("1");
    expect(page.hasEarlier).toBe(false);

    await panel.loadEarlier();

    expect(panel.view?.entries.map((entry) => entry.id)).toEqual([
      "fixture-1",
      "fixture-2",
      "fixture-3",
      "fixture-4",
      "fixture-5",
      "fixture-6",
      "fixture-7",
    ]);
    expect(panel.view?.cursor).toBe("1");
    expect(panel.entriesEl.children).toHaveLength(7);
    expect(panel.errorMessage).toBeUndefined();
  });

  it("keeps the entry-details response shape the panel shows", async () => {
    const dataDirectory = seededDataDirectory();
    const { panel, durablePeer } = panelFor(dataDirectory);
    panel.handleChannelData(await firstWatchFrame(durablePeer));

    await panel.showEntryDetails("fixture-4");

    expect(panel.detailsEl.hidden).toBe(false);
    const details = JSON.parse(panel.detailsEl.textContent);
    expect(details).toMatchObject({
      entryId: "fixture-4",
      entry: {
        id: "fixture-4",
        kind: "tool-output",
        toolOutput: { name: "read", details: { bytes: 41233, lines: 812 } },
      },
    });
    expect(panel.detailEntryId).toBe("fixture-4");
  });
});
