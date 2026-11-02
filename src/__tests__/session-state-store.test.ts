import { describe, expect, it } from "vitest";
import {
  createInitialSessionState,
  createSessionStateStore,
  type SessionContext,
} from "../../extensions/capabilities/session-state.js";

function ctxFor(sessionId: string): SessionContext {
  return { sessionManager: { getSessionId: () => sessionId } };
}

describe("createSessionStateStore", () => {
  it("returns one object per session id and reuses it", () => {
    const store = createSessionStateStore(createInitialSessionState);

    const first = store(ctxFor("session-a"));
    const again = store(ctxFor("session-a"));
    const other = store(ctxFor("session-b"));

    expect(again).toBe(first);
    expect(other).not.toBe(first);
    expect(store.peek("session-a")).toBe(first);
  });

  it("clears every session on clear so a reused id starts fresh (bd-173)", () => {
    const store = createSessionStateStore(createInitialSessionState);
    const leaked = store(ctxFor("session-a"));
    leaked.currentTaskId = "bd-12";
    leaked.awaitingReviewResponse = true;

    store.clear();

    // A suite that reuses ids must not inherit the previous case's state.
    expect(store.peek("session-a")).toBeUndefined();
    expect(store(ctxFor("session-a"))).not.toBe(leaked);
    expect(store(ctxFor("session-a")).currentTaskId).toBe("");
  });

  it("disposes every dropped state, so a leaked timer stops with the entry (bd-173)", () => {
    const disposed: string[] = [];
    const store = createSessionStateStore(createInitialSessionState, (state) => {
      disposed.push(state.currentTaskId);
    });
    store(ctxFor("session-a")).currentTaskId = "bd-12";
    store(ctxFor("session-b")).currentTaskId = "bd-15";

    store.clear();

    expect(disposed.sort()).toEqual(["bd-12", "bd-15"]);
  });

  it("disposes each state once across repeated clears and tolerates an empty store", () => {
    const disposed: string[] = [];
    const store = createSessionStateStore(createInitialSessionState, (state) => {
      disposed.push(state.currentTaskId);
    });

    // Nothing to drop: no throw, and the hook is not invented a state.
    expect(() => {
      store.clear();
    }).not.toThrow();
    expect(disposed).toEqual([]);

    store(ctxFor("session-a")).currentTaskId = "bd-12";
    store.clear();
    store.clear();

    expect(disposed).toEqual(["bd-12"]);
  });

  it("hands the dispose hook the dropped object itself, not a copy", () => {
    const seen: unknown[] = [];
    const store = createSessionStateStore(createInitialSessionState, (state) => {
      seen.push(state);
    });
    const leaked = store(ctxFor("session-a"));

    store.clear();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(leaked);
  });
});
