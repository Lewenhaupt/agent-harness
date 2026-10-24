import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Resolve the repo root from this test file's location so the guard is invariant
// to the Vitest working directory (same approach as flake-playwright-env.test.ts).
const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, "..", "..");

const readJson = (relativePath: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(repoRoot, relativePath), "utf8")) as Record<string, unknown>;

const packageJson = readJson("package.json");
const thirdPartyJson = readJson("nix/pi-extensions/package.json");
const flakeSource = readFileSync(join(repoRoot, "flake.nix"), "utf8");
const binPiSource = readFileSync(join(repoRoot, "bin/pi"), "utf8");

const harnessExtensions = (packageJson.pi as { extensions?: string[] }).extensions ?? [];
const thirdPartyExtensions = (thirdPartyJson.piExtensions ?? {}) as Record<string, string>;
const thirdPartyDependencies = (thirdPartyJson.dependencies ?? {}) as Record<string, string>;

describe("pi extension manifests (bd-131)", () => {
  it("harness pi.extensions lists exactly the extension entry points in extensions/", () => {
    const onDisk = readdirSync(join(repoRoot, "extensions"))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => `./extensions/${name}`)
      .sort();

    expect([...harnessExtensions].sort()).toEqual(onDisk);
  });

  it("every harness extension entry point exists", () => {
    for (const entry of harnessExtensions) {
      expect(existsSync(join(repoRoot, entry)), `missing ${entry}`).toBe(true);
    }
  });

  it("every third-party entry point has a matching dependency", () => {
    for (const name of Object.keys(thirdPartyExtensions)) {
      expect(thirdPartyDependencies, `${name} is not a dependency`).toHaveProperty([name]);
    }
  });

  it("third-party entry paths are package-relative, not absolute or escaping", () => {
    for (const [name, entry] of Object.entries(thirdPartyExtensions)) {
      expect(entry.startsWith("/"), `${name} entry is absolute`).toBe(false);
      expect(entry.includes(".."), `${name} entry escapes its package`).toBe(false);
      expect(entry.length, `${name} entry is empty`).toBeGreaterThan(0);
    }
  });

  it("bin/pi derives its -e list from the manifests instead of hardcoding one", () => {
    expect(binPiSource).toContain("package.json");
    expect(binPiSource).toContain("nix/pi-extensions/package.json");
    expect(binPiSource).toContain("BELAYD_PI_EXTENSIONS_DIR");
    // No hand-written per-extension -e lines and no pinned npm fetch.
    expect(binPiSource).not.toMatch(/-e "\$repo_dir\/extensions\//);
    expect(binPiSource).not.toMatch(/npm:pi-agent-browser-native@/);
  });

  it("flake.nix derives its extension list from the same manifests", () => {
    expect(flakeSource).toContain("piExtensionManifest");
    expect(flakeSource).toContain("harnessExtensionPaths");
    expect(flakeSource).toContain("thirdPartyExtensionPaths");
    expect(flakeSource).toContain("BELAYD_PI_EXTENSIONS_DIR");
    // The old hand-maintained per-package entry paths must not come back.
    expect(flakeSource).not.toContain("pi-exa/src/index.ts");
    expect(flakeSource).not.toContain("pi-ast-grep/src/index.ts");
  });
});
