/**
 * Tests for the per-bead engagement reader (bd-153).
 *
 * The runner is injected, so the read cost and the read-only invariant are
 * asserted where they run: two read-only `bd` calls per bead, a bounded fan-out,
 * and a per-bead failure that never takes the fleet view down. Several cases
 * drive the real reader into `applyFleetBeadEngagement`/`formatFleetStatus`
 * because a synthetic engagement object cannot catch a reader that renders a
 * failed read as an empty thread.
 */

import { describe, expect, it, vi } from "vitest";

import {
  BEAD_READ_MAX_BUFFER_BYTES,
  BEAD_READ_TIMEOUT_MS,
  type BeadCommentLookup,
  type lookupBeadComments,
} from "../bead-comments.js";
import type { lookupOpenHumanGate, OpenHumanGateLookup } from "../bead-gates.js";
import { ENGAGEMENT_CONCURRENCY, lookupFleetBeadEngagement } from "../fleet-bead-engagement.js";
import type { FleetBeadRunner, FleetBeadRunnerOptions } from "../fleet-beads.js";
import {
  applyFleetBeadEngagement,
  applyFleetBeadLookup,
  buildFleetStatus,
  type FleetMemberSnapshot,
  type FleetStatus,
  formatFleetStatus,
  formatNeedsYou,
} from "../fleet-status.js";

const CWD = "/repo";

/** Matches an unpaired UTF-16 surrogate, i.e. an astral character cut in half. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

type CommentLookupOptions = Parameters<typeof lookupBeadComments>[0];
type GateLookupOptions = Parameters<typeof lookupOpenHumanGate>[0];

interface RecordedCall {
  argv: readonly string[];
  options: FleetBeadRunnerOptions;
}

interface InstrumentedRunner {
  runBd: FleetBeadRunner;
  calls: RecordedCall[];
  maxInFlight: () => number;
}

type RunnerHandlers = {
  comments?: (beadId: string) => unknown;
  gates?: (beadId: string) => unknown;
  delayMs?: number;
  throwFor?: (beadId: string) => boolean;
  throwWhen?: (argv: readonly string[]) => boolean;
};

/** `comments`/`gate list` put the bead id in a different argv slot. */
function beadIdFromArgv(argv: readonly string[]): string {
  return argv[1] === "list" ? (argv[2] ?? "") : (argv[1] ?? "");
}

function replyFor(argv: readonly string[], handlers: RunnerHandlers, beadId: string): string {
  if (argv[0] === "comments") return JSON.stringify(handlers.comments?.(beadId) ?? null);
  if (argv[0] === "gate") return JSON.stringify(handlers.gates?.(beadId) ?? null);
  throw new Error(`unexpected bd argv: ${argv.join(" ")}`);
}

function instrumentedRunner(handlers: RunnerHandlers): InstrumentedRunner {
  const calls: RecordedCall[] = [];
  let inFlight = 0;
  let peak = 0;

  const runBd: FleetBeadRunner = async (argv, options) => {
    calls.push({ argv: [...argv], options });
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    try {
      if (handlers.delayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, handlers.delayMs));
      }
      const beadId = beadIdFromArgv(argv);
      if (handlers.throwFor?.(beadId) === true) throw new Error(`bd failed for ${beadId}`);
      if (handlers.throwWhen?.(argv) === true) throw new Error(`bd failed: ${argv.join(" ")}`);
      return { stdout: replyFor(argv, handlers, beadId) };
    } finally {
      inFlight -= 1;
    }
  };

  return { runBd, calls, maxInFlight: () => peak };
}

function comment(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    issue_id: "bd-12",
    author: "hugo",
    created_at: "2026-10-27T07:47:29Z",
    text: `comment ${id}`,
    ...overrides,
  };
}

function memberSnapshot(taskId: string): FleetMemberSnapshot {
  return {
    worktreePath: `/repo.${taskId}`,
    isMainWorktree: false,
    branch: `feat/${taskId}`,
    workflow: {
      kind: "ok",
      state: {
        schemaVersion: 1,
        taskId,
        workflowType: "feature",
        branch: `feat/${taskId}`,
        originalCwd: `/repo.${taskId}`,
        phaseOrder: ["plan"],
        completedPhaseNames: [],
        startedAt: 1_000,
        updatedAt: 2_000,
      },
    },
    runs: [],
    lease: { state: "absent" },
  };
}

/** A fleet whose members only job is to carry the task ids into the formatter. */
function fleetWithMembers(taskIds: readonly string[]): FleetStatus {
  return buildFleetStatus({
    fleetId: "fleet-1",
    intent: undefined,
    members: taskIds.map(memberSnapshot),
  });
}

function fleetWith(taskId: string): FleetStatus {
  return fleetWithMembers([taskId]);
}

async function readAndFormat(
  taskIds: readonly string[],
  runBd: FleetBeadRunner,
): Promise<{ text: string; status: FleetStatus }> {
  const lookup = await lookupFleetBeadEngagement({ taskIds, cwd: CWD, runBd });
  const status = applyFleetBeadEngagement(fleetWith(taskIds[0] ?? "bd-12"), lookup);
  return { text: formatFleetStatus(status), status };
}

describe("lookupFleetBeadEngagement", () => {
  it("spawns nothing when there is no task id", async () => {
    const { runBd, calls } = instrumentedRunner({});

    expect(await lookupFleetBeadEngagement({ taskIds: [], cwd: CWD, runBd })).toEqual({
      ok: true,
      entries: [],
    });
    expect(calls).toEqual([]);
  });

  it("runs exactly one comments read and one gate list per bead, read-only", async () => {
    const { runBd, calls } = instrumentedRunner({
      comments: (beadId) =>
        beadId === "bd-12"
          ? [
              comment("c-1", { created_at: "2026-10-27T07:00:00Z", text: "older" }),
              comment("c-2", { created_at: "2026-10-27T08:00:00Z", text: "newer" }),
            ]
          : null,
      gates: (beadId) =>
        beadId === "bd-15"
          ? [
              {
                id: "gate-1",
                status: "open",
                await_type: "human",
                created_at: "2026-10-27T07:47:29Z",
              },
            ]
          : null,
    });

    const result = await lookupFleetBeadEngagement({
      taskIds: ["bd-12", "bd-15"],
      cwd: CWD,
      runBd,
    });

    expect(result).toEqual({
      ok: true,
      entries: [
        {
          taskId: "bd-12",
          engagement: {
            comments: {
              state: "read",
              newest: {
                author: "hugo",
                text: "newer",
                createdAt: "2026-10-27T08:00:00Z",
              },
            },
            awaitingHuman: false,
          },
        },
        {
          taskId: "bd-15",
          engagement: { comments: { state: "read" }, awaitingHuman: true },
        },
      ],
    });

    // Only read subcommands, and only the two documented shapes: this path can
    // never become a writer (no `gate create/resolve`, no `bd comment`).
    expect(calls.map((call) => call.argv).sort()).toEqual(
      [
        ["comments", "bd-12", "--json"],
        ["comments", "bd-15", "--json"],
        ["gate", "list", "bd-12", "--json"],
        ["gate", "list", "bd-15", "--json"],
      ].sort(),
    );
    expect(calls[0]?.options).toEqual({
      cwd: CWD,
      stdin: undefined,
      timeoutInMs: BEAD_READ_TIMEOUT_MS,
      maxBufferInBytes: BEAD_READ_MAX_BUFFER_BYTES,
    });
  });

  it("reads a fleet ordering gate as waiting on its blocker, never as a human wait", async () => {
    // bd-158: the same `gate list` read names the member a bead is ordered behind.
    // It must not land in `awaitingHuman` (nobody has to answer it) and must not
    // leave the member in "Needs you".
    const { runBd } = instrumentedRunner({
      gates: () => [
        {
          id: "bd-950",
          status: "open",
          await_type: "human",
          title: "belayd-fleet-ordering: fleet:default bd-12 -> bd-15",
          description:
            "Ad-hoc gate blocking bd-15\n\nReason: belayd-fleet-ordering: fleet:default bd-12 -> bd-15",
        },
      ],
    });

    const result = await lookupFleetBeadEngagement({ taskIds: ["bd-15"], cwd: CWD, runBd });

    expect(result).toEqual({
      ok: true,
      entries: [
        {
          taskId: "bd-15",
          engagement: {
            comments: { state: "read" },
            awaitingHuman: false,
            orderingBlocker: "bd-12",
          },
        },
      ],
    });
  });

  it("breaks equal timestamps by comment id, deterministically", async () => {
    const { runBd } = instrumentedRunner({
      comments: () => [comment("c-1", { text: "first" }), comment("c-2", { text: "second" })],
    });

    const result = await lookupFleetBeadEngagement({ taskIds: ["bd-12"], cwd: CWD, runBd });

    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    expect(result.entries[0]?.engagement.comments).toEqual({
      state: "read",
      newest: { author: "hugo", text: "second", createdAt: "2026-10-27T07:47:29Z" },
    });
  });

  it("treats a malformed gate record as unknown, never as resolved", async () => {
    const { runBd } = instrumentedRunner({
      // Records exist, but none is an open human gate: a renamed status or
      // await_type must not render as "not waiting on a human".
      gates: () => [{ id: "gate-1", status: "closed", await_type: "timer" }],
    });

    const result = await lookupFleetBeadEngagement({ taskIds: ["bd-12"], cwd: CWD, runBd });

    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    const engagement = result.entries[0]?.engagement ?? { comments: { state: "unknown" } };
    expect(engagement.awaitingHuman).toBe(undefined);
    expect("awaitingHuman" in engagement).toBe(false);
  });

  it("keeps a failed gate read unknown while the comment column still renders", async () => {
    const comments = vi.fn(
      async (_options: CommentLookupOptions): Promise<BeadCommentLookup> => ({
        ok: true,
        comments: [
          {
            id: "c-1",
            issueId: "bd-12",
            author: "hugo",
            createdAt: "2026-10-27T07:47:29Z",
            text: "answered",
          },
        ],
        dropped: 0,
      }),
    );
    const gates = vi.fn(
      async (_options: GateLookupOptions): Promise<OpenHumanGateLookup> => ({
        ok: false,
        error: "gate list failed",
      }),
    );

    const result = await lookupFleetBeadEngagement({
      taskIds: ["bd-12"],
      cwd: CWD,
      runBd: vi.fn<FleetBeadRunner>(),
      lookupComments: comments,
      lookupGate: gates,
    });

    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    const engagement = result.entries[0]?.engagement;
    expect(engagement?.awaitingHuman).toBe(undefined);
    expect(engagement?.comments).toEqual({
      state: "read",
      newest: { author: "hugo", text: "answered", createdAt: "2026-10-27T07:47:29Z" },
    });
  });

  it("degrades one bead's failed reads without failing the others", async () => {
    const { runBd } = instrumentedRunner({
      comments: () => [comment("c-1")],
      gates: (beadId) =>
        beadId === "bd-15" ? [{ id: "gate-1", status: "open", await_type: "human" }] : null,
      throwFor: (beadId) => beadId === "bd-12",
    });

    const result = await lookupFleetBeadEngagement({
      taskIds: ["bd-12", "bd-15"],
      cwd: CWD,
      runBd,
    });

    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    expect(result.entries).toEqual([
      { taskId: "bd-12", engagement: { comments: { state: "unknown" } } },
      {
        taskId: "bd-15",
        engagement: {
          comments: {
            state: "read",
            newest: {
              author: "hugo",
              text: "comment c-1",
              createdAt: "2026-10-27T07:47:29Z",
            },
          },
          awaitingHuman: true,
        },
      },
    ]);
  });

  it("contains a throwing lookup seam to its own bead", async () => {
    const comments = vi.fn(async (options: CommentLookupOptions): Promise<BeadCommentLookup> => {
      if (options.beadId === "bd-12") throw new Error("seam exploded");
      return { ok: true, comments: [], dropped: 0 };
    });
    const gates = vi.fn(
      async (options: GateLookupOptions): Promise<OpenHumanGateLookup> =>
        options.beadId === "bd-15"
          ? { ok: true, status: "open", gate: { gateId: "gate-1" } }
          : { ok: true, status: "none" },
    );

    const result = await lookupFleetBeadEngagement({
      taskIds: ["bd-12", "bd-15"],
      cwd: CWD,
      runBd: vi.fn<FleetBeadRunner>(),
      lookupComments: comments,
      lookupGate: gates,
    });

    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    // A throwing comments seam still leaves the gate signal for that bead.
    expect(result.entries[0]?.engagement).toEqual({
      comments: { state: "unknown" },
      awaitingHuman: false,
    });
    expect(result.entries[1]?.engagement).toEqual({
      comments: { state: "read" },
      awaitingHuman: true,
    });
    expect(comments).toHaveBeenCalledTimes(2);
    expect(gates).toHaveBeenCalledTimes(2);
  });

  it("bounds the number of beads read at once and keeps input order", async () => {
    const taskIds = Array.from({ length: 8 }, (_, index) => `bd-${100 + index}`);
    const { runBd, maxInFlight } = instrumentedRunner({
      comments: () => null,
      gates: () => null,
      delayMs: 2,
    });

    const result = await lookupFleetBeadEngagement({ taskIds, cwd: CWD, runBd });

    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    expect(result.entries.map((entry) => entry.taskId)).toEqual(taskIds);
    // A wide `Promise.all` would peak at 8; the pool caps it.
    expect(maxInFlight()).toBeLessThanOrEqual(ENGAGEMENT_CONCURRENCY);
    expect(maxInFlight()).toBeGreaterThan(1);
  });

  it("bounds a seam that never settles instead of hanging the fleet view", async () => {
    vi.useFakeTimers();
    try {
      const pending = lookupFleetBeadEngagement({
        taskIds: ["bd-12"],
        cwd: CWD,
        runBd: vi.fn<FleetBeadRunner>(),
        lookupComments: vi.fn(() => new Promise<BeadCommentLookup>(() => undefined)),
        lookupGate: vi.fn(async (): Promise<OpenHumanGateLookup> => ({ ok: true, status: "none" })),
      });

      await vi.advanceTimersByTimeAsync(BEAD_READ_TIMEOUT_MS + 2_000);
      const result = await pending;
      expect(result).toHaveProperty("ok", true);
      if (!result.ok) return;
      expect(result.entries[0]?.engagement).toEqual({
        comments: { state: "unknown" },
        awaitingHuman: false,
      });
      // The timed-out read is `(unknown)` on the member block, never `(none)`.
      const status = applyFleetBeadEngagement(fleetWith("bd-12"), result);
      const text = formatFleetStatus(status);
      expect(text).toContain("  newest comment: (unknown)");
      expect(text).not.toContain("  newest comment: (none)");
      // Every watchdog timer was cleared: a status call must not leak one.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a slow read succeed instead of firing the watchdog", async () => {
    vi.useFakeTimers();
    try {
      const slow = BEAD_READ_TIMEOUT_MS - 500;
      const pending = lookupFleetBeadEngagement({
        taskIds: ["bd-12"],
        cwd: CWD,
        runBd: vi.fn<FleetBeadRunner>(),
        lookupComments: vi.fn(async (): Promise<BeadCommentLookup> => {
          await new Promise((resolve) => setTimeout(resolve, slow));
          return {
            ok: true,
            comments: [
              {
                id: "c-1",
                issueId: "bd-12",
                author: "hugo",
                createdAt: "2026-10-27T07:47:29Z",
                text: "slow but answered",
              },
            ],
            dropped: 0,
          };
        }),
        lookupGate: vi.fn(async (): Promise<OpenHumanGateLookup> => ({ ok: true, status: "none" })),
      });

      // Advance past the slow read but short of the watchdog deadline: the
      // suggestion under test is that the watchdog bounds a hang, not a wait.
      await vi.advanceTimersByTimeAsync(slow);
      const result = await pending;

      expect(result).toHaveProperty("ok", true);
      if (!result.ok) return;
      expect(result.entries[0]?.engagement).toEqual({
        comments: {
          state: "read",
          newest: {
            author: "hugo",
            text: "slow but answered",
            createdAt: "2026-10-27T07:47:29Z",
          },
        },
        awaitingHuman: false,
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("contains one bead's failed reads without failing the fleet view or warning", async () => {
    // bd-12 loses both reads (comments and gate); bd-15 answers normally.
    const { runBd } = instrumentedRunner({
      comments: () => null,
      gates: () => null,
      throwFor: (beadId) => beadId === "bd-12",
    });

    const lookup = await lookupFleetBeadEngagement({
      taskIds: ["bd-12", "bd-15"],
      cwd: CWD,
      runBd,
    });

    // One unreadable bead is not a fleet-wide outage, so it must not warn.
    expect(lookup).toHaveProperty("ok", true);
    if (!lookup.ok) return;
    const status = applyFleetBeadEngagement(fleetWithMembers(["bd-12", "bd-15"]), lookup);
    expect(
      status.warnings.filter((warning) => warning.kind === "bead-engagement-unavailable"),
    ).toHaveLength(0);

    const text = formatFleetStatus(status);
    const memberBlocks = text.split("\nMember ");
    expect(memberBlocks).toHaveLength(3);
    const [, failed, healthy] = memberBlocks;
    expect(failed).toContain("  awaiting human: unknown");
    expect(failed).toContain("  newest comment: (unknown)");
    expect(failed).not.toContain("  newest comment: (none)");
    // The sibling's columns are untouched by the failed reads next to it.
    expect(healthy).toContain("  awaiting human: no");
    expect(healthy).toContain("  newest comment: (none)");
    expect(text).not.toContain("bead engagement unavailable");
  });
});

describe("failed reads stay fail-closed end to end", () => {
  it("renders (unknown), never (none), when the comments read failed", async () => {
    const { runBd } = instrumentedRunner({
      gates: () => null,
      throwWhen: (argv) => argv[0] === "comments",
    });

    const { text } = await readAndFormat(["bd-12"], runBd);

    expect(text).toContain("  newest comment: (unknown)");
    expect(text).not.toContain("  newest comment: (none)");
    expect(text).toContain("  awaiting human: no");
  });

  it("renders (none) only when the read succeeded and the thread is empty", async () => {
    const { runBd } = instrumentedRunner({ comments: () => null, gates: () => null });

    const { text } = await readAndFormat(["bd-12"], runBd);

    expect(text).toContain("  newest comment: (none)");
  });

  it("degrades a fleet-wide bd outage to exactly one warning", async () => {
    const { runBd } = instrumentedRunner({ throwWhen: () => true });

    const { text, status } = await readAndFormat(["bd-12", "bd-15"], runBd);

    expect(status.warnings).toHaveLength(1);
    expect(status.warnings[0]).toHaveProperty("kind", "bead-engagement-unavailable");
    expect(status.warnings[0]?.message).toContain("bd failed");
    // Every member keeps no engagement line at all; the warning carries the fact.
    expect(text).not.toContain("newest comment:");
    expect(text).toContain("Warnings (1):");
  });

  it("renders (unknown), never (none), when bd returned records that all failed to parse", async () => {
    const { runBd } = instrumentedRunner({
      // Both records lack a usable id/text: bd schema drift, not an empty thread.
      comments: () => [{ text: "no id" }, { id: "c-2" }],
      gates: () => null,
    });

    const lookup = await lookupFleetBeadEngagement({
      taskIds: ["bd-12"],
      cwd: CWD,
      runBd,
    });
    const text = formatFleetStatus(applyFleetBeadEngagement(fleetWith("bd-12"), lookup));

    expect(text).toContain("  newest comment: (unknown)");
    expect(text).not.toContain("  newest comment: (none)");
    expect(text).toContain("  awaiting human: no");

    // The Needs-you line must say "comments unknown" too, not "no comments yet".
    const withHumanLabel = applyFleetBeadLookup(fleetWith("bd-12"), {
      ok: true,
      beads: [
        {
          id: "bd-12",
          title: "Fleet status",
          status: "open",
          priority: 2,
          labels: ["human"],
        },
      ],
    });
    const needsYou = formatNeedsYou(applyFleetBeadEngagement(withHumanLabel, lookup));
    expect(needsYou).toContain("Needs you (1): bd-12");
    expect(needsYou).toContain("(comments unknown)");
    expect(needsYou).not.toContain("(no comments yet)");
  });

  it("still shows the newest usable comment from a partially malformed thread", async () => {
    const { runBd } = instrumentedRunner({
      comments: () => [{ text: "no id" }, comment("c-1", { text: "still here" })],
      gates: () => null,
    });

    const result = await lookupFleetBeadEngagement({ taskIds: ["bd-12"], cwd: CWD, runBd });

    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    expect(result.entries[0]?.engagement.comments).toEqual({
      state: "read",
      newest: { author: "hugo", text: "still here", createdAt: "2026-10-27T07:47:29Z" },
    });
    // The member block shows that parsed comment rather than `(unknown)`.
    const text = formatFleetStatus(applyFleetBeadEngagement(fleetWith("bd-12"), result));
    expect(text).toContain('  newest comment: hugo 2026-10-27T07:47:29Z: "still here"');
    expect(text).not.toContain("  newest comment: (unknown)");
  });

  it("keeps the lone bead usable when only the comments drifted", async () => {
    const { runBd } = instrumentedRunner({
      comments: () => [{ text: "no id" }],
      gates: () => null,
    });

    const result = await lookupFleetBeadEngagement({ taskIds: ["bd-12"], cwd: CWD, runBd });

    // Schema drift in comments is not a total outage: the gate column still
    // renders, so the lookup stays ok with an unknown comment column.
    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    expect(result.entries[0]?.engagement).toEqual({
      comments: { state: "unknown" },
      awaitingHuman: false,
    });
  });

  it("counts an all-dropped thread as no usable half when the gate also failed", async () => {
    const { runBd } = instrumentedRunner({
      comments: () => [{ text: "no id" }],
      throwWhen: (argv) => argv[0] === "gate",
    });

    const result = await lookupFleetBeadEngagement({ taskIds: ["bd-12"], cwd: CWD, runBd });

    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.error).toContain("bd failed");
  });

  it("strips control characters out of comment fields before rendering", async () => {
    const { runBd } = instrumentedRunner({
      comments: () => [
        comment("c-1", {
          author: "hu\u001b[31mgo",
          text: "\u0000drop \u001b[31mred\u001b[0m",
        }),
      ],
      gates: () => null,
    });

    const { text } = await readAndFormat(["bd-12"], runBd);

    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\u0000");
    expect(text).toContain('  newest comment: hugo 2026-10-27T07:47:29Z: "drop red"');
  });

  it("replaces embedded quotes so the one-line quoting still holds", async () => {
    const { runBd } = instrumentedRunner({
      comments: () => [comment("c-1", { text: 'he said "drop it"' })],
      gates: () => null,
    });

    const { text } = await readAndFormat(["bd-12"], runBd);

    expect(text).toContain(`  newest comment: hugo 2026-10-27T07:47:29Z: "he said 'drop it'"`);
    expect(text).not.toContain('"he said "drop it""');
  });

  it("keeps the excerpt cap after quote substitution", async () => {
    const { runBd } = instrumentedRunner({
      comments: () => [comment("c-1", { text: '"'.repeat(300) })],
      gates: () => null,
    });

    const { text } = await readAndFormat(["bd-12"], runBd);
    const line = text.split("\n").find((entry) => entry.includes("newest comment:")) ?? "";
    const quoteStart = line.indexOf('Z: "') + 4;
    const quoted = line.slice(quoteStart);

    // 120 excerpt chars + the ellipsis, wrapped in the closing quote.
    expect(quoted.length).toBeLessThanOrEqual(122);
    expect(line.match(/"/gu)).toHaveLength(2);
  });

  it("renders an astral-only comment without a lone surrogate", async () => {
    const { runBd } = instrumentedRunner({
      comments: () => [comment("c-1", { text: "😀".repeat(130) })],
      gates: () => null,
    });

    const { text } = await readAndFormat(["bd-12"], runBd);
    const line = text.split("\n").find((entry) => entry.includes("newest comment:")) ?? "";

    expect(line).toContain('newest comment: hugo 2026-10-27T07:47:29Z: "');
    expect(line).not.toContain("\uFFFD");
    expect(LONE_SURROGATE.test(line)).toBe(false);
  });
});
