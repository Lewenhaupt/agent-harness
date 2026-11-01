/**
 * Unit tests for the publish gate (bd-181): pure path classification and the
 * deterministic refusal contract the publish step and the merge drain rely on.
 */

import { describe, expect, it } from "vitest";
import {
  evaluatePublishGate,
  isHarnessLocalPath,
  isProofArtifactPathInDiff,
  isPublishablePath,
} from "../publish-gate.js";

describe("isProofArtifactPathInDiff", () => {
  it.each([
    "docs/proof/bd-38-proof.cast",
    "docs/proof/bd-179/README.md",
    "proof/recording.cast",
    "proof-of-work/bd-181/shot.png",
    "./docs/proof/bd-181/shot.png",
    ".//proof/bd-181/shot.png",
    "docs//proof/bd-181/shot.png",
    "././proof/shot.png",
    "screenshots/any.trace.zip",
    "assets/dashboard.PNG",
    "captures/demo.cast",
    "docs/proof/bd-181/café proof.png",
  ])("treats %s as proof", (path) => {
    expect(isProofArtifactPathInDiff(path)).toBe(true);
  });

  it.each([
    "src/proof.ts",
    "docs/proofs/notes.md",
    "proof-of-worker/x.txt",
    "docs/x.md",
    "proof\\shot.png",
    "docs/proоf/x.cast",
    "screenshots/café.cast",
  ])("does not treat %s as proof", (path) => {
    expect(isProofArtifactPathInDiff(path)).toBe(false);
  });
});

describe("isHarnessLocalPath", () => {
  it.each([
    ".belayd/proof-receipt.json",
    ".belayd/workflow.json",
    ".belayd-task.json",
    "proof-of-work",
    "./.belayd/proof-dir",
    ".belayd//proof-dir",
    ".belayd",
  ])("treats %s as harness-local", (path) => {
    expect(isHarnessLocalPath(path)).toBe(true);
  });

  it("treats a leading double slash as absolute, not harness-local", () => {
    expect(isHarnessLocalPath("//.belayd/x")).toBe(false);
    expect(isPublishablePath("//.belayd/x")).toBe(false);
  });

  it("does not treat a path with no segments as harness-local", () => {
    expect(isHarnessLocalPath("./")).toBe(false);
    expect(isHarnessLocalPath(".")).toBe(false);
  });

  it.each(["docs/belayd.md", "src/.belayd/x.ts", "proof-of-work/x.png"])(
    "does not treat %s as harness-local",
    (path) => {
      expect(isHarnessLocalPath(path)).toBe(false);
    },
  );
});

describe("isPublishablePath", () => {
  it.each(["src/a.ts", "docs/x.md", "package.json", "./src/a.ts"])(
    "accepts repo-relative %s",
    (path) => {
      expect(isPublishablePath(path)).toBe(true);
    },
  );

  it.each([
    "",
    "/abs/src/a.ts",
    "../outside.ts",
    "src/../../outside.ts",
    ".belayd/workflow.json",
    ".belayd-task.json",
    ".belayd",
    "proof-of-work",
    "docs/proof/bd-181/shot.png",
    "proof-of-work/x.png",
    "captures/demo.cast",
    "proof\\shot.png",
    ".//proof/x.png",
    "docs/proоf/x.cast",
  ])("refuses %s", (path) => {
    expect(isPublishablePath(path)).toBe(false);
  });
});

describe("evaluatePublishGate", () => {
  it("passes a publishable payload in deterministic order", () => {
    const result = evaluatePublishGate({ changedPaths: ["src/b.ts", "docs/a.md", "./src/a.ts"] });
    expect(result).toStrictEqual({ ok: true, paths: ["docs/a.md", "src/a.ts", "src/b.ts"] });
  });

  it("passes an empty payload", () => {
    expect(evaluatePublishGate({ changedPaths: [] })).toStrictEqual({ ok: true, paths: [] });
  });

  it("refuses proof artifacts and names every one of them", () => {
    const result = evaluatePublishGate({
      changedPaths: ["src/a.ts", "docs/proof/bd-181/shot.png", "proof/recording.cast"],
    });
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("proof-artifacts-in-diff");
    expect(result.paths).toStrictEqual(["docs/proof/bd-181/shot.png", "proof/recording.cast"]);
    expect(result.text).toContain("proof-artifacts-in-diff");
    expect(result.text).toContain("docs/proof/bd-181/shot.png, proof/recording.cast");
    expect(result.text.split("\n")).toHaveLength(1);
  });

  it("reports the proof reason first when a payload is both proof and out of scope", () => {
    const result = evaluatePublishGate({
      changedPaths: [".belayd/workflow.json", "docs/proof/bd-181/shot.png"],
      intendedPaths: ["src/a.ts"],
    });
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("proof-artifacts-in-diff");
    expect(result.paths).toStrictEqual(["docs/proof/bd-181/shot.png"]);
  });

  it("refuses harness-local, absolute, and traversal paths without intendedPaths", () => {
    const result = evaluatePublishGate({
      changedPaths: ["src/a.ts", ".belayd/workflow.json", "/abs/x.ts", "../escape.ts"],
    });
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("paths-outside-scope");
    expect(result.paths).toStrictEqual(["../escape.ts", ".belayd/workflow.json", "/abs/x.ts"]);
    expect(result.text).toContain("paths-outside-scope");
  });

  it("refuses a publishable path that is outside the declared payload", () => {
    const result = evaluatePublishGate({
      changedPaths: ["src/a.ts", "src/sneaked.ts"],
      intendedPaths: ["src/a.ts"],
    });
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("paths-outside-scope");
    expect(result.paths).toStrictEqual(["src/sneaked.ts"]);
    expect(result.text).toContain("src/sneaked.ts");
  });

  it("accepts a payload that matches the declared set", () => {
    expect(
      evaluatePublishGate({
        changedPaths: ["src/b.ts", "src/a.ts"],
        intendedPaths: ["./src/a.ts", "src/b.ts"],
      }),
    ).toStrictEqual({ ok: true, paths: ["src/a.ts", "src/b.ts"] });
  });

  it("is deterministic: identical input yields identical refusals", () => {
    const input = { changedPaths: ["proof/b.comp", "proof/a.cast"] };
    expect(evaluatePublishGate(input)).toStrictEqual(evaluatePublishGate(input));
    const refusal = evaluatePublishGate(input);
    if (refusal.ok) return;
    expect(refusal.paths).toStrictEqual(["proof/a.cast", "proof/b.comp"]);
  });

  it("normalizes before classifying and reports the normalized path", () => {
    const result = evaluatePublishGate({
      changedPaths: [".//proof/bd-181/shot.png", "././src/a.ts", "docs//x.md"],
    });
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("proof-artifacts-in-diff");
    expect(result.paths).toStrictEqual(["proof/bd-181/shot.png"]);
    expect(result.text).toContain("proof/bd-181/shot.png");
  });

  it("refuses a homoglyph proof directory as out of scope and says why", () => {
    const result = evaluatePublishGate({ changedPaths: ["docs/proоf/x.cast"] });
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("paths-outside-scope");
    expect(result.paths).toStrictEqual(["docs/proоf/x.cast"]);
    expect(result.text).toContain("non-ASCII/lookalike path cannot be reliably classified");
  });

  it("refuses a non-ASCII filename outside a proof directory", () => {
    const result = evaluatePublishGate({ changedPaths: ["docs/café.md"] });
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("paths-outside-scope");
    expect(result.text).toContain("rename it to ASCII");
  });

  it("classifies a non-ASCII filename under an ASCII proof directory as proof", () => {
    const result = evaluatePublishGate({ changedPaths: ["docs/proof/bd-181/café proof.png"] });
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("proof-artifacts-in-diff");
    expect(result.paths).toStrictEqual(["docs/proof/bd-181/café proof.png"]);
  });

  it("rejects backslash paths outright", () => {
    for (const path of ["src\\a.ts", "docs\\proof\\shot.png"]) {
      expect(isPublishablePath(path)).toBe(false);
    }
    const result = evaluatePublishGate({ changedPaths: ["src\\a.ts"] });
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toBe("paths-outside-scope");
  });

  it("bounds the refusal line but keeps every path in the result", () => {
    const changedPaths = Array.from(
      { length: 13 },
      (_unused, index) => `docs/proof/x/artifact-${String(index).padStart(2, "0")}.png`,
    );
    const result = evaluatePublishGate({ changedPaths });
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.paths).toHaveLength(13);
    expect(result.text).toContain("(+3 more");
    expect(result.text).toContain("`paths`");
    expect(result.text.split("\n")).toHaveLength(1);
    // The bounded list is a prefix of the deterministic sorted order.
    expect(result.text).toContain("artifact-00.png");
    expect(result.text).not.toContain("artifact-12.png");
  });
});
