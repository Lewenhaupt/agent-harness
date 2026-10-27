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

  it("loads the extension through the derived manifest list in belayd-pi", () => {
    if (flakeContents === null || packageJsonContents === null) {
      throw new Error("could not read flake.nix or nix/pi-extensions/package.json");
    }
    // bd-131: the entry path lives in the manifest next to its dependency, and
    // flake.nix derives the -e list from it. -ne still disables discovery, so
    // the derived list is the only thing that loads extensions.
    expect(packageJsonContents).toContain(
      '"pi-agent-browser-native": "dist/extensions/agent-browser/index.js"',
    );
    expect(flakeContents).toContain("piExtensionManifest.piExtensions");
    expect(flakeContents).toContain("thirdPartyExtensionPaths");
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

  it("resolves the package from the Nix tree in the isolated repo-dev wrapper", () => {
    if (binPiContents === null) {
      throw new Error(`could not read bin/pi at ${binPiPath}`);
    }
    // bd-131: bin/pi no longer pins an npm spec at runtime (that fetch silently
    // produced a smaller tool set under PI_OFFLINE=1); it reads the manifest and
    // resolves against the store tree the devShell exports.
    expect(binPiContents).toContain("BELAYD_PI_EXTENSIONS_DIR");
    expect(binPiContents).toContain("nix/pi-extensions/package.json");
    expect(binPiContents).not.toContain("-e npm:pi-agent-browser-native@0.9.2");
  });
});

describe("bd-83: pi-web embeds pi-coding-agent >= 1.0 for agent-browser", () => {
  it("pins the pi-web upstream tag whose lockfile resolves pi-coding-agent 1.3.0", () => {
    if (flakeContents === null) {
      throw new Error(`could not read flake.nix at ${flakePath}`);
    }
    // The tag and rev must move together; a rev that still points at an older
    // pi-coding-agent release would defeat the bump. These literals are
    // intentionally version-pinned: a future pi-web bump must update flake.nix's
    // tag+rev and this test in lockstep, so a half-updated bump (new tag, stale
    // rev) fails here.
    expect(flakeContents).toContain('version = "1.202610.8";');
    expect(flakeContents).toContain('rev = "5ebda4decf14d759f4ee099e0ce03ddd8d64d85c"');
  });

  it("leaves the transcript poll interval to upstream (bd-123)", () => {
    if (flakeContents === null) {
      throw new Error(`could not read flake.nix at ${flakePath}`);
    }
    // bd-123 patched upstream's 5s selected-session poll down to 20s. Upstream
    // v1.202610.8 polls every 30s (SELECTED_SESSION_REFRESH_MS), so the patch was
    // dropped rather than retargeted: re-adding a substituteInPlace of this
    // literal here would mean a later bump regressed the interval unnoticed.
    expect(flakeContents).not.toContain('"const SELECTED_SESSION_REFRESH_MS = 5_000;"');
  });

  it("no longer patches the lockfile because 1.202610.8 ships SDK 1.3.0 with integrity", () => {
    if (flakeContents === null) {
      throw new Error(`could not read flake.nix at ${flakePath}`);
    }
    // pi-web 1.202610.8 resolves pi-coding-agent 1.3.0, whose nested
    // @earendil-works deps all carry registry integrity values, so the patch
    // that 1.202610.1 needed must not be applied (a stale reference would fail
    // the build at patch time) and the file itself should be gone.
    expect(flakeContents).not.toContain("patches = [ ./nix/pi-web-integrity.patch ]");
    expect(integrityPatchContents).toBeNull();
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
