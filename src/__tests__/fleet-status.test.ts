/**
 * Unit tests for fleet status (bd-126 P0).
 *
 * The aggregation/formatting layer is pure, so most cases pass already-read
 * data and assert on the returned object. The reader takes an injected fs seam
 * plus two git seams, so its cases exercise the same pure layer without
 * shelling out to git.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  applyFleetBeadLookup,
  buildFleetStatus,
  DEFAULT_FLEET_ID,
  deriveFleetMemberState,
  FLEET_MEMBER_STATES,
  type FleetIntent,
  type FleetMemberSnapshot,
  type FleetStatusFs,
  type FleetWorkflowSnapshot,
  fleetAuditLogPath,
  fleetBeadTaskIds,
  fleetEventsDir,
  fleetInboxDir,
  fleetIntentFilePath,
  fleetMergeQueueFilePath,
  fleetStateDir,
  formatFleetStatus,
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

function sampleMember(overrides: Partial<FleetMemberSnapshot> = {}): FleetMemberSnapshot {
  return {
    worktreePath: "/repo.feat-bd-12",
    isMainWorktree: false,
    branch: "feat/bd-12",
    workflow: okWorkflow(),
    runs: [],
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
