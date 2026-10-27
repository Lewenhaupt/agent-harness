/**
 * Unit tests for the pi-web session-pin client.
 *
 * The pin has to coexist with an operator pinning sessions by hand in the UI, so
 * the cases that matter are the compare-and-replace rules: never write from a
 * snapshot we could not read, never replace ids we did not choose, and re-derive
 * the write after a 409 instead of forcing a stale list through.
 */

import { describe, expect, it } from "vitest";
import type { PiWebHttpRequest, PiWebHttpResponse } from "../pi-web-navigation.js";
import {
  matchProjectId,
  matchWorkspaceId,
  mutateSessionPins,
  normalizeWorkspacePath,
  parseSessionPins,
  projectWorkspacesPath,
  sessionPinsPath,
  withoutSessionPin,
  withSessionPin,
} from "../pi-web-navigation.js";

interface Call {
  request: PiWebHttpRequest;
  reply: PiWebHttpResponse;
}

/** Scripted transport: each request pops one recorded reply. */
function scriptedTransport(replies: readonly PiWebHttpResponse[]): {
  calls: Call[];
  transport: (request: PiWebHttpRequest) => Promise<PiWebHttpResponse>;
} {
  const calls: Call[] = [];
  const queue = [...replies];
  return {
    calls,
    transport: async (request) => {
      const reply = queue.shift();
      if (reply === undefined)
        throw new Error(`unexpected request ${request.method} ${request.path}`);
      calls.push({ request, reply });
      return reply;
    },
  };
}

describe("session pin routes", () => {
  it("builds the machine-scoped session-pin path", () => {
    expect(sessionPinsPath({ projectId: "p 1", workspaceId: "w/2" })).toBe(
      "/api/machines/local/navigation/projects/p%201/workspaces/w%2F2/session-pins",
    );
  });

  it("honours an explicit machine id", () => {
    expect(sessionPinsPath({ projectId: "p", workspaceId: "w", machineId: "box" })).toContain(
      "/api/machines/box/",
    );
  });

  it("builds the workspace catalog path", () => {
    expect(projectWorkspacesPath("p 1")).toBe("/api/projects/p%201/workspaces");
  });
});

describe("parseSessionPins", () => {
  it("reads ids and revision", () => {
    expect(parseSessionPins({ ids: ["a", "b"], revision: 4 })).toEqual({
      ids: ["a", "b"],
      revision: 4,
    });
  });

  it("reads a record without a revision", () => {
    expect(parseSessionPins({ ids: [] })).toEqual({ ids: [] });
  });

  it("rejects shapes a write must not be derived from", () => {
    expect(parseSessionPins(null)).toBeUndefined();
    expect(parseSessionPins({ ids: "a" })).toBeUndefined();
    expect(parseSessionPins({ ids: ["a", ""] })).toBeUndefined();
    expect(parseSessionPins({ ids: [], revision: 1.5 })).toBeUndefined();
  });
});

describe("pin list helpers", () => {
  it("appends without disturbing the operator's order", () => {
    expect(withSessionPin(["x", "y"], "me")).toEqual(["x", "y", "me"]);
  });

  it("is idempotent", () => {
    expect(withSessionPin(["x", "me"], "me")).toEqual(["x", "me"]);
  });

  it("removes only the given id", () => {
    expect(withoutSessionPin(["me", "x"], "me")).toEqual(["x"]);
    expect(withoutSessionPin(["x"], "me")).toEqual(["x"]);
  });
});

describe("workspace lookup", () => {
  const projects = [
    { id: "other", path: "/home/hugo/git/other" },
    { id: "harness", path: "/home/hugo/git/belayd-agent-harness" },
  ];
  const workspaces = {
    status: "provider",
    projectId: "harness",
    workspaces: [
      { id: "main", path: "/home/hugo/git/belayd-agent-harness", isMain: true },
      { id: "wt", path: "/home/hugo/git/feat-bd-153", isMain: false },
    ],
  };

  it("matches a project by exact path", () => {
    expect(matchProjectId(projects, "/home/hugo/git/belayd-agent-harness")).toBe("harness");
  });

  it("tolerates a trailing slash", () => {
    expect(matchProjectId(projects, "/home/hugo/git/belayd-agent-harness/")).toBe("harness");
  });

  it("does not prefix-match a worktree onto its project", () => {
    expect(matchProjectId(projects, "/home/hugo/git/feat-bd-153")).toBeUndefined();
  });

  it("matches a worktree workspace by path", () => {
    expect(matchWorkspaceId(workspaces, "/home/hugo/git/feat-bd-153")).toBe("wt");
  });

  it("rejects unknown shapes", () => {
    expect(matchProjectId({}, "/x")).toBeUndefined();
    expect(matchWorkspaceId({ status: "none" }, "/x")).toBeUndefined();
  });

  it("normalizes paths without touching the root", () => {
    expect(normalizeWorkspacePath("/a/b///")).toBe("/a/b");
    expect(normalizeWorkspacePath("/")).toBe("/");
  });
});

describe("mutateSessionPins", () => {
  const base = { projectId: "p", workspaceId: "w" };

  it("writes the updated list with the current revision", async () => {
    const script = scriptedTransport([
      { status: 200, body: { ids: ["x"], revision: 7 } },
      { status: 200, body: { ids: ["x", "me"], revision: 8 } },
    ]);
    const result = await mutateSessionPins({
      ...base,
      request: script.transport,
      update: (ids) => withSessionPin(ids, "me"),
    });
    expect(result).toEqual({ ok: true, pins: { ids: ["x", "me"], revision: 8 }, changed: true });
    expect(script.calls[1]?.request.body).toEqual({ ids: ["x", "me"], revision: 7 });
  });

  it("does not write when the list already holds the id", async () => {
    const script = scriptedTransport([{ status: 200, body: { ids: ["me"], revision: 2 } }]);
    const result = await mutateSessionPins({
      ...base,
      request: script.transport,
      update: (ids) => withSessionPin(ids, "me"),
    });
    expect(result).toEqual({ ok: true, pins: { ids: ["me"], revision: 2 }, changed: false });
    expect(script.calls).toHaveLength(1);
  });

  it("re-derives the write after a lost race", async () => {
    const script = scriptedTransport([
      { status: 200, body: { ids: ["x"], revision: 7 } },
      { status: 409, body: { error: "conflict", ids: ["x", "y"], revision: 8 } },
      { status: 200, body: { ids: ["x", "y"], revision: 8 } },
      { status: 200, body: { ids: ["x", "y", "me"], revision: 9 } },
    ]);
    const result = await mutateSessionPins({
      ...base,
      request: script.transport,
      update: (ids) => withSessionPin(ids, "me"),
    });
    expect(result.ok).toBe(true);
    // The operator's own pin ("y") survived: the retry used the winning snapshot.
    expect(script.calls[3]?.request.body).toEqual({ ids: ["x", "y", "me"], revision: 8 });
  });

  it("gives up after the attempt budget instead of looping", async () => {
    const conflict: PiWebHttpResponse = {
      status: 409,
      body: { error: "conflict", ids: [], revision: 3 },
    };
    const script = scriptedTransport([
      { status: 200, body: { ids: [], revision: 3 } },
      conflict,
      { status: 200, body: { ids: [], revision: 4 } },
      conflict,
    ]);
    const result = await mutateSessionPins({
      ...base,
      request: script.transport,
      update: (ids) => withSessionPin(ids, "me"),
      maxAttempts: 2,
    });
    expect(result).toEqual({ ok: false, error: "pin list changed while writing" });
  });

  it("refuses to write from a snapshot it cannot parse", async () => {
    const script = scriptedTransport([{ status: 200, body: { pins: [] } }]);
    const result = await mutateSessionPins({
      ...base,
      request: script.transport,
      update: (ids) => withSessionPin(ids, "me"),
    });
    expect(result.ok).toBe(false);
    expect(script.calls).toHaveLength(1);
  });

  it("reports a failed read without inventing an empty list", async () => {
    const script = scriptedTransport([{ status: 404, body: { error: "nope" } }]);
    const result = await mutateSessionPins({
      ...base,
      request: script.transport,
      update: (ids) => withSessionPin(ids, "me"),
    });
    expect(result).toEqual({ ok: false, error: "read failed with HTTP 404" });
  });

  it("drops the precondition when pi-web omits the revision", async () => {
    const script = scriptedTransport([
      { status: 200, body: { ids: [] } },
      { status: 200, body: { ids: ["me"] } },
    ]);
    await mutateSessionPins({
      ...base,
      request: script.transport,
      update: (ids) => withSessionPin(ids, "me"),
    });
    expect(script.calls[1]?.request.body).toEqual({ ids: ["me"] });
  });
});
