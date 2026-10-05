import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Resolve the repo root from this test file's location (src/__tests__ -> repo root)
// rather than process.cwd(), so the test is invariant to the Vitest working directory.
const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, "..", "..");

function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

const flakePath = join(repoRoot, "flake.nix");
const packageJsonPath = join(repoRoot, "nix", "pi-extensions", "package.json");
const binPiPath = join(repoRoot, "bin", "pi");
const integrityPatchPath = join(repoRoot, "nix", "pi-web-integrity.patch");
const nixTmpPatchPath = join(repoRoot, "nix", "nix-tmp-belayd-pi-web.patch");

// Read once; a missing file surfaces a clear failure rather than a skip, because
// these files are the artifacts this regression guard exists to protect.
const flakeContents = readIfPresent(flakePath);
const packageJsonContents = readIfPresent(packageJsonPath);
const binPiContents = readIfPresent(binPiPath);
const integrityPatchContents = readIfPresent(integrityPatchPath);
const nixTmpPatchContents = readIfPresent(nixTmpPatchPath);

describe("bd-68: agent-browser extension wiring", () => {
  it("flake.nix is readable from the test file location", () => {
    if (flakeContents === null) {
      throw new Error(`could not read flake.nix at ${flakePath}`);
    }
    expect(typeof flakeContents).toBe("string");
    expect(flakeContents.length).toBeGreaterThan(0);
  });

  it("lists pi-agent-browser-native in the pi-extensions npm dependencies", () => {
    if (packageJsonContents === null) {
      throw new Error(`could not read package.json at ${packageJsonPath}`);
    }
    expect(packageJsonContents).toContain('"pi-agent-browser-native"');
  });

  it("puts the llm-agents agent-browser CLI on the shared devShell/service PATH", () => {
    if (flakeContents === null) {
      throw new Error(`could not read flake.nix at ${flakePath}`);
    }
    // `${system}` in flake.nix is Nix interpolation, not a JS template
    // placeholder. Assemble the expected substring from parts that never
    // spell out `${...}` in one literal, keeping biome's
    // noTemplateCurlyInString quiet without weakening the assertion.
    const nixSystemInterp = ["${", "system", "}"].join("");
    const devShellEntry = ["llm-agents.packages.", nixSystemInterp, ".agent-browser"].join("");
    // devShellTools feeds both devShells.default and pi-web-runtime-env, so this
    // one entry must be present for `agent-browser` to resolve for spawned agents.
    expect(flakeContents).toContain(devShellEntry);
  });

  it("routes devShellTools into all three devShell/service wiring points", () => {
    if (flakeContents === null) {
      throw new Error(`could not read flake.nix at ${flakePath}`);
    }
    // The tool entry alone is inert; it only reaches agents when the shared
    // devShellTools list is consumed by the devShell, the pi-web runtime env,
    // and is itself defined. A rename of devShellTools would break wiring while
    // keeping the agent-browser entry string intact, so all three anchors are
    // asserted together.
    expect(flakeContents).toContain("devShellTools = [");
    expect(flakeContents).toContain("paths = devShellTools ++ [");
    expect(flakeContents).toContain("packages = devShellTools ++ [");
  });

  it("loads the extension explicitly in the configured belayd-pi binary", () => {
    if (flakeContents === null) {
      throw new Error(`could not read flake.nix at ${flakePath}`);
    }
    // -ne disables discovery, so the store-path entry must be in the explicit list.
    expect(flakeContents).toContain(
      "pi-agent-browser-native/dist/extensions/agent-browser/index.js",
    );
  });

  it("exports pi-agent-browser-extension for the pi-web orchestrator symlink", () => {
    if (flakeContents === null) {
      throw new Error(`could not read flake.nix at ${flakePath}`);
    }
    // Actual packages output membership: the artifact must be in the packages
    // `inherit` (alongside pi-extensions), not merely mentioned in a comment or
    // at its attribute definition.
    expect(flakeContents).toMatch(
      /inherit[^;]*\bpi-extensions\b[^;]*\bpi-agent-browser-extension\b[^;]*;/,
    );
    // Structural wiring: the artifact is a runCommand derivation that builds
    // from the pi-agent-browser-native package nested in the pi-extensions tree.
    // Asserting derivation name + source path keeps a harmless variable rename
    // passing while a wiring regression still fails.
    expect(flakeContents).toContain('runCommand "pi-agent-browser-extension"');
    expect(flakeContents).toContain(
      "pi-extensions}/lib/node_modules/pi-extensions/node_modules/pi-agent-browser-native",
    );
  });

  it("loads the npm package in the isolated repo-dev wrapper", () => {
    if (binPiContents === null) {
      throw new Error(`could not read bin/pi at ${binPiPath}`);
    }
    expect(binPiContents).toContain("-e npm:pi-agent-browser-native@0.9.2");
  });
});

describe("bd-83: pi-web embeds pi-coding-agent >= 1.0 for agent-browser", () => {
  it("pins the pi-web upstream tag whose lockfile resolves pi-coding-agent 1.0.0", () => {
    if (flakeContents === null) {
      throw new Error(`could not read flake.nix at ${flakePath}`);
    }
    // The tag and rev must move together; a rev that still points at a
    // pi-coding-agent ^0.84.x/^0.87.x release would defeat the bump. These
    // literals are intentionally version-pinned: a future pi-web bump must
    // update flake.nix's tag+rev and this test in lockstep, so a half-updated
    // bump (new tag, stale rev) fails here.
    expect(flakeContents).toContain('version = "1.202610.1";');
    expect(flakeContents).toContain('rev = "3f5f39eb988810b468f486e4334f10adcdb96b21"');
  });

  it("fills in integrity for the nested @earendil-works 1.0.0 deps", () => {
    if (integrityPatchContents === null) {
      throw new Error(`could not read pi-web integrity patch at ${integrityPatchPath}`);
    }
    // prefetch-npm-deps refuses non-git deps without integrity; the upstream
    // lockfile omits it for pi-coding-agent's nested @earendil-works deps. Keep
    // the explicit known set so a wholesale hunk deletion (not just a dropped
    // integrity line) still fails.
    for (const dep of [
      "chord",
      "pi-agent-core",
      "pi-ai",
      "pi-codemode",
      "pi-mcp",
      "pi-telemetry",
      "pi-tui",
    ]) {
      expect(integrityPatchContents).toContain(
        `pi-coding-agent/node_modules/@earendil-works/${dep}`,
      );
    }

    // Parse the patch so a future nested @earendil-works dep added without an
    // integrity line fails here instead of at prefetch-npm-deps time: every
    // nested key hunk in the patch must carry exactly one added integrity line.
    const nestedKeyPattern =
      /^[ +-]\s*"node_modules\/@earendil-works\/pi-coding-agent\/node_modules\/@earendil-works\/([a-z-]+)": \{/;
    const nestedKeys: string[] = [];
    const integrityKeys: string[] = [];
    let currentDep: string | null = null;
    let currentHasIntegrity = false;
    const flushCurrentDep = () => {
      if (currentDep === null) return;
      nestedKeys.push(currentDep);
      if (currentHasIntegrity) integrityKeys.push(currentDep);
      currentDep = null;
      currentHasIntegrity = false;
    };
    for (const line of integrityPatchContents.split("\n")) {
      const keyMatch = line.match(nestedKeyPattern);
      if (keyMatch) {
        flushCurrentDep();
        currentDep = keyMatch[1] ?? null;
        continue;
      }
      if (currentDep !== null && /^\+.*"integrity": "sha512-/.test(line)) {
        currentHasIntegrity = true;
      }
    }
    flushCurrentDep();
    expect(nestedKeys.length).toBeGreaterThan(0);
    expect(integrityKeys).toEqual(nestedKeys);
  });

  it("records the nix-tmp home-manager symlink for the pi-web orchestrator", () => {
    if (nixTmpPatchContents === null) {
      throw new Error(`could not read nix-tmp patch at ${nixTmpPatchPath}`);
    }
    // The actual symlink lives in the separate nix-tmp repo; this in-tree patch
    // is the reviewable record, so deleting it would drop the only trace here.
    expect(nixTmpPatchContents).toContain(
      'home.file.".pi/agent/extensions/pi-agent-browser".source',
    );
    expect(nixTmpPatchContents).toContain("pi-agent-browser-extension");
  });
});
