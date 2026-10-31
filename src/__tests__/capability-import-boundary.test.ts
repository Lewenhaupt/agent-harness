/**
 * Capability import boundary + size ratchet (bd-179).
 *
 * The composer (`extensions/index.ts`) may import everything. Capability
 * modules under `extensions/capabilities/` may not reach the fleet supervisor
 * (`src/fleet-*.ts`, `src/fleet-state.ts` — except the explicitly allowlisted
 * fleet module) and may never reach the process gate (`src/process-gate.ts`),
 * allowlisted or not: they must stay callable without extension globals, which
 * is what the durable-member runtime and the PR publish path need.
 *
 * The checker (`src/capability-import-boundary.ts`) walks the transitive module
 * graph — imports, re-exports and literal dynamic imports — and fails closed on
 * anything it cannot resolve. Its unit tests below pin each rule over synthetic
 * module graphs, including the plain-import and re-export barrel chains.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  isForbiddenFleetImport,
  isForbiddenProcessGate,
  type ModuleGraphSeams,
  parseModuleReferences,
  resolveRelativeSpecifier,
  scanCapabilityModule,
} from "../capability-import-boundary.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const capabilitiesDir = join(repoRoot, "extensions/capabilities");

/**
 * Capability modules allowed to import fleet modules.
 *
 * The fleet capability owns the only fleet types the session state needs; every
 * other capability must stay fleet-free. Widening this set is a deliberate edit
 * here — a glob or directory-wide exemption would let any module drift back
 * into the fleet. Being listed never permits `src/process-gate.ts`.
 */
const FLEET_IMPORT_ALLOWLIST: ReadonlySet<string> = new Set(["extensions/capabilities/fleet.ts"]);

/**
 * Ceiling for the composer's line count, set ~50 above the achieved size.
 *
 * The target end state is a wiring file: the entry point, the
 * `harnessAlreadyLoaded` dedup, seam normalisation, the ordered
 * `register<Capability>` calls and the default export — no tool or hook body.
 * Every new capability line belongs in `extensions/capabilities/`, so reaching
 * that target is what keeps bd-179 from regressing into the 13k-line blast
 * radius it split. Raise this only for wiring, never for a capability body.
 */
const INDEX_MAX_LINES = 415;

const diskSeams: ModuleGraphSeams = {
  read: (repoRelativePath) => {
    try {
      return readFileSync(join(repoRoot, repoRelativePath), "utf8");
    } catch {
      return undefined;
    }
  },
  exists: (repoRelativePath) => existsSync(join(repoRoot, repoRelativePath)),
};

function capabilityModules(): string[] {
  if (!existsSync(capabilitiesDir)) return [];
  return readdirSync(capabilitiesDir)
    .filter((name) => name.endsWith(".ts"))
    .sort()
    .map((name) => `extensions/capabilities/${name}`);
}

function lineCount(source: string): number {
  return source.split("\n").length - (source.endsWith("\n") ? 1 : 0);
}

describe("capability import boundary (bd-179)", () => {
  it("has capability modules instead of the monolith", () => {
    const modules = capabilityModules();
    expect(existsSync(capabilitiesDir), "extensions/capabilities/ is missing").toBe(true);
    expect(modules.length, "extensions/capabilities/ has no modules").toBeGreaterThan(0);
    expect(modules).toContain("extensions/capabilities/context.ts");
  });

  it("no capability module reaches fleet or the process gate", () => {
    for (const entry of capabilityModules()) {
      const fleetAllowed = FLEET_IMPORT_ALLOWLIST.has(entry);
      const violations = scanCapabilityModule({ entry, seams: diskSeams, fleetAllowed });
      expect(
        violations,
        violations.map((violation) => `[${violation.kind}] ${violation.detail}`).join("\n"),
      ).toEqual([]);
    }
  });

  it("keeps the fleet-import allowlist explicit and minimal", () => {
    expect([...FLEET_IMPORT_ALLOWLIST].sort()).toEqual(["extensions/capabilities/fleet.ts"]);
  });

  it("keeps the composer under the size ratchet", () => {
    const source = readFileSync(join(repoRoot, "extensions/index.ts"), "utf8");
    const lines = lineCount(source);
    expect(
      lines,
      `extensions/index.ts is ${lines.toString()} lines (ceiling ${INDEX_MAX_LINES.toString()}); ` +
        "put new capability code in extensions/capabilities/ and register it from the composer",
    ).toBeLessThanOrEqual(INDEX_MAX_LINES);
  });
});

describe("capability import checker", () => {
  it("splits imports, re-exports and dynamic imports", () => {
    const references = parseModuleReferences(
      [
        'import { a } from "../../src/a.js";',
        'import type { B } from "../../src/b.js";',
        'import "../../src/side-effect.js";',
        'export * from "../../src/star.js";',
        'export { c } from "../../src/c.js";',
        'export type { D } from "../../src/d.js";',
        'const lazy = await import("../../src/lazy.js");',
      ].join("\n"),
    );
    expect(references.imports.map((edge) => edge.specifier)).toEqual([
      "../../src/a.js",
      "../../src/side-effect.js",
    ]);
    expect(references.typeImports.map((edge) => edge.specifier)).toEqual(["../../src/b.js"]);
    expect(references.reexports.map((edge) => edge.specifier)).toEqual([
      "../../src/star.js",
      "../../src/c.js",
      "../../src/d.js",
    ]);
    expect(references.dynamicImports.map((edge) => edge.specifier)).toEqual(["../../src/lazy.js"]);
    expect(references.nonLiteralDynamicImports).toEqual([]);
  });

  it("resolves .js specifiers to .ts and bare directories to index.ts", () => {
    const present = new Set(["src/a.ts", "src/dir/index.ts"]);
    const exists = (path: string) => present.has(path);
    expect(resolveRelativeSpecifier("extensions/capabilities/x.ts", "../../src/a.js", exists)).toBe(
      "src/a.ts",
    );
    expect(resolveRelativeSpecifier("extensions/capabilities/x.ts", "../../src/dir", exists)).toBe(
      "src/dir/index.ts",
    );
    expect(
      resolveRelativeSpecifier("extensions/capabilities/x.ts", "../../src/missing.js", exists),
    ).toBeNull();
    expect(resolveRelativeSpecifier("extensions/capabilities/x.ts", "typebox", exists)).toBeNull();
  });

  it("names the process gate and fleet modules as forbidden, and nothing else", () => {
    expect(isForbiddenProcessGate("src/process-gate.ts")).toBe(true);
    expect(isForbiddenProcessGate("src/fleet-accept.ts")).toBe(false);
    expect(isForbiddenFleetImport("src/fleet-accept.ts")).toBe(true);
    expect(isForbiddenFleetImport("src/fleet-state.ts")).toBe(true);
    expect(isForbiddenFleetImport("src/process-gate.ts")).toBe(false);
    expect(isForbiddenFleetImport("src/archify.ts")).toBe(false);
    expect(isForbiddenFleetImport("src/aws-broker/plan.ts")).toBe(false);
    expect(isForbiddenFleetImport("extensions/capabilities/fleet.ts")).toBe(false);
  });

  it("reports a direct forbidden import", () => {
    const seams = fixtureSeams({
      "extensions/capabilities/x.ts": 'import { g } from "../../src/process-gate.js";',
      "src/process-gate.ts": "export const g = 1;",
    });
    const violations = scanCapabilityModule({
      entry: "extensions/capabilities/x.ts",
      seams,
      fleetAllowed: false,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.kind).toBe("process-gate");
    expect(violations[0]?.chain).toEqual(["extensions/capabilities/x.ts", "src/process-gate.ts"]);
  });

  it("follows a plain-import chain to the process gate", () => {
    // The real bug this rule caught: doctor.ts -> tool-audit.ts -> process-gate.
    const seams = fixtureSeams({
      "extensions/capabilities/doctor.ts": 'import { audit } from "../../src/tool-audit.js";',
      "src/tool-audit.ts": 'import { ALL_PHASE_TOOLS } from "./process-gate.js";',
      "src/process-gate.ts": "export const ALL_PHASE_TOOLS = [];",
    });
    const violations = scanCapabilityModule({
      entry: "extensions/capabilities/doctor.ts",
      seams,
      fleetAllowed: false,
    });
    expect(violations.map((violation) => violation.kind)).toEqual(["process-gate"]);
    expect(violations[0]?.chain).toEqual([
      "extensions/capabilities/doctor.ts",
      "src/tool-audit.ts",
      "src/process-gate.ts",
    ]);
  });

  it("follows a re-export barrel to a forbidden module", () => {
    const seams = fixtureSeams({
      "extensions/capabilities/x.ts": 'import { anything } from "../../src/index.js";',
      "src/index.ts": [
        'export { helper } from "./workflow-registry.js";',
        'export * from "./fleet-accept.js";',
      ].join("\n"),
      "src/workflow-registry.ts": "export const helper = 1;",
      "src/fleet-accept.ts": "export const accept = 1;",
    });
    const violations = scanCapabilityModule({
      entry: "extensions/capabilities/x.ts",
      seams,
      fleetAllowed: false,
    });
    expect(violations.map((violation) => violation.kind)).toEqual(["fleet"]);
    expect(violations[0]?.chain).toEqual([
      "extensions/capabilities/x.ts",
      "src/index.ts",
      "src/fleet-accept.ts",
    ]);
  });

  it("lets an allowlisted fleet module import fleet code but never the process gate", () => {
    const seams = fixtureSeams({
      "extensions/capabilities/fleet.ts": [
        'import { accept } from "../../src/fleet-accept.js";',
        'import { g } from "../../src/process-gate.js";',
      ].join("\n"),
      "src/fleet-accept.ts": "export const accept = 1;",
      "src/process-gate.ts": "export const g = 1;",
    });
    const fleetAllowed = scanCapabilityModule({
      entry: "extensions/capabilities/fleet.ts",
      seams,
      fleetAllowed: true,
    });
    // The fleet import passes; the gate does not.
    expect(fleetAllowed.map((violation) => violation.kind)).toEqual(["process-gate"]);
    expect(
      scanCapabilityModule({
        entry: "extensions/capabilities/fleet.ts",
        seams,
        fleetAllowed: false,
      }).map((violation) => violation.kind),
    ).toEqual(["fleet", "process-gate"]);
  });

  it("fails closed on an unresolvable relative specifier", () => {
    const seams = fixtureSeams({
      "extensions/capabilities/x.ts": 'import { a } from "../../src/typo.js";',
    });
    const violations = scanCapabilityModule({
      entry: "extensions/capabilities/x.ts",
      seams,
      fleetAllowed: false,
    });
    expect(violations.map((violation) => violation.kind)).toEqual(["unresolvable-specifier"]);
    expect(violations[0]?.detail).toContain("../../src/typo.js");
  });

  it("fails closed on an unreadable module", () => {
    const files: Record<string, string> = {
      "extensions/capabilities/x.ts": 'import { a } from "../../src/a.js";',
      "src/a.ts": "export const a = 1;",
    };
    // The file exists but cannot be read: the scan must not treat that as "no
    // imports to worry about".
    const seams: ModuleGraphSeams = {
      read: (repoRelativePath) =>
        repoRelativePath === "src/a.ts" ? undefined : files[repoRelativePath],
      exists: (repoRelativePath) => repoRelativePath in files,
    };
    const violations = scanCapabilityModule({
      entry: "extensions/capabilities/x.ts",
      seams,
      fleetAllowed: false,
    });
    expect(violations.map((violation) => violation.kind)).toEqual(["unreadable-module"]);
    expect(violations[0]?.detail).toContain("src/a.ts");
  });

  it("follows a literal dynamic import and reports a non-literal one", () => {
    const seams = fixtureSeams({
      "extensions/capabilities/lazy.ts": 'const m = await import("../../src/fleet-accept.js");',
      "extensions/capabilities/opaque.ts": "const m = await import(someVariable);",
      "src/fleet-accept.ts": "export const accept = 1;",
    });
    expect(
      scanCapabilityModule({
        entry: "extensions/capabilities/lazy.ts",
        seams,
        fleetAllowed: false,
      }).map((violation) => violation.kind),
    ).toEqual(["fleet"]);
    expect(
      scanCapabilityModule({
        entry: "extensions/capabilities/opaque.ts",
        seams,
        fleetAllowed: false,
      }).map((violation) => violation.kind),
    ).toEqual(["dynamic-non-literal"]);
  });

  it("ends a statement at the first semicolon so a trailing decoy cannot steal the specifier", () => {
    // A line-based parser keeps the rest of the line in the same statement, so
    // the `from "./benign.js"` inside the trailing string is its FIRST
    // `FROM_CLAUSE` match and the forbidden bare import disappears from the
    // scan. Verified against that implementation: it reported `./benign.js`
    // and never saw `../../src/process-gate.js`.
    const seams = fixtureSeams({
      "extensions/capabilities/x.ts": [
        'import "../../src/side-effect.js"; // note; keep this',
        'import "../../src/process-gate.js"; const decoy = "from \'./benign.js\'";',
      ].join("\n"),
      "src/side-effect.ts": "export {};",
      "src/process-gate.ts": "export const g = 1;",
    });
    const violations = scanCapabilityModule({
      entry: "extensions/capabilities/x.ts",
      seams,
      fleetAllowed: false,
    });
    expect(violations.map((violation) => violation.kind)).toEqual(["process-gate"]);
  });

  it("does not treat a regex literal containing quotes as an opening string", () => {
    // A regex body may contain quotes. Reading one as an opening quote makes the
    // scanner consume the following literal `import("…")` as string content, so
    // the dynamic edge — and its forbidden target — disappears. Verified against
    // the pre-regex implementation: it found no literal dynamic import here.
    const source = [
      "const quotes = /[\"']/;",
      'const loader = await import("../../src/fleet-accept.js");',
      'import { g } from "../../src/process-gate.js";',
    ].join("\n");
    const references = parseModuleReferences(source);
    expect(references.dynamicImports.map((edge) => edge.specifier)).toEqual([
      "../../src/fleet-accept.js",
    ]);
    expect(references.imports.map((edge) => edge.specifier)).toEqual(["../../src/process-gate.js"]);
    const seams = fixtureSeams({
      "extensions/capabilities/y.ts": source,
      "src/process-gate.ts": "export const g = 1;",
      "src/fleet-accept.ts": "export const accept = 1;",
    });
    expect(
      scanCapabilityModule({
        entry: "extensions/capabilities/y.ts",
        seams,
        fleetAllowed: false,
      }).map((violation) => violation.kind),
    ).toEqual(["process-gate", "fleet"]);
  });

  it("reports a concatenated dynamic-import argument instead of dropping it", () => {
    // A quoted argument that is not the whole call argument is dynamic: the
    // header promises the check fails closed, so it must be reported.
    const references = parseModuleReferences('const m = await import("./" + suffix + ".js");');
    expect(references.dynamicImports).toEqual([]);
    expect(references.nonLiteralDynamicImports).toEqual(['"./" + suffix + ".js"']);
    const seams = fixtureSeams({
      "extensions/capabilities/z.ts": 'const m = await import("./" + suffix + ".js");',
    });
    expect(
      scanCapabilityModule({
        entry: "extensions/capabilities/z.ts",
        seams,
        fleetAllowed: false,
      }).map((violation) => violation.kind),
    ).toEqual(["dynamic-non-literal"]);
  });

  it("does not report import( inside a doc comment or string as a dynamic import", () => {
    const references = parseModuleReferences(
      [
        "/**",
        " * Resolve the module with await import(variable) when needed.",
        ' * The literal form is import("../../src/a.js").',
        " */",
        'const label = "call import(dynamicThing) instead";',
        'const real = await import("../../src/b.js");',
      ].join("\n"),
    );
    expect(references.nonLiteralDynamicImports).toEqual([]);
    expect(references.dynamicImports.map((edge) => edge.specifier)).toEqual(["../../src/b.js"]);
  });

  it("does not follow type-only imports of intermediates", () => {
    // Type-only edges are erased at runtime, so naming a gate type from an
    // intermediate module is not a runtime reach; a capability's own type import
    // of a forbidden module is still a violation.
    const seams = fixtureSeams({
      "extensions/capabilities/x.ts": 'import { helper } from "../../src/registry.js";',
      "src/registry.ts":
        'import type { Phase } from "./process-gate.js";\nexport const helper = 1;',
      "src/process-gate.ts": "export type Phase = string;",
    });
    expect(
      scanCapabilityModule({
        entry: "extensions/capabilities/x.ts",
        seams,
        fleetAllowed: false,
      }),
    ).toEqual([]);

    const direct = fixtureSeams({
      "extensions/capabilities/y.ts": 'import type { Phase } from "../../src/process-gate.js";',
      "src/process-gate.ts": "export type Phase = string;",
    });
    expect(
      scanCapabilityModule({
        entry: "extensions/capabilities/y.ts",
        seams: direct,
        fleetAllowed: false,
      }).map((violation) => violation.kind),
    ).toEqual(["process-gate"]);
  });
});

function fixtureSeams(files: Record<string, string>): ModuleGraphSeams {
  return {
    read: (repoRelativePath) => files[repoRelativePath],
    exists: (repoRelativePath) => repoRelativePath in files,
  };
}
