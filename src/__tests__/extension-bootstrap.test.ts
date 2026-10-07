/**
 * Tests for the `/bootstrap` extension (bd-80).
 *
 * Covers the pure helpers (name sanitization, token substitution, precondition
 * predicates, handoff/summary text), the copy + token-substitution path (which
 * must never mutate the shared template tree), and the command's abort path
 * when the target directory is not empty. The remaining scripted I/O steps are
 * verified manually end-to-end (see docs/bootstrap.md).
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import bootstrapExtension, {
  BD_CONFIG_SETTINGS,
  buildHandoffMessage,
  buildSummary,
  classifyTargetDir,
  copyTemplateTree,
  findMissingTools,
  GENERATED_TOP_LEVEL_ENTRIES,
  hasBeadsManagedBlock,
  hasOnlyGitEntry,
  REQUIRED_TOOL_NAMES,
  resolveCommand,
  resolveTemplateDir,
  STEP_DEFINITIONS,
  sanitizeProjectName,
  substituteIdentifierTokens,
  substituteTree,
} from "../../extensions/bootstrap.js";

describe("sanitizeProjectName", () => {
  it("lowercases and collapses disallowed runs to a single dash", () => {
    expect(sanitizeProjectName("My  Cool  App")).toBe("my-cool-app");
    expect(sanitizeProjectName("Foo__Bar")).toBe("foo__bar");
  });

  it("collapses repeated separators and trims the edges", () => {
    expect(sanitizeProjectName("--Hello//World--")).toBe("hello-world");
    expect(sanitizeProjectName(".dot.starts")).toBe("dot.starts");
  });

  it("falls back to 'app' when nothing valid remains", () => {
    expect(sanitizeProjectName("***")).toBe("app");
  });

  it("never returns a name npm would reject (leading '.', '_', or '-')", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["My  Cool  App", "my-cool-app"],
      ["Foo__Bar", "foo__bar"],
      ["--Hello//World--", "hello-world"],
      [".dot.starts", "dot.starts"],
      ["_leading", "leading"],
      ["-leading", "leading"],
      ["...", "app"],
      ["***", "app"],
      ["", "app"],
    ];

    for (const [input, expected] of cases) {
      const result = sanitizeProjectName(input);
      expect(result).toBe(expected);
      expect(result).not.toMatch(/^[._-]/);
    }
  });
});

describe("STEP_DEFINITIONS", () => {
  it("stages the scaffold after git init and before nix flake lock", () => {
    const ids = STEP_DEFINITIONS.map((step) => step.id);
    const gitInitIndex = ids.indexOf("git-init");
    const gitAddIndex = ids.indexOf("git-add");
    const flakeLockIndex = ids.indexOf("flake-lock");

    expect(gitInitIndex).toBeGreaterThanOrEqual(0);
    expect(gitAddIndex).toBe(gitInitIndex + 1);
    expect(flakeLockIndex).toBe(gitAddIndex + 1);
  });

  it("exposes git add -A as its own labelled step", () => {
    const gitAdd = STEP_DEFINITIONS.find((step) => step.id === "git-add");
    expect(gitAdd).toHaveProperty("command", "git add -A");
  });

  it("re-stages generated artifacts after bd prime for the initial commit", () => {
    const ids = STEP_DEFINITIONS.map((step) => step.id);
    const finalAdd = STEP_DEFINITIONS.find((step) => step.id === "git-add-final");
    expect(finalAdd).toHaveProperty("command", "git add -A");
    expect(ids.indexOf("git-add-final")).toBe(ids.indexOf("bd-prime") + 1);
  });

  it("pins sequential beads IDs before bd prime", () => {
    const ids = STEP_DEFINITIONS.map((step) => step.id);
    const idMode = STEP_DEFINITIONS.find((step) => step.id === "bd-config-id-mode");
    expect(idMode).toHaveProperty("command", "bd config set issue_id_mode counter");
    expect(ids.indexOf("bd-config-id-mode")).toBeGreaterThan(ids.indexOf("bd-init"));
    expect(ids.indexOf("bd-config-id-mode")).toBeLessThan(ids.indexOf("bd-prime"));
  });
});

describe("BD_CONFIG_SETTINGS", () => {
  it("maps every pinned config value to a real step command", () => {
    for (const setting of BD_CONFIG_SETTINGS) {
      const step = STEP_DEFINITIONS.find((entry) => entry.id === setting.stepId);
      expect(step).toHaveProperty("command", `bd config set ${setting.key} ${setting.value}`);
    }
  });

  it("switches beads off hash-based IDs", () => {
    expect(BD_CONFIG_SETTINGS).toContainEqual(
      expect.objectContaining({ key: "issue_id_mode", value: "counter" }),
    );
  });
});

describe("classifyTargetDir", () => {
  const templateEntries = [
    ".config",
    "flake.nix",
    "package.json",
    "pnpm-workspace.yaml",
    "turbo.json",
  ];

  it("accepts an empty directory and a bare .git entry", () => {
    expect(classifyTargetDir([], templateEntries, GENERATED_TOP_LEVEL_ENTRIES)).toEqual({
      kind: "empty",
    });
    expect(classifyTargetDir([".git"], templateEntries, GENERATED_TOP_LEVEL_ENTRIES)).toEqual({
      kind: "empty",
    });
  });

  it("treats a scaffold with generated artifacts as resumable", () => {
    const entries = [
      ".git",
      ".config",
      "flake.nix",
      "package.json",
      "turbo.json",
      "flake.lock",
      "node_modules",
      ".beads",
    ];
    expect(classifyTargetDir(entries, templateEntries, GENERATED_TOP_LEVEL_ENTRIES)).toEqual({
      kind: "resumable",
    });
  });

  it("accepts a partial copy that still carries two scaffold signatures", () => {
    // A copy interrupted before every template landed must remain resumable as
    // long as two of the distinctive markers made it.
    expect(
      classifyTargetDir(
        [".config", "turbo.json", "package.json"],
        templateEntries,
        GENERATED_TOP_LEVEL_ENTRIES,
      ),
    ).toEqual({ kind: "resumable" });
  });

  it("rejects a directory with only one scaffold signature", () => {
    expect(
      classifyTargetDir([".config", "package.json"], templateEntries, GENERATED_TOP_LEVEL_ENTRIES),
    ).toEqual({ kind: "not-empty", unknownEntries: [".config", "package.json"] });
  });

  it("rejects a plain `nix flake init` directory", () => {
    // flake.nix (+ flake.lock) alone must not qualify as a scaffold.
    expect(
      classifyTargetDir(["flake.nix", "flake.lock"], templateEntries, GENERATED_TOP_LEVEL_ENTRIES),
    ).toEqual({ kind: "not-empty", unknownEntries: ["flake.nix", "flake.lock"] });
  });

  it("rejects a pi-aware repo that merely has .pi, package.json, and README.md", () => {
    expect(
      classifyTargetDir(
        [".pi", "package.json", "README.md"],
        [...templateEntries, ".pi", "README.md"],
        GENERATED_TOP_LEVEL_ENTRIES,
      ),
    ).toEqual({ kind: "not-empty", unknownEntries: [".pi", "package.json", "README.md"] });
  });

  it("rejects a non-empty directory that lacks the scaffold marker", () => {
    expect(
      classifyTargetDir(["package.json"], templateEntries, GENERATED_TOP_LEVEL_ENTRIES),
    ).toEqual({ kind: "not-empty", unknownEntries: ["package.json"] });
    expect(
      classifyTargetDir([".git", "existing.txt"], templateEntries, GENERATED_TOP_LEVEL_ENTRIES),
    ).toEqual({ kind: "not-empty", unknownEntries: ["existing.txt"] });
  });

  it("rejects a scaffold carrying unknown files", () => {
    expect(
      classifyTargetDir(
        [".config", "turbo.json", "mystery.txt"],
        templateEntries,
        GENERATED_TOP_LEVEL_ENTRIES,
      ),
    ).toEqual({ kind: "unknown-entries", unknownEntries: ["mystery.txt"] });
  });
});

describe("substituteIdentifierTokens", () => {
  it("replaces identifier tokens only", () => {
    const content = [
      "name: __PROJECT_NAME__",
      "package: @__PACKAGE_SCOPE__/core",
      "prose: __PROJECT_DESCRIPTION__ __PROJECT_ONELINER__",
    ].join("\n");

    const result = substituteIdentifierTokens(content, {
      projectName: "acme",
      packageScope: "acme",
    });

    expect(result).toContain("name: acme");
    expect(result).toContain("package: @acme/core");
    // Prose tokens are deliberately left for the agent handoff.
    expect(result).toContain("prose: __PROJECT_DESCRIPTION__ __PROJECT_ONELINER__");
  });
});

describe("hasBeadsManagedBlock", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects every bd-managed block marker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bootstrap-beads-"));
    tempDirs.push(dir);

    const integration = join(dir, "integration.md");
    const codex = join(dir, "codex.md");
    const guidelines = join(dir, "guidelines.md");
    const plain = join(dir, "plain.md");
    writeFileSync(integration, "<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal -->\nbody\n");
    writeFileSync(codex, "<!-- BEGIN BEADS CODEX SETUP -->\nbody\n");
    writeFileSync(guidelines, "<!-- BEADS GUIDELINES START -->\nbody\n");
    writeFileSync(plain, "# AGENTS.md\n\nJust a plain file.\n");

    expect(await hasBeadsManagedBlock(integration)).toBe(true);
    expect(await hasBeadsManagedBlock(codex)).toBe(true);
    expect(await hasBeadsManagedBlock(guidelines)).toBe(true);
    expect(await hasBeadsManagedBlock(plain)).toBe(false);
    expect(await hasBeadsManagedBlock(join(dir, "missing.md"))).toBe(false);
  });
});

describe("copyTemplateTree and substituteTree", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes substituted content to the target and leaves the template byte-identical", async () => {
    const templateDir = mkdtempSync(join(tmpdir(), "bootstrap-template-"));
    const targetDir = mkdtempSync(join(tmpdir(), "bootstrap-target-"));
    tempDirs.push(templateDir, targetDir);

    const relativeTemplatePath = join("packages", "core", "package.json");
    const templateFile = join(templateDir, relativeTemplatePath);
    mkdirSync(join(templateDir, "packages", "core"), { recursive: true });
    writeFileSync(templateFile, '{"name": "@__PACKAGE_SCOPE__/core", "bin": "__PROJECT_NAME__"}');
    const templateBefore = readFileSync(templateFile, "utf-8");

    const copied = await copyTemplateTree(templateDir, targetDir);
    expect(copied.ok).toBe(true);
    if (!copied.ok) return;

    const substituted = await substituteTree(templateDir, targetDir, copied.value.files, {
      projectName: "acme",
      packageScope: "acme",
    });
    expect(substituted).toEqual({ ok: true, value: [relativeTemplatePath] });

    expect(readFileSync(join(targetDir, relativeTemplatePath), "utf-8")).toBe(
      '{"name": "@acme/core", "bin": "acme"}',
    );
    // The shared template tree must never be mutated in place.
    expect(readFileSync(templateFile, "utf-8")).toBe(templateBefore);
  });

  it("makes a copied read-only template tree writable (Nix-store modes)", async () => {
    // The Nix-built pi runs templates straight from the read-only store
    // (0444/0555); `cp` preserves that, so without normalisation the
    // substitution write and every later resume fail with EACCES (bd-93).
    const templateDir = mkdtempSync(join(tmpdir(), "bootstrap-template-"));
    const targetDir = mkdtempSync(join(tmpdir(), "bootstrap-target-"));
    tempDirs.push(templateDir, targetDir);

    const nestedDir = join(templateDir, "packages", "core");
    mkdirSync(nestedDir, { recursive: true });
    const templateFile = join(nestedDir, "package.json");
    writeFileSync(templateFile, '{"name": "@__PACKAGE_SCOPE__/core"}');
    chmodSync(nestedDir, 0o555);
    chmodSync(templateFile, 0o444);

    const copied = await copyTemplateTree(templateDir, targetDir);
    expect(copied.ok).toBe(true);
    if (!copied.ok) return;

    const targetFile = join(targetDir, "packages", "core", "package.json");
    expect(statSync(targetFile).mode & 0o200).not.toBe(0);
    expect(statSync(join(targetDir, "packages", "core")).mode & 0o200).not.toBe(0);

    const substituted = await substituteTree(templateDir, targetDir, copied.value.files, {
      projectName: "acme",
      packageScope: "acme",
    });
    expect(substituted.ok).toBe(true);
    expect(readFileSync(targetFile, "utf-8")).toBe('{"name": "@acme/core"}');

    // A resume must also copy over a target the previous run left read-only.
    chmodSync(targetFile, 0o444);
    const recopied = await copyTemplateTree(templateDir, targetDir);
    expect(recopied.ok).toBe(true);

    // Restore writability so the shared afterEach rmSync can clean up the
    // intentionally read-only template fixture.
    chmodSync(templateFile, 0o644);
    chmodSync(nestedDir, 0o755);
    chmodSync(join(templateDir, "packages"), 0o755);
  });

  it("preserves a target file that already carries a bd-managed block", async () => {
    const templateDir = mkdtempSync(join(tmpdir(), "bootstrap-template-"));
    const targetDir = mkdtempSync(join(tmpdir(), "bootstrap-target-"));
    tempDirs.push(templateDir, targetDir);

    writeFileSync(join(templateDir, "AGENTS.md"), "# __PROJECT_NAME__\n");
    const preserved = "<!-- BEGIN BEADS INTEGRATION v:1 -->\n# acme\n<!-- END -->\n";
    writeFileSync(join(targetDir, "AGENTS.md"), preserved);

    const copied = await copyTemplateTree(templateDir, targetDir);
    expect(copied.ok).toBe(true);
    if (!copied.ok) return;

    const substituted = await substituteTree(templateDir, targetDir, copied.value.files, {
      projectName: "acme",
      packageScope: "acme",
    });
    expect(substituted).toEqual({ ok: true, value: [] });
    expect(readFileSync(join(targetDir, "AGENTS.md"), "utf-8")).toBe(preserved);
  });
});

describe("hasOnlyGitEntry", () => {
  it("accepts an empty directory and a bare .git entry", () => {
    expect(hasOnlyGitEntry([])).toBe(true);
    expect(hasOnlyGitEntry([".git"])).toBe(true);
  });

  it("rejects anything else", () => {
    expect(hasOnlyGitEntry([".git", "src"])).toBe(false);
    expect(hasOnlyGitEntry(["node_modules"])).toBe(false);
  });
});

describe("findMissingTools", () => {
  it("returns only tools that no PATH directory provides", () => {
    const isExecutable = (candidate: string): boolean =>
      candidate === "/bin/nix" || candidate === "/usr/bin/git";

    expect(findMissingTools(["nix", "git", "bd"], "/bin:/usr/bin", isExecutable)).toEqual(["bd"]);
  });

  it("returns every tool when PATH is empty", () => {
    expect(findMissingTools(["nix", "pnpm"], "", () => true)).toEqual(["nix", "pnpm"]);
  });
});

describe("resolveCommand", () => {
  const isExecutable = (candidate: string): boolean =>
    candidate === "/bin/bd" || candidate === "/bin/node";

  it("runs the tool directly when it is on the host PATH", () => {
    expect(
      resolveCommand({
        file: "pnpm",
        args: ["install"],
        cwd: "/tmp/new-project",
        devShellTools: ["node"],
        pathValue: "/bin",
        isExecutable,
      }),
    ).toEqual({ file: "pnpm", args: ["install"], viaDevShell: false });
  });

  it("wraps a missing devShell tool in `nix develop <cwd> -c`", () => {
    expect(
      resolveCommand({
        file: "pnpm",
        args: ["install"],
        cwd: "/tmp/new-project",
        devShellTools: ["pnpm"],
        pathValue: "/bin",
        isExecutable,
      }),
    ).toEqual({
      file: "nix",
      args: ["develop", "/tmp/new-project", "-c", "pnpm", "install"],
      viaDevShell: true,
    });
  });

  it("wraps when any paired devShell tool is missing (bd without dolt)", () => {
    // bd shells out to dolt, so a host bd alone is not enough.
    const isBdOnly = (candidate: string): boolean => candidate === "/bin/bd";
    expect(
      resolveCommand({
        file: "bd",
        args: ["prime"],
        cwd: "/tmp/new-project",
        devShellTools: ["bd", "dolt"],
        pathValue: "/bin",
        isExecutable: isBdOnly,
      }),
    ).toEqual({
      file: "nix",
      args: ["develop", "/tmp/new-project", "-c", "bd", "prime"],
      viaDevShell: true,
    });
  });

  it("never wraps a command without a devShell tool (host tools)", () => {
    // git/nix/direnv are precondition-guaranteed; wrapping them would be
    // circular for nix and pointless for the others.
    expect(
      resolveCommand({
        file: "git",
        args: ["init"],
        cwd: "/tmp/new-project",
        pathValue: "",
        isExecutable: () => false,
      }),
    ).toEqual({ file: "git", args: ["init"], viaDevShell: false });
  });
});

describe("REQUIRED_TOOL_NAMES", () => {
  it("requires only host tools the scaffold devShell cannot provide", () => {
    expect([...REQUIRED_TOOL_NAMES]).toEqual(["nix", "git", "direnv"]);
    // bd and pnpm must not be hard requirements: they are self-provisioned
    // from the scaffold's own devShell (bd-93).
    expect(REQUIRED_TOOL_NAMES).not.toContain("bd");
    expect(REQUIRED_TOOL_NAMES).not.toContain("pnpm");
  });
});

describe("handoff and summary text", () => {
  const report = {
    projectName: "acme",
    packageScope: "acme",
    templateFiles: ["package.json", "README.md"],
    substitutedFiles: ["package.json"],
    commands: ["git init", "pnpm install"],
  };

  it("names the project and the prose placeholders the agent must replace", () => {
    const message = buildHandoffMessage(report);
    expect(message).toContain("acme");
    expect(message).toContain("__PROJECT_DESCRIPTION__");
    expect(message).toContain("__PROJECT_ONELINER__");
    expect(message).toContain("initial commit");
    // The shipped AGENTS.md acceptance criteria include root `pnpm lint` and
    // `pnpm test:integration`, which turbo's per-package `lint`/`test` miss.
    expect(message).toContain("pnpm lint");
    expect(message).toContain("pnpm test:integration");
  });

  it("summarizes scripted vs agent-owned work", () => {
    const summary = buildSummary(report);
    expect(summary).toContain("2 template files");
    expect(summary).toContain("package.json, README.md");
    expect(summary).toContain("git init, pnpm install");
    expect(summary).toContain("Agent-owned");
  });
});

describe("bootstrap templates", () => {
  const templateRoot = resolveTemplateDir();
  const files = listFilesRecursive(templateRoot);
  const allowedPlaceholders = new Set([
    "__PROJECT_NAME__",
    "__PACKAGE_SCOPE__",
    "__PROJECT_DESCRIPTION__",
    "__PROJECT_ONELINER__",
  ]);
  const codeExtensions = [".ts", ".tsx", ".js", ".jsx"];

  it("contains no non-null assertions or `any` types in code files", () => {
    for (const file of files) {
      if (!codeExtensions.some((extension) => file.endsWith(extension))) continue;
      const content = readFileSync(file, "utf-8");
      expect(content, `${relative(process.cwd(), file)} uses a non-null assertion`).not.toMatch(
        /[A-Za-z0-9_)\]]!(?!=)/,
      );
      expect(content, `${relative(process.cwd(), file)} uses any`).not.toMatch(/\bany\b/);
    }
  });

  it("uses only the four defined placeholder tokens", () => {
    const found = new Set<string>();
    for (const file of files) {
      const content = readFileSync(file, "utf-8");
      for (const match of content.matchAll(/__[A-Z][A-Z0-9_]*__/g)) {
        found.add(match[0]);
      }
    }
    expect([...found].sort()).toEqual([...allowedPlaceholders].sort());
  });

  it("excludes generated trees via negated includes, not inert scanner ignores", () => {
    // `files.experimentalScannerIgnores` accepts bare names, not globs, so the
    // previous `".beads/**"` entry was silently ignored and `biome check .`
    // failed on the tracked .beads/metadata.json (bd-94).
    const config = JSON.parse(readFileSync(join(templateRoot, "biome.json"), "utf-8")) as {
      files?: { includes?: string[]; experimentalScannerIgnores?: unknown };
    };
    expect(config.files?.experimentalScannerIgnores).toBeUndefined();
    const includes = config.files?.includes ?? [];
    for (const ignored of ["**/dist", "**/coverage", "**/.turbo", "**/.beads"]) {
      expect(includes).toContain(`!${ignored}`);
    }
  });
});

function listFilesRecursive(root: string): string[] {
  const entries = readdirSync(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(full));
      continue;
    }
    if (statSync(full).isFile()) files.push(full);
  }
  return files;
}

interface MockPi {
  api: ExtensionAPI;
  commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
  messages: unknown[];
}

function createMockPi(): MockPi {
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const messages: unknown[] = [];
  const api = {
    registerCommand: (
      name: string,
      command: { handler: (args: string, ctx: unknown) => Promise<void> },
    ) => {
      commands.set(name, command);
    },
    registerTool: () => {},
    on: () => {},
    sendMessage: (message: unknown) => {
      messages.push(message);
    },
    events: { emit: () => {}, on: () => () => {} },
  } as unknown as ExtensionAPI;
  return { api, commands, messages };
}

describe("bootstrapExtension", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("registers the /bootstrap command", () => {
    const { api, commands } = createMockPi();
    bootstrapExtension(api);
    expect(commands.has("bootstrap")).toBe(true);
  });

  it("aborts before running commands when the directory is not empty", async () => {
    const { api, commands, messages } = createMockPi();
    bootstrapExtension(api);

    const cwd = mkdtempSync(join(tmpdir(), "bootstrap-test-"));
    tempDirs.push(cwd);
    writeFileSync(join(cwd, "existing.txt"), "do not clobber");

    const notify = vi.fn();
    await commands.get("bootstrap")?.handler("", { cwd, ui: { notify } });

    expect(notify).toHaveBeenCalledWith(expect.stringContaining("aborted"), "error");
    expect(messages).toHaveLength(0);
  });
});
