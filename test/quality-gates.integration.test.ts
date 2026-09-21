import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SpawnDetails } from "../src/agent-registry.js";
import {
  ensureProofBridge,
  proofDirForTask,
  resolveProjectProofBase,
  resolveProofBase,
} from "../src/proof-dir.js";
import { gateProofContent, validateCastRecording } from "../src/quality-gates.js";
import { projectKeyFromRepoRoot, resolveRepoKey } from "../src/worktree.js";

const REPO_ROOT = resolve(import.meta.dirname, "..");

const MOCK_DETAILS: SpawnDetails = {
  messages: [],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
  exitCode: 0,
};

describe("validateCastRecording (integration)", () => {
  const task63Cast = resolve(REPO_ROOT, "proof-of-work/TASK-63/03a-agent-harness-tests.cast");
  const task67Cast = resolve(REPO_ROOT, "proof-of-work/TASK-67/rename-fix.cast");

  it("passes for TASK-63 recording (valid proof)", async () => {
    if (!existsSync(task63Cast)) {
      console.warn("Skipping integration test: proof-of-work/TASK-63 not found (clean checkout)");
      return;
    }

    const result = await validateCastRecording(task63Cast);

    expect(result).toHaveProperty("passed", true);
  });

  it("fails for TASK-67 recording (no command executed)", async () => {
    if (!existsSync(task67Cast)) {
      console.warn("Skipping integration test: proof-of-work/TASK-67 not found (clean checkout)");
      return;
    }

    const result = await validateCastRecording(task67Cast);

    expect(result).toHaveProperty("passed", false);
    expect(result.feedback).toContain("no command executed");
  });
});

describe("proof-of-work relocation (integration)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "belayd-proof-integration-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const validCast = [
    JSON.stringify({ version: 3, command: "node dist/cli.js --serve" }),
    JSON.stringify([0.0, "o", "Running tests...\n"]),
    JSON.stringify([1.5, "o", "PASS\n"]),
    JSON.stringify([2.0, "x", "0"]),
  ].join("\n");

  it("resolves the proof base from the environment or XDG state", () => {
    expect(resolveProofBase({ BELAYD_PROOF_DIR: "/custom/proof" })).toBe("/custom/proof");
    expect(resolveProofBase({ XDG_STATE_HOME: "/custom/state" })).toBe(
      join("/custom/state", "belayd", "proof"),
    );
  });

  it("creates the bridge symlink and validates artifacts through it", async () => {
    const workspaceRoot = join(tmpDir, "repo");
    await mkdir(join(workspaceRoot, ".git"), { recursive: true });

    const proofBase = resolveProofBase({ BELAYD_PROOF_DIR: join(tmpDir, "external", "proof") });
    const proofDir = proofDirForTask("bd-99", proofBase);

    const bridge = ensureProofBridge(workspaceRoot, proofBase);
    expect(bridge).toHaveProperty("ok", true);
    expect(readFileSync(join(workspaceRoot, ".belayd/proof-dir"), "utf-8").trim()).toBe(
      resolve(proofBase),
    );

    await mkdir(proofDir, { recursive: true });
    await writeFile(join(proofDir, "valid.cast"), validCast, "utf-8");

    // No proofDir option: the gate must follow the workspace symlink.
    const result = await gateProofContent(
      "Proof recording: proof-of-work/bd-99/valid.cast\n",
      MOCK_DETAILS,
      { cwd: workspaceRoot },
    );

    expect(result).toHaveProperty("passed", true);
  });

  it("validates artifacts directly when proofDir is provided", async () => {
    const proofBase = join(tmpDir, "external", "proof");
    const proofDir = proofDirForTask("bd-99", proofBase);
    await mkdir(proofDir, { recursive: true });
    await writeFile(join(proofDir, "valid.cast"), validCast, "utf-8");

    const result = await gateProofContent(
      "Proof recording: proof-of-work/bd-99/valid.cast\n",
      MOCK_DETAILS,
      { proofDir },
    );

    expect(result).toHaveProperty("passed", true);
  });

  it("replaces an empty proof-of-work directory with the bridge symlink", async () => {
    const workspaceRoot = join(tmpDir, "repo");
    await mkdir(join(workspaceRoot, ".git"), { recursive: true });
    await mkdir(join(workspaceRoot, "proof-of-work"), { recursive: true });

    const proofBase = join(tmpDir, "external", "proof");
    const result = ensureProofBridge(workspaceRoot, proofBase);

    expect(result).toHaveProperty("ok", true);
    expect(readlinkSync(join(workspaceRoot, "proof-of-work"))).toBe(resolve(proofBase));
    expect(existsSync(join(workspaceRoot, ".belayd/proof-dir"))).toBe(true);
  });

  it("errors when the bridge target is a non-empty real directory", async () => {
    const workspaceRoot = join(tmpDir, "repo");
    await mkdir(join(workspaceRoot, ".git"), { recursive: true });
    await mkdir(join(workspaceRoot, "proof-of-work"), { recursive: true });
    await writeFile(join(workspaceRoot, "proof-of-work", "keep.cast"), "{}", "utf-8");

    const result = ensureProofBridge(workspaceRoot, join(tmpDir, "external", "proof"));

    expect(result).toHaveProperty("ok", false);
    expect(existsSync(join(workspaceRoot, "proof-of-work", "keep.cast"))).toBe(true);
    expect(existsSync(join(workspaceRoot, ".belayd/proof-dir"))).toBe(false);
  });

  it("keeps proof artifacts outside the workspace tree", async () => {
    const workspaceRoot = join(tmpDir, "repo");
    await mkdir(join(workspaceRoot, ".git"), { recursive: true });

    const proofBase = join(tmpDir, "external", "proof");
    const proofDir = proofDirForTask("bd-99", proofBase);
    ensureProofBridge(workspaceRoot, proofBase);
    await mkdir(proofDir, { recursive: true });
    await writeFile(join(proofDir, "artifact.txt"), "artifact", "utf-8");

    // The artifact is reachable via the symlink but lives outside the repo.
    expect(existsSync(join(workspaceRoot, "proof-of-work", "bd-99", "artifact.txt"))).toBe(true);
    expect(existsSync(join(workspaceRoot, "artifact.txt"))).toBe(false);
  });

  it("does not re-create a symlink when one already points at the same target", async () => {
    const workspaceRoot = join(tmpDir, "repo");
    await mkdir(join(workspaceRoot, ".git"), { recursive: true });
    const proofBase = join(tmpDir, "external", "proof");

    const first = ensureProofBridge(workspaceRoot, proofBase);
    const second = ensureProofBridge(workspaceRoot, proofBase);

    expect(first).toHaveProperty("ok", true);
    expect(second).toHaveProperty("ok", true);
    // The first-created symlink is left intact (target is unchanged).
    expect(readlinkSync(join(workspaceRoot, "proof-of-work"))).toBe(resolve(proofBase));
  });

  it("namespaces the proof base per project and validates through bridge and explicit proofDir", async () => {
    const repoRoot = join(tmpDir, "repo-a");
    initGitRepo(repoRoot);
    const globalRoot = join(tmpDir, "global", "proof");

    const projectBase = resolveProjectProofBase({ BELAYD_PROOF_DIR: globalRoot }, repoRoot);
    expect(projectBase).toHaveProperty("ok", true);
    if (!projectBase.ok) throw new Error(projectBase.error);
    expect(projectBase.base).toBe(join(globalRoot, projectKeyFromRepoRoot(repoRoot)));

    const bridge = ensureProofBridge(repoRoot, projectBase.base);
    expect(bridge).toHaveProperty("ok", true);
    expect(readFileSync(join(repoRoot, ".belayd/proof-dir"), "utf-8").trim()).toBe(
      resolve(projectBase.base),
    );

    const proofDir = proofDirForTask("bd-99", projectBase.base);
    await mkdir(proofDir, { recursive: true });
    await writeFile(join(proofDir, "valid.cast"), validCast, "utf-8");

    const viaBridge = await gateProofContent(
      "Proof recording: proof-of-work/bd-99/valid.cast\n",
      MOCK_DETAILS,
      { cwd: repoRoot },
    );
    expect(viaBridge).toHaveProperty("passed", true);

    const viaProofDir = await gateProofContent(
      "Proof recording: proof-of-work/bd-99/valid.cast\n",
      MOCK_DETAILS,
      { proofDir },
    );
    expect(viaProofDir).toHaveProperty("passed", true);
  });

  it("gives sibling repos with the same task ID distinct bases and no shared directory", async () => {
    const repoA = join(tmpDir, "repo-a");
    const repoB = join(tmpDir, "repo-b");
    initGitRepo(repoA);
    initGitRepo(repoB);
    const globalRoot = join(tmpDir, "global", "proof");

    const baseA = resolveProjectProofBase({ BELAYD_PROOF_DIR: globalRoot }, repoA);
    const baseB = resolveProjectProofBase({ BELAYD_PROOF_DIR: globalRoot }, repoB);
    expect(baseA).toHaveProperty("ok", true);
    expect(baseB).toHaveProperty("ok", true);
    if (!baseA.ok || !baseB.ok) throw new Error("expected project bases");
    expect(baseA.base).not.toBe(baseB.base);

    const dirA = proofDirForTask("bd-99", baseA.base);
    const dirB = proofDirForTask("bd-99", baseB.base);
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    await writeFile(join(dirA, "only-a.txt"), "a", "utf-8");

    // bd-99 in repo B must not see repo A's artifact.
    expect(existsSync(join(dirA, "only-a.txt"))).toBe(true);
    expect(existsSync(join(dirB, "only-a.txt"))).toBe(false);
  });

  it("negative control: the legacy non-namespaced path DOES collide for the same task ID", async () => {
    // This is the core bug bd-58 fixes. Without project namespacing
    // (`resolveProjectProofBase`), two sibling repos with the same task ID
    // resolve to one shared directory via `resolveProofBase` + `proofDirForTask`.
    // Asserting the collision here proves the namespaced tests above are doing
    // real work rather than being tautological.
    const repoA = join(tmpDir, "legacy-repo-a");
    const repoB = join(tmpDir, "legacy-repo-b");
    initGitRepo(repoA);
    initGitRepo(repoB);
    const globalRoot = join(tmpDir, "legacy-global", "proof");

    const legacyDirA = proofDirForTask("bd-99", resolveProofBase({ BELAYD_PROOF_DIR: globalRoot }));
    const legacyDirB = proofDirForTask("bd-99", resolveProofBase({ BELAYD_PROOF_DIR: globalRoot }));

    // The legacy path keys only on task ID, so both repos map to the same dir.
    expect(legacyDirA).toBe(legacyDirB);
    expect(legacyDirA).toBe(join(globalRoot, "bd-99"));

    // And the namespaced path demonstrably diverges from this legacy collision.
    const namespacedA = resolveProjectProofBase({ BELAYD_PROOF_DIR: globalRoot }, repoA);
    const namespacedB = resolveProjectProofBase({ BELAYD_PROOF_DIR: globalRoot }, repoB);
    expect(namespacedA).toHaveProperty("ok", true);
    expect(namespacedB).toHaveProperty("ok", true);
    if (!namespacedA.ok || !namespacedB.ok) throw new Error("expected namespaced bases");
    expect(namespacedA.base).not.toBe(legacyDirA);
    expect(namespacedB.base).not.toBe(legacyDirA);
  });

  it("migrates a pre-existing global-base bridge to the namespaced base on a real repo", async () => {
    const repoRoot = join(tmpDir, "repo-migrate");
    initGitRepo(repoRoot);
    const legacyGlobalBase = join(tmpDir, "legacy", "proof");

    // Old behavior: bridge to the global base with the harness marker in place.
    const legacyBridge = ensureProofBridge(repoRoot, legacyGlobalBase);
    expect(legacyBridge).toHaveProperty("ok", true);
    expect(readlinkSync(join(repoRoot, "proof-of-work"))).toBe(resolve(legacyGlobalBase));

    const namespacedBase = join(legacyGlobalBase, projectKeyFromRepoRoot(repoRoot));
    const migrated = ensureProofBridge(repoRoot, namespacedBase);

    expect(migrated).toHaveProperty("ok", true);
    expect(readlinkSync(join(repoRoot, "proof-of-work"))).toBe(resolve(namespacedBase));
    expect(readFileSync(join(repoRoot, ".belayd/proof-dir"), "utf-8").trim()).toBe(
      resolve(namespacedBase),
    );
  });

  it("refuses to repoint a foreign symlink that has no harness marker", async () => {
    const repoRoot = join(tmpDir, "repo-foreign");
    initGitRepo(repoRoot);
    const foreignTarget = join(tmpDir, "foreign-target");
    mkdirSync(foreignTarget, { recursive: true });
    symlinkSync(foreignTarget, join(repoRoot, "proof-of-work"));

    const result = ensureProofBridge(repoRoot, join(tmpDir, "desired", "proof"));

    expect(result).toHaveProperty("ok", false);
    // Over-eager repointing would silently redirect a link the harness did not create.
    expect(readlinkSync(join(repoRoot, "proof-of-work"))).toBe(foreignTarget);
    expect(existsSync(join(repoRoot, ".belayd/proof-dir"))).toBe(false);
  });

  it("resolves one project key for the main repo and its linked worktree", async () => {
    const repoRoot = join(tmpDir, "repo-main");
    initGitRepo(repoRoot);
    const worktreePath = join(tmpDir, "repo-linked");
    execFileSync(
      "git",
      ["-C", repoRoot, "worktree", "add", "-q", "-b", "feat/bd-99", worktreePath],
      {
        timeout: 30_000,
        stdio: "pipe",
      },
    );

    const mainKey = resolveRepoKey(repoRoot);
    const linkedKey = resolveRepoKey(worktreePath);
    expect(mainKey).toHaveProperty("ok", true);
    expect(linkedKey).toHaveProperty("ok", true);
    if (!mainKey.ok || !linkedKey.ok) throw new Error("expected repo keys");
    expect(linkedKey.key).toBe(mainKey.key);

    const globalRoot = join(tmpDir, "global", "proof");
    const mainBase = resolveProjectProofBase({ BELAYD_PROOF_DIR: globalRoot }, repoRoot);
    const linkedBase = resolveProjectProofBase({ BELAYD_PROOF_DIR: globalRoot }, worktreePath);
    expect(mainBase).toHaveProperty("ok", true);
    expect(linkedBase).toHaveProperty("ok", true);
    if (!mainBase.ok || !linkedBase.ok) throw new Error("expected project bases");
    expect(linkedBase.base).toBe(mainBase.base);
  });
});

/** Initialize a git repo with one commit so `git worktree add` works. */
function initGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const run = (args: string[]): void => {
    execFileSync("git", ["-C", dir, ...args], { timeout: 30_000, stdio: "pipe" });
  };
  run(["init", "-q"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Belayd Test"]);
  writeFileSync(join(dir, "README.md"), "init\n", "utf-8");
  run(["add", "README.md"]);
  run(["commit", "-q", "-m", "init"]);
}
