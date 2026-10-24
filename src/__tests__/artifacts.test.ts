import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  artifactPath,
  formatArtifactIndex,
  listPhaseArtifacts,
  MAX_ARTIFACT_CHARS,
  readPhaseArtifact,
  writePhaseArtifact,
} from "../artifacts.js";

const dirs: string[] = [];
function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "belayd-artifacts-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("artifactPath", () => {
  it("is worktree-relative and one file per phase", () => {
    expect(artifactPath("review")).toBe(".belayd/artifacts/review.md");
  });

  it("keeps an unexpected phase name filesystem-safe", () => {
    expect(artifactPath("some/phase")).toBe(".belayd/artifacts/some-phase.md");
  });
});

describe("writePhaseArtifact", () => {
  it("writes a header plus the phase output", () => {
    const cwd = tempRepo();
    const result = writePhaseArtifact({
      cwd,
      phase: "scout",
      taskId: "bd-1",
      text: "## Files Retrieved\n- src/a.ts",
    });

    expect(result).toHaveProperty("ok", true);
    const written = readPhaseArtifact({ cwd, phase: "scout" });
    expect(written).toContain("bd-1");
    expect(written).toContain("Files Retrieved");
    expect(written).toContain("src/a.ts");
  });

  it("truncates from both ends, keeping the conclusion", () => {
    const cwd = tempRepo();
    const text = `${"H".repeat(500)}${"M".repeat(5000)}${"T".repeat(500)}`;
    const result = writePhaseArtifact({
      cwd,
      phase: "review",
      taskId: "bd-1",
      text,
      maxChars: 1000,
    });

    expect(result).toHaveProperty("ok", true);
    expect(result).toHaveProperty("truncated", true);
    const written = readPhaseArtifact({ cwd, phase: "review" }) ?? "";
    expect(written).toContain("characters omitted");
    expect(written).toContain("T".repeat(50));
  });

  it("reports a write failure instead of throwing", () => {
    const cwd = tempRepo();
    // A file where the artifacts directory must go.
    writeFileSync(join(cwd, ".belayd"), "not a directory", "utf8");

    const result = writePhaseArtifact({ cwd, phase: "plan", taskId: "bd-1", text: "x" });

    expect(result).toHaveProperty("ok", false);
  });

  it("stays inside the default bound", () => {
    const cwd = tempRepo();
    writePhaseArtifact({
      cwd,
      phase: "implement",
      taskId: "bd-1",
      text: "x".repeat(MAX_ARTIFACT_CHARS * 2),
    });
    const written = readPhaseArtifact({ cwd, phase: "implement" }) ?? "";

    expect(written.length).toBeLessThan(MAX_ARTIFACT_CHARS + 500);
  });
});

describe("readPhaseArtifact", () => {
  it("returns undefined when the phase has no artifact", () => {
    expect(readPhaseArtifact({ cwd: tempRepo(), phase: "test" })).toBeUndefined();
  });
});

describe("listPhaseArtifacts", () => {
  it("lists present artifacts in workflow order, not filesystem order", () => {
    const cwd = tempRepo();
    for (const phase of ["review", "scout", "implement"]) {
      writePhaseArtifact({ cwd, phase, taskId: "bd-1", text: phase });
    }

    expect(listPhaseArtifacts(cwd).map((artifact) => artifact.phase)).toEqual([
      "scout",
      "implement",
      "review",
    ]);
  });
});

describe("formatArtifactIndex", () => {
  it("returns an empty string when there are no artifacts", () => {
    expect(formatArtifactIndex({ cwd: tempRepo() })).toBe("");
  });

  it("names paths and sizes, and skips the phase about to run", () => {
    const cwd = tempRepo();
    writePhaseArtifact({ cwd, phase: "scout", taskId: "bd-1", text: "findings" });
    writePhaseArtifact({ cwd, phase: "plan", taskId: "bd-1", text: "plan" });

    const forImplement = formatArtifactIndex({ cwd, forPhase: "implement" });
    expect(forImplement).toContain("## Prior phase artifacts");
    expect(forImplement).toContain(".belayd/artifacts/scout.md");
    expect(forImplement).toContain(".belayd/artifacts/plan.md");

    const forScout = formatArtifactIndex({ cwd, forPhase: "scout" });
    expect(forScout).toContain("plan.md");
    expect(forScout).not.toContain("scout.md");
  });
});

describe("orchestrator wiring", () => {
  // Source-level guard: the artifact bus only works if the orchestrator writes on
  // completion AND names the files in the next phase's prompt. A refactor that
  // drops either half would leave every unit test above passing and the feature
  // silently gone.
  const source = readFileSync(new URL("../../extensions/index.ts", import.meta.url), "utf8");

  it("writes an artifact for a successful delivery, before the follow-up", () => {
    expect(source).toContain("recordPhaseArtifact({");
    expect(source).toContain("if (!options.delivery.success) return;");
    expect(source).toContain('text: options.delivery.result.content?.[0]?.text ?? "",');
  });

  it("prepends the artifact index to the phase prompt, on fresh and resumed runs", () => {
    expect(source).toContain("formatArtifactIndex({ cwd, forPhase: phaseName })");
    // Counted rather than matched literally: the wiring is a template
    // interpolation, which a test string cannot carry without escaping.
    const uses = (source.match(/artifactBlock/g) ?? []).length;
    expect(uses).toBeGreaterThanOrEqual(3); // declaration + fresh task + resumed task
    expect(source).toContain("await buildFullPhaseTask({");
  });
});
