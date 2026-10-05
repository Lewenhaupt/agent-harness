import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Resolve the repo root from this test file's location (src/__tests__ -> repo
// root) rather than process.cwd(), so the test is invariant to the Vitest
// working directory.
const testDir = import.meta.dirname;
const repoRoot = join(testDir, "..", "..");
const skillPath = join(repoRoot, ".agents", "skills", "archify", "SKILL.md");
const flakePath = join(repoRoot, "flake.nix");

// Both files are artifacts this regression guard exists to protect, so a
// missing file is surfaced as a clear failure rather than skipped.
let flakeContents: string | null = null;
let skillContents: string | null = null;
try {
  flakeContents = readFileSync(flakePath, "utf8");
} catch {
  flakeContents = null;
}
try {
  skillContents = readFileSync(skillPath, "utf8");
} catch {
  skillContents = null;
}

// biome noTemplateCurlyInString would flag a literal `${archify}` / `${...}`;
// assemble the placeholder from parts instead.
function interpolate(expression: string): string {
  return `\${${expression}}`;
}

function requireContents(value: string | null, path: string): string {
  if (value === null) throw new Error(`could not read ${path}`);
  return value;
}

describe("bd-87: archify skill + ARCHIFY_HOME", () => {
  it("ships the thin router skill", () => {
    const skill = requireContents(skillContents, skillPath);
    expect(skill.length).toBeGreaterThan(0);
  });

  it("declares `name: archify` frontmatter", () => {
    const skill = requireContents(skillContents, skillPath);
    expect(skill.startsWith("---")).toBe(true);
    expect(skill).toContain("name: archify");
    expect(skill).toContain("description:");
  });

  it("routes to the upstream assets under $ARCHIFY_HOME instead of vendoring them", () => {
    const skill = requireContents(skillContents, skillPath);
    const normalized = skill.replaceAll(interpolate("ARCHIFY_HOME"), "$ARCHIFY_HOME");
    for (const referenced of [
      "$ARCHIFY_HOME/SKILL.md",
      "$ARCHIFY_HOME/schemas",
      "$ARCHIFY_HOME/examples",
      "$ARCHIFY_HOME/references",
    ]) {
      expect(normalized).toContain(referenced);
    }
  });

  it("does not embed the upstream authoring contract", () => {
    const skill = requireContents(skillContents, skillPath);
    // Headings unique to the upstream SKILL.md that copying would reintroduce.
    expect(skill).not.toContain("## Type router");
    expect(skill).not.toContain("## Fast authoring path");
  });

  it("mentions the guidance commands and the excluded subcommands", () => {
    const skill = requireContents(skillContents, skillPath);
    expect(skill).toContain("command=guide");
    expect(skill).toContain("command=examples");
    expect(skill).toContain("9/9");
    expect(skill).toContain("visual-check");
    expect(skill).toContain("preview");
  });
});

describe("bd-87: flake.nix ARCHIFY_HOME wiring", () => {
  it("flake.nix is readable from the test file location", () => {
    const flake = requireContents(flakeContents, flakePath);
    expect(flake.length).toBeGreaterThan(0);
  });

  it("exports ARCHIFY_HOME from the archify wrapper", () => {
    const flake = requireContents(flakeContents, flakePath);
    expect(flake).toContain('export ARCHIFY_HOME="$out/libexec/archify"');
  });

  it("adds ARCHIFY_HOME to the pi-web module environment", () => {
    const flake = requireContents(flakeContents, flakePath);
    const entry = `"ARCHIFY_HOME=${interpolate("archify")}/libexec/archify"`;
    expect(flake).toContain(entry);
  });

  it("exports ARCHIFY_HOME in the devShell shellHook", () => {
    const flake = requireContents(flakeContents, flakePath);
    const exportLine = `export ARCHIFY_HOME="${interpolate("archify")}/libexec/archify"`;
    expect(flake).toContain(exportLine);
  });

  it("declares archify in the pi-web module let bindings", () => {
    const flake = requireContents(flakeContents, flakePath);
    const binding = `archify = self.packages.${interpolate("system")}.archify;`;
    expect(flake).toContain(binding);
  });
});
