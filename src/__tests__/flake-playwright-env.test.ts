import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Resolve the repo root from this test file's location (src/__tests__ -> repo root)
// rather than process.cwd(), so the test is invariant to the Vitest working directory.
const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, "..", "..");
const flakePath = join(repoRoot, "flake.nix");

// Read once; if the file is missing we surface a clear failure rather than skipping,
// because the flake is the artifact this regression guard exists to protect.
let flakeContents: string | null = null;
try {
  flakeContents = readFileSync(flakePath, "utf8");
} catch {
  flakeContents = null;
}

describe("bd-64: flake.nix playwright env", () => {
  it("flake.nix is readable from the test file location", () => {
    if (flakeContents === null) {
      throw new Error(`could not read flake.nix at ${flakePath}`);
    }
    expect(typeof flakeContents).toBe("string");
    expect(flakeContents.length).toBeGreaterThan(0);
  });

  it("exposes the `playwright` binary via pkgs.playwright-test in devShellTools", () => {
    if (flakeContents === null) {
      throw new Error(`could not read flake.nix at ${flakePath}`);
    }
    // pkgs.playwright-test provides the `playwright` test runner + show-trace CLI.
    expect(flakeContents).toContain("pkgs.playwright-test");
  });

  it("no longer fetches the pinned playwright-core@1.61.0-alpha tarball", () => {
    if (flakeContents === null) {
      throw new Error(`could not read flake.nix at ${flakePath}`);
    }
    // playwrightCoreSrc pinned the alpha tarball and was removed in bd-64; guard against reintroduction.
    expect(flakeContents).not.toContain("playwrightCoreSrc");
  });

  it("builds playwright-cli against pkgs.playwright-driver (browsers stay in lockstep)", () => {
    if (flakeContents === null) {
      throw new Error(`could not read flake.nix at ${flakePath}`);
    }
    // The CLI derivation now copies nixpkgs' playwright-driver into its node_modules,
    // so CLI and PLAYWRIGHT_BROWSERS_PATH revisions cannot drift.
    expect(flakeContents).toContain("pkgs.playwright-driver");
  });
});
