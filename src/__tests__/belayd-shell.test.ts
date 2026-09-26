import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupRenderedScripts,
  createShellHarness,
  readArgvLog,
  renderScript,
  runScript,
  type ShellHarness,
} from "./helpers/belayd-script-harness.js";

function writeFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

interface Fixtures {
  direnvRepo: string;
  flakeRepo: string;
  shellNixRepo: string;
  passRepo: string;
  noDevShellRepo: string;
}

describe("belayd-shell wrapper (unit)", () => {
  let harness: ShellHarness;
  let wrapper: string;
  let fixtures: Fixtures;

  beforeEach(() => {
    harness = createShellHarness();
    wrapper = renderScript("belayd-shell", {
      realShell: harness.realShell,
      jqPath: harness.jqPath,
    }).path;

    const { root } = harness;
    fixtures = {
      direnvRepo: join(root, "direnv-repo"),
      flakeRepo: join(root, "flake-repo"),
      shellNixRepo: join(root, "shellnix-repo"),
      passRepo: join(root, "pass-repo"),
      noDevShellRepo: join(root, "no-devshell-repo"),
    };
    writeFile(join(fixtures.direnvRepo, ".envrc"), "export FOO=1\n");
    mkdirSync(join(fixtures.direnvRepo, "sub", "deep"), { recursive: true });
    writeFile(join(fixtures.flakeRepo, "flake.nix"), "{}\n");
    writeFile(join(fixtures.shellNixRepo, "shell.nix"), "{}\n");
    writeFile(join(fixtures.noDevShellRepo, "flake.nix"), "{}\n");
    writeFile(join(fixtures.noDevShellRepo, ".pi/no-devshell"), "");
    mkdirSync(fixtures.passRepo, { recursive: true });
    mkdirSync(join(fixtures.passRepo, "sub"), { recursive: true });
  });

  afterEach(() => {
    harness.cleanup();
    cleanupRenderedScripts();
  });

  const run = (cwd: string, args: string[], env: NodeJS.ProcessEnv = harness.env) =>
    runScript(wrapper, args, { cwd, env });

  const argv = () => readArgvLog(harness.argvLog);

  describe("direnv mode argv shapes", () => {
    it("loads the env via `direnv export bash` and forwards -c verbatim", () => {
      const result = run(fixtures.direnvRepo, ["-c", "echo hi"]);

      expect(result).toHaveProperty("status", 0);
      // The real shell is exec'd directly with the caller's argv; direnv is
      // consulted only to produce the env diff.
      expect(argv()).toEqual(["argc=2", "-c", "echo hi"]);
      expect(readArgvLog(harness.direnvLog)).toEqual([
        "argc=2",
        "export",
        "bash",
        `cwd=${fixtures.direnvRepo}`,
      ]);
    });

    it("forwards -lc verbatim", () => {
      run(fixtures.direnvRepo, ["-lc", "echo hi"]);

      expect(argv()).toEqual(["argc=2", "-lc", "echo hi"]);
    });

    it("forwards -l and no-args shapes", () => {
      run(fixtures.direnvRepo, ["-l"]);
      expect(argv()).toEqual(["argc=1", "-l"]);

      writeFileSync(harness.argvLog, "");
      run(fixtures.direnvRepo, []);
      expect(argv()).toEqual(["argc=0"]);
    });

    it("applies the exported env before exec", () => {
      const result = run(fixtures.direnvRepo, ["-c", "echo hi"], {
        ...harness.env,
        BELAYD_TEST_DIRENV_EXPORT: "export BELAYD_TEST_SHELL_STDOUT=yes",
      });

      expect(result.stdout).toBe("yes");
    });

    it("discards direnv status noise on the success path (W7)", () => {
      const result = run(fixtures.direnvRepo, ["-c", "echo hi"]);

      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain("direnv:");
    });

    it("forwards non-fatal .envrc runtime errors on the success path (W8)", () => {
      const env = {
        ...harness.env,
        BELAYD_TEST_DIRENV_DIAG: "./.envrc:1: bad-command-xyz: command not found",
      };
      const result = run(fixtures.direnvRepo, ["-c", "echo hi"], env);

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("bad-command-xyz: command not found");
      // The status banner is still filtered; only the real diagnostic remains.
      expect(result.stderr).not.toContain("direnv: loading");
      // The command still ran.
      expect(argv()).toEqual(["argc=2", "-c", "echo hi"]);
    });

    it("filters a status line hidden behind stacked ANSI escapes (S6)", () => {
      const env = {
        ...harness.env,
        BELAYD_TEST_DIRENV_DIAG: "\u001b[0m\u001b[31mdirenv: loading nested",
      };
      const result = run(fixtures.direnvRepo, ["-c", "echo hi"], env);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    });
  });

  describe("flake mode argv shapes", () => {
    it("forwards -c through nix develop", () => {
      run(fixtures.flakeRepo, ["-c", "echo hi"]);

      expect(argv()).toEqual([
        "argc=6",
        "develop",
        fixtures.flakeRepo,
        "-c",
        harness.realShell,
        "-c",
        "echo hi",
      ]);
    });

    it("forwards -l through nix develop", () => {
      run(fixtures.flakeRepo, ["-l"]);

      expect(argv()).toEqual([
        "argc=5",
        "develop",
        fixtures.flakeRepo,
        "-c",
        harness.realShell,
        "-l",
      ]);
    });
  });

  describe("shell.nix mode argv shapes", () => {
    it("quotes the command string for -c", () => {
      run(fixtures.shellNixRepo, ["-c", "echo hi"]);

      expect(argv()).toEqual([
        "argc=3",
        fixtures.shellNixRepo,
        "--command",
        `exec ${harness.realShell} -c echo\\ hi`,
      ]);
    });

    it("handles the no-args shape", () => {
      run(fixtures.shellNixRepo, []);

      expect(argv()).toEqual([
        "argc=3",
        fixtures.shellNixRepo,
        "--command",
        `exec ${harness.realShell}`,
      ]);
    });
  });

  describe("transparent pass-through", () => {
    it("execs the real shell with no output and forwards args", () => {
      const result = run(fixtures.passRepo, ["-c", "echo hi"]);

      expect(result).toHaveProperty("status", 0);
      expect(result).toHaveProperty("stdout", "");
      expect(result).toHaveProperty("stderr", "");
      expect(argv()).toEqual(["argc=2", "-c", "echo hi"]);
    });

    it("preserves cwd from a subdirectory", () => {
      run(join(fixtures.passRepo, "sub"), ["-c", "pwd"]);

      const logged = readArgvLog(harness.pwdLog);
      expect(logged).toEqual([join(fixtures.passRepo, "sub")]);
    });
  });

  describe("root resolution", () => {
    it("walks up from a nested subdirectory", () => {
      run(join(fixtures.direnvRepo, "sub", "deep"), ["-c", "pwd"]);

      // direnv is asked to export from the resolved root, while the shell is
      // exec'd in the caller's original cwd.
      expect(readArgvLog(harness.direnvLog)).toContain(`cwd=${fixtures.direnvRepo}`);
      expect(readArgvLog(harness.pwdLog)).toEqual([join(fixtures.direnvRepo, "sub", "deep")]);
    });

    it("stops at a .pi/no-devshell marker and passes through", () => {
      const result = run(fixtures.noDevShellRepo, ["-c", "echo hi"]);

      expect(result).toHaveProperty("status", 0);
      // Real shell got the args directly; nix/direnv were never consulted.
      expect(argv()).toEqual(["argc=2", "-c", "echo hi"]);
    });

    it("prefers direnv over the flake when both exist in the root", () => {
      writeFile(join(fixtures.direnvRepo, "flake.nix"), "{}\n");
      run(fixtures.direnvRepo, ["-c", "echo hi"]);

      expect(readArgvLog(harness.direnvLog)).toContain("export");
      expect(argv()).not.toContain("develop");
    });

    it("prefers the nearest flake over an ancestor .envrc", () => {
      writeFile(join(fixtures.direnvRepo, "child", "flake.nix"), "{}\n");
      run(join(fixtures.direnvRepo, "child"), ["-c", "echo hi"]);

      expect(argv()).toContain(join(fixtures.direnvRepo, "child"));
      expect(argv()).toContain("develop");
    });
  });

  describe("no-recursion guard", () => {
    it("execs the real shell without resolving a devShell", () => {
      const env = { ...harness.env, BELAYD_SHELL_ACTIVE: "1" };
      run(fixtures.direnvRepo, ["-c", "echo hi"], env);

      expect(argv()).toEqual(["argc=2", "-c", "echo hi"]);
    });
  });

  describe("fail-loud branches", () => {
    it("fails when .envrc exists but direnv is not on PATH", () => {
      const env = { ...harness.env, PATH: harness.bashDir };
      const result = run(fixtures.direnvRepo, ["-c", "echo hi"], env);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("direnv is not on PATH");
      expect(result.stderr).toContain("belayd-shell:");
    });

    it("fails loud and never falls back when .envrc is blocked", () => {
      const env = {
        ...harness.env,
        BELAYD_TEST_DIRENV_STATUS: '{"state":{"foundRC":{"allowed":1}}}',
      };
      const result = run(fixtures.direnvRepo, ["-c", "echo hi"], env);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`direnv allow ${fixtures.direnvRepo}`);
      // The flake path must not be used when .envrc exists.
      expect(argv()).toEqual([]);
    });

    it("fails loud when .envrc is denied", () => {
      const env = {
        ...harness.env,
        BELAYD_TEST_DIRENV_STATUS: '{"state":{"foundRC":{"allowed":2}}}',
      };
      const result = run(fixtures.direnvRepo, ["-c", "echo hi"], env);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("direnv allow");
    });

    it("names the file when direnv reports no readable state (S4)", () => {
      const env = {
        ...harness.env,
        BELAYD_TEST_DIRENV_STATUS: '{"state":{"foundRC":null}}',
      };
      const result = run(fixtures.direnvRepo, ["-c", "echo hi"], env);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("no readable state");
      expect(result.stderr).toContain(fixtures.direnvRepo);
      expect(result.stderr).not.toContain("state: unknown");
    });

    it("propagates a nix develop failure exit code", () => {
      const env = { ...harness.env, BELAYD_TEST_NIX_EXIT: "7" };
      const result = run(fixtures.flakeRepo, ["-c", "echo hi"], env);

      expect(result.status).toBe(7);
    });

    it("fails loud on a broken .envrc and does not run the command (W1)", () => {
      const env = { ...harness.env, BELAYD_TEST_DIRENV_EXIT: "7" };
      const result = run(fixtures.direnvRepo, ["-c", "echo should-not-run"], env);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("direnv export bash exited 7");
      expect(result.stderr).toContain("exit status 7");
      expect(result.stdout).not.toContain("should-not-run");
      // The status noise is still filtered from the failure diagnostics.
      expect(result.stderr).not.toContain("direnv: loading");
    });
  });
});
