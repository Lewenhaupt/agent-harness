import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ARCHIFY_COMMANDS,
  ARCHIFY_DIAGRAM_TYPES,
  ARCHIFY_GUIDANCE_COMMANDS,
  ARCHIFY_QUALITY_PROFILES,
  ARCHIFY_TOOL_COMMANDS,
  buildArchifyArgs,
  buildArchifyCheckArgs,
  buildArchifyGuideArgs,
  buildArchifyInspectArgs,
  formatArchifyIgnoredParamsNote,
  formatArchifyResult,
  ignoredArchifyParams,
  isArchifyCommand,
  isArchifyDiagramType,
  isArchifyQuality,
  isArchifyToolCommand,
  listArchifyExamples,
  parseArchifyReceipt,
  resolveArchifyHome,
} from "../archify.js";

describe("buildArchifyArgs", () => {
  it("defaults deliver to the showcase quality profile and requests JSON", () => {
    expect(
      buildArchifyArgs({
        command: "deliver",
        type: "workflow",
        input: "in.json",
        output: "out.html",
      }),
    ).toEqual(["deliver", "workflow", "in.json", "out.html", "--quality", "showcase", "--json"]);
  });

  it("honors an explicit quality profile", () => {
    expect(
      buildArchifyArgs({
        command: "deliver",
        type: "workflow",
        input: "in.json",
        output: "out.html",
        quality: "standard",
      }),
    ).toEqual(["deliver", "workflow", "in.json", "out.html", "--quality", "standard", "--json"]);
  });

  it("appends --repo-root when provided", () => {
    expect(
      buildArchifyArgs({
        command: "validate",
        type: "architecture",
        input: "in.json",
        repoRoot: "/repo",
      }),
    ).toEqual([
      "validate",
      "architecture",
      "in.json",
      "--quality",
      "showcase",
      "--repo-root",
      "/repo",
      "--json",
    ]);
  });

  it("builds render and validate forms", () => {
    // Upstream `render` silently ignores --json, so the fallback omits it.
    expect(
      buildArchifyArgs({
        command: "render",
        type: "sequence",
        input: "in.json",
        output: "out.html",
      }),
    ).toEqual(["render", "sequence", "in.json", "out.html", "--quality", "showcase"]);
    expect(buildArchifyArgs({ command: "validate", type: "lifecycle", input: "in.json" })).toEqual([
      "validate",
      "lifecycle",
      "in.json",
      "--quality",
      "showcase",
      "--json",
    ]);
  });

  it("omits output when it is not provided", () => {
    expect(buildArchifyArgs({ command: "deliver", type: "dataflow", input: "in.json" })).toEqual([
      "deliver",
      "dataflow",
      "in.json",
      "--quality",
      "showcase",
      "--json",
    ]);
  });

  it("lets callers override the --json decision", () => {
    expect(
      buildArchifyArgs({
        command: "render",
        type: "architecture",
        input: "in.json",
        output: "out.html",
        json: true,
      }),
    ).toContain("--json");
    expect(
      buildArchifyArgs({ command: "deliver", type: "architecture", input: "in.json", json: false }),
    ).not.toContain("--json");
  });
});

describe("parseArchifyReceipt", () => {
  it("parses a deliver receipt (validation shape)", () => {
    const stdout = JSON.stringify({
      schemaVersion: 1,
      ok: true,
      command: "deliver",
      type: "workflow",
      input: "/tmp/in.json",
      output: "/tmp/out.html",
      specification: { sha256: "spec-hash", bytes: 5687 },
      artifact: { sha256: "artifact-hash", bytes: 723032 },
      validation: {
        checksPassed: 9,
        checkCount: 9,
        compositionProfile: "showcase",
        compositionStatus: "pass",
        errors: 0,
        warnings: 0,
      },
    });

    const parsed = parseArchifyReceipt(stdout);

    expect(parsed).toHaveProperty("ok", true);
    if (!parsed.ok) throw new Error("expected a parsed receipt");
    expect(parsed.receipt).toHaveProperty("ok", true);
    expect(parsed.receipt).toHaveProperty("command", "deliver");
    expect(parsed.receipt).toHaveProperty("artifact.sha256", "artifact-hash");
    expect(parsed.receipt).toHaveProperty("validation.checksPassed", 9);
    expect(parsed.receipt).toHaveProperty("validation.checkCount", 9);
  });

  it("normalizes the real validate receipt shape (checks + composition)", () => {
    const stdout = JSON.stringify({
      schemaVersion: 1,
      ok: true,
      command: "validate",
      type: "architecture",
      input: "/tmp/in.json",
      checks: [
        { name: "single_svg", ok: true, details: [] },
        { name: "finite_svg", ok: true, details: [] },
        { name: "label_route_clearance", ok: false, details: ["too close"] },
      ],
      composition: {
        schemaVersion: 1,
        profile: "standard",
        status: "warn",
        summary: { errors: 0, warnings: 1 },
      },
    });

    const parsed = parseArchifyReceipt(stdout);

    expect(parsed).toHaveProperty("ok", true);
    if (!parsed.ok) throw new Error("expected a parsed receipt");
    expect(parsed.receipt.validation).toHaveProperty("checksPassed", 2);
    expect(parsed.receipt.validation).toHaveProperty("checkCount", 3);
    expect(parsed.receipt.validation).toHaveProperty("compositionProfile", "standard");
    expect(parsed.receipt.validation).toHaveProperty("compositionStatus", "warn");
    expect(parsed.receipt.validation).toHaveProperty("warnings", 1);
  });

  it("parses a failed receipt with stage and diagnostics", () => {
    const stdout = JSON.stringify({
      schemaVersion: 1,
      ok: false,
      command: "validate",
      stage: "render",
      type: "workflow",
      input: "/tmp/bad.json",
      error: "workflow schema validation failed",
      diagnostics: [
        {
          code: "schema/required",
          severity: "error",
          message: "must have required property 'schema_version'",
          subject: { diagramType: "workflow", path: "/" },
          evidence: { keyword: "required" },
          supportedFixes: ['add required property "schema_version"'],
        },
      ],
    });

    const parsed = parseArchifyReceipt(stdout);

    expect(parsed).toHaveProperty("ok", true);
    if (!parsed.ok) throw new Error("expected a parsed receipt");
    expect(parsed.receipt).toHaveProperty("ok", false);
    expect(parsed.receipt).toHaveProperty("stage", "render");
    expect(parsed.receipt.diagnostics).toHaveLength(1);
    expect(parsed.receipt.diagnostics[0]).toHaveProperty("code", "schema/required");
  });

  it("rejects empty stdout", () => {
    expect(parseArchifyReceipt("   \n")).toHaveProperty("ok", false);
  });

  it("rejects non-JSON stdout", () => {
    expect(parseArchifyReceipt("not json at all")).toHaveProperty("ok", false);
  });

  it("rejects JSON without an ok discriminator", () => {
    expect(parseArchifyReceipt('{"command":"deliver"}')).toHaveProperty("ok", false);
  });
});

describe("formatArchifyResult", () => {
  it("summarizes a successful receipt", () => {
    const text = formatArchifyResult({
      ok: true,
      receipt: {
        schemaVersion: 1,
        ok: true,
        command: "deliver",
        type: "workflow",
        input: "/tmp/in.json",
        output: "/tmp/out.html",
        stage: undefined,
        error: undefined,
        specification: { sha256: "spec-hash", bytes: 10 },
        artifact: { sha256: "artifact-hash", bytes: 20 },
        validation: {
          checksPassed: 9,
          checkCount: 9,
          compositionProfile: "showcase",
          compositionStatus: "pass",
          errors: 0,
          warnings: 0,
        },
        diagnostics: [],
      },
    });

    expect(text).toContain("archify deliver workflow: ok");
    expect(text).toContain("artifact: /tmp/out.html");
    expect(text).toContain("sha256: artifact-hash");
    expect(text).toContain("validation: 9/9 checks passed, showcase, pass");
  });

  it("renders failure diagnostics with stage and supported fixes", () => {
    const text = formatArchifyResult({
      ok: true,
      receipt: {
        schemaVersion: 1,
        ok: false,
        command: "validate",
        type: "workflow",
        input: "/tmp/bad.json",
        output: undefined,
        stage: "render",
        error: "schema validation failed",
        specification: undefined,
        artifact: undefined,
        validation: undefined,
        diagnostics: [
          {
            code: "schema/required",
            severity: "error",
            message: "must have required property 'schema_version'",
            subject: { diagramType: "workflow", path: "/" },
            evidence: undefined,
            supportedFixes: ['add required property "schema_version"'],
          },
        ],
      },
    });

    expect(text).toContain("archify validate workflow: failed");
    expect(text).toContain("stage: render");
    expect(text).toContain("error: schema validation failed");
    expect(text).toContain(
      "schema/required: must have required property 'schema_version' (diagramType=workflow, path=/)",
    );
    expect(text).toContain('fix: add required property "schema_version"');
  });

  it("tolerates a receipt missing optional fields", () => {
    const text = formatArchifyResult({
      ok: true,
      receipt: {
        schemaVersion: 1,
        ok: true,
        command: "validate",
        type: undefined,
        input: undefined,
        output: undefined,
        stage: undefined,
        error: undefined,
        specification: undefined,
        artifact: undefined,
        validation: undefined,
        diagnostics: [],
      },
    });

    expect(text).toContain("archify validate: ok");
    expect(text).not.toContain("artifact:");
    expect(text).not.toContain("validation:");
  });

  it("renders a transport error", () => {
    expect(formatArchifyResult({ ok: false, error: "archify not found" })).toContain(
      "archify: failed",
    );
  });
});

describe("type guards", () => {
  it("accepts every declared diagram type", () => {
    for (const type of ARCHIFY_DIAGRAM_TYPES) {
      expect(isArchifyDiagramType(type)).toBe(true);
    }
  });

  it("rejects an unknown diagram type", () => {
    expect(isArchifyDiagramType("flowchart")).toBe(false);
  });

  it("accepts every declared command and quality profile", () => {
    for (const command of ARCHIFY_COMMANDS) {
      expect(isArchifyCommand(command)).toBe(true);
    }
    for (const profile of ARCHIFY_QUALITY_PROFILES) {
      expect(isArchifyQuality(profile)).toBe(true);
    }
  });

  it("rejects unknown commands and quality profiles", () => {
    expect(isArchifyCommand("preview")).toBe(false);
    expect(isArchifyQuality("deluxe")).toBe(false);
  });
});

describe("guidance command args", () => {
  it("defaults guide to --json and omits scenario/lang when absent", () => {
    expect(buildArchifyGuideArgs({})).toEqual(["guide", "--json"]);
  });

  it("passes a scenario positionally and --lang when provided", () => {
    expect(buildArchifyGuideArgs({ scenario: "login flow", lang: "fr" })).toEqual([
      "guide",
      "login flow",
      "--lang",
      "fr",
      "--json",
    ]);
  });

  it("lets callers opt out of --json", () => {
    expect(buildArchifyGuideArgs({ json: false })).toEqual(["guide"]);
  });

  it("places --lang between the scenario slot and --json when only lang is given", () => {
    expect(buildArchifyGuideArgs({ lang: "fr" })).toEqual(["guide", "--lang", "fr", "--json"]);
  });

  it("omits --json even with scenario and lang when json is false", () => {
    expect(buildArchifyGuideArgs({ scenario: "login flow", lang: "fr", json: false })).toEqual([
      "guide",
      "login flow",
      "--lang",
      "fr",
    ]);
  });

  it("builds inspect and check argv", () => {
    expect(buildArchifyInspectArgs({ type: "architecture", input: "in.json" })).toEqual([
      "inspect",
      "architecture",
      "in.json",
    ]);
    expect(buildArchifyCheckArgs("out.html")).toEqual(["check", "out.html"]);
  });
});

describe("tool command surface", () => {
  it("composes renderer + guidance commands", () => {
    expect(ARCHIFY_TOOL_COMMANDS).toHaveLength(7);
    for (const command of ARCHIFY_COMMANDS) expect(ARCHIFY_TOOL_COMMANDS).toContain(command);
    for (const command of ARCHIFY_GUIDANCE_COMMANDS) {
      expect(ARCHIFY_TOOL_COMMANDS).toContain(command);
    }
  });

  it("keeps isArchifyCommand as the renderer guard (rejects guidance + preview)", () => {
    expect(isArchifyCommand("guide")).toBe(false);
    expect(isArchifyCommand("examples")).toBe(false);
    expect(isArchifyCommand("inspect")).toBe(false);
    expect(isArchifyCommand("check")).toBe(false);
    expect(isArchifyCommand("preview")).toBe(false);
  });

  it("accepts guidance commands through isArchifyToolCommand", () => {
    for (const command of ARCHIFY_TOOL_COMMANDS) {
      expect(isArchifyToolCommand(command)).toBe(true);
    }
    expect(isArchifyToolCommand("preview")).toBe(false);
    expect(isArchifyToolCommand("visual-check")).toBe(false);
  });
});

describe("ignoredArchifyParams", () => {
  it("reports supplied params a guide invocation does not consume", () => {
    expect(
      ignoredArchifyParams("guide", {
        scenario: "login flow",
        quality: "showcase",
        repoRoot: "/repo",
      }),
    ).toEqual(["quality", "repoRoot"]);
  });

  it("treats every param as ignored for examples", () => {
    expect(
      ignoredArchifyParams("examples", {
        type: "architecture",
        input: "in.json",
        output: "out.html",
        scenario: "x",
      }),
    ).toEqual(["type", "input", "output", "scenario"]);
  });

  it("keeps input for check but not type/output/quality/repoRoot", () => {
    expect(
      ignoredArchifyParams("check", {
        input: "out.html",
        type: "architecture",
        output: "out.html",
        quality: "standard",
        repoRoot: "/repo",
      }),
    ).toEqual(["type", "output", "quality", "repoRoot"]);
  });

  it("keeps type and input for inspect", () => {
    expect(
      ignoredArchifyParams("inspect", {
        type: "architecture",
        input: "in.json",
        output: "out.html",
        quality: "showcase",
        repoRoot: "/repo",
      }),
    ).toEqual(["output", "quality", "repoRoot"]);
  });

  it("returns an empty list when nothing irrelevant was supplied", () => {
    expect(ignoredArchifyParams("guide", { scenario: "login flow" })).toEqual([]);
    expect(ignoredArchifyParams("examples", {})).toEqual([]);
  });
});

describe("formatArchifyIgnoredParamsNote", () => {
  it("returns an empty string when nothing was ignored", () => {
    expect(formatArchifyIgnoredParamsNote("guide", [])).toBe("");
  });

  it("lists the ignored params in backticks with the command", () => {
    expect(formatArchifyIgnoredParamsNote("guide", ["quality", "repoRoot"])).toBe(
      "\n\nnote: `quality`, `repoRoot` ignored for command=guide.",
    );
  });
});

describe("resolveArchifyHome", () => {
  it("errors when ARCHIFY_HOME is unset", () => {
    const result = resolveArchifyHome({});
    expect(result).toHaveProperty("ok", false);
    if (result.ok) throw new Error("expected a failure result");
    expect(result.error).toContain("ARCHIFY_HOME is not set");
  });

  it("errors when ARCHIFY_HOME is empty/whitespace", () => {
    expect(resolveArchifyHome({ ARCHIFY_HOME: "  " })).toHaveProperty("ok", false);
  });

  it("returns the home path when set", () => {
    const result = resolveArchifyHome({ ARCHIFY_HOME: "/nix/store/x/libexec/archify" });
    expect(result).toHaveProperty("ok", true);
    if (!result.ok) throw new Error("expected a home result");
    expect(result.home).toBe("/nix/store/x/libexec/archify");
  });

  it("returns the value untrimmed when it is non-blank (callers must export it clean)", () => {
    // Documented behavior: only a fully blank value is rejected; surrounding
    // whitespace of a non-blank value is preserved, not trimmed.
    const result = resolveArchifyHome({ ARCHIFY_HOME: "  /nix/store/x/libexec/archify \n" });
    expect(result).toHaveProperty("ok", true);
    if (!result.ok) throw new Error("expected a home result");
    expect(result.home).toBe("  /nix/store/x/libexec/archify \n");
  });
});

describe("listArchifyExamples", () => {
  let tmpRoot: string | undefined;

  afterEach(() => {
    if (tmpRoot !== undefined) rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = undefined;
  });

  it("returns sorted absolute paths for *.json files only", () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "belayd-archify-examples-"));
    const examplesDir = join(tmpRoot, "examples");
    mkdirSync(examplesDir);
    writeFileSync(join(examplesDir, "b.workflow.json"), "{}");
    writeFileSync(join(examplesDir, "a.architecture.json"), "{}");
    writeFileSync(join(examplesDir, "b.workflow.html"), "<html>");

    const result = listArchifyExamples(tmpRoot);
    expect(result).toHaveProperty("ok", true);
    if (!result.ok) throw new Error("expected an examples result");
    expect(result.examples).toEqual([
      join(examplesDir, "a.architecture.json"),
      join(examplesDir, "b.workflow.json"),
    ]);
  });

  it("errors when the examples directory is missing", () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "belayd-archify-examples-"));
    const result = listArchifyExamples(tmpRoot);
    expect(result).toHaveProperty("ok", false);
    if (result.ok) throw new Error("expected a failure result");
    expect(result.error).toContain("could not read archify examples");
  });

  it("names the unreadable directory in the failure message", () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "belayd-archify-examples-"));
    const result = listArchifyExamples(tmpRoot);
    expect(result).toHaveProperty("ok", false);
    if (result.ok) throw new Error("expected a failure result");
    expect(result.error).toContain(join(tmpRoot, "examples"));
    // The underlying fs error (ENOENT) is surfaced, not swallowed.
    expect(result.error).toContain("ENOENT");
  });

  it("returns an empty list (not an error) for an empty examples directory", () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "belayd-archify-examples-"));
    mkdirSync(join(tmpRoot, "examples"));

    const result = listArchifyExamples(tmpRoot);
    expect(result).toHaveProperty("ok", true);
    if (!result.ok) throw new Error("expected an examples result");
    expect(result.examples).toEqual([]);
  });

  it("lists a directory named *.json alongside files (name-based filter only)", () => {
    // Documented behavior: filtering is by name suffix (`endsWith(".json")`),
    // with no stat-based file/directory check, so a subdirectory named
    // `*.json` is listed too. Assert it explicitly so a future change to
    // stat-based filtering must consciously update this expectation.
    tmpRoot = mkdtempSync(join(tmpdir(), "belayd-archify-examples-"));
    const examplesDir = join(tmpRoot, "examples");
    mkdirSync(examplesDir);
    mkdirSync(join(examplesDir, "b.subdir.json"));
    writeFileSync(join(examplesDir, "a.architecture.json"), "{}");

    const result = listArchifyExamples(tmpRoot);
    expect(result).toHaveProperty("ok", true);
    if (!result.ok) throw new Error("expected an examples result");
    expect(result.examples).toEqual([
      join(examplesDir, "a.architecture.json"),
      join(examplesDir, "b.subdir.json"),
    ]);
  });
});
