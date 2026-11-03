import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Resolve the repo root from this test file's location (src/__tests__ -> repo
// root) rather than process.cwd(), so the test is invariant to the Vitest
// working directory.
const testDir = import.meta.dirname;
const repoRoot = join(testDir, "..", "..");
const skillPath = join(repoRoot, ".agents", "skills", "unslop", "SKILL.md");
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

// biome noTemplateCurlyInString would flag a literal `${unslop}` / `${...}`;
// assemble the placeholder from parts instead.
function interpolate(expression: string): string {
  return `\${${expression}}`;
}

function requireContents(value: string | null, path: string): string {
  if (value === null) throw new Error(`could not read ${path}`);
  return value;
}

/**
 * The entries of the `devShellTools` list, comments stripped.
 *
 * A bare `toContain("pkgs.ffmpeg")` over the whole flake is satisfied by any
 * mention — the comment that explains why ffmpeg is there, or a different
 * package list — so it cannot catch ffmpeg being dropped from the shell.
 */
function devShellTools(flake: string): string[] {
  const start = flake.indexOf("devShellTools = [");
  if (start === -1) throw new Error("flake.nix has no devShellTools list");
  const end = flake.indexOf("\n        ];", start);
  if (end === -1) throw new Error("flake.nix devShellTools list is not closed");
  // Entries may carry a trailing comment; a comment-only line must not count.
  return flake
    .slice(start, end)
    .split("\n")
    .map((line) => (line.split("#")[0] ?? "").trim())
    .filter((line) => line.length > 0);
}

describe("bd-253: unslop router skill", () => {
  it("ships the thin router skill", () => {
    const skill = requireContents(skillContents, skillPath);
    expect(skill.length).toBeGreaterThan(0);
  });

  it("declares `name: unslop` frontmatter and keeps the skill model-invocable", () => {
    const skill = requireContents(skillContents, skillPath);
    expect(skill.startsWith("---")).toBe(true);
    expect(skill).toContain("name: unslop");
    // A sub-agent has nobody to type /skill:unslop, so hiding the skill from
    // model selection would make it unreachable where it is most needed.
    expect(skill).not.toContain("disable-model-invocation");
  });

  it("copies the upstream description verbatim so the triggers still fire", () => {
    const skill = requireContents(skillContents, skillPath);
    const description = skill.split("\n").find((line) => line.startsWith("description:")) ?? "";
    for (const trigger of [
      "vibecoded",
      "AI-looking UI",
      "purple gradients",
      "emoji labels",
      "uneven spacing",
      "unslop",
      "React, Tailwind, HTML and CSS",
    ]) {
      expect(description).toContain(trigger);
    }
  });

  it("carries the CC BY 4.0 credit to the upstream author", () => {
    const skill = requireContents(skillContents, skillPath);
    expect(skill).toContain("Damir Sokolovsky");
    expect(skill).toContain("@heydamir");
    expect(skill).toContain("CC BY 4.0");
    expect(skill).toContain("Keep this credit in");
  });

  it("routes to the pinned upstream material instead of vendoring it", () => {
    const skill = requireContents(skillContents, skillPath);
    const normalized = skill.replaceAll(interpolate("UNSLOP_HOME"), "$UNSLOP_HOME");
    for (const referenced of [
      "$UNSLOP_HOME/SKILL.md",
      "$UNSLOP_HOME/references",
      "$UNSLOP_HOME/references/refs",
      "$UNSLOP_HOME/examples/dashboard.html",
      "$UNSLOP_HOME/examples/hero.html",
    ]) {
      expect(normalized).toContain(referenced);
    }
    // The reference images are read through the vision tool, not the router.
    expect(normalized).toContain("describe_image");
  });

  it("substitutes the harness wrappers for upstream's absolute /scripts paths", () => {
    const skill = requireContents(skillContents, skillPath);
    expect(skill).toContain("unslop-snapshot <url> <out.html>");
    expect(skill).toContain("unslop-story <story.html> <out.mp4>");
    expect(skill).toContain("NODE_PATH");
    // The substitution block keeps the wrappers on the harness side of the map.
    expect(skill).toContain("| Here |");
  });

  it("does not embed the upstream instructions", () => {
    const skill = requireContents(skillContents, skillPath);
    // Headings unique to the upstream SKILL.md that copying would reintroduce.
    expect(skill).not.toContain("## 1. Spacing");
    expect(skill).not.toContain("## Direction");
    expect(skill).not.toContain("## Story video");
  });

  it("names the missing-harness-shell and no-image-tool fallbacks", () => {
    const skill = requireContents(skillContents, skillPath);
    expect(skill).toContain("nix develop");
    expect(skill).toContain("No image-generation service");
  });
});

describe("bd-253: flake.nix unslop wiring", () => {
  it("flake.nix is readable from the test file location", () => {
    const flake = requireContents(flakeContents, flakePath);
    expect(flake.length).toBeGreaterThan(0);
  });

  it("pins upstream by rev and hash", () => {
    const flake = requireContents(flakeContents, flakePath);
    expect(flake).toContain('owner = "heydamir";');
    expect(flake).toContain('repo = "unslop";');
    expect(flake).toContain('rev = "a6f121eee5f29c2f74976b75456feae8b66afb3a";');
    // A placeholder hash means the pin was never resolved.
    expect(flake).not.toContain("hash = pkgs.lib.fakeHash;");
  });

  it("declares the unslop package output layout and its two wrappers", () => {
    const flake = requireContents(flakeContents, flakePath);
    expect(flake).toContain("$out/libexec/unslop/");
    expect(flake).toContain("$out/lib/node_modules/playwright-core/");
    expect(flake).toContain('export NODE_PATH="$out/lib/node_modules"');
    expect(flake).toContain("$out/bin/unslop-snapshot");
    expect(flake).toContain("$out/bin/unslop-story");
  });

  it("adds the unslop package to the flake outputs", () => {
    const flake = requireContents(flakeContents, flakePath);
    // The packages attribute is what `nix build .#unslop` resolves.
    expect(flake).toContain("\n            unslop\n");
  });

  it("puts ffmpeg and the unslop wrappers in devShellTools", () => {
    const flake = requireContents(flakeContents, flakePath);
    const tools = devShellTools(flake);
    // scripts/story.mjs hard-fails without ffmpeg, and the skill's own commands
    // resolve unslop-snapshot/unslop-story from the devShell PATH, so both have
    // to be entries of this list rather than merely mentioned in the flake.
    expect(tools).toContain("pkgs.ffmpeg");
    expect(tools).toContain("unslop");
  });

  it("declares unslop in the pi-web module let bindings", () => {
    const flake = requireContents(flakeContents, flakePath);
    const binding = `unslop = self.packages.${interpolate("system")}.unslop;`;
    expect(flake).toContain(binding);
  });

  it("adds UNSLOP_HOME to the pi-web module environment", () => {
    const flake = requireContents(flakeContents, flakePath);
    const entry = `"UNSLOP_HOME=${interpolate("unslop")}/libexec/unslop"`;
    expect(flake).toContain(entry);
  });

  it("exports UNSLOP_HOME in the devShell shellHook", () => {
    const flake = requireContents(flakeContents, flakePath);
    const exportLine = `export UNSLOP_HOME="${interpolate("unslop")}/libexec/unslop"`;
    expect(flake).toContain(exportLine);
  });
});
