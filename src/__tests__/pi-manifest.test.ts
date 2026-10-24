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

describe("project context budget (bd-137)", () => {
  const agentsMd = readFileSync(join(repoRoot, "AGENTS.md"), "utf8");
  const repoLayout = readFileSync(join(repoRoot, "docs/repo-layout.md"), "utf8");

  it("keeps AGENTS.md inside the per-session context budget", () => {
    // pi loads AGENTS.md into the project_context prompt section of every
    // session, sub-agents included. It was 30.5 KB (~7.6k tokens) and dominated
    // the sub-agent system prompt; the split moved detail into docs/. The bound
    // leaves room for the two managed Beads blocks, which are not ours to trim.
    const bytes = Buffer.byteLength(agentsMd, "utf8");
    expect(bytes).toBeLessThan(12 * 1024);
  });

  it("keeps the rules an agent must know before touching anything", () => {
    for (const rule of [
      "Be extremely concise",
      "language of the user's most recent message",
      "Never close tasks",
      "No `!` non-null assertions",
      "pnpm test:integration",
      "docs/repo-layout.md",
      "docs/packaging.md",
    ]) {
      expect(agentsMd, `AGENTS.md lost: ${rule}`).toContain(rule);
    }
  });

  it("keeps the managed Beads blocks intact", () => {
    expect(agentsMd).toContain("<!-- BEGIN BEADS INTEGRATION");
    expect(agentsMd).toContain("<!-- END BEADS INTEGRATION -->");
    expect(agentsMd).toContain("<!-- BEGIN BEADS CODEX SETUP");
  });

  it("points the moved detail at docs/repo-layout.md instead of duplicating it", () => {
    // The module map moved; a duplicate table in AGENTS.md would drift and cost
    // tokens in every session.
    expect(repoLayout).toContain("## Module map");
    expect(repoLayout).toContain("## Docs index");
    expect(agentsMd).not.toContain("├── src/");
  });
});
