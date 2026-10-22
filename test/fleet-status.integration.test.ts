/**
 * End-to-end fleet status aggregation (bd-126 P0) against real git.
 *
 * Two linked worktrees each carry Belayd workflow state; one carries a run
 * manifest. The test asserts the view is derived correctly from real
 * `git worktree list --porcelain -z` output and — the P0 contract — that
 * reading it changes nothing: no file in the repo or either worktree is
 * touched, no ref moves, and no fleet directory appears.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_FLEET_ID,
  fleetStateDir,
  formatFleetStatus,
  getPhasesForType,
  listWorktrees,
  RunStatus,
  readFleetStatus,
  resolveGitCommonDir,
  writeRunManifest,
  writeWorkflowState,
} from "../src/index.js";
import { gitContextFreeEnv } from "../src/worktree.js";

process.env.BELAYD_MODEL_COOLDOWN_FILE = join(tmpdir(), "belayd-fleet-status-integration.json");
process.env.BELAYD_PROOF_DIR = join(tmpdir(), "belayd-fleet-status-integration-proof");

function git(args: readonly string[], cwd: string): string {
  return execFileSync("git", [...args], {
    cwd,
    env: gitContextFreeEnv(),
    encoding: "utf8",
    stdio: "pipe",
  }).trim();
}

function commit(cwd: string, file: string, content: string, message: string): void {
  writeFileSync(join(cwd, file), content);
  git(["add", "."], cwd);
  git(["commit", "-qm", message], cwd);
}

function seedWorkflow(cwd: string, taskId: string, branch: string, completed: string[] = []): void {
  const now = 1_700_000_000_000;
  const result = writeWorkflowState({
    cwd,
    state: {
      schemaVersion: 1,
      taskId,
      workflowType: "feature",
      branch,
      originalCwd: cwd,
      phaseOrder: getPhasesForType("feature"),
      completedPhaseNames: completed,
      startedAt: now,
      updatedAt: now,
    },
  });
  expect(result).toEqual({ ok: true });
}

/**
 * Every tracked path outside `.git` with its size and mtime. A write anywhere in
 * a worktree shows up here even when the file is gitignored (`.belayd/` is).
 */
function snapshotTree(root: string): string[] {
  const rows: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        rows.push(`dir ${relative(root, full)}`);
        walk(full);
        continue;
      }
      const stats = statSync(full);
      rows.push(`file ${relative(root, full)} ${stats.size} ${stats.mtimeMs}`);
    }
  };
  walk(root);
  return rows.sort();
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details: { exitCode: number };
}

interface RegisteredTool {
  name: string;
  execute: (...args: unknown[]) => Promise<ToolResult>;
}

describe("fleet status (integration, real git)", () => {
  let repo: string;
  let worktreeA: string;
  let worktreeB: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "belayd-fleet-"));
    worktreeA = `${repo}-a`;
    worktreeB = `${repo}-b`;

    git(["init", "-q", "-b", "main"], repo);
    git(["config", "user.email", "test@example.com"], repo);
    git(["config", "user.name", "Test"], repo);
    commit(repo, ".gitignore", ".belayd/\n", "base");
    git(["worktree", "add", "-q", "-b", "feat/bd-a", worktreeA, "main"], repo);
    git(["worktree", "add", "-q", "-b", "feat/bd-b", worktreeB, "main"], repo);

    seedWorkflow(worktreeA, "bd-a", "feat/bd-a", ["plan"]);
    seedWorkflow(worktreeB, "bd-b", "feat/bd-b");
    expect(
      writeRunManifest({
        cwd: worktreeA,
        manifest: {
          schemaVersion: 1,
          runId: "run-a-plan",
          taskId: "bd-a",
          phase: "plan",
          sessionName: "belayd-bd-a-sub-plan",
          status: RunStatus.Completed,
          startedAt: 1_700_000_000_100,
          completedAt: 1_700_000_000_200,
        },
      }),
    ).toEqual({ ok: true });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(worktreeA, { recursive: true, force: true });
    rmSync(worktreeB, { recursive: true, force: true });
  });

  it("aggregates every worktree from real porcelain -z output", () => {
    const listed = listWorktrees(repo);

    expect(listed).toHaveProperty("ok", true);
    expect(listed).toHaveProperty("warnings", []);
    if (!listed.ok) return;
    expect(listed.entries).toEqual([
      { path: repo, branch: "main", isMainWorktree: true },
      { path: worktreeA, branch: "feat/bd-a", isMainWorktree: false },
      { path: worktreeB, branch: "feat/bd-b", isMainWorktree: false },
    ]);

    const result = readFleetStatus({ cwd: repo, fleetId: DEFAULT_FLEET_ID });

    expect(result).toHaveProperty("ok", true);
    if (!result.ok) return;
    // The main checkout holds no workflow state, so it is not a member.
    expect(result.value.members.map((member) => member.taskId)).toEqual(["bd-a", "bd-b"]);
    expect(result.value.members.map((member) => member.branch)).toEqual(["feat/bd-a", "feat/bd-b"]);
    expect(result.value.members[0]).toHaveProperty("completedPhases", ["plan"]);
    expect(result.value.members[0]?.latestRuns).toEqual([
      {
        phase: "plan",
        runId: "run-a-plan",
        status: RunStatus.Completed,
        startedAt: 1_700_000_000_100,
        completedAt: 1_700_000_000_200,
      },
    ]);
    expect(result.value.counts.active).toBe(2);
    expect(result.value.warnings).toEqual([]);
  });

  it("writes nothing and reports the same view on repeated reads", () => {
    const commonDir = resolveGitCommonDir(repo);
    expect(commonDir).toHaveProperty("ok", true);
    if (!commonDir.ok) return;
    const fleetDir = fleetStateDir(commonDir.commonDir, DEFAULT_FLEET_ID);

    const treeBefore = snapshotTree(repo);
    const treeABefore = snapshotTree(worktreeA);
    const treeBBefore = snapshotTree(worktreeB);
    const refsBefore = git(["for-each-ref", "--format=%(refname) %(objectname)"], repo);
    const porcelainBefore = git(["worktree", "list", "--porcelain"], repo);
    const statusBefore = [repo, worktreeA, worktreeB].map((dir) =>
      git(["status", "--porcelain", "--untracked-files=all"], dir),
    );

    const first = readFleetStatus({ cwd: repo, fleetId: DEFAULT_FLEET_ID });
    const second = readFleetStatus({ cwd: repo, fleetId: DEFAULT_FLEET_ID });

    expect(first).toHaveProperty("ok", true);
    expect(second).toHaveProperty("ok", true);
    if (!first.ok || !second.ok) return;
    expect(formatFleetStatus(second.value)).toBe(formatFleetStatus(first.value));
    expect(second.value).toEqual(first.value);

    expect(snapshotTree(repo)).toEqual(treeBefore);
    expect(snapshotTree(worktreeA)).toEqual(treeABefore);
    expect(snapshotTree(worktreeB)).toEqual(treeBBefore);
    expect(git(["for-each-ref", "--format=%(refname) %(objectname)"], repo)).toBe(refsBefore);
    expect(git(["worktree", "list", "--porcelain"], repo)).toBe(porcelainBefore);
    expect(
      [repo, worktreeA, worktreeB].map((dir) =>
        git(["status", "--porcelain", "--untracked-files=all"], dir),
      ),
    ).toEqual(statusBefore);
    // P0 never creates shared fleet state, not even the default directory.
    expect(existsSync(fleetDir)).toBe(false);
  });

  it("keeps a real worktree whose path contains a newline", () => {
    // Only `--porcelain -z` can carry this path; the line-oriented fallback
    // would split the record and skip it with a warning.
    const newlinePath = `${repo}-new\nline`;
    git(["worktree", "add", "-q", "-b", "feat/bd-c", newlinePath, "main"], repo);
    seedWorkflow(newlinePath, "bd-c", "feat/bd-c");

    try {
      const listed = listWorktrees(repo);
      expect(listed).toHaveProperty("ok", true);
      if (!listed.ok) return;
      expect(listed.entries.map((entry) => entry.path)).toContain(newlinePath);

      const result = readFleetStatus({ cwd: repo, fleetId: DEFAULT_FLEET_ID });
      expect(result).toHaveProperty("ok", true);
      if (!result.ok) return;
      const member = result.value.members.find((entry) => entry.taskId === "bd-c");
      expect(member).toHaveProperty("worktreePath", newlinePath);
      expect(member).toHaveProperty("workflowFile", "ok");
    } finally {
      rmSync(newlinePath, { recursive: true, force: true });
    }
  });

  it("returns an error value for a directory that is not a git repository", () => {
    const plain = mkdtempSync(join(tmpdir(), "belayd-fleet-plain-"));

    try {
      const result = readFleetStatus({ cwd: plain, fleetId: DEFAULT_FLEET_ID });

      expect(result).toHaveProperty("ok", false);
      if (result.ok) return;
      expect(result.error).toContain("git rev-parse --git-common-dir failed");
      expect(readdirSync(plain)).toEqual([]);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it("serves the belayd_fleet_status tool without touching any worktree", async () => {
    const trees = [repo, worktreeA, worktreeB];
    const before = trees.map((dir) => snapshotTree(dir));

    const mod = await import("../extensions/index.js");
    const tools = new Map<string, RegisteredTool>();
    const api = {
      registerTool: (def: RegisteredTool) => {
        tools.set(def.name, def);
      },
      registerCommand: () => {},
      on: () => {},
      sendMessage: () => {},
      getActiveTools: () => [],
      setActiveTools: () => {},
      events: { emit: () => {}, on: () => () => {} },
    } as unknown as ExtensionAPI;
    (mod.default as (pi: ExtensionAPI) => void)(api);

    const tool = tools.get("belayd_fleet_status");
    if (tool === undefined) throw new Error("belayd_fleet_status was not registered");

    const result = await tool.execute("fleet-call", {}, undefined, undefined, { cwd: repo });

    expect(result.details.exitCode).toBe(0);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain(`Fleet ${DEFAULT_FLEET_ID}`);
    expect(text).toContain("Member bd-a");
    expect(text).toContain("Member bd-b");
    expect(text).toContain("states: active=2");
    expect(trees.map((dir) => snapshotTree(dir))).toEqual(before);
  });
});
