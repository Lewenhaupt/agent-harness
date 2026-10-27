/**
 * Unit tests for fleet status (bd-126 P0).
 *
 * The aggregation/formatting layer is pure, so most cases pass already-read
 * data and assert on the returned object. The reader takes an injected fs seam
 * plus two git seams, so its cases exercise the same pure layer without
 * shelling out to git.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { recordRunMemberStopped, startFleetRun } from "../fleet-run.js";
import {
  applyFleetBeadEngagement,
  applyFleetBeadLookup,
  beadNeedsHuman,
  buildFleetStatus,
  DEFAULT_FLEET_ID,
  deriveFleetMemberState,
  FLEET_MEMBER_STATES,
  type FleetBeadEngagement,
  type FleetIntent,
  type FleetMemberSnapshot,
  type FleetStatus,
  type FleetStatusFs,
  type FleetWorkflowSnapshot,
  fleetAuditLogPath,
  fleetBeadTaskIds,
  fleetEventsDir,
  fleetInboxDir,
  fleetIntentFilePath,
  fleetMergeQueueFilePath,
  fleetStateDir,
  formatBeadOwnership,
  formatFleetStatus,
  formatNeedsYou,
  NEEDS_YOU_EXCERPT_MAX_CHARS,
  NEEDS_YOU_LIST_MAX,
  parseBeadView,
  parseBeadViews,
  parseFleetIntent,
  readFleetStatus,
  sanitizeFleetId,
} from "../fleet-status.js";
import type { RunManifest } from "../run-manifest.js";
import { RunStatus, runManifestPath } from "../run-manifest.js";
import { isValidTaskId } from "../session-naming.js";
import type { WorkflowState } from "../workflow-state.js";
import { workflowStateFilePath } from "../workflow-state.js";
import {
  parseWorktreeListPorcelain,
  parseWorktreeListPorcelainZ,
  type WorktreeListEntry,
} from "../worktree.js";

const PHASES = ["plan", "implement", "review", "test", "commit"];

// Real `bd show --json` payload (bd 1.3.0 dev), so the ownership columns are
// checked against bd's actual field names/types instead of a hand-written
// object. Provenance: `bd show bd-26 --json --brief-deps` in this repo, captured
// verbatim; `--brief-deps` only trims dependency bodies, and every top-level
// field asserted below is byte-identical to a plain `bd show bd-26 --json`.
const REAL_SHOW_JSON = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "fixtures", "bd-show-real.json"),
  "utf8",
);

function sampleWorkflow(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    schemaVersion: 1,
    taskId: "bd-12",
    workflowType: "feature",
    branch: "feat/bd-12",
    originalCwd: "/repo.feat-bd-12",
    phaseOrder: [...PHASES],
    completedPhaseNames: ["plan"],
    startedAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  };
}

function sampleRun(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    schemaVersion: 1,
    runId: "run-1",
    taskId: "bd-12",
    phase: "plan",
    sessionName: "belayd-bd-12-sub-plan",
    status: RunStatus.Completed,
    startedAt: 1_100,
    completedAt: 1_200,
    ...overrides,
  };
}

function okWorkflow(overrides: Partial<WorkflowState> = {}): FleetWorkflowSnapshot {
  return { kind: "ok", state: sampleWorkflow(overrides) };
}

/**
 * Manifests another bead left in the same `.belayd/runs` directory.
 *
 * Two task ids, several phases of a finished workflow, a crash and a failure:
 * exactly what a fresh worktree inherits when a consumer repository commits its
 * manifests (bd-146). All start after this member's own runs, so an unfiltered
 * view would prefer them — including a `plan` manifest, so a regression that
 * filters by phase instead of by task id cannot pass unnoticed.
 */
function inheritedRuns(): RunManifest[] {
  return [
    sampleRun({
      runId: "bd16-scout",
      taskId: "bd-16",
      phase: "scout",
      sessionName: "belayd-bd-16-sub-scout",
      startedAt: 3_000,
      completedAt: 3_100,
    }),
    sampleRun({
      runId: "bd16-commit",
      taskId: "bd-16",
      phase: "commit",
      sessionName: "belayd-bd-16-sub-commit",
      startedAt: 3_200,
      completedAt: 3_300,
    }),
    sampleRun({
      runId: "bd83-test",
      taskId: "bd-83",
      phase: "test",
      sessionName: "belayd-bd-83-sub-test",
      startedAt: 3_400,
      completedAt: 3_500,
    }),
    sampleRun({
      runId: "bd83-implement",
      taskId: "bd-83",
      phase: "implement",
      sessionName: "belayd-bd-83-sub-implement",
      status: RunStatus.Interrupted,
      startedAt: 3_600,
      completedAt: 3_700,
    }),
    sampleRun({
      runId: "bd16-review",
      taskId: "bd-16",
      phase: "review",
      sessionName: "belayd-bd-16-sub-review",
      status: RunStatus.Failed,
      startedAt: 3_800,
      completedAt: 3_900,
      failureReason: "gate failed",
    }),
    // Same phase as the member's own `plan` run and newer, so only the task id
    // separates them.
    sampleRun({
      runId: "bd16-plan",
      taskId: "bd-16",
      phase: "plan",
      sessionName: "belayd-bd-16-sub-plan",
      startedAt: 3_950,
      completedAt: 3_970,
    }),
  ];
}

function sampleMember(overrides: Partial<FleetMemberSnapshot> = {}): FleetMemberSnapshot {
  return {
    worktreePath: "/repo.feat-bd-12",
    isMainWorktree: false,
    branch: "feat/bd-12",
    workflow: okWorkflow(),
    runs: [],
    lease: { state: "absent" },
    ...overrides,
  };
}

function sampleIntent(overrides: Partial<FleetIntent> = {}): FleetIntent {
  return {
    schemaVersion: 1,
    fleetId: "fleet-1",
    taskIds: ["bd-12", "bd-15"],
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  };
}

interface FakeFs extends FleetStatusFs {
  files: Map<string, string>;
}

/** In-memory fs supporting the reads and the `readdirSync` that listRuns needs. */
function createFakeFs(initial: Record<string, string> = {}): FakeFs {
  const files = new Map(Object.entries(initial));
  return {
    files,
    existsSync: (path) => files.has(path),
    readFileSync: (path) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    writeFileSync: (path, data) => {
      files.set(path, data);
    },
    renameSync: (oldPath, newPath) => {
      const content = files.get(oldPath);
      if (content === undefined) throw new Error(`ENOENT: ${oldPath}`);
      files.delete(oldPath);
      files.set(newPath, content);
    },
    mkdirSync: () => {
      // The in-memory fs has no directory hierarchy to create.
    },
    unlinkSync: (path) => {
      files.delete(path);
    },
    readdirSync: (path) => {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const names = new Set<string>();
      for (const file of files.keys()) {
        if (!file.startsWith(prefix)) continue;
        const rest = file.slice(prefix.length);
        const head = rest.split("/")[0];
        if (head !== undefined) names.add(head);
      }
      return [...names];
    },
  };
}

const worktreeEntries: WorktreeListEntry[] = [
  { path: "/repo", branch: "main", isMainWorktree: true },
  { path: "/repo.feat-bd-12", branch: "feat/bd-12", isMainWorktree: false },
];

describe("fleet state paths", () => {
  it("places every shared artifact under <git-common-dir>/belayd/fleet/<fleetId>", () => {
    const dir = fleetStateDir("/repo/.git", "fleet-1");

    expect(dir).toBe(join("/repo/.git", "belayd", "fleet", "fleet-1"));
    expect(fleetIntentFilePath("/repo/.git", "fleet-1")).toBe(join(dir, "fleet.json"));
    expect(fleetInboxDir("/repo/.git", "fleet-1")).toBe(join(dir, "inbox"));
    expect(fleetEventsDir("/repo/.git", "fleet-1")).toBe(join(dir, "events"));
    expect(fleetMergeQueueFilePath("/repo/.git", "fleet-1")).toBe(join(dir, "merge-queue.json"));
    expect(fleetAuditLogPath("/repo/.git", "fleet-1")).toBe(join(dir, "audit.log"));
  });

  it("sanitizes ids so they cannot escape the fleet root", () => {
    expect(sanitizeFleetId("../escape")).toBe(".._escape");
    expect(sanitizeFleetId("..")).toBe(DEFAULT_FLEET_ID);
    expect(sanitizeFleetId("")).toBe(DEFAULT_FLEET_ID);
    expect(fleetStateDir("/repo/.git", "../escape")).toContain(".._escape");
  });

  it("collapses whitespace and separators into one path-safe segment", () => {
    expect(sanitizeFleetId("  fleet one  ")).toBe("fleet_one");
    expect(sanitizeFleetId("../../etc")).toBe(".._.._etc");
    expect(sanitizeFleetId("..").split("/")).not.toContain("..");
    // No sanitized id may reintroduce a path separator or traversal segment.
    for (const requested of ["../escape", "../../etc", "a/b", "a\\b", " ~ ", ".."]) {
      const sanitized = sanitizeFleetId(requested);
      expect(sanitized).not.toContain("/");
      expect(sanitized).not.toContain("\\");
      expect(sanitized).not.toBe("");
    }
  });
});

describe("parseFleetIntent", () => {
  it("parses a valid intent record with optional fields", () => {
    expect(parseFleetIntent(sampleIntent({ maxConcurrent: 3, paused: true }))).toHaveProperty(
      "maxConcurrent",
      3,
    );
    expect(parseFleetIntent(sampleIntent())).toHaveProperty("taskIds", ["bd-12", "bd-15"]);
  });

  it("returns undefined for corrupt, wrong-version, or invalid intent", () => {
    expect(parseFleetIntent("not json")).toBe(undefined);
    expect(parseFleetIntent({ ...sampleIntent(), schemaVersion: 2 })).toBe(undefined);
    expect(parseFleetIntent({ ...sampleIntent(), taskIds: "bd-12" })).toBe(undefined);
  });
});

describe("parseWorktreeListPorcelain", () => {
  it("parses worktree paths and branches, marking the first entry as main", () => {
    const porcelain = [
      "worktree /repo",
      "HEAD 1111111",
      "branch refs/heads/main",
      "",
      "worktree /repo.feat-bd-12",
      "HEAD 2222222",
      "branch refs/heads/feat/bd-12",
      "",
    ].join("\n");

    expect(parseWorktreeListPorcelain(porcelain)).toEqual({
      entries: [
        { path: "/repo", branch: "main", isMainWorktree: true },
        { path: "/repo.feat-bd-12", branch: "feat/bd-12", isMainWorktree: false },
      ],
      warnings: [],
    });
  });

  it("keeps a detached worktree with no branch", () => {
    const porcelain = [
      "worktree /repo",
      "branch refs/heads/main",
      "",
      "worktree /tmp/det",
      "detached",
      "",
    ].join("\n");

    expect(parseWorktreeListPorcelain(porcelain)).toEqual({
      entries: [
        { path: "/repo", branch: "main", isMainWorktree: true },
        { path: "/tmp/det", branch: undefined, isMainWorktree: false },
      ],
      warnings: [],
    });
  });

  it("returns no entries for empty output", () => {
    expect(parseWorktreeListPorcelain("")).toEqual({ entries: [], warnings: [] });
  });

  it("skips a record whose path contains a newline and reports a warning", () => {
    const porcelain = [
      "worktree /repo.feat-bd-12",
      "line2",
      "branch refs/heads/feat/bd-12",
      "",
    ].join("\n");

    const parsed = parseWorktreeListPorcelain(porcelain);

    expect(parsed.entries).toEqual([]);
    expect(parsed.warnings).toHaveLength(1);
  });
});

describe("deriveFleetMemberState", () => {
  const base = {
    workflow: okWorkflow(),
    runs: [] as RunManifest[],
    completedPhases: ["plan"],
    pendingPhases: ["implement", "review", "test", "commit"],
    awaitingReviewResponse: false,
  };

  it("treats unreadable workflow state as missing-state", () => {
    expect(deriveFleetMemberState({ ...base, workflow: { kind: "missing" } })).toBe(
      "missing-state",
    );
    expect(deriveFleetMemberState({ ...base, workflow: { kind: "corrupt" } })).toBe(
      "missing-state",
    );
  });

  it("prefers interrupted over every other signal", () => {
    expect(
      deriveFleetMemberState({
        ...base,
        runs: [sampleRun({ phase: "implement", status: RunStatus.Interrupted })],
        awaitingReviewResponse: true,
      }),
    ).toBe("interrupted");
  });

  it("reports awaiting-human for a pending review response or an undelivered user completion", () => {
    expect(deriveFleetMemberState({ ...base, awaitingReviewResponse: true })).toBe(
      "awaiting-human",
    );
    expect(
      deriveFleetMemberState({
        ...base,
        runs: [
          sampleRun({
            phase: "implement",
            status: RunStatus.Completed,
            completedBy: "user",
            completionReport: "done",
          }),
        ],
      }),
    ).toBe("awaiting-human");
  });

  it("reports blocked only when the newest run of a pending phase failed", () => {
    expect(
      deriveFleetMemberState({
        ...base,
        runs: [sampleRun({ phase: "implement", status: RunStatus.Failed })],
      }),
    ).toBe("blocked");
    // A failure for a phase that later completed is history, not a blocker.
    expect(
      deriveFleetMemberState({
        ...base,
        completedPhases: ["plan", "implement"],
        pendingPhases: ["review", "test", "commit"],
        runs: [sampleRun({ phase: "implement", status: RunStatus.Failed })],
      }),
    ).toBe("active");
  });

  it("reports idle when every phase completed and active otherwise", () => {
    expect(deriveFleetMemberState({ ...base, completedPhases: PHASES, pendingPhases: [] })).toBe(
      "idle",
    );
    expect(deriveFleetMemberState(base)).toBe("active");
  });

  it("prefers awaiting-human over a failed pending phase", () => {
    // An operator owes a review response; the failed run is not the dominant
    // signal, so the state must not decay to `blocked`.
    expect(
      deriveFleetMemberState({
        ...base,
        awaitingReviewResponse: true,
        runs: [sampleRun({ phase: "implement", status: RunStatus.Failed })],
      }),
    ).toBe("awaiting-human");
  });

  it("treats a delivered user completion as not awaiting a human", () => {
    expect(
      deriveFleetMemberState({
        ...base,
        runs: [
          sampleRun({
            phase: "plan",
            status: RunStatus.Completed,
            completedBy: "user",
            completionReport: "done",
            deliveredAt: 1_300,
          }),
        ],
      }),
    ).toBe("active");
  });

  it("treats a user completion without a report as not awaiting a human", () => {
    expect(
      deriveFleetMemberState({
        ...base,
        runs: [sampleRun({ phase: "plan", status: RunStatus.Completed, completedBy: "user" })],
      }),
    ).toBe("active");
  });
});

describe("buildFleetStatus", () => {
  it("returns an empty view for an empty fleet", () => {
    const status = buildFleetStatus({ fleetId: "fleet-1", intent: undefined, members: [] });

    expect(status.members).toEqual([]);
    expect(status.warnings).toEqual([]);
    expect(status.counts).toEqual({
      active: 0,
      blocked: 0,
      "awaiting-human": 0,
      interrupted: 0,
      idle: 0,
      "missing-state": 0,
    });
  });

  it("skips the main checkout until it holds workflow state", () => {
    const bare = buildFleetStatus({
      fleetId: "fleet-1",
      intent: undefined,
      members: [
        {
          worktreePath: "/repo",
          isMainWorktree: true,
          branch: "main",
          workflow: { kind: "missing" },
          runs: [],
          lease: { state: "absent" },
        },
      ],
    });
    expect(bare.members).toEqual([]);

    const inPlace = buildFleetStatus({
      fleetId: "fleet-1",
      intent: undefined,
      members: [sampleMember({ worktreePath: "/repo", isMainWorktree: true, branch: "main" })],
    });
    expect(inPlace.members).toHaveLength(1);
  });

  it("renders a stopped member with its stop reason and its live worktree", () => {
    const run = recordRunMemberStopped({
      run: startFleetRun({ now: 1_000, accept: true, members: [{ taskId: "bd-12" }] }),
      taskId: "bd-12",
      reason: "phase-failed",
      detail: "phase test failed: gate failed",
      now: 2_000,
    });
    const status = buildFleetStatus({
      fleetId: "fleet-1",
      intent: sampleIntent({ taskIds: ["bd-12", "bd-15"], run }),
      members: [sampleMember()],
    });

    const text = formatFleetStatus(status);
    // The stop is a report about the session, not a removal: the member is still
    // in the intent and still observed in its worktree.
    expect(text).toContain("intent: bd-12, bd-15");
    expect(text).toContain("stopped bd-12 (phase-failed): phase test failed: gate failed");
    expect(text).toContain("Member bd-12");
    expect(text).toContain("worktree: /repo.feat-bd-12");
  });

  it("renders persisted deferrals so a waiting member is never invisible (W3)", () => {
    const status = buildFleetStatus({
      fleetId: "fleet-1",
      intent: sampleIntent({
        deferred: [
          { taskId: "bd-19", reason: "capacity", detail: "all 3 slots taken" },
          { taskId: "bd-22", reason: "dependency", detail: "wave 1: waits for bd-19" },
        ],
      }),
      members: [sampleMember()],
    });

    const text = formatFleetStatus(status);
    expect(text).toContain("deferred: bd-19 (capacity), bd-22 (dependency)");
  });

  it("bounds the deferred summary instead of printing an unbounded list", () => {
    const deferred = Array.from({ length: 12 }, (_unused, index) => ({
      taskId: `bd-${100 + index}`,
      reason: "capacity" as const,
      detail: "no slot",
    }));
    const status = buildFleetStatus({
      fleetId: "fleet-1",
      intent: sampleIntent({ deferred }),
      members: [],
    });

    const text = formatFleetStatus(status);
    expect(text).toContain("bd-100 (capacity)");
    expect(text).toContain("and 4 more");
    expect(text).not.toContain("bd-111");
  });

  it("renders a parked fleet with its stash and the way out", () => {
    const status = buildFleetStatus({
      fleetId: "fleet-1",
      intent: sampleIntent({
        paused: true,
        note: "root restore conflicted",
        park: { reason: "root restore conflicted", stashRef: "abc123", recordedAt: 5 },
      }),
      members: [],
    });

    const text = formatFleetStatus(status);
    expect(text).toContain("paused");
    expect(text).toContain("parked: root restore conflicted (stash abc123)");
    expect(text).toContain("belayd_fleet_reconcile");
    expect(text).toContain("belayd_fleet_resume");
  });

  it("derives a healthy member mid-workflow", () => {
    const status = buildFleetStatus({
      fleetId: "fleet-1",
      intent: sampleIntent(),
      members: [sampleMember({ runs: [sampleRun()] })],
    });

    expect(status.intent).toHaveProperty("taskIds", ["bd-12", "bd-15"]);
    expect(status.members[0]).toHaveProperty("taskId", "bd-12");
    expect(status.members[0]).toHaveProperty("worktreePath", "/repo.feat-bd-12");
    expect(status.members[0]).toHaveProperty("branch", "feat/bd-12");
    expect(status.members[0]).toHaveProperty("workflowType", "feature");
    expect(status.members[0]).toHaveProperty("completedPhases", ["plan"]);
    expect(status.members[0]).toHaveProperty("pendingPhases", [
      "implement",
      "review",
      "test",
      "commit",
    ]);
    expect(status.members[0]).toHaveProperty("awaitingReviewResponse", false);
    expect(status.members[0]).toHaveProperty("interruptedRunCount", 0);
    expect(status.members[0]).toHaveProperty("updatedAt", 2_000);
    expect(status.members[0]).toHaveProperty("state", "active");
    expect(status.members[0]?.latestRuns).toEqual([
      {
        phase: "plan",
        runId: "run-1",
        status: RunStatus.Completed,
        startedAt: 1_100,
        completedAt: 1_200,
      },
    ]);
    expect(status.counts.active).toBe(1);
  });

  it("ignores run manifests inherited from the primary checkout (bd-161)", () => {
    const status = buildFleetStatus({
      fleetId: "fleet-1",
      intent: sampleIntent({
        taskIds: ["bd-12"],
        run: startFleetRun({ now: 1_000, accept: false, members: [{ taskId: "bd-12" }] }),
      }),
      members: [
        sampleMember({
          runs: [
            sampleRun({
              runId: "mthosemh",
              taskId: "bd-37",
              phase: "implement",
              sessionName: "belayd-bd-37-sub-implement-mthosemh",
              status: RunStatus.Failed,
              startedAt: 1_100,
            }),
          ],
        }),
      ],
    });

    // The run loop reads this worktree as `starting`; the read-only view must not
    // contradict it with another bead's failure.
    expect(status.members[0]).toHaveProperty("state", "active");
    expect(status.members[0]).toHaveProperty("interruptedRunCount", 0);
    expect(status.members[0]?.latestRuns).toEqual([]);
  });

  it("ignores this member's own manifests that predate its launch", () => {
    const status = buildFleetStatus({
      fleetId: "fleet-1",
      intent: sampleIntent({
        taskIds: ["bd-12"],
        run: startFleetRun({ now: 1_000, accept: false, members: [{ taskId: "bd-12" }] }),
      }),
      members: [
        sampleMember({
          runs: [
            sampleRun({ phase: "implement", status: RunStatus.Failed, startedAt: 900 }),
            sampleRun({ phase: "test", status: RunStatus.Interrupted, startedAt: 950 }),
          ],
        }),
      ],
    });

    // Same cutoff as the loop: a previous execution copied into this worktree is
    // not a stop verdict for the new one.
    expect(status.members[0]).toHaveProperty("state", "active");
    expect(status.members[0]).toHaveProperty("interruptedRunCount", 0);
    expect(status.members[0]?.latestRuns).toEqual([]);
  });

  it("does not attribute a same-task failure when the run records no launch", () => {
    const status = buildFleetStatus({
      fleetId: "fleet-1",
      intent: sampleIntent({
        taskIds: ["bd-12"],
        run: startFleetRun({ now: 1_000, accept: false, members: [] }),
      }),
      members: [
        sampleMember({
          runs: [sampleRun({ phase: "implement", status: RunStatus.Failed, startedAt: 1_100 })],
        }),
      ],
    });

    // A legacy run record with no member launch cannot prove the failure is this
    // execution's, so the view follows the loop's non-fatal reading.
    expect(status.members[0]).toHaveProperty("state", "active");
    expect(status.members[0]?.latestRuns).toEqual([]);
  });

  it("filters another task's interrupted run out of the interrupted count", () => {
    const status = buildFleetStatus({
      fleetId: "fleet-1",
      intent: sampleIntent({
        taskIds: ["bd-12"],
        run: startFleetRun({ now: 1_000, accept: false, members: [{ taskId: "bd-12" }] }),
      }),
      members: [
        sampleMember({
          runs: [
            sampleRun({
              taskId: "bd-37",
              phase: "implement",
              status: RunStatus.Interrupted,
              startedAt: 1_100,
            }),
          ],
        }),
      ],
    });

    // `interrupted` is the one run status that reorders the whole member list, so
    // an inherited crash must not promote this member to the top of the view.
    expect(status.members[0]).toHaveProperty("state", "active");
    expect(status.members[0]).toHaveProperty("interruptedRunCount", 0);
    expect(status.counts.interrupted).toBe(0);
  });

  it("keeps a live same-task run that predates the recorded launch", () => {
    const status = buildFleetStatus({
      fleetId: "fleet-1",
      intent: sampleIntent({
        taskIds: ["bd-12"],
        run: startFleetRun({ now: 1_000, accept: false, members: [{ taskId: "bd-12" }] }),
      }),
      members: [
        sampleMember({
          runs: [sampleRun({ phase: "implement", status: RunStatus.Running, startedAt: 900 })],
        }),
      ],
    });

    // The launch cutoff drops previous executions, never an execution still
    // running: dropping it would hide a live member from the view entirely.
    expect(status.members[0]?.latestRuns[0]).toHaveProperty("status", RunStatus.Running);
    expect(status.members[0]).toHaveProperty("state", "active");
  });

  it("keys the worktree by the branch's task id, not a stale workflow task id", () => {
    const status = buildFleetStatus({
      fleetId: "fleet-1",
      intent: sampleIntent({
        taskIds: ["bd-12"],
        run: startFleetRun({ now: 1_000, accept: false, members: [{ taskId: "bd-12" }] }),
      }),
      members: [
        sampleMember({
          // The worktree moved on to bd-12 but `.belayd/` still holds the previous
          // occupant's state; the branch is what the loop keys the member by.
          workflow: okWorkflow({ taskId: "bd-99" }),
          runs: [
            sampleRun({ taskId: "bd-12", phase: "implement", startedAt: 1_100 }),
            sampleRun({ taskId: "bd-99", phase: "test", startedAt: 1_200, runId: "stale" }),
          ],
        }),
      ],
    });

    expect(status.members[0]?.latestRuns.map((run) => run.runId)).toEqual(["run-1"]);
  });

  it("uses the workflow task id when the branch names no fleet member", () => {
    const status = buildFleetStatus({
      fleetId: "fleet-1",
      intent: sampleIntent({
        taskIds: ["bd-15"],
        run: startFleetRun({ now: 1_000, accept: false, members: [{ taskId: "bd-15" }] }),
      }),
      members: [
        sampleMember({
          branch: "feat/bd-12",
          workflow: okWorkflow({ taskId: "bd-99" }),
          runs: [sampleRun({ taskId: "bd-12", phase: "implement", startedAt: 1_100 })],
        }),
      ],
    });

    // bd-12 is not in the fleet here, so the view follows `workflow.json` — which
    // is also what keeps it from reporting runs the loop would not own.
    expect(status.members[0]?.latestRuns).toEqual([]);
  });

  it("reports runs as read when no task id can be derived", () => {
    const status = buildFleetStatus({
      fleetId: "fleet-1",
      intent: undefined,
      members: [
        sampleMember({
          worktreePath: "/repo.plain",
          branch: undefined,
          workflow: { kind: "missing" },
          runs: [sampleRun({ taskId: "bd-12", phase: "implement", startedAt: 1_100 })],
        }),
      ],
    });

    // Without a member id there is nothing to attribute the manifest to, so the
    // view stays file-truth instead of hiding every run behind a missing key.
    expect(status.members[0]?.latestRuns.map((run) => run.runId)).toEqual(["run-1"]);
  });

  it("reports only the workflow's own manifests out of a mixed set (bd-146)", () => {
    const status = buildFleetStatus({
      fleetId: "fleet-1",
      intent: undefined,
      members: [
        sampleMember({
          // A fresh worktree inherits another bead's manifests when they are
          // committed to git (bd-146: three bd-16 manifests were checked out
          // from main), and they must not become this member's evidence.
          runs: [
            sampleRun({ runId: "own-plan", taskId: "bd-12", phase: "plan", startedAt: 1_100 }),
            ...inheritedRuns(),
          ],
        }),
      ],
    });

    const member = status.members[0];
    expect(member?.latestRuns.map((run) => `${run.phase}=${run.status}`)).toEqual([
      "plan=completed",
    ]);
    // Pin the identity: `inheritedRuns` carries a newer `bd16-plan`, so a
    // phase-only filter would report a foreign run as this member's.
    expect(member?.latestRuns.map((run) => run.runId)).toEqual(["own-plan"]);
    // The foreign interrupted run is not this member's crash either.
    expect(member).toHaveProperty("interruptedRunCount", 0);
    // Nor does a foreign failure of a phase this member still owes make it
    // `blocked`.
    expect(member).toHaveProperty("state", "active");
    // Nor may a foreign run push `last updated` past this member's own evidence.
    expect(member).toHaveProperty("updatedAt", 2_000);
  });

  it("still counts its own interrupted run among another task's manifests (bd-146)", () => {
    const status = buildFleetStatus({
      fleetId: "fleet-1",
      intent: undefined,
      members: [
        sampleMember({
          runs: [
            sampleRun({
              runId: "own-implement",
              taskId: "bd-12",
              phase: "implement",
              status: RunStatus.Interrupted,
              startedAt: 1_300,
              completedAt: 1_400,
            }),
            ...inheritedRuns(),
          ],
        }),
      ],
    });

    const member = status.members[0];
    // The filter must not swallow this member's own evidence: a foreign crash is
    // ignored, its own still stops the member.
    expect(member?.latestRuns.map((run) => run.runId)).toEqual(["own-implement"]);
    expect(member).toHaveProperty("interruptedRunCount", 1);
    expect(member).toHaveProperty("state", "interrupted");
    // `updatedAt` takes the newer of the manifests and `workflow.json` (2_000).
    expect(member).toHaveProperty("updatedAt", 2_000);
    expect(status.counts.interrupted).toBe(1);
  });

  it("keeps its own completed final phase when the state file is gone (bd-146)", () => {
    const status = buildFleetStatus({
      fleetId: "fleet-1",
      intent: undefined,
      members: [
        sampleMember({
          workflow: { kind: "missing" },
          runs: [
            sampleRun({
              runId: "own-commit",
              taskId: "bd-12",
              phase: "commit",
              startedAt: 1_900,
              completedAt: 1_950,
            }),
            // Newer, and therefore the runs an unfiltered view would prefer.
            ...inheritedRuns(),
          ],
        }),
      ],
    });

    const member = status.members[0];
    // Completion clears `.belayd/workflow.json` while the manifests stay, so the
    // branch's task id is the only key that still attributes the final phase.
    expect(member).toHaveProperty("workflowFile", "missing");
    expect(member?.latestRuns.map((run) => `${run.phase}=${run.status}`)).toEqual([
      "commit=completed",
    ]);
    expect(member?.latestRuns.map((run) => run.runId)).toEqual(["own-commit"]);
    expect(member).toHaveProperty("updatedAt", 1_950);
    expect(member).toHaveProperty("state", "missing-state");
  });

  it("distinguishes a running run from an interrupted one", () => {
    const running = buildFleetStatus({
      fleetId: "fleet-1",
      intent: undefined,
      members: [
        sampleMember({
          runs: [sampleRun({ phase: "implement", status: RunStatus.Running, runId: "run-2" })],
        }),
      ],
    });
    expect(running.members[0]).toHaveProperty("state", "active");
    expect(running.members[0]?.latestRuns[0]).toHaveProperty("status", RunStatus.Running);

    const interrupted = buildFleetStatus({
      fleetId: "fleet-1",
      intent: undefined,
      members: [
        sampleMember({
          runs: [
            sampleRun({ phase: "implement", status: RunStatus.Interrupted, runId: "run-3" }),
            sampleRun({ phase: "test", status: RunStatus.Interrupted, runId: "run-4" }),
          ],
        }),
      ],
    });
    expect(interrupted.members[0]).toHaveProperty("state", "interrupted");
    expect(interrupted.members[0]).toHaveProperty("interruptedRunCount", 2);
    expect(interrupted.counts.interrupted).toBe(1);
  });

  it("keeps only the most recent run per phase, ordered by phase order", () => {
    const status = buildFleetStatus({
      fleetId: "fleet-1",
      intent: undefined,
      members: [
        sampleMember({
          runs: [
            sampleRun({ phase: "plan", runId: "plan-1", startedAt: 1_100 }),
            sampleRun({ phase: "implement", runId: "impl-1", startedAt: 1_500 }),
            sampleRun({
              phase: "plan",
              runId: "plan-2",
              status: RunStatus.Failed,
              startedAt: 1_600,
            }),
            sampleRun({ phase: "implement", runId: "impl-2", startedAt: 1_700 }),
          ],
        }),
      ],
    });

    expect(status.members[0]?.latestRuns.map((run) => run.runId)).toEqual(["plan-2", "impl-2"]);
  });

  it("surfaces missing and corrupt workflow.json as warnings, not a crash", () => {
    const status = buildFleetStatus({
      fleetId: "fleet-1",
      intent: undefined,
      members: [
        sampleMember({
          worktreePath: "/repo.feat-bd-19",
          branch: "feat/bd-19",
          workflow: { kind: "missing" },
        }),
        sampleMember({
          worktreePath: "/repo.feat-bd-15",
          branch: "feat/bd-15",
          workflow: { kind: "corrupt" },
        }),
      ],
    });

    expect(status.members).toHaveLength(2);
    expect(status.counts["missing-state"]).toBe(2);
    expect(status.warnings.map((warning) => warning.kind).sort()).toEqual([
      "corrupt-workflow-state",
      "missing-workflow-state",
    ]);
    // Members without a task id sort last, by worktree path.
    expect(status.members.map((member) => member.worktreePath)).toEqual([
      "/repo.feat-bd-15",
      "/repo.feat-bd-19",
    ]);
  });

  it("warns when two members claim the same task id", () => {
    const status = buildFleetStatus({
      fleetId: "fleet-1",
      intent: undefined,
      members: [
        sampleMember({ worktreePath: "/repo.feat-bd-12" }),
        sampleMember({ worktreePath: "/repo.dup-bd-12" }),
      ],
    });

    const duplicate = status.warnings.find((warning) => warning.kind === "duplicate-task-id");
    expect(duplicate).toHaveProperty("taskId", "bd-12");
    expect(duplicate?.message).toContain("/repo.dup-bd-12");
    expect(duplicate?.message).toContain("/repo.feat-bd-12");
  });

  it("warns when workflow.json disagrees with the branch or directory name", () => {
    const status = buildFleetStatus({
      fleetId: "fleet-1",
      intent: undefined,
      members: [
        sampleMember({
          worktreePath: "/repo.feat-bd-12",
          branch: "feat/bd-12",
          workflow: okWorkflow({ taskId: "bd-13" }),
        }),
      ],
    });

    const mismatch = status.warnings.find((warning) => warning.kind === "task-id-mismatch");
    expect(mismatch).toHaveProperty("taskId", "bd-13");
    expect(mismatch?.message).toContain("bd-12");
  });

  it("derives the expected task id from the directory when the branch is detached", () => {
    const status = buildFleetStatus({
      fleetId: "fleet-1",
      intent: undefined,
      members: [
        sampleMember({
          worktreePath: "/repo.feat-bd-12",
          branch: undefined,
          workflow: okWorkflow({ taskId: "bd-13" }),
        }),
      ],
    });

    expect(status.members[0]).toHaveProperty("expectedTaskId", "bd-12");
    expect(status.warnings.map((warning) => warning.kind)).toEqual(["task-id-mismatch"]);
  });

  it("orders members by task id deterministically regardless of input order", () => {
    const bd19 = sampleMember({
      worktreePath: "/repo.feat-bd-19",
      branch: "feat/bd-19",
      workflow: okWorkflow({ taskId: "bd-19" }),
    });
    const bd12 = sampleMember();
    const noState = sampleMember({
      worktreePath: "/repo.feat-bd-nope",
      branch: "feat/nope",
      workflow: { kind: "missing" },
    });

    const forward = buildFleetStatus({
      fleetId: "fleet-1",
      intent: undefined,
      members: [bd19, bd12, noState],
    });
    const reverse = buildFleetStatus({
      fleetId: "fleet-1",
      intent: undefined,
      members: [noState, bd12, bd19],
    });

    expect(forward.members.map((member) => member.taskId ?? "(none)")).toEqual([
      "bd-12",
      "bd-19",
      "(none)",
    ]);
    expect(formatFleetStatus(forward)).toBe(formatFleetStatus(reverse));
  });

  it("breaks equal startedAt ties by runId, independent of input order", () => {
    // `listRuns` orders equal timestamps by readdirSync, so the same manifest
    // set can arrive in either order; the winner must not depend on that.
    const failed = sampleRun({
      phase: "implement",
      runId: "run-a",
      status: RunStatus.Failed,
      startedAt: 1_500,
      completedAt: 1_500,
    });
    const completed = sampleRun({
      phase: "implement",
      runId: "run-b",
      status: RunStatus.Completed,
      startedAt: 1_500,
      completedAt: 1_600,
    });

    const forward = buildFleetStatus({
      fleetId: "fleet-1",
      intent: undefined,
      members: [sampleMember({ runs: [failed, completed] })],
    });
    const reverse = buildFleetStatus({
      fleetId: "fleet-1",
      intent: undefined,
      members: [sampleMember({ runs: [completed, failed] })],
    });

    expect(forward.members[0]?.latestRuns[0]).toHaveProperty("runId", "run-b");
    expect(reverse.members[0]?.latestRuns[0]).toHaveProperty("runId", "run-b");
    expect(forward.members[0]).toHaveProperty("state", "active");
    expect(reverse.members[0]).toHaveProperty("state", "active");
  });

  it("aligns the directory task-id pattern with taskIdFromBranch", () => {
    const subBead = buildFleetStatus({
      fleetId: "fleet-1",
      intent: undefined,
      members: [
        sampleMember({
          worktreePath: "/repo.feat-bd-12.3",
          branch: "feat/bd-12.3",
          workflow: okWorkflow({ taskId: "bd-12.3" }),
        }),
      ],
    });
    expect(subBead.members[0]).toHaveProperty("expectedTaskId", "bd-12.3");
    expect(subBead.warnings).toEqual([]);

    // `taskIdFromBranch` does not accept a second dot segment either, so neither
    // source claims an id and no mismatch is invented for the same worktree.
    const deep = buildFleetStatus({
      fleetId: "fleet-1",
      intent: undefined,
      members: [
        sampleMember({
          worktreePath: "/repo.feat-bd-12.3.4",
          branch: "feat/bd-12.3.4",
          workflow: okWorkflow({ taskId: "bd-12.3.4" }),
        }),
      ],
    });
    expect(deep.members[0]).toHaveProperty("expectedTaskId", undefined);
    expect(deep.warnings).toEqual([]);
  });

  it("orders by code unit, not by host locale", () => {
    // `localeCompare` sorts lowercase before uppercase in en-US; code-unit order
    // puts "BD-12" first. Pinning the latter keeps output locale-independent.
    const upper = sampleMember({
      worktreePath: "/repo.BD-12",
      branch: "feat/bd-12",
      workflow: okWorkflow({ taskId: "BD-12" }),
    });
    const lower = sampleMember();

    const status = buildFleetStatus({
      fleetId: "fleet-1",
      intent: undefined,
      members: [lower, upper],
    });

    expect(status.members.map((member) => member.taskId)).toEqual(["BD-12", "bd-12"]);
    const rendered = formatFleetStatus(status);
    expect(rendered.indexOf("Member BD-12")).toBeLessThan(rendered.indexOf("Member bd-12"));
  });

  it("orders paths and unknown phases by code unit, where localeCompare diverges", () => {
    // ICU/en-US sorts "a" before "B" and "a" before "Z"; code-unit order
    // reverses both. `localeCompare` here would flip the view per host locale.
    const status = buildFleetStatus({
      fleetId: "fleet-1",
      intent: undefined,
      members: [
        sampleMember({
          worktreePath: "/repo.a-bd-12",
          runs: [
            sampleRun({ phase: "a-extra", runId: "a-extra-1", startedAt: 1_100 }),
            sampleRun({ phase: "Z-extra", runId: "Z-extra-1", startedAt: 1_100 }),
          ],
        }),
        sampleMember({ worktreePath: "/repo.B-bd-12" }),
      ],
    });

    expect(status.members.map((member) => member.worktreePath)).toEqual([
      "/repo.B-bd-12",
      "/repo.a-bd-12",
    ]);
    expect(status.members[1]?.latestRuns.map((run) => run.phase)).toEqual(["Z-extra", "a-extra"]);
    const duplicate = status.warnings.find((warning) => warning.kind === "duplicate-task-id");
    expect(duplicate?.message).toContain("/repo.B-bd-12, /repo.a-bd-12");
  });

  it("raises updatedAt to the newest run timestamp when that is later than workflow.json", () => {
    const status = buildFleetStatus({
      fleetId: "fleet-1",
      intent: undefined,
      members: [
        sampleMember({
          runs: [sampleRun({ startedAt: 4_000, completedAt: 4_100 })],
        }),
      ],
    });

    // workflow.json says 2_000; the run is newer, so the view reports the run.
    expect(status.members[0]).toHaveProperty("updatedAt", 4_100);
  });

  it("falls back to the run start for an unfinished run", () => {
    const status = buildFleetStatus({
      fleetId: "fleet-1",
      intent: undefined,
      members: [
        sampleMember({
          runs: [
            sampleRun({
              phase: "implement",
              status: RunStatus.Running,
              startedAt: 5_000,
              completedAt: undefined,
            }),
          ],
        }),
      ],
    });

    expect(status.members[0]).toHaveProperty("updatedAt", 5_000);
  });

  it("keeps the main checkout when its workflow.json is corrupt, not just when it is missing", () => {
    // Only a *state-less* main checkout is the supervisor's merge target; a
    // corrupt file means it meant to be a member.
    const status = buildFleetStatus({
      fleetId: "fleet-1",
      intent: undefined,
      members: [
        {
          worktreePath: "/repo",
          isMainWorktree: true,
          branch: "main",
          workflow: { kind: "corrupt" },
          runs: [],
          lease: { state: "absent" },
        },
      ],
    });

    expect(status.members).toHaveLength(1);
    expect(status.members[0]).toHaveProperty("state", "missing-state");
    expect(status.warnings.map((warning) => warning.kind)).toEqual(["corrupt-workflow-state"]);
  });

  it("orders an unknown phase after every known phase, by code unit", () => {
    const status = buildFleetStatus({
      fleetId: "fleet-1",
      intent: undefined,
      members: [
        sampleMember({
          runs: [
            sampleRun({ phase: "zz-sideways", runId: "zz-1", startedAt: 1_100 }),
            sampleRun({ phase: "plan", runId: "plan-1", startedAt: 1_100 }),
            sampleRun({ phase: "aa-sideways", runId: "aa-1", startedAt: 1_100 }),
          ],
        }),
      ],
    });

    expect(status.members[0]?.latestRuns.map((run) => run.phase)).toEqual([
      "plan",
      "aa-sideways",
      "zz-sideways",
    ]);
  });

  it("lists every worktree claiming a duplicated task id, in code-unit order", () => {
    const status = buildFleetStatus({
      fleetId: "fleet-1",
      intent: undefined,
      members: [
        sampleMember({ worktreePath: "/repo.c-bd-12" }),
        sampleMember({ worktreePath: "/repo.a-bd-12" }),
        sampleMember({ worktreePath: "/repo.b-bd-12" }),
      ],
    });

    const duplicates = status.warnings.filter((warning) => warning.kind === "duplicate-task-id");
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]).toHaveProperty("taskId", "bd-12");
    expect(duplicates[0]?.message).toContain("3 worktrees");
    expect(duplicates[0]?.message).toContain("/repo.a-bd-12, /repo.b-bd-12, /repo.c-bd-12");
  });

  it("keeps the warning list stable across member input permutations", () => {
    const mismatched = sampleMember({
      worktreePath: "/repo.feat-bd-13",
      branch: "feat/bd-13",
      workflow: okWorkflow({ taskId: "bd-99" }),
    });
    const duplicateA = sampleMember({ worktreePath: "/repo.feat-bd-12" });
    const duplicateB = sampleMember({ worktreePath: "/repo.dup-bd-12" });
    const stateless = sampleMember({
      worktreePath: "/repo.feat-bd-30",
      branch: "feat/bd-30",
      workflow: { kind: "missing" },
    });
    const corrupt = sampleMember({
      worktreePath: "/repo.feat-bd-31",
      branch: "feat/bd-31",
      workflow: { kind: "corrupt" },
    });
    const members = [stateless, duplicateB, corrupt, duplicateA, mismatched];
    const worktreeWarnings = [
      { kind: "unparsed-worktree-path" as const, message: "skipped entry" },
    ];

    const forward = buildFleetStatus({
      fleetId: "fleet-1",
      intent: undefined,
      members,
      worktreeWarnings,
    });
    const reverse = buildFleetStatus({
      fleetId: "fleet-1",
      intent: undefined,
      members: [...members].reverse(),
      worktreeWarnings,
    });

    expect(forward.warnings.map((warning) => warning.kind)).toEqual([
      "unparsed-worktree-path",
      "task-id-mismatch",
      "missing-workflow-state",
      "corrupt-workflow-state",
      "duplicate-task-id",
    ]);
    expect(reverse.warnings).toEqual(forward.warnings);
  });
});

describe("formatFleetStatus", () => {
  it("renders an empty fleet", () => {
    const status = buildFleetStatus({ fleetId: "fleet-1", intent: undefined, members: [] });

    expect(formatFleetStatus(status)).toBe(
      [
        "Fleet fleet-1",
        "  intent: none recorded",
        "  members: 0",
        `  states: ${FLEET_MEMBER_STATES.map((state) => `${state}=0`).join(" ")}`,
        "",
        "No fleet members: no worktree holds Belayd workflow state.",
      ].join("\n"),
    );
  });

  it("lists the ordering gates bd still blocks on, so a wedge is visible", () => {
    // C4: a landing that merged but could not resolve its gate leaves the record.
    // Before this line the only way to see the wedge was `bd gate list` or the docs.
    const status = buildFleetStatus({
      fleetId: "fleet-1",
      intent: sampleIntent({
        orderingGates: [
          { blocker: "bd-12", blocked: "bd-15", gateId: "bd-901" },
          { blocker: "bd-12", blocked: "bd-16", gateId: "bd-902" },
        ],
      }),
      members: [],
    });

    const text = formatFleetStatus(status);
    expect(text).toContain(
      "ordering gates open: bd-12 -> bd-15 (gate bd-901), bd-12 -> bd-16 (gate bd-902)",
    );

    // No records means no line at all: a healthy fleet's header does not grow.
    const without = formatFleetStatus(
      buildFleetStatus({ fleetId: "fleet-1", intent: sampleIntent({}), members: [] }),
    );
    expect(without).not.toContain("ordering gates");
  });

  it("renders one member stably", () => {
    const status = buildFleetStatus({
      fleetId: "fleet-1",
      intent: sampleIntent({ maxConcurrent: 3 }),
      members: [sampleMember()],
    });

    expect(formatFleetStatus(status)).toBe(
      [
        "Fleet fleet-1",
        "  intent: bd-12, bd-15, max 3 concurrent",
        "  members: 1",
        "  states: active=1 blocked=0 awaiting-human=0 interrupted=0 idle=0 missing-state=0",
        "",
        "Member bd-12 — active",
        "  worktree: /repo.feat-bd-12 (branch feat/bd-12)",
        "  workflow: feature 1/5 phases complete",
        "  pending: implement, review, test, commit",
        "  awaiting review response: no",
        "  interrupted runs: 0",
        "  orchestrator lease: none",
        "  last updated: 1970-01-01T00:00:02.000Z",
        "  latest runs: none",
      ].join("\n"),
    );
  });

  it("renders warnings after the member list", () => {
    const status = buildFleetStatus({
      fleetId: "fleet-1",
      intent: undefined,
      members: [sampleMember({ workflow: { kind: "missing" } })],
    });

    expect(formatFleetStatus(status)).toContain("Warnings (1):");
    expect(formatFleetStatus(status)).toContain("no .belayd/workflow.json");
  });

  it("renders a detached member with unreadable workflow state", () => {
    const status = buildFleetStatus({
      fleetId: "fleet-1",
      intent: undefined,
      members: [
        sampleMember({
          worktreePath: "/repo.feat-bd-12",
          branch: undefined,
          workflow: { kind: "corrupt" },
        }),
      ],
    });

    const rendered = formatFleetStatus(status);
    expect(rendered).toContain("Member (no task id) — missing-state");
    expect(rendered).toContain("branch detached HEAD");
    expect(rendered).toContain("workflow: corrupt");
    expect(rendered).toContain("last updated: unknown");
    expect(rendered).toContain("latest runs: none");
  });

  it("emits no ANSI escape sequences and is byte-stable across calls", () => {
    const status = buildFleetStatus({
      fleetId: "fleet-1",
      intent: sampleIntent({ paused: true }),
      members: [
        sampleMember({ runs: [sampleRun({ phase: "implement", status: RunStatus.Failed })] }),
        sampleMember({
          worktreePath: "/repo.feat-bd-19",
          branch: "feat/bd-19",
          workflow: { kind: "missing" },
        }),
      ],
      worktreeWarnings: [{ kind: "unparsed-worktree-path", message: "skipped entry" }],
    });

    const first = formatFleetStatus(status);
    const second = formatFleetStatus(status);

    expect(first).toBe(second);
    expect(first).not.toContain("\u001b");
    expect(first).toContain("bd-12, bd-15, paused");
    expect(first).toContain("  - skipped entry");
  });
});

describe("bead metadata (read-only bd enrichment)", () => {
  function statusOf(members: readonly FleetMemberSnapshot[]) {
    return buildFleetStatus({ fleetId: "fleet-1", intent: undefined, members });
  }

  it("parses a bead record and tolerates absent or renamed fields", () => {
    expect(
      parseBeadView({
        id: "bd-12",
        title: "Fix login",
        status: "open",
        priority: 1,
        labels: ["fleet"],
        description: "ignored, stripped by the schema",
      }),
    ).toEqual({
      id: "bd-12",
      title: "Fix login",
      status: "open",
      priority: 1,
      labels: ["fleet"],
    });

    const bare = parseBeadView({ id: "bd-12" });
    expect(bare).toHaveProperty("title", undefined);
    expect(bare).toHaveProperty("status", undefined);
    expect(bare).toHaveProperty("priority", undefined);
    expect(bare).toHaveProperty("labels", []);

    // A renamed or re-typed field costs that field, never the whole record.
    const renamed = parseBeadView({
      id: "bd-12",
      name: "renamed title",
      status: 7,
      priority: "high",
      labels: "fleet",
    });
    expect(renamed).toHaveProperty("id", "bd-12");
    expect(renamed).toHaveProperty("title", undefined);
    expect(renamed).toHaveProperty("status", undefined);
    expect(renamed).toHaveProperty("priority", undefined);
    expect(renamed).toHaveProperty("labels", []);

    expect(parseBeadView({ title: "no id" })).toBe(undefined);
    expect(parseBeadView({ id: "" })).toBe(undefined);
    expect(parseBeadView("not an object")).toBe(undefined);
    expect(parseBeadView(null)).toBe(undefined);
  });

  it("parses the batched show payload and survives garbage", () => {
    const records = [
      { id: "bd-12", title: "Fix login", status: "open", priority: 1, labels: [] },
      { id: "bd-15", title: "Add fleet", status: "in_progress", priority: 2, labels: ["fleet"] },
    ];
    expect(parseBeadViews(records).map((bead) => bead.id)).toEqual(["bd-12", "bd-15"]);
    // Older bd versions answer one id with a bare object.
    expect(parseBeadViews(records[0]).map((bead) => bead.id)).toEqual(["bd-12"]);
    // bd's "no issues found" error object carries no id ⇒ no beads, no throw.
    expect(parseBeadViews({ error: "no issues found", schema_version: 1 })).toEqual([]);
    expect(parseBeadViews([null, 7, "x", { id: "bd-12" }]).map((bead) => bead.id)).toEqual([
      "bd-12",
    ]);
    expect(parseBeadViews(undefined)).toEqual([]);
  });

  it("requests one lookup for valid, unique task ids only", () => {
    const status = statusOf([
      sampleMember({ worktreePath: "/repo.feat-bd-15", workflow: okWorkflow({ taskId: "bd-15" }) }),
      sampleMember(),
      sampleMember({ worktreePath: "/repo.dup", workflow: okWorkflow({ taskId: "bd-12" }) }),
      // Not a task id shape: it must never reach bd argv (a leading `-` would be a flag).
      sampleMember({ worktreePath: "/repo.flag", workflow: okWorkflow({ taskId: "--json" }) }),
      sampleMember({ worktreePath: "/repo.none", workflow: { kind: "missing" } }),
    ]);

    expect(fleetBeadTaskIds(status)).toEqual(["bd-12", "bd-15"]);
    for (const taskId of fleetBeadTaskIds(status)) expect(isValidTaskId(taskId)).toBe(true);
    expect(fleetBeadTaskIds(statusOf([]))).toEqual([]);
  });

  it("attaches metadata by task id, case-insensitively, without reordering members", () => {
    const status = statusOf([
      sampleMember(),
      sampleMember({ worktreePath: "/repo.feat-bd-15", workflow: okWorkflow({ taskId: "bd-15" }) }),
    ]);

    const enriched = applyFleetBeadLookup(status, {
      ok: true,
      beads: [{ id: "BD-12", title: "Fix login", status: "open", priority: 1, labels: [] }],
    });

    expect(enriched.members.map((member) => member.taskId)).toEqual(["bd-12", "bd-15"]);
    expect(enriched.members[0]?.bead).toHaveProperty("title", "Fix login");
    expect(enriched.members[1]?.bead).toBe(undefined);
    // bd answered one of the two ids: exactly one bounded warning names the gap.
    expect(enriched.warnings).toHaveLength(status.warnings.length + 1);
    expect(enriched.warnings.at(-1)).toHaveProperty("kind", "bead-metadata-missing");
    expect(enriched.warnings.at(-1)?.message).toContain("bd-15");
    expect(enriched.warnings.at(-1)?.message).toContain("1 of 2");
    expect(formatFleetStatus(enriched)).toContain("  bead: Fix login (open)");
  });

  it("renders an unknown bead status and title without crashing", () => {
    const enriched = applyFleetBeadLookup(statusOf([sampleMember()]), {
      ok: true,
      beads: [
        { id: "bd-12", title: undefined, status: undefined, priority: undefined, labels: [] },
      ],
    });

    expect(formatFleetStatus(enriched)).toContain("  bead: (no title) (status unknown)");
  });

  it("degrades to no bead metadata with exactly one fleet-level warning", () => {
    const status = statusOf([
      sampleMember(),
      sampleMember({
        worktreePath: "/repo.feat-bd-15",
        branch: "feat/bd-15",
        workflow: okWorkflow({ taskId: "bd-15", branch: "feat/bd-15" }),
      }),
    ]);

    const degraded = applyFleetBeadLookup(status, { ok: false, error: "no beads database found" });

    expect(degraded.members.map((member) => member.bead)).toEqual([undefined, undefined]);
    expect(degraded.warnings).toHaveLength(1);
    expect(degraded.warnings[0]).toHaveProperty("kind", "bead-metadata-unavailable");
    expect(degraded.warnings[0]?.message).toContain("no beads database found");
    // one warning for the fleet, never one per member
    expect(formatFleetStatus(degraded)).toContain("Warnings (1):");
  });

  it("bounds a runaway bd error message into one line", () => {
    const degraded = applyFleetBeadLookup(statusOf([sampleMember()]), {
      ok: false,
      error: `${"x".repeat(10_000)}\nsecond line`,
    });

    const message = degraded.warnings[0]?.message ?? "";
    expect(message.length).toBeLessThan(400);
    expect(message).not.toContain("\n");
    expect(message).toContain("…");
  });

  it("warns once when a successful lookup matches none of the expected ids", () => {
    const status = statusOf([sampleMember()]);
    // bd wrapping its records in an envelope flattens to no beads; silence here
    // would make that shape drift invisible in the fleet view.
    const unchanged = applyFleetBeadLookup(status, { ok: true, beads: [] });

    expect(unchanged.members[0]?.bead).toBe(undefined);
    expect(unchanged.warnings).toHaveLength(1);
    expect(unchanged.warnings[0]).toHaveProperty("kind", "bead-metadata-missing");
    expect(unchanged.warnings[0]?.message).toContain("1 of 1");
    expect(formatFleetStatus(unchanged)).not.toContain("  bead: ");
    expect(formatFleetStatus(unchanged)).toContain("bd returned no record");
  });

  it("bounds the missing-id warning and stays quiet when every id matched", () => {
    const status = statusOf([
      sampleMember(),
      ...Array.from({ length: 12 }, (_, index) =>
        sampleMember({
          worktreePath: `/repo.feat-bd-${100 + index}`,
          workflow: okWorkflow({ taskId: `bd-${100 + index}`, branch: `feat/bd-${100 + index}` }),
        }),
      ),
    ]);

    const missing = applyFleetBeadLookup(status, { ok: true, beads: [] });
    const message = missing.warnings.at(-1)?.message ?? "";
    expect(message).toContain("13 of 13");
    expect(message).toContain("+8 more");
    expect(message.length).toBeLessThan(400);

    const allMatched = applyFleetBeadLookup(statusOf([sampleMember()]), {
      ok: true,
      beads: [
        { id: "bd-12", title: undefined, status: undefined, priority: undefined, labels: [] },
      ],
    });
    expect(allMatched.warnings).toEqual([]);
  });
});

describe("readFleetStatus", () => {
  const commonDir = "/repo/.git";
  const cwd = "/repo";
  const fleetId = "fleet-1";

  function readWith(fs: FleetStatusFs) {
    return readFleetStatus({
      cwd,
      fleetId,
      fs,
      resolveCommonDir: () => ({ ok: true, commonDir }),
      listWorktrees: () => ({ ok: true, entries: worktreeEntries, warnings: [] }),
    });
  }

  it("returns an empty view when no fleet directory or workflow state exists", () => {
    const fs = createFakeFs();
    const result = readFleetStatus({
      cwd,
      fleetId,
      fs,
      resolveCommonDir: () => ({ ok: true, commonDir }),
      listWorktrees: () => ({ ok: true, entries: [], warnings: [] }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.members).toEqual([]);
    expect(result.value.warnings).toEqual([]);
    expect(formatFleetStatus(result.value)).toContain("No fleet members");
  });

  it("reads intent, workflow state, and run manifests from the seam", () => {
    const fs = createFakeFs({
      [fleetIntentFilePath(commonDir, fleetId)]: JSON.stringify(sampleIntent()),
      [workflowStateFilePath("/repo.feat-bd-12")]: JSON.stringify(sampleWorkflow()),
      [runManifestPath("/repo.feat-bd-12", "run-1")]: JSON.stringify(sampleRun()),
    });

    const result = readWith(fs);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.intent).toHaveProperty("taskIds", ["bd-12", "bd-15"]);
    expect(result.value.members).toHaveLength(1);
    expect(result.value.members[0]).toHaveProperty("taskId", "bd-12");
    expect(result.value.members[0]?.latestRuns[0]).toHaveProperty("status", RunStatus.Completed);
    expect(result.value.warnings).toEqual([]);
  });

  it("reads a fresh worktree's committed manifests without adopting another task's (bd-146)", () => {
    // The consumer repository commits `.belayd/runs`, so a worktree created
    // minutes ago checks out manifests for beads it has never touched.
    const fs = createFakeFs({
      [workflowStateFilePath("/repo.feat-bd-12")]: JSON.stringify(sampleWorkflow()),
      [runManifestPath("/repo.feat-bd-12", "own-plan")]: JSON.stringify(
        sampleRun({ runId: "own-plan", taskId: "bd-12", phase: "plan", startedAt: 1_100 }),
      ),
      ...Object.fromEntries(
        inheritedRuns().map((run) => [
          runManifestPath("/repo.feat-bd-12", run.runId),
          JSON.stringify(run),
        ]),
      ),
    });

    const result = readWith(fs);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.members[0]?.latestRuns.map((run) => run.runId)).toEqual(["own-plan"]);
    expect(result.value.members[0]).toHaveProperty("interruptedRunCount", 0);
    expect(formatFleetStatus(result.value)).toContain("latest runs: plan=completed");
  });

  it("reads a member whose worktree path contains a newline", () => {
    const newlinePath = "/repo.feat-bd-12\nline2";
    const parsed = parseWorktreeListPorcelainZ(
      [`worktree ${newlinePath}`, "HEAD 1111111", "branch refs/heads/feat/bd-12", "", ""].join(
        "\0",
      ),
    );
    const fs = createFakeFs({
      [workflowStateFilePath(newlinePath)]: JSON.stringify(sampleWorkflow()),
      [runManifestPath(newlinePath, "run-1")]: JSON.stringify(sampleRun()),
    });

    const result = readFleetStatus({
      cwd,
      fleetId,
      fs,
      resolveCommonDir: () => ({ ok: true, commonDir }),
      listWorktrees: () => ({ ok: true, entries: parsed.entries, warnings: parsed.warnings }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.members).toHaveLength(1);
    expect(result.value.members[0]).toHaveProperty("worktreePath", newlinePath);
    expect(result.value.members[0]).toHaveProperty("workflowFile", "ok");
    expect(result.value.members[0]).toHaveProperty("state", "active");
    expect(result.value.warnings).toEqual([]);
  });

  it("surfaces worktree-enumeration warnings from the reader seam", () => {
    const result = readFleetStatus({
      cwd,
      fleetId,
      fs: createFakeFs(),
      resolveCommonDir: () => ({ ok: true, commonDir }),
      listWorktrees: () => ({ ok: true, entries: [], warnings: ["worktree entry was skipped"] }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.warnings).toEqual([
      { kind: "unparsed-worktree-path", message: "worktree entry was skipped" },
    ]);
    expect(formatFleetStatus(result.value)).toContain("worktree entry was skipped");
  });

  it("treats a corrupt intent file as absent and warns about unreadable workflow state", () => {
    const fs = createFakeFs({
      [fleetIntentFilePath(commonDir, fleetId)]: "not json",
      [workflowStateFilePath("/repo.feat-bd-12")]: "{ truncated",
    });

    const result = readWith(fs);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.intent).toBe(undefined);
    expect(result.value.members[0]).toHaveProperty("state", "missing-state");
    expect(result.value.warnings.map((warning) => warning.kind)).toEqual([
      "corrupt-workflow-state",
    ]);
  });

  it("returns an error value when the git-common-dir probe fails", () => {
    const result = readFleetStatus({
      cwd,
      fleetId,
      fs: createFakeFs(),
      resolveCommonDir: () => ({ ok: false, error: "git rev-parse --git-common-dir failed" }),
      listWorktrees: () => ({ ok: true, entries: [], warnings: [] }),
    });

    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.error).toContain("git-common-dir failed");
  });

  it("returns an error value when worktree enumeration fails", () => {
    const result = readFleetStatus({
      cwd,
      fleetId,
      fs: createFakeFs(),
      resolveCommonDir: () => ({ ok: true, commonDir }),
      listWorktrees: () => ({ ok: false, error: "git worktree list failed" }),
    });

    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.error).toContain("git worktree list failed");
  });

  it("derives the same view when readdirSync returns run entries in another order", () => {
    // `listRuns` orders equal timestamps by readdirSync, so a tie on startedAt
    // must settle on runId, not on directory order.
    const failedRun = sampleRun({
      phase: "implement",
      runId: "run-a",
      status: RunStatus.Failed,
      startedAt: 1_500,
      completedAt: 1_500,
    });
    const completedRun = sampleRun({
      phase: "implement",
      runId: "run-b",
      status: RunStatus.Completed,
      startedAt: 1_500,
      completedAt: 1_600,
    });
    const files = {
      [workflowStateFilePath("/repo.feat-bd-12")]: JSON.stringify(sampleWorkflow()),
      [runManifestPath("/repo.feat-bd-12", "run-a")]: JSON.stringify(failedRun),
      [runManifestPath("/repo.feat-bd-12", "run-b")]: JSON.stringify(completedRun),
    };

    const forwardFs = createFakeFs(files);
    const reverseFs = createFakeFs(files);
    reverseFs.readdirSync = (path) => [...createFakeFs(files).readdirSync(path)].reverse();

    const forward = readWith(forwardFs);
    const reverse = readWith(reverseFs);

    expect(forward.ok).toBe(true);
    expect(reverse.ok).toBe(true);
    if (!forward.ok || !reverse.ok) return;
    expect(reverse.value).toEqual(forward.value);
    expect(forward.value.members[0]?.latestRuns[0]).toHaveProperty("runId", "run-b");
    expect(forward.value.members[0]).toHaveProperty("state", "active");
  });

  it.each([
    ["../evil", ".._evil"],
    [".", DEFAULT_FLEET_ID],
    ["..", DEFAULT_FLEET_ID],
    ["", DEFAULT_FLEET_ID],
  ])("renders the sanitized id that located the files for %j", (requested, expected) => {
    const fs = createFakeFs({
      [fleetIntentFilePath(commonDir, expected)]: JSON.stringify(
        sampleIntent({ fleetId: expected }),
      ),
    });
    const result = readFleetStatus({
      cwd,
      fleetId: requested,
      fs,
      resolveCommonDir: () => ({ ok: true, commonDir }),
      listWorktrees: () => ({ ok: true, entries: [], warnings: [] }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fleetId).toBe(expected);
    expect(result.value.intent).toHaveProperty("fleetId", expected);
    expect(result.value.requestedFleetId).toBe(requested === expected ? undefined : requested);

    const rendered = formatFleetStatus(result.value);
    expect(rendered.startsWith(`Fleet ${expected}`)).toBe(true);
    if (requested === expected) return;
    expect(rendered).not.toContain(`Fleet ${requested}\n`);
    expect(rendered).toContain(`(requested "${requested}")`);
  });
});

describe("read-only contract", () => {
  const commonDir = "/repo/.git";
  const cwd = "/repo";

  interface CountingFs extends FleetStatusFs {
    files: Map<string, string>;
    writes: string[];
    reads: string[];
  }

  /** Fake fs that records every write-shaped call so the test can assert none happen. */
  function countingFs(initial: Record<string, string> = {}): CountingFs {
    const inner = createFakeFs(initial);
    const writes: string[] = [];
    const reads: string[] = [];
    return {
      files: inner.files,
      writes,
      reads,
      existsSync: (path) => {
        reads.push(`existsSync ${path}`);
        return inner.existsSync(path);
      },
      readFileSync: (path) => {
        reads.push(`readFileSync ${path}`);
        return inner.readFileSync(path);
      },
      readdirSync: (path) => {
        reads.push(`readdirSync ${path}`);
        return inner.readdirSync(path);
      },
      // Write APIs exist on the seam but must never be reached by the reader.
      writeFileSync: (path) => {
        writes.push(`writeFileSync ${path}`);
      },
      renameSync: (oldPath, newPath) => {
        writes.push(`renameSync ${oldPath} -> ${newPath}`);
      },
      mkdirSync: (path) => {
        writes.push(`mkdirSync ${path}`);
      },
      unlinkSync: (path) => {
        writes.push(`unlinkSync ${path}`);
      },
    };
  }

  function readCounting(fs: CountingFs) {
    return readFleetStatus({
      cwd,
      fleetId: "fleet-1",
      fs,
      resolveCommonDir: () => ({ ok: true, commonDir }),
      listWorktrees: () => ({ ok: true, entries: worktreeEntries, warnings: [] }),
    });
  }

  it("issues no write, rename, mkdir, or unlink for a populated fleet", () => {
    const fs = countingFs({
      [fleetIntentFilePath(commonDir, "fleet-1")]: JSON.stringify(sampleIntent()),
      [workflowStateFilePath("/repo.feat-bd-12")]: JSON.stringify(sampleWorkflow()),
      [runManifestPath("/repo.feat-bd-12", "run-1")]: JSON.stringify(sampleRun()),
    });

    const result = readCounting(fs);

    expect(result.ok).toBe(true);
    expect(fs.reads.length).toBeGreaterThan(0);
    expect(fs.writes).toEqual([]);
  });

  it("never creates the absent intent file or any fleet directory", () => {
    const fs = countingFs({
      [workflowStateFilePath("/repo.feat-bd-12")]: JSON.stringify(sampleWorkflow()),
    });
    const before = [...fs.files.keys()].sort();

    const result = readCounting(fs);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.intent).toBe(undefined);
    expect(fs.writes).toEqual([]);
    expect([...fs.files.keys()].sort()).toEqual(before);
  });

  it("never rewrites corrupt workflow state or a corrupt intent file", () => {
    const fs = countingFs({
      [fleetIntentFilePath(commonDir, "fleet-1")]: "not json",
      [workflowStateFilePath("/repo")]: "not json",
      [workflowStateFilePath("/repo.feat-bd-12")]: "{ truncated",
    });
    const before = new Map(fs.files);

    const result = readCounting(fs);

    expect(result.ok).toBe(true);
    expect(fs.writes).toEqual([]);
    expect(fs.files).toEqual(before);
  });

  it("calls each read-only git seam exactly once with the session cwd", () => {
    const gitCalls: string[] = [];

    const result = readFleetStatus({
      cwd,
      fleetId: "fleet-1",
      fs: countingFs(),
      resolveCommonDir: (given) => {
        gitCalls.push(`rev-parse --git-common-dir ${given}`);
        return { ok: true, commonDir };
      },
      listWorktrees: (given) => {
        gitCalls.push(`worktree list --porcelain -z ${given}`);
        return { ok: true, entries: [], warnings: [] };
      },
    });

    expect(result.ok).toBe(true);
    // Exactly two probes, both read-only, both against the caller's cwd.
    expect(gitCalls).toEqual([
      `rev-parse --git-common-dir ${cwd}`,
      `worktree list --porcelain -z ${cwd}`,
    ]);
  });

  it("runs no git probe at all when the common-dir probe fails", () => {
    const gitCalls: string[] = [];

    const result = readFleetStatus({
      cwd,
      fleetId: "fleet-1",
      fs: countingFs(),
      resolveCommonDir: () => ({ ok: false, error: "not a git repository" }),
      listWorktrees: () => {
        gitCalls.push("worktree list");
        return { ok: true, entries: [], warnings: [] };
      },
    });

    expect(result).toEqual({ ok: false, error: "not a git repository" });
    expect(gitCalls).toEqual([]);
  });
});

describe("bead ownership and human surfaces (bd-153)", () => {
  function statusOf(members: readonly FleetMemberSnapshot[]): FleetStatus {
    return buildFleetStatus({ fleetId: "fleet-1", intent: undefined, members });
  }

  function member(taskId: string): FleetMemberSnapshot {
    const branch = `feat/${taskId}`;
    return sampleMember({
      worktreePath: `/repo.${taskId}`,
      branch,
      workflow: okWorkflow({ taskId, branch }),
    });
  }

  function beadRecord(id: string, overrides: Record<string, unknown> = {}) {
    return { id, title: `Title ${id}`, status: "open", priority: 2, labels: [], ...overrides };
  }

  function enriched(
    members: readonly FleetMemberSnapshot[],
    beads: readonly Record<string, unknown>[],
    entries: readonly { taskId: string; engagement: FleetBeadEngagement }[],
  ): FleetStatus {
    const base = applyFleetBeadLookup(statusOf(members), {
      ok: true,
      beads: beads.map((record) => parseBeadView(record)).filter((bead) => bead !== undefined),
    });
    return applyFleetBeadEngagement(base, { ok: true, entries });
  }

  it("parses ownership fields and degrades each one independently", () => {
    expect(
      parseBeadView({
        id: "bd-12",
        title: "Fix login",
        status: "open",
        priority: 1,
        labels: ["human"],
        assignee: "belayd:bd-12:implement",
        owner: "hugo",
        comment_count: 3,
        updated_at: "2026-10-27T07:47:29Z",
      }),
    ).toEqual({
      id: "bd-12",
      title: "Fix login",
      status: "open",
      priority: 1,
      labels: ["human"],
      assignee: "belayd:bd-12:implement",
      owner: "hugo",
      commentCount: 3,
      updatedAt: "2026-10-27T07:47:29Z",
    });

    // A renamed or re-typed field costs that column, never the whole record.
    const renamed = parseBeadView({
      id: "bd-12",
      assignee_name: "renamed",
      owner_id: 7,
      comments: 3,
      modified_at: 12345,
    });
    expect(renamed).toHaveProperty("id", "bd-12");
    expect(renamed).toHaveProperty("commentCount", undefined);
    expect(renamed).toHaveProperty("assignee", undefined);
    expect(renamed).toHaveProperty("owner", undefined);
    expect(renamed).toHaveProperty("updatedAt", undefined);

    // A negative count is not a comment thread; it degrades too.
    expect(parseBeadView({ id: "bd-12", comment_count: -1 })).toHaveProperty(
      "commentCount",
      undefined,
    );

    const bare = parseBeadView({ id: "bd-12" });
    expect(bare).toHaveProperty("assignee", undefined);
    expect(bare).toHaveProperty("owner", undefined);
    expect(bare).toHaveProperty("commentCount", undefined);
    expect(bare).toHaveProperty("updatedAt", undefined);
  });

  it("keeps id, title and labels when all four ownership fields are malformed", () => {
    // Every new field wrong at once (wrong types, not just renames): the record
    // and the columns bd did report must still render.
    const raw = {
      id: "bd-12",
      title: "Fix login",
      status: "open",
      priority: 1,
      labels: ["human"],
      assignee: 42,
      owner: { name: "hugo" },
      comment_count: "3",
      updated_at: 1729,
    };
    const bead = parseBeadView(raw);
    expect(bead).toHaveProperty("id", "bd-12");
    expect(bead).toHaveProperty("title", "Fix login");
    expect(bead?.labels).toEqual(["human"]);
    expect(bead).toHaveProperty("assignee", undefined);
    expect(bead).toHaveProperty("owner", undefined);
    expect(bead).toHaveProperty("commentCount", undefined);
    expect(bead).toHaveProperty("updatedAt", undefined);

    const text = formatFleetStatus(enriched([member("bd-12")], [raw], []));
    expect(text).toContain("  bead: Fix login (open)");
    expect(text).toContain("  human: yes");
    // A malformed field degrades to its own "not reported" text, and a
    // malformed optional field adds no line at all.
    expect(text).toContain("  owner: (unknown)");
    expect(text).toContain("  assignee: (unassigned)");
    expect(text).not.toContain("  comment count:");
    expect(text).not.toContain("  bead updated:");
  });

  it("parses a real bd 1.3.0 `bd show --json` payload", () => {
    const beads = parseBeadViews(JSON.parse(REAL_SHOW_JSON));
    expect(beads).toHaveLength(1);
    const bead = beads[0];
    expect(bead).toHaveProperty("id", "bd-26");
    expect(bead).toHaveProperty(
      "title",
      "Investigate moving proof-of-work artifacts out of the git worktree",
    );
    expect(bead).toHaveProperty("status", "open");
    expect(bead).toHaveProperty("priority", 2);
    // bd reports a person's display name as `assignee` and their email as
    // `owner`; both are plain strings, and `comment_count` is a JSON number.
    expect(bead).toHaveProperty("assignee", "Hugo Lewenhaupt");
    expect(bead).toHaveProperty("owner", "hugo.lewenhaupt@gmail.com");
    expect(bead).toHaveProperty("commentCount", 2);
    expect(bead).toHaveProperty("updatedAt", "2026-08-31T19:53:54Z");

    // bd omits `assignee` entirely for an unassigned bead (recorded from
    // `bd show bd-159 --json`): that absence must render as (unassigned).
    const record: Record<string, unknown> = JSON.parse(REAL_SHOW_JSON)[0];
    const unassigned = Object.fromEntries(
      Object.entries(record).filter(([key]) => key !== "assignee"),
    );
    expect(parseBeadView(unassigned)).toHaveProperty("assignee", undefined);

    // And the whole record still renders through the surface it feeds.
    const text = formatFleetStatus(enriched([member("bd-26")], [record], []));
    expect(text).toContain(
      "  bead: Investigate moving proof-of-work artifacts out of the git worktree (open)",
    );
    expect(text).toContain("  owner: hugo.lewenhaupt@gmail.com");
    expect(text).toContain("  assignee: Hugo Lewenhaupt");
    expect(text).toContain("  bead updated: 2026-08-31T19:53:54Z");
    expect(text).toContain("  comment count: 2");
  });

  it("flags the bd human label", () => {
    expect(beadNeedsHuman(parseBeadView(beadRecord("bd-12", { labels: ["human"] })))).toBe(true);
    expect(beadNeedsHuman(parseBeadView(beadRecord("bd-12")))).toBe(false);
    expect(beadNeedsHuman(undefined)).toBe(false);
  });

  it("attaches engagement by task id, case-insensitively, and leaves a missing member unknown", () => {
    const status = statusOf([member("bd-12"), member("bd-15")]);

    const attached = applyFleetBeadEngagement(status, {
      ok: true,
      entries: [
        {
          taskId: "BD-12",
          engagement: {
            comments: {
              state: "read",
              newest: { author: "hugo", text: "q", createdAt: "2026-10-27T07:47:29Z" },
            },
            awaitingHuman: true,
          },
        },
      ],
    });

    expect(attached.members[0]?.engagement).toEqual({
      comments: {
        state: "read",
        newest: { author: "hugo", text: "q", createdAt: "2026-10-27T07:47:29Z" },
      },
      awaitingHuman: true,
    });
    // A missing entry means "unknown", not a fleet-wide warning.
    expect(attached.members[1]?.engagement).toBe(undefined);
    expect(attached.warnings).toEqual(status.warnings);
  });

  it("degrades engagement to exactly one fleet-level warning", () => {
    const status = statusOf([member("bd-12"), member("bd-15")]);

    const degraded = applyFleetBeadEngagement(status, {
      ok: false,
      error: "no beads database found\nsecond line",
    });

    expect(degraded.members.map((view) => view.engagement)).toEqual([undefined, undefined]);
    expect(degraded.warnings).toHaveLength(1);
    expect(degraded.warnings[0]).toHaveProperty("kind", "bead-engagement-unavailable");
    expect(degraded.warnings[0]?.message).toContain("no beads database found");
    expect(degraded.warnings[0]?.message).not.toContain("\n");
    expect(formatFleetStatus(degraded)).toContain("Warnings (1):");
  });

  it("bounds a runaway engagement read error into one line", () => {
    const degraded = applyFleetBeadEngagement(statusOf([member("bd-12")]), {
      ok: false,
      error: `${"x".repeat(10_000)}\nsecond line`,
    });

    const message = degraded.warnings[0]?.message ?? "";
    expect(message.length).toBeLessThan(400);
    expect(message).toContain("…");
  });

  it("renders owner, assignee and the human flag under the bead line", () => {
    const status = enriched(
      [member("bd-12")],
      [
        beadRecord("bd-12", {
          labels: ["human"],
          assignee: "belayd:bd-12:implement",
          owner: "hugo",
          comment_count: 1,
          updated_at: "2026-10-27T07:47:29Z",
        }),
      ],
      [],
    );

    const text = formatFleetStatus(status);
    expect(text).toContain(
      [
        "  bead: Title bd-12 (open)",
        "  owner: hugo",
        "  assignee: belayd:bd-12:implement",
        "  human: yes",
        "  bead updated: 2026-10-27T07:47:29Z",
        "  comment count: 1",
      ].join("\n"),
    );
  });

  it("says (unknown) for an unreported owner and (unassigned) for a missing assignee", () => {
    const status = applyFleetBeadLookup(statusOf([member("bd-12")]), {
      ok: true,
      beads: [
        { id: "bd-12", title: undefined, status: undefined, priority: undefined, labels: [] },
      ],
    });

    const text = formatFleetStatus(status);
    expect(text).toContain("  owner: (unknown)");
    expect(text).toContain("  assignee: (unassigned)");
    expect(text).toContain("  human: no");
    // bd did not report these, so no fabricated timestamp or count is shown.
    expect(text).not.toContain("  bead updated:");
    expect(text).not.toContain("  comment count:");
    // No engagement read ⇒ no engagement lines at all (regression contract).
    expect(text).not.toContain("awaiting human:");
    expect(text).not.toContain("newest comment:");
  });

  it("renders an unread comment column as unknown, never none", () => {
    const status = enriched(
      [member("bd-12")],
      [beadRecord("bd-12")],
      [{ taskId: "bd-12", engagement: { comments: { state: "unknown" } } }],
    );

    const text = formatFleetStatus(status);
    expect(text).toContain("  awaiting human: unknown");
    expect(text).toContain("  newest comment: (unknown)");
    expect(text).not.toContain("  newest comment: (none)");
    expect(text).not.toContain("  awaiting human: no");
  });

  it("renders (none) only when the comment read succeeded and the thread is empty", () => {
    const status = enriched(
      [member("bd-12")],
      [beadRecord("bd-12")],
      [{ taskId: "bd-12", engagement: { comments: { state: "read" } } }],
    );

    expect(formatFleetStatus(status)).toContain("  newest comment: (none)");
  });

  it("caps the per-member newest-comment excerpt", () => {
    const status = enriched(
      [member("bd-12")],
      [beadRecord("bd-12")],
      [
        {
          taskId: "bd-12",
          engagement: {
            comments: {
              state: "read",
              newest: {
                author: "hugo",
                text: "x".repeat(500),
                createdAt: "2026-10-27T00:00:00Z",
              },
            },
          },
        },
      ],
    );

    expect(formatFleetStatus(status)).toContain(
      `  newest comment: hugo 2026-10-27T00:00:00Z: "${"x".repeat(NEEDS_YOU_EXCERPT_MAX_CHARS - 1)}…"`,
    );
  });

  it("caps a multi-byte excerpt by code point, not by byte length", () => {
    // CJK characters are three UTF-8 bytes each but one JS code unit, so a
    // byte-based cap would cut this to ~40 characters.
    const status = enriched(
      [member("bd-12")],
      [beadRecord("bd-12")],
      [
        {
          taskId: "bd-12",
          engagement: {
            comments: {
              state: "read",
              newest: {
                author: "hugo",
                text: "漢".repeat(400),
                createdAt: "2026-10-27T00:00:00Z",
              },
            },
          },
        },
      ],
    );

    const line = formatFleetStatus(status)
      .split("\n")
      .find((entry) => entry.includes("newest comment:"));
    const quoted = (line ?? "").slice((line ?? "").indexOf('Z: "') + 4);
    expect(quoted).toBe(`${"漢".repeat(NEEDS_YOU_EXCERPT_MAX_CHARS - 1)}…"`);
    // 120 code points of 3-byte characters: the excerpt is bounded by count,
    // not by the 362-byte input.
    expect(quoted.length).toBe(NEEDS_YOU_EXCERPT_MAX_CHARS + 1);
    expect(quoted).not.toContain("\uFFFD");
  });

  it("renders byte-identically across calls and member orderings, with no relative age", () => {
    const beads = [
      beadRecord("bd-19", {
        labels: ["human"],
        assignee: "belayd:bd-19:orchestrator",
        owner: "hugo",
        comment_count: 2,
        updated_at: "2026-10-27T07:47:29Z",
      }),
      beadRecord("bd-22"),
    ];
    const entries: { taskId: string; engagement: FleetBeadEngagement }[] = [
      {
        taskId: "bd-19",
        engagement: {
          comments: {
            state: "read",
            newest: {
              author: "hugo",
              text: "should we drop the marker?",
              createdAt: "2026-10-27T07:47:29Z",
            },
          },
          awaitingHuman: true,
        },
      },
      { taskId: "bd-22", engagement: { comments: { state: "read" }, awaitingHuman: false } },
    ];

    const first = formatFleetStatus(enriched([member("bd-19"), member("bd-22")], beads, entries));
    const again = formatFleetStatus(enriched([member("bd-19"), member("bd-22")], beads, entries));
    const reversed = formatFleetStatus(
      enriched([member("bd-22"), member("bd-19")], beads, entries),
    );

    expect(again).toBe(first);
    expect(reversed).toBe(first);
    // Every timestamp is printed as bd reported it: nothing reads a clock.
    expect(first).toContain("bead updated: 2026-10-27T07:47:29Z");
    expect(first).not.toMatch(
      /\b\d+\s*(?:s|sec|secs|second|seconds|min|mins|minute|minutes|h|hr|hour|hours|day|days)\s+ago\b/u,
    );
  });

  it("formatNeedsYou is undefined when nothing needs a human", () => {
    const status = enriched(
      [member("bd-12")],
      [beadRecord("bd-12")],
      [{ taskId: "bd-12", engagement: { comments: { state: "read" }, awaitingHuman: false } }],
    );

    expect(formatNeedsYou(status)).toBe(undefined);
    expect(formatFleetStatus(status)).not.toContain("Needs you");
  });

  it("names every waiting bead together, with assignee and newest comment", () => {
    const status = enriched(
      [member("bd-19"), member("bd-22")],
      [
        beadRecord("bd-19", { labels: ["human"], assignee: "belayd:bd-19:orchestrator" }),
        beadRecord("bd-22", { labels: ["human"] }),
      ],
      [
        {
          taskId: "bd-19",
          engagement: {
            comments: {
              state: "read",
              newest: {
                author: "hugo",
                text: "should we drop the marker?",
                createdAt: "2026-10-27T07:47:29Z",
              },
            },
            awaitingHuman: true,
          },
        },
        {
          taskId: "bd-22",
          engagement: { comments: { state: "read" }, awaitingHuman: false },
        },
      ],
    );

    expect(formatNeedsYou(status)).toBe(
      [
        "Needs you (2): bd-19, bd-22",
        '  - bd-19 (assignee belayd:bd-19:orchestrator, awaiting human) — hugo 2026-10-27T07:47:29Z: "should we drop the marker?"',
        "  - bd-22 (assignee (unassigned)) — (no comments yet)",
      ].join("\n"),
    );

    const text = formatFleetStatus(status);
    const header = text.indexOf("Needs you (2)");
    expect(header).toBeGreaterThan(text.indexOf("  states:"));
    expect(header).toBeLessThan(text.indexOf("Member bd-19"));
  });

  it("includes a bead with an open human gate even without the human label", () => {
    const status = enriched(
      [member("bd-12")],
      [beadRecord("bd-12")],
      [{ taskId: "bd-12", engagement: { comments: { state: "unknown" }, awaitingHuman: true } }],
    );

    expect(formatNeedsYou(status)).toContain("Needs you (1): bd-12");
    expect(formatNeedsYou(status)).toContain("(assignee (unassigned), awaiting human)");
    // The comment read is unread, not empty: never "(no comments yet)".
    expect(formatNeedsYou(status)).toContain("(comments unknown)");
  });

  it("says (unknown) for the assignee when the bead record failed to read", () => {
    const status = enriched(
      [member("bd-12")],
      [],
      [{ taskId: "bd-12", engagement: { comments: { state: "read" }, awaitingHuman: true } }],
    );

    const block = formatNeedsYou(status) ?? "";
    expect(block).toContain("(assignee (unknown), awaiting human)");
    expect(block).not.toContain("(unassigned)");
  });

  it("caps the needs-you list and names the remainder", () => {
    const total = NEEDS_YOU_LIST_MAX + 3;
    const members = Array.from({ length: total }, (_, index) => member(`bd-${100 + index}`));
    const status = enriched(
      members,
      members.map((_, index) => beadRecord(`bd-${100 + index}`, { labels: ["human"] })),
      [],
    );

    const block = formatNeedsYou(status) ?? "";
    const lines = block.split("\n");
    expect(lines[0]).toBe(
      `Needs you (${total}): ${members
        .map((_, index) => `bd-${100 + index}`)
        .slice(0, NEEDS_YOU_LIST_MAX)
        .join(", ")}`,
    );
    expect(lines.at(-1)).toBe("  …and 3 more");
    expect(lines).toHaveLength(1 + NEEDS_YOU_LIST_MAX + 1);
  });

  it("orders the listed beads by task id", () => {
    const status = enriched(
      [member("bd-22"), member("bd-19")],
      [beadRecord("bd-19", { labels: ["human"] }), beadRecord("bd-22", { labels: ["human"] })],
      [],
    );

    expect(formatNeedsYou(status)?.split("\n")[0]).toBe("Needs you (2): bd-19, bd-22");
  });
});

describe("formatBeadOwnership (belayd_status section)", () => {
  const bead = {
    id: "bd-19",
    title: "Ownership surfaces",
    status: "open",
    priority: 2,
    labels: ["human"],
    assignee: "belayd:bd-19:orchestrator",
    owner: "hugo",
  };

  it("renders the bead columns and the needs-you line", () => {
    expect(
      formatBeadOwnership({
        cwdTaskId: "bd-19",
        bead,
        engagement: {
          comments: {
            state: "read",
            newest: {
              author: "hugo",
              text: "should we drop the marker?",
              createdAt: "2026-10-27T07:47:29Z",
            },
          },
          awaitingHuman: true,
        },
      }),
    ).toBe(
      [
        "**Bead bd-19**",
        "- title: Ownership surfaces",
        "- status: open",
        "- owner: hugo",
        "- assignee: belayd:bd-19:orchestrator",
        "- human: yes",
        "- awaiting human: yes",
        '- newest comment: hugo 2026-10-27T07:47:29Z: "should we drop the marker?"',
        "**Needs you** — bd-19 is waiting on a human.",
      ].join("\n"),
    );
  });

  it("prints nothing without a task id or without any bead data", () => {
    expect(formatBeadOwnership({ cwdTaskId: "" })).toBe(undefined);
    expect(formatBeadOwnership({ cwdTaskId: "bd-19" })).toBe(undefined);
  });

  it("renders unknown for an unrecognized gate and never says no", () => {
    const section =
      formatBeadOwnership({
        cwdTaskId: "bd-19",
        engagement: { comments: { state: "unknown" } },
      }) ?? "";
    expect(section).toContain("- awaiting human: unknown");
    expect(section).toContain("- newest comment: (unknown)");
    expect(section).not.toContain("- awaiting human: no");
    // "needs you" must not fire on an unknown gate.
    expect(section).not.toContain("**Needs you**");
  });

  it("renders (none) and no for an empty thread and a resolved gate", () => {
    const section =
      formatBeadOwnership({
        cwdTaskId: "bd-19",
        bead,
        engagement: { comments: { state: "read" }, awaitingHuman: false },
      }) ?? "";

    // The two non-unknown outcomes, on the belayd_status surface: a successful
    // empty read says (none), a `none` gate says no (and it is the only `no`).
    expect(section).toContain("- awaiting human: no");
    expect(section).toContain("- newest comment: (none)");
    expect(section).not.toContain("(unknown)");
    // The `human` label still names the bead even though the gate is resolved.
    expect(section).toContain("**Needs you** — bd-19 is waiting on a human.");
  });

  it("keeps the bead columns when only the engagement read failed", () => {
    const section =
      formatBeadOwnership({
        cwdTaskId: "bd-19",
        bead,
        error: "gate list failed",
      }) ?? "";

    expect(section).toContain("- title: Ownership surfaces");
    expect(section).toContain("- owner: hugo");
    expect(section).toContain("- assignee: belayd:bd-19:orchestrator");
    expect(section).toContain("bead engagement unavailable (bd read failed): gate list failed");
  });

  it("degrades a read failure to one bounded line", () => {
    const section = formatBeadOwnership({
      cwdTaskId: "bd-19",
      error: `${"x".repeat(10_000)}\nsecond line`,
    });
    expect(section?.startsWith("bead detail unavailable (bd read failed): ")).toBe(true);
    expect(section).not.toContain("\n");
    expect((section ?? "").length).toBeLessThan(400);
  });
});
