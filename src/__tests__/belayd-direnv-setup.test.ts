import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupRenderedScripts,
  createShellHarness,
  renderScript,
  runScript,
  type ShellHarness,
} from "./helpers/belayd-script-harness.js";

/**
 * Locate the real `direnv` binary (not the harness stub) so the parser can be
 * validated against the same TOML engine the runtime uses. Returns null when
 * direnv is unavailable; callers then skip only the parse assertion.
 */
function findDirenv(): string | null {
  const explicit = process.env.BELAYD_TEST_DIRENV;
  if (explicit && existsSync(explicit)) {
    return explicit;
  }
  const onPath = spawnSync("sh", ["-c", "command -v direnv"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  }).stdout.trim();
  return onPath === "" ? null : onPath;
}

const DIRENV_PATH = findDirenv();

interface TomlParserCase {
  label: string;
  initial: string;
  /** Requested prefixes; "@REPO@" is replaced by the whitelisted repo path. */
  newPrefixes: string[];
  outcome: "merged" | "unchanged";
  mustContain?: string[];
  warn?: string;
  /** CRLF fixture: assert no inserted line introduces a bare \n. */
  assertCrlf?: boolean;
}

describe("belayd-direnv-setup (unit)", () => {
  let harness: ShellHarness;
  let setup: string;
  let toml: string;

  beforeEach(() => {
    harness = createShellHarness();
    setup = renderScript("belayd-direnv-setup", {
      realShell: harness.realShell,
      jqPath: harness.jqPath,
    }).path;
    toml = join(harness.root, "direnv", "direnv.toml");
  });

  afterEach(() => {
    harness.cleanup();
    cleanupRenderedScripts();
  });

  const run = (args: string[]) => runScript(setup, args, { cwd: harness.root, env: harness.env });

  // Real direnv reads `$XDG_CONFIG_HOME/direnv/direnv.toml`; point it at the
  // harness so the rewritten file is the one under test. Strip ambient direnv
  // state so a parent session cannot influence the result.
  const direnvEnv = (): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: harness.root };
    for (const key of Object.keys(env)) {
      if (key.startsWith("DIRENV_") || key === "BELAYD_SHELL_ACTIVE") {
        delete env[key];
      }
    }
    return env;
  };

  const writeToml = (contents: string): void => {
    mkdirSync(join(harness.root, "direnv"), { recursive: true });
    writeFileSync(toml, contents);
  };

  it("creates the file with a header when missing", () => {
    const result = run(["--toml", toml, "--prefix", "/home/x/git"]);

    expect(result).toHaveProperty("status", 0);
    const contents = readFileSync(toml, "utf-8");
    expect(contents).toContain("[whitelist]");
    expect(contents).toContain('prefix = ["/home/x/git"]');
  });

  it("is a no-op when every prefix is already present", () => {
    writeToml('[whitelist]\nprefix = ["/home/x/git"]\n');
    const before = statSync(toml, { bigint: true }).mtimeNs;

    const result = run(["--toml", toml, "--prefix", "/home/x/git"]);

    expect(result).toHaveProperty("status", 0);
    expect(statSync(toml, { bigint: true }).mtimeNs).toBe(before);
  });

  it("adds a missing prefix into the existing [whitelist] table", () => {
    writeToml('[whitelist]\nprefix = ["/home/x/git"]\n');

    run(["--toml", toml, "--prefix", "/home/x/other"]);

    const contents = readFileSync(toml, "utf-8");
    expect(contents).toContain('prefix = ["/home/x/git", "/home/x/other"]');
    // Existing content is preserved; no second assignment was appended.
    expect(contents.match(/prefix =/g)).toHaveLength(1);
  });

  it("appends a new [whitelist] table when absent, keeping existing lines", () => {
    writeToml('# keep me\n[tools]\nfoo = "bar"\n');

    run(["--toml", toml, "--prefix", "/home/x/git"]);

    const contents = readFileSync(toml, "utf-8");
    expect(contents).toContain("# keep me");
    expect(contents).toContain('[tools]\nfoo = "bar"');
    expect(contents).toContain("[whitelist]");
    expect(contents).toContain('prefix = ["/home/x/git"]');
  });

  it("never duplicates a prefix across repeated runs", () => {
    run(["--toml", toml, "--prefix", "/home/x/git", "--prefix", "/home/x/git"]);
    run(["--toml", toml, "--prefix", "/home/x/git"]);

    const contents = readFileSync(toml, "utf-8");
    expect(contents.match(/\/home\/x\/git/g)).toHaveLength(1);
  });

  it("merges a new prefix into a table that had none", () => {
    writeToml("[whitelist]\n# no prefix key yet\n");

    run(["--toml", toml, "--prefix", "/home/x/git"]);

    const contents = readFileSync(toml, "utf-8");
    expect(contents).toContain("[whitelist]");
    expect(contents).toContain('prefix = ["/home/x/git"]');
    expect(contents).toContain("# no prefix key yet");
  });

  it("warns and exits 0 on a malformed prefix entry", () => {
    const corrupt = '[whitelist]\nprefix = ["/unterminated\n';
    writeToml(corrupt);

    const result = run(["--toml", toml, "--prefix", "/home/x/git"]);

    expect(result).toHaveProperty("status", 0);
    expect(result.stderr).toContain("malformed");
    expect(readFileSync(toml, "utf-8")).toBe(corrupt);
  });

  it("adds one missing prefix into a multi-line array", () => {
    writeToml('[whitelist]\nprefix = [\n  "/home/x/git",\n]\n');

    run(["--toml", toml, "--prefix", "/home/x/other"]);

    const contents = readFileSync(toml, "utf-8");
    expect(contents).toContain('  "/home/x/git",');
    expect(contents).toContain('  "/home/x/other",');
    expect(contents.match(/prefix =/g)).toHaveLength(1);
  });

  it("adds two missing prefixes into a multi-line array", () => {
    writeToml('[whitelist]\nprefix = [\n  "/home/x/git",\n]\n');

    run(["--toml", toml, "--prefix", "/home/x/a", "--prefix", "/home/x/b"]);

    const contents = readFileSync(toml, "utf-8");
    expect(contents).toContain('  "/home/x/a",');
    expect(contents).toContain('  "/home/x/b",');
    expect(contents.match(/prefix =/g)).toHaveLength(1);
  });

  it("is a no-op when the multi-line array already contains the prefix", () => {
    writeToml('[whitelist]\nprefix = [\n  "/home/x/git",\n]\n');
    const before = statSync(toml, { bigint: true }).mtimeNs;

    const result = run(["--toml", toml, "--prefix", "/home/x/git"]);

    expect(result).toHaveProperty("status", 0);
    expect(statSync(toml, { bigint: true }).mtimeNs).toBe(before);
  });

  it("preserves comments in a multi-line array while adding a prefix", () => {
    writeToml('[whitelist]\nprefix = [\n  # keep this\n  "/home/x/git",  # existing\n]\n');

    run(["--toml", toml, "--prefix", "/home/x/other"]);

    const contents = readFileSync(toml, "utf-8");
    expect(contents).toContain("# keep this");
    expect(contents).toContain("/home/x/git");
    expect(contents).toContain("/home/x/other");
  });

  it("fills an empty multi-line array", () => {
    writeToml("[whitelist]\nprefix = [\n]\n");

    run(["--toml", toml, "--prefix", "/home/x/git"]);

    const contents = readFileSync(toml, "utf-8");
    expect(contents).toContain("prefix = [");
    expect(contents).toContain('  "/home/x/git",');
  });

  it("recognizes a [whitelist] table with an inline comment", () => {
    writeToml('[whitelist] # managed\nprefix = ["/home/x/git"]\n');

    run(["--toml", toml, "--prefix", "/home/x/other"]);

    const contents = readFileSync(toml, "utf-8");
    expect(contents).toContain('prefix = ["/home/x/git", "/home/x/other"]');
    // Exactly one table: a second appended table would orphan the first list.
    expect(contents.match(/^\[whitelist\]/gm)).toHaveLength(1);
  });

  it("recognizes a [whitelist] table with trailing whitespace", () => {
    writeToml('[whitelist]   \nprefix = ["/home/x/git"]\n');

    run(["--toml", toml, "--prefix", "/home/x/other"]);

    const contents = readFileSync(toml, "utf-8");
    expect(contents).toContain('prefix = ["/home/x/git", "/home/x/other"]');
    expect(contents.match(/^\[whitelist\]/gm)).toHaveLength(1);
  });

  it("warns and leaves the file untouched on duplicate prefix keys (W4)", () => {
    const duplicate = '[whitelist]\nprefix = ["/home/x/a"]\nprefix = ["/home/x/b"]\n';
    writeToml(duplicate);

    const result = run(["--toml", toml, "--prefix", "/home/x/git"]);

    expect(result).toHaveProperty("status", 0);
    expect(result.stderr).toContain("more than one");
    expect(readFileSync(toml, "utf-8")).toBe(duplicate);
  });

  describe("quote-aware array scanning (C3)", () => {
    const assertSingleTableAndKey = (contents: string): void => {
      expect(contents.match(/^\[whitelist\]/gm)).toHaveLength(1);
      expect(contents.match(/prefix =/g)).toHaveLength(1);
    };

    it("keeps a `]` inside a double-quoted path", () => {
      writeToml('[whitelist]\nprefix = ["/home/x/[bracket]/git"]\n');

      run(["--toml", toml, "--prefix", "/home/x/other"]);

      const contents = readFileSync(toml, "utf-8");
      expect(contents).toContain('"/home/x/[bracket]/git"');
      expect(contents).toContain('"/home/x/other"');
      assertSingleTableAndKey(contents);
    });

    it("keeps both `[` and `]` inside a quoted path", () => {
      writeToml('[whitelist]\nprefix = ["/home/x/[a]/[b]/git"]\n');

      run(["--toml", toml, "--prefix", "/home/x/other"]);

      const contents = readFileSync(toml, "utf-8");
      expect(contents).toContain('"/home/x/[a]/[b]/git"');
      assertSingleTableAndKey(contents);
    });

    it("keeps a `]` inside a literal single-quoted path", () => {
      writeToml("[whitelist]\nprefix = ['/home/x/[lit]/git']\n");

      run(["--toml", toml, "--prefix", "/home/x/other"]);

      const contents = readFileSync(toml, "utf-8");
      expect(contents).toContain("'/home/x/[lit]/git'");
      expect(contents).toContain('"/home/x/other"');
      assertSingleTableAndKey(contents);
    });

    it("does not treat `#` inside a quoted path as a comment", () => {
      writeToml('[whitelist]\nprefix = ["/home/x/has#hash"] # trailing comment\n');

      run(["--toml", toml, "--prefix", "/home/x/other"]);

      const contents = readFileSync(toml, "utf-8");
      expect(contents).toContain('"/home/x/has#hash"');
      expect(contents).toContain("# trailing comment");
      expect(contents).toContain('"/home/x/other"');
      assertSingleTableAndKey(contents);
    });

    it("does not split on `,` inside a quoted path", () => {
      writeToml('[whitelist]\nprefix = ["/home/x/a,b"]\n');

      run(["--toml", toml, "--prefix", "/home/x/other"]);

      const contents = readFileSync(toml, "utf-8");
      expect(contents).toContain('"/home/x/a,b"');
      assertSingleTableAndKey(contents);
    });

    it("keeps an escaped quote inside a path", () => {
      writeToml('[whitelist]\nprefix = ["/home/x/a\\"b"]\n');

      run(["--toml", toml, "--prefix", "/home/x/other"]);

      const contents = readFileSync(toml, "utf-8");
      expect(contents).toContain('a\\"b');
      assertSingleTableAndKey(contents);
    });

    it("is a no-op when a `]`-bearing path is already present", () => {
      writeToml('[whitelist]\nprefix = ["/home/x/[bracket]/git"]\n');
      const before = statSync(toml, { bigint: true }).mtimeNs;

      const result = run(["--toml", toml, "--prefix", "/home/x/[bracket]/git"]);

      expect(result).toHaveProperty("status", 0);
      expect(statSync(toml, { bigint: true }).mtimeNs).toBe(before);
    });

    it("warns and leaves the file untouched on an unterminated array", () => {
      const corrupt = '[whitelist]\nprefix = ["/home/x/a",\n';
      writeToml(corrupt);

      const result = run(["--toml", toml, "--prefix", "/home/x/git"]);

      expect(result).toHaveProperty("status", 0);
      expect(result.stderr).toContain("malformed");
      expect(readFileSync(toml, "utf-8")).toBe(corrupt);
    });

    it("warns and leaves a multi-line array untouched when a line opens a string", () => {
      const corrupt = '[whitelist]\nprefix = [\n  "/home/x/at\\\n  "/home/x/b",\n]\n';
      writeToml(corrupt);

      const result = run(["--toml", toml, "--prefix", "/home/x/git"]);

      expect(result).toHaveProperty("status", 0);
      expect(result.stderr).toContain("malformed");
      expect(readFileSync(toml, "utf-8")).toBe(corrupt);
    });
  });

  describe("interior whitespace in the [whitelist] header (C4)", () => {
    // Each header must be recognized as the whitelist table so the prefix is
    // merged in place instead of a second (invalid) table being appended.
    const headers = [
      "[ whitelist ]",
      "[whitelist ]",
      "[ whitelist]",
      "[\twhitelist\t]",
      "[ whitelist ] # comment",
    ];

    headers.forEach((header) => {
      it(`merges into "${header}" and keeps a single table`, () => {
        writeToml(`${header}\nprefix = ["/home/x/old"]\n`);

        const result = run(["--toml", toml, "--prefix", "/home/x/new"]);

        expect(result.status, header).toBe(0);
        const contents = readFileSync(toml, "utf-8");
        expect(contents, header).toContain('prefix = ["/home/x/old", "/home/x/new"]');
        expect(contents.match(/^\s*\[\s*whitelist\s*\]/gm), header).toHaveLength(1);
        // The header line is preserved verbatim, whitespace and comment included.
        expect(contents, header).toContain(header);
      });
    });

    it("appends a fresh [whitelist] table when only a spaced table exists elsewhere", () => {
      // A non-whitelist table must not be mistaken for whitelist, so the
      // requested prefix is added to a new table rather than `[ other ]`.
      writeToml("[ other ]\nfoo = 1\n");

      run(["--toml", toml, "--prefix", "/home/x/new"]);

      const contents = readFileSync(toml, "utf-8");
      expect(contents).toContain("[ other ]");
      expect(contents).toContain("[whitelist]");
      expect(contents).toContain('prefix = ["/home/x/new"]');
    });
  });

  describe("rejects nested array and inline-table shapes (W9)", () => {
    const corrupt = [
      'prefix = [["/a"], "/b"]',
      'prefix = [{p = "/a"}, "/b"]',
      'prefix = [["/home/x/new"], "/b"]',
      'prefix = [ ["/a"] ]',
    ];

    corrupt.forEach((value) => {
      it(`leaves ${value} untouched`, () => {
        const original = `[whitelist]\n${value}\n`;
        writeToml(original);

        const result = run(["--toml", toml, "--prefix", "/home/x/new"]);

        expect(result.status, value).toBe(0);
        expect(result.stderr, value).toContain("malformed");
        expect(readFileSync(toml, "utf-8"), value).toBe(original);
      });
    });
  });

  describe("rejects other unsupported whitelist shapes", () => {
    const unsupported = [
      '["whitelist"]\nprefix = ["/a"]',
      "['whitelist']\nprefix = ['/a']",
      '[[whitelist]]\nprefix = ["/a"]',
      'whitelist = { prefix = ["/a"] }',
      'whitelist.prefix = ["/a"]',
      '[whitelist]\n"prefix" = ["/a"]',
      '[whitelist]\nprefix.x = ["/a"]',
    ];

    unsupported.forEach((contents) => {
      it(`leaves ${JSON.stringify(contents)} untouched`, () => {
        writeToml(contents);

        const result = run(["--toml", toml, "--prefix", "/home/x/new"]);

        expect(result.status).toBe(0);
        expect(result.stderr).toContain("unsupported");
        expect(readFileSync(toml, "utf-8")).toBe(contents);
      });
    });

    it("leaves a file with two [whitelist] tables untouched", () => {
      const contents = '[whitelist]\nprefix = ["/a"]\n[whitelist]\nprefix = ["/b"]';
      writeToml(contents);

      const result = run(["--toml", toml, "--prefix", "/home/x/new"]);

      expect(result.status).toBe(0);
      expect(result.stderr).not.toBe("");
      expect(readFileSync(toml, "utf-8")).toBe(contents);
    });
  });

  describe("comment-aware array scanning (W10)", () => {
    it("merges past a `]` inside a `#` comment on its own line", () => {
      writeToml(
        '[whitelist]\nprefix = [\n  "/home/x/old",\n  # keep this ] bracket\n  "/home/x/old2",\n]\n',
      );

      const result = run(["--toml", toml, "--prefix", "/home/x/new"]);

      expect(result.status).toBe(0);
      const contents = readFileSync(toml, "utf-8");
      expect(contents).toContain("# keep this ] bracket");
      expect(contents).toContain('"/home/x/old"');
      expect(contents).toContain('"/home/x/old2"');
      expect(contents).toContain('"/home/x/new"');
    });

    it("merges when the closing `]` carries a trailing comment containing `]`", () => {
      writeToml('[whitelist]\nprefix = [\n  "/home/x/old",\n] # trailing ] comment\n');

      const result = run(["--toml", toml, "--prefix", "/home/x/new"]);

      expect(result.status).toBe(0);
      const contents = readFileSync(toml, "utf-8");
      expect(contents).toContain("# trailing ] comment");
      expect(contents).toContain('"/home/x/new"');
    });

    it("merges with a `#` comment containing both `[` and `,`", () => {
      writeToml(
        '[whitelist]\nprefix = [\n  "/home/x/old",\n  # has [ and , inside\n  "/home/x/old2",\n]\n',
      );

      const result = run(["--toml", toml, "--prefix", "/home/x/new"]);

      expect(result.status).toBe(0);
      const contents = readFileSync(toml, "utf-8");
      expect(contents).toContain("# has [ and , inside");
      expect(contents).toContain('"/home/x/old2"');
      expect(contents).toContain('"/home/x/new"');
    });
  });

  // Regression net for the whole direnv.toml parser class: every shape either
  // merges (preserving prior content) or is left byte-identical with a warning,
  // and every modified result must be accepted by the real direnv binary.
  it("sweeps a matrix of direnv.toml shapes and validates each with real direnv", () => {
    const repo = join(harness.root, "whitelisted-repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, ".envrc"), "export A=1\n");
    const substitute = (value: string): string => value.replaceAll("@REPO@", repo);

    const bigArray = [
      "[whitelist]",
      "prefix = [",
      ...Array.from({ length: 500 }, (_, i) => `  "/home/x/e${i}",`),
      "]",
      "",
    ].join("\n");

    const cases: TomlParserCase[] = [
      {
        label: "single-line array",
        initial: '[whitelist]\nprefix = ["/home/x/old"]\n',
        newPrefixes: ["@REPO@"],
        outcome: "merged",
        mustContain: ['prefix = ["/home/x/old", "@REPO@"]'],
      },
      {
        label: "multi-line array",
        initial: '[whitelist]\nprefix = [\n  "/home/x/old",\n]\n',
        newPrefixes: ["@REPO@"],
        outcome: "merged",
        mustContain: ['  "/home/x/old",', '  "@REPO@",'],
      },
      {
        label: "multi-line array with comments",
        initial: '[whitelist]\nprefix = [\n  # keep this\n  "/home/x/old",  # existing\n]\n',
        newPrefixes: ["@REPO@"],
        outcome: "merged",
        mustContain: ["# keep this", "# existing", '"/home/x/old"', '"@REPO@"'],
      },
      {
        label: "multi-line array with ] in an own-line # comment",
        initial:
          '[whitelist]\nprefix = [\n  "/home/x/old",\n  # keep this ] bracket\n  "/home/x/old2",\n]\n',
        newPrefixes: ["@REPO@"],
        outcome: "merged",
        mustContain: ["# keep this ] bracket", '"/home/x/old2"', '"@REPO@"'],
      },
      {
        label: "multi-line array with [ and , in a # comment",
        initial:
          '[whitelist]\nprefix = [\n  "/home/x/old",\n  # has [ and , inside\n  "/home/x/old2",\n]\n',
        newPrefixes: ["@REPO@"],
        outcome: "merged",
        mustContain: ["# has [ and , inside", '"/home/x/old2"', '"@REPO@"'],
      },
      {
        label: "trailing comment after ] containing ]",
        initial: '[whitelist]\nprefix = [\n  "/home/x/old",\n] # trailing ] comment\n',
        newPrefixes: ["@REPO@"],
        outcome: "merged",
        mustContain: ["# trailing ] comment", '"@REPO@"'],
      },
      {
        label: "interior-whitespace header",
        initial: '[ whitelist ]\nprefix = ["/home/x/old"]\n',
        newPrefixes: ["@REPO@"],
        outcome: "merged",
        mustContain: ["[ whitelist ]", '"@REPO@"'],
      },
      {
        label: "inline-comment header",
        initial: '[whitelist] # managed\nprefix = ["/home/x/old"]\n',
        newPrefixes: ["@REPO@"],
        outcome: "merged",
        mustContain: ["[whitelist] # managed", '"@REPO@"'],
      },
      {
        label: "CRLF file",
        initial: '[whitelist]\r\nprefix = [\r\n  "/home/x/old"\r\n]\r\n',
        newPrefixes: ["@REPO@"],
        outcome: "merged",
        mustContain: ['  "/home/x/old",', '  "@REPO@",'],
        assertCrlf: true,
      },
      {
        label: "no [whitelist] table at all",
        initial: '[tools]\nfoo = "bar"\n',
        newPrefixes: ["@REPO@"],
        outcome: "merged",
        mustContain: ["[tools]", 'foo = "bar"', "[whitelist]", '"@REPO@"'],
      },
      {
        label: "whitelist nested among unrelated tables",
        initial: '[a]\nx = 1\n[whitelist]\nprefix = ["/home/x/old"]\n[b]\ny = 2\n',
        newPrefixes: ["@REPO@"],
        outcome: "merged",
        mustContain: ["[a]", "[b]", '"/home/x/old"', '"@REPO@"'],
      },
      {
        label: "quoted structural characters in paths",
        initial:
          '[whitelist]\nprefix = ["/home/x/[bracket]/git", "/home/x/has#hash", "/home/x/a,b", "/home/x/a\'b"]\n',
        newPrefixes: ["@REPO@"],
        outcome: "merged",
        mustContain: [
          '"/home/x/[bracket]/git"',
          '"/home/x/has#hash"',
          '"/home/x/a,b"',
          '"/home/x/a\'b"',
          '"@REPO@"',
        ],
      },
      {
        label: "nested arrays",
        initial: '[whitelist]\nprefix = [["/a"], "/b"]\n',
        newPrefixes: ["@REPO@"],
        outcome: "unchanged",
        warn: "malformed",
      },
      {
        label: "inline tables",
        initial: '[whitelist]\nprefix = [{p = "/a"}, "/b"]\n',
        newPrefixes: ["@REPO@"],
        outcome: "unchanged",
        warn: "malformed",
      },
      {
        label: "bare-string prefix",
        initial: '[whitelist]\nprefix = "/home/x/old"\n',
        newPrefixes: ["@REPO@"],
        outcome: "unchanged",
        warn: "malformed",
      },
      {
        label: "unterminated array",
        initial: '[whitelist]\nprefix = ["/home/x/a",\n',
        newPrefixes: ["@REPO@"],
        outcome: "unchanged",
        warn: "malformed",
      },
      {
        label: "duplicate prefix keys",
        initial: '[whitelist]\nprefix = ["/home/x/a"]\nprefix = ["/home/x/b"]\n',
        newPrefixes: ["@REPO@"],
        outcome: "unchanged",
        warn: "more than one",
      },
      {
        label: "500-entry array plus two new prefixes",
        initial: bigArray,
        newPrefixes: ["@REPO@", "/home/x/added"],
        outcome: "merged",
        mustContain: ['"/home/x/e0"', '"/home/x/e499"', '"@REPO@"', '"/home/x/added"'],
      },
    ];

    const assertDirenvAccepts = (label: string): void => {
      if (DIRENV_PATH === null) {
        return;
      }
      let statusRaw: string;
      try {
        statusRaw = execFileSync(DIRENV_PATH, ["status", "--json"], {
          cwd: repo,
          env: direnvEnv(),
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        });
      } catch (error) {
        throw new Error(`${label}: real direnv rejected the file: ${String(error)}`);
      }
      const status = JSON.parse(statusRaw) as {
        state: { foundRC: { allowed: number } | null };
      };
      const found = status.state.foundRC;
      expect(found, label).not.toBeNull();
      if (found !== null) {
        expect(found.allowed, label).toBe(0);
      }
    };

    const assertCase = (testCase: TomlParserCase): void => {
      const initial = substitute(testCase.initial);
      writeToml(initial);
      const result = run([
        "--toml",
        toml,
        ...testCase.newPrefixes.map(substitute).flatMap((p) => ["--prefix", p]),
      ]);

      expect(result.status, testCase.label).toBe(0);

      if (testCase.outcome === "unchanged") {
        expect(result.stderr, testCase.label).toContain(testCase.warn ?? "");
        expect(readFileSync(toml), testCase.label).toEqual(Buffer.from(initial));
        return;
      }

      const contents = readFileSync(toml, "utf-8");
      for (const rawExpected of testCase.mustContain ?? []) {
        const expected = substitute(rawExpected);
        expect(contents, `${testCase.label}: ${expected}`).toContain(expected);
      }
      // A merge must not append a second value for the same key.
      const prefixKeys = contents.match(/prefix =/g) ?? [];
      expect(prefixKeys, testCase.label).toHaveLength(1);

      if (testCase.assertCrlf === true) {
        // Every newline must belong to a CRLF pair; a bare \n would be a
        // mixed-ending file.
        expect(contents.split("\r\n").join(""), testCase.label).not.toContain("\n");
      }

      assertDirenvAccepts(testCase.label);
    };

    cases.forEach(assertCase);
  });
});
