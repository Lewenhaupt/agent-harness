import { describe, expect, it } from "vitest";
import {
  ARCHIFY_COMMANDS,
  ARCHIFY_DIAGRAM_TYPES,
  ARCHIFY_QUALITY_PROFILES,
  buildArchifyArgs,
  formatArchifyResult,
  isArchifyCommand,
  isArchifyDiagramType,
  isArchifyQuality,
  parseArchifyReceipt,
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
