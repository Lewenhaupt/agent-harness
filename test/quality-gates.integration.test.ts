import { existsSync, mkdtempSync, readlinkSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SpawnDetails } from "../src/agent-registry.js";
import { ensureProofBridge, proofDirForTask, resolveProofBase } from "../src/proof-dir.js";
import { gateProofContent, validateCastRecording } from "../src/quality-gates.js";

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
    JSON.stringify({ version: 3, command: "pnpm test" }),
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

  it("errors when the bridge target is already a real directory", async () => {
    const workspaceRoot = join(tmpDir, "repo");
    await mkdir(join(workspaceRoot, ".git"), { recursive: true });
    await mkdir(join(workspaceRoot, "proof-of-work"), { recursive: true });

    const result = ensureProofBridge(workspaceRoot, join(tmpDir, "external", "proof"));

    expect(result).toHaveProperty("ok", false);
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
});
