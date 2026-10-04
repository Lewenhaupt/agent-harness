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

// Read once; a missing file surfaces a clear failure rather than a skip, because
// these files are the artifacts this regression guard exists to protect.
const flakeContents = readIfPresent(flakePath);
const packageJsonContents = readIfPresent(packageJsonPath);
const binPiContents = readIfPresent(binPiPath);

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
