import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupRenderedScripts,
  findJq,
  renderScript,
  runScript,
} from "../src/__tests__/helpers/belayd-script-harness.js";

const REPO_ROOT = resolve(import.meta.dirname, "..");

function which(binary: string): string | null {
  const result = execFileSync("sh", ["-c", `command -v ${binary}`], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  return result === "" ? null : result;
}

const BASH_PATH = which("bash");
const DIRENV_PATH = which("direnv");
const NIX_PATH = which("nix");
const JQ_PATH = findJq();

/** Strip direnv state and the wrapper guard so each fixture starts clean. */
function integrationEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    if (key.startsWith("DIRENV_") || key === "BELAYD_SHELL_ACTIVE") {
      delete env[key];
    }
  }
  return env;
}

describe("belayd-shell (integration, real binaries)", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "belayd-shell-integration-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    cleanupRenderedScripts();
  });

  function renderWrapper(): string {
    if (BASH_PATH === null || JQ_PATH === null) {
      throw new Error("integration prerequisites missing (bash/jq)");
    }
    return renderScript("belayd-shell", { realShell: BASH_PATH, jqPath: JQ_PATH }).path;
  }

  it("loads a real .envrc and preserves cwd from a subdirectory", () => {
    if (DIRENV_PATH === null) {
      console.warn("Skipping integration test: direnv not available");
      return;
    }
    const dir = join(tmpRoot, "direnv-repo");
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, ".envrc"), "export BELAYD_TEST_ENV=ok\n");

    const env = integrationEnv({
      XDG_DATA_HOME: join(tmpRoot, "direnv-data"),
      XDG_CONFIG_HOME: join(tmpRoot, "direnv-config"),
    });
    execFileSync("direnv", ["allow", dir], { cwd: dir, env, stdio: "pipe" });

    const result = runScript(renderWrapper(), ["-c", "echo $BELAYD_TEST_ENV; pwd"], {
      cwd: join(dir, "sub"),
      env,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ok");
    expect(result.stdout).toContain(join(dir, "sub"));
  });

  it("fails loud for a blocked .envrc without falling back", () => {
    if (DIRENV_PATH === null) {
      console.warn("Skipping integration test: direnv not available");
      return;
    }
    const dir = join(tmpRoot, "blocked-repo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".envrc"), "export NOPE=1\n");

    const env = integrationEnv({
      XDG_DATA_HOME: join(tmpRoot, "blocked-data"),
      XDG_CONFIG_HOME: join(tmpRoot, "blocked-config"),
    });
    const result = runScript(renderWrapper(), ["-c", "echo hi"], { cwd: dir, env });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`direnv allow ${dir}`);
  });

  it("resolves a devShell-only tool through nix develop and preserves cwd", () => {
    if (NIX_PATH === null) {
      console.warn("Skipping integration test: nix not available");
      return;
    }
    const dir = join(tmpRoot, "flake-repo");
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeMinimalFlake(dir);

    const result = runScript(renderWrapper(), ["-c", "command -v belayd-devshell-only-tool; pwd"], {
      cwd: join(dir, "sub"),
      env: integrationEnv(),
      timeoutInMs: 120_000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("belayd-devshell-only-tool");
    expect(result.stdout).toContain(join(dir, "sub"));
  });

  it("is a transparent pass-through in a plain directory", () => {
    const dir = join(tmpRoot, "plain");
    mkdirSync(dir, { recursive: true });

    const result = runScript(renderWrapper(), ["-c", "command -v bash; printf marker"], {
      cwd: dir,
      env: integrationEnv(),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("marker");
    // Nothing extra on stderr and the ambient PATH (pi-web-runtime-env) is intact.
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("/bin/bash");
  });

  it("forwards exit codes and keeps stdout/stderr separated", () => {
    const dir = join(tmpRoot, "plain-exit");
    mkdirSync(dir, { recursive: true });

    const result = runScript(renderWrapper(), ["-c", "printf out; printf err >&2; exit 3"], {
      cwd: dir,
      env: integrationEnv(),
    });

    expect(result.status).toBe(3);
    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
  });

  it("suppresses the direnv loading line on a successful load (W1)", () => {
    if (DIRENV_PATH === null) {
      console.warn("Skipping integration test: direnv not available");
      return;
    }
    const dir = join(tmpRoot, "quiet-repo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".envrc"), "export BELAYD_QUIET=1\n");

    const env = integrationEnv({
      XDG_DATA_HOME: join(tmpRoot, "quiet-data"),
      XDG_CONFIG_HOME: join(tmpRoot, "quiet-config"),
    });
    execFileSync("direnv", ["allow", dir], { cwd: dir, env, stdio: "pipe" });

    const result = runScript(renderWrapper(), ["-c", "echo ok"], { cwd: dir, env });

    expect(result.status).toBe(0);
    // The export/eval entry path discards direnv's stderr on success, so no
    // status banner of any kind reaches the caller.
    expect(result.stdout).toBe("ok\n");
    expect(result.stderr).toBe("");
  });

  it("keeps every line of a large stderr burst as a file and as a pipe (W6)", () => {
    if (DIRENV_PATH === null) {
      console.warn("Skipping integration test: direnv not available");
      return;
    }
    const dir = join(tmpRoot, "burst-repo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".envrc"), "export BURST=1\n");

    const env = integrationEnv({
      XDG_DATA_HOME: join(tmpRoot, "burst-data"),
      XDG_CONFIG_HOME: join(tmpRoot, "burst-config"),
    });
    execFileSync("direnv", ["allow", dir], { cwd: dir, env, stdio: "pipe" });
    const wrapper = renderWrapper();

    // Run through bash so the wrapper's stderr is a regular file: the removed
    // `2> >(filter)` pattern lost data specifically in that mode because bash
    // does not wait for the process-substitution subshell after `exec`.
    const errPath = join(tmpRoot, "burst.err");
    execFileSync("bash", ["-c", `"${wrapper}" -c 'seq 1 10000 >&2' 2>"${errPath}"`], {
      cwd: dir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const fileLines = readFileSync(errPath, "utf-8")
      .split("\n")
      .filter((line) => line !== "");
    expect(fileLines).toHaveLength(10000);

    const piped = runScript(wrapper, ["-c", "seq 1 10000 >&2"], { cwd: dir, env });
    expect(piped.stderr.split("\n").filter((line) => line !== "")).toHaveLength(10000);
  });

  it("execs the shell in place so the wrapper pid becomes the shell pid (W6)", async () => {
    if (DIRENV_PATH === null) {
      console.warn("Skipping integration test: direnv not available");
      return;
    }
    const dir = join(tmpRoot, "exec-repo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".envrc"), "export EXEC_TEST=1\n");

    const env = integrationEnv({
      XDG_DATA_HOME: join(tmpRoot, "exec-data"),
      XDG_CONFIG_HOME: join(tmpRoot, "exec-config"),
    });
    execFileSync("direnv", ["allow", dir], { cwd: dir, env, stdio: "pipe" });

    const child = spawn(renderWrapper(), ["-c", "printf %s $$"], { cwd: dir, env });
    const launchedPid = child.pid;
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    const exitCode = await new Promise<number | null>((resolveClose) => {
      child.on("close", resolveClose);
    });

    expect(exitCode).toBe(0);
    expect(launchedPid).toBeDefined();
    expect(stdout.trim()).toBe(String(launchedPid));
  });

  it("still behaves as a login/interactive shell with -lc (W6)", () => {
    if (DIRENV_PATH === null) {
      console.warn("Skipping integration test: direnv not available");
      return;
    }
    const dir = join(tmpRoot, "login-repo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".envrc"), "export LOGIN_TEST=1\n");

    const env = integrationEnv({
      XDG_DATA_HOME: join(tmpRoot, "login-data"),
      XDG_CONFIG_HOME: join(tmpRoot, "login-config"),
    });
    execFileSync("direnv", ["allow", dir], { cwd: dir, env, stdio: "pipe" });

    const result = runScript(renderWrapper(), ["-lc", "echo login-ok"], { cwd: dir, env });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("login-ok");
    expect(result.stderr).not.toContain("direnv:");
  });

  it("stays silent in a nix-direnv repo from the root and a subdirectory (W7)", () => {
    if (DIRENV_PATH === null || NIX_PATH === null) {
      console.warn("Skipping integration test: direnv/nix not available");
      return;
    }
    const dir = join(tmpRoot, "nix-direnv-repo");
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeMinimalFlake(dir);
    writeFileSync(join(dir, ".envrc"), "use flake\n");

    // Keep the ambient XDG_CONFIG_HOME so the nix-direnv `use flake` helper is
    // available; only the allow-state directory is redirected.
    const env = integrationEnv({ XDG_DATA_HOME: join(tmpRoot, "nd-data") });
    execFileSync("direnv", ["allow", dir], { cwd: dir, env, stdio: "pipe" });
    const wrapper = renderWrapper();

    for (const cwd of [dir, join(dir, "sub")]) {
      const result = runScript(wrapper, ["-c", "echo ok"], { cwd, env, timeoutInMs: 180_000 });
      expect(result.status, cwd).toBe(0);
      expect(result.stdout, cwd).toBe("ok\n");
      const noise = result.stderr.split("\n").filter((line) => line.includes("direnv:"));
      expect(noise, cwd).toHaveLength(0);
    }
  }, 180_000);

  it("emits arrays with quoted structural characters that real direnv accepts (C3)", () => {
    if (DIRENV_PATH === null || JQ_PATH === null) {
      console.warn("Skipping integration test: direnv/jq not available");
      return;
    }
    const setup = renderScript("belayd-direnv-setup", {
      realShell: BASH_PATH ?? "/bin/bash",
      jqPath: JQ_PATH,
    }).path;
    const cases: Array<{ label: string; initial: string; mustContain: string }> = [
      {
        label: "] in double-quoted path",
        initial: '[whitelist]\nprefix = ["/home/x/[bracket]/git"]\n',
        mustContain: '"/home/x/[bracket]/git"',
      },
      {
        label: "[] in double-quoted path",
        initial: '[whitelist]\nprefix = ["/home/x/[a]/[b]/git"]\n',
        mustContain: '"/home/x/[a]/[b]/git"',
      },
      {
        label: "] in literal single-quoted path",
        initial: "[whitelist]\nprefix = ['/home/x/[lit]/git']\n",
        mustContain: "'/home/x/[lit]/git'",
      },
      {
        label: "# in double-quoted path",
        initial: '[whitelist]\nprefix = ["/home/x/has#hash"] # keep\n',
        mustContain: '"/home/x/has#hash"',
      },
      {
        label: ", in double-quoted path",
        initial: '[whitelist]\nprefix = ["/home/x/a,b"]\n',
        mustContain: '"/home/x/a,b"',
      },
      {
        label: "escaped quote in path",
        initial: '[whitelist]\nprefix = ["/home/x/a\\"b"]\n',
        mustContain: 'a\\"b',
      },
    ];

    cases.forEach((testCase, index) => {
      const configDir = join(tmpRoot, `c3-config-${index}`);
      const dataDir = join(tmpRoot, `c3-data-${index}`);
      const repo = join(tmpRoot, `c3-repo-${index}`);
      mkdirSync(join(configDir, "direnv"), { recursive: true });
      mkdirSync(repo, { recursive: true });
      writeFileSync(join(repo, ".envrc"), "export A=1\n");
      const toml = join(configDir, "direnv", "direnv.toml");
      writeFileSync(toml, testCase.initial);

      const setupResult = runScript(setup, ["--toml", toml, "--prefix", repo], {
        cwd: tmpRoot,
        env: integrationEnv(),
      });
      expect(setupResult.status, testCase.label).toBe(0);

      const contents = readFileSync(toml, "utf-8");
      expect(contents, testCase.label).toContain(testCase.mustContain);
      expect(contents.match(/^\[whitelist\]/gm), testCase.label).toHaveLength(1);
      expect(contents.match(/prefix =/g), testCase.label).toHaveLength(1);

      // Real direnv must parse the rewritten file (invalid TOML makes
      // `direnv status --json` fail) and honour the newly whitelisted repo.
      const env = integrationEnv({ XDG_CONFIG_HOME: configDir, XDG_DATA_HOME: dataDir });
      const statusRaw = execFileSync("direnv", ["status", "--json"], {
        cwd: repo,
        env,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const status = JSON.parse(statusRaw) as { state: { foundRC: { allowed: number } } };
      expect(status.state.foundRC.allowed, testCase.label).toBe(0);
    });
  });

  it("still surfaces a broken .envrc as an actionable failure (W1)", () => {
    if (DIRENV_PATH === null) {
      console.warn("Skipping integration test: direnv not available");
      return;
    }
    const dir = join(tmpRoot, "broken-repo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".envrc"), "exit 7\n");

    const env = integrationEnv({
      XDG_DATA_HOME: join(tmpRoot, "broken-data"),
      XDG_CONFIG_HOME: join(tmpRoot, "broken-config"),
    });
    execFileSync("direnv", ["allow", dir], { cwd: dir, env, stdio: "pipe" });

    const result = runScript(renderWrapper(), ["-c", "echo should-not-run"], { cwd: dir, env });

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("should-not-run");
    expect(result.stderr).not.toContain("direnv: loading");
    expect(result.stderr).toContain("exit status");
  });

  it("produces direnv.toml that real direnv accepts (C2)", () => {
    if (DIRENV_PATH === null || JQ_PATH === null) {
      console.warn("Skipping integration test: direnv/jq not available");
      return;
    }
    const configDir = join(tmpRoot, "whitelist-config");
    const dataDir = join(tmpRoot, "whitelist-data");
    const repo = join(tmpRoot, "whitelist-repo");
    mkdirSync(join(configDir, "direnv"), { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, ".envrc"), "export A=1\n");
    const toml = join(configDir, "direnv", "direnv.toml");
    // The inline comment is the regression: a naive parser appends a second
    // [whitelist] table (last-wins) and orphans this prefix list.
    writeFileSync(toml, '[whitelist] # managed\nprefix = [\n  "/already",\n]\n');

    const setup = renderScript("belayd-direnv-setup", {
      realShell: BASH_PATH ?? "/bin/bash",
      jqPath: JQ_PATH,
    }).path;
    const setupResult = runScript(setup, ["--toml", toml, "--prefix", repo], {
      cwd: tmpRoot,
      env: integrationEnv(),
    });
    expect(setupResult.status).toBe(0);

    const contents = readFileSync(toml, "utf-8");
    expect(contents.match(/^\[whitelist\]/gm)).toHaveLength(1);

    const env = integrationEnv({ XDG_CONFIG_HOME: configDir, XDG_DATA_HOME: dataDir });
    const statusRaw = execFileSync("direnv", ["status", "--json"], {
      cwd: repo,
      env,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const status = JSON.parse(statusRaw) as { state: { foundRC: { allowed: number } } };
    expect(status.state.foundRC.allowed).toBe(0);
  });

  it("forwards a non-fatal .envrc runtime error without the status banner (W8)", () => {
    if (DIRENV_PATH === null) {
      console.warn("Skipping integration test: direnv not available");
      return;
    }
    const dir = join(tmpRoot, "runtime-error-repo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".envrc"), "bad-command-xyz\n");

    const env = integrationEnv({
      XDG_DATA_HOME: join(tmpRoot, "runtime-error-data"),
      XDG_CONFIG_HOME: join(tmpRoot, "runtime-error-config"),
    });
    execFileSync("direnv", ["allow", dir], { cwd: dir, env, stdio: "pipe" });

    const result = runScript(renderWrapper(), ["-c", "echo still-runs"], { cwd: dir, env });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("still-runs\n");
    expect(result.stderr).toContain("bad-command-xyz: command not found");
    expect(result.stderr).not.toContain("direnv: loading");
  });

  it("does not lose a 10000-line .envrc diagnostic burst to a file (W8)", () => {
    if (DIRENV_PATH === null) {
      console.warn("Skipping integration test: direnv not available");
      return;
    }
    const dir = join(tmpRoot, "diag-burst-repo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".envrc"), "seq 1 10000 >&2\n");

    const env = integrationEnv({
      XDG_DATA_HOME: join(tmpRoot, "diag-burst-data"),
      XDG_CONFIG_HOME: join(tmpRoot, "diag-burst-config"),
    });
    execFileSync("direnv", ["allow", dir], { cwd: dir, env, stdio: "pipe" });
    const wrapper = renderWrapper();

    // stderr redirected to a regular file is the mode in which the removed
    // process-substitution filter lost data after `exec`.
    const errPath = join(tmpRoot, "diag-burst.err");
    execFileSync("bash", ["-c", `"${wrapper}" -c 'true' 2>"${errPath}"`], {
      cwd: dir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const lines = readFileSync(errPath, "utf-8")
      .split("\n")
      .filter((line) => line !== "");
    expect(lines).toHaveLength(10000);
  });

  it("accepts interior whitespace in the [whitelist] header (C4)", () => {
    if (DIRENV_PATH === null || JQ_PATH === null) {
      console.warn("Skipping integration test: direnv/jq not available");
      return;
    }
    const headers = [
      "[ whitelist ]",
      "[whitelist ]",
      "[ whitelist]",
      "[\twhitelist\t]",
      "[ whitelist ] # managed",
    ];
    headers.forEach((header, index) => {
      const configDir = join(tmpRoot, `c4-config-${index}`);
      const dataDir = join(tmpRoot, `c4-data-${index}`);
      const repo = join(tmpRoot, `c4-repo-${index}`);
      mkdirSync(join(configDir, "direnv"), { recursive: true });
      mkdirSync(repo, { recursive: true });
      writeFileSync(join(repo, ".envrc"), "export A=1\n");
      const toml = join(configDir, "direnv", "direnv.toml");
      writeFileSync(toml, `${header}\nprefix = ["/already"]\n`);

      const setup = renderScript("belayd-direnv-setup", {
        realShell: BASH_PATH ?? "/bin/bash",
        jqPath: JQ_PATH,
      }).path;
      const setupResult = runScript(setup, ["--toml", toml, "--prefix", repo], {
        cwd: tmpRoot,
        env: integrationEnv(),
      });
      expect(setupResult.status, header).toBe(0);

      const contents = readFileSync(toml, "utf-8");
      // Exactly one whitelist-equivalent table; a second would be invalid TOML.
      expect(contents.match(/^\s*\[\s*whitelist\s*\]/gm), header).toHaveLength(1);
      expect(contents, header).toContain(`prefix = ["/already", "${repo}"]`);

      const env = integrationEnv({ XDG_CONFIG_HOME: configDir, XDG_DATA_HOME: dataDir });
      const statusRaw = execFileSync("direnv", ["status", "--json"], {
        cwd: repo,
        env,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const status = JSON.parse(statusRaw) as { state: { foundRC: { allowed: number } } };
      expect(status.state.foundRC.allowed, header).toBe(0);
    });
  });

  it("leaves nested-array prefix shapes untouched (W9)", () => {
    if (JQ_PATH === null) {
      console.warn("Skipping integration test: jq not available");
      return;
    }
    const setup = renderScript("belayd-direnv-setup", {
      realShell: BASH_PATH ?? "/bin/bash",
      jqPath: JQ_PATH,
    }).path;
    const configDir = join(tmpRoot, "w9-config");
    mkdirSync(join(configDir, "direnv"), { recursive: true });
    const repo = join(tmpRoot, "w9-repo");
    const toml = join(configDir, "direnv", "direnv.toml");
    const cases = ['prefix = [["/a"], "/b"]', 'prefix = [{p = "/a"}, "/b"]'];
    cases.forEach((value) => {
      const original = `[whitelist]\n${value}\n`;
      writeFileSync(toml, original);

      const result = runScript(setup, ["--toml", toml, "--prefix", repo], {
        cwd: tmpRoot,
        env: integrationEnv(),
      });

      expect(result.status, value).toBe(0);
      expect(result.stderr, value).toContain("malformed");
      expect(readFileSync(toml, "utf-8"), value).toBe(original);
    });
  });
});

/**
 * Build a minimal flake that provides a uniquely-named devShell-only tool, so
 * the assertion cannot pass via an ambient PATH binary. `flake.lock` is copied
 * from this repo so nix uses the already-cached nixpkgs pin (offline).
 */
function writeMinimalFlake(dir: string): void {
  const lock = readFileSync(join(REPO_ROOT, "flake.lock"), "utf-8");
  writeFileSync(join(dir, "flake.lock"), lock);
  const system = detectSystem();
  writeFileSync(
    join(dir, "flake.nix"),
    `{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  outputs = { self, nixpkgs }:
    let
      pkgs = import nixpkgs { system = "${system}"; };
      marker = pkgs.writeShellScriptBin "belayd-devshell-only-tool" "echo devshell-only";
    in {
      devShells.${system}.default = pkgs.mkShell { packages = [ marker pkgs.jq ]; };
    };
}
`,
  );
}

function detectSystem(): string {
  try {
    return execFileSync("nix", ["eval", "--raw", "--impure", "--expr", "builtins.currentSystem"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "x86_64-linux";
  }
}
