import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");

export interface RenderedScript {
  path: string;
  /** Directory of the render, removed by {@link cleanupRenderedScripts}. */
  dir: string;
}

const renderedDirs: string[] = [];

/**
 * Render a checked-in script to a temp file by performing the same
 * `@placeholder@` substitution the Nix `belayd-shell` derivation does. Keep
 * this in sync with flake.nix: the tokens and their targets must match.
 *
 * The repo shebang (`#!/usr/bin/env bash`) is kept as-is because bash is on
 * PATH in the test environment; the Nix build rewrites it to a store shebang.
 */
export function renderScript(
  name: string,
  placeholders: { realShell: string; jqPath: string },
): RenderedScript {
  const source = readFileSync(join(REPO_ROOT, "scripts", `${name}.sh`), "utf-8");
  const rendered = source
    .replaceAll("@realShell@", placeholders.realShell)
    .replaceAll("@jq@", placeholders.jqPath);
  const dir = mkdtempSync(join(tmpdir(), `belayd-render-${name}-`));
  const path = join(dir, name);
  writeFileSync(path, rendered);
  chmodSync(path, 0o755);
  renderedDirs.push(dir);
  return { path, dir };
}

export function cleanupRenderedScripts(): void {
  for (const dir of renderedDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

const REAL_SHELL_STUB = `#!/bin/sh
printf 'argc=%s\\n' "$#" > "$BELAYD_TEST_ARGV_LOG"
printf '%s\\n' "$@" >> "$BELAYD_TEST_ARGV_LOG"
if [ -n "\${BELAYD_TEST_PWD_LOG:-}" ]; then pwd >> "$BELAYD_TEST_PWD_LOG"; fi
printf '%s' "\${BELAYD_TEST_SHELL_STDOUT:-}"
printf '%s' "\${BELAYD_TEST_SHELL_STDERR:-}" >&2
exit "\${BELAYD_TEST_SHELL_EXIT:-0}"
`;

const DIRENV_STUB = `#!/bin/sh
if [ "$1" = "status" ]; then
  printf '%s\\n' "$BELAYD_TEST_DIRENV_STATUS"
  exit 0
fi
if [ "$1" = "export" ]; then
  if [ -n "\${BELAYD_TEST_DIRENV_LOG:-}" ]; then
    printf 'argc=%s\\n' "$#" > "$BELAYD_TEST_DIRENV_LOG"
    printf '%s\\n' "$@" >> "$BELAYD_TEST_DIRENV_LOG"
    printf 'cwd=%s\\n' "$(pwd)" >> "$BELAYD_TEST_DIRENV_LOG"
  fi
  printf 'direnv: loading %s/.envrc\\n' "\${BELAYD_TEST_DIRENV_ROOT:-.}" >&2
  if [ "\${BELAYD_TEST_DIRENV_EXIT:-0}" != "0" ]; then
    printf 'direnv: error %s/.envrc: exit status %s\\n' "\${BELAYD_TEST_DIRENV_ROOT:-.}" "$BELAYD_TEST_DIRENV_EXIT" >&2
    exit "$BELAYD_TEST_DIRENV_EXIT"
  fi
  if [ -n "\${BELAYD_TEST_DIRENV_DIAG:-}" ]; then
    printf '%s\\n' "\${BELAYD_TEST_DIRENV_DIAG}" >&2
  fi
  if [ -n "\${BELAYD_TEST_DIRENV_EXPORT:-}" ]; then
    printf '%s\\n' "\${BELAYD_TEST_DIRENV_EXPORT}"
  fi
  exit 0
fi
printf 'argc=%s\\n' "$#" > "$BELAYD_TEST_ARGV_LOG"
printf '%s\\n' "$@" >> "$BELAYD_TEST_ARGV_LOG"
exit "\${BELAYD_TEST_DIRENV_EXIT:-0}"
`;

const NIX_STUB = `#!/bin/sh
printf 'argc=%s\\n' "$#" > "$BELAYD_TEST_ARGV_LOG"
printf '%s\\n' "$@" >> "$BELAYD_TEST_ARGV_LOG"
exit "\${BELAYD_TEST_NIX_EXIT:-0}"
`;

export interface ShellHarness {
  root: string;
  stubDir: string;
  bashDir: string;
  realShell: string;
  jqPath: string;
  argvLog: string;
  pwdLog: string;
  direnvLog: string;
  /** Base env with the stubs first on PATH. */
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

/**
 * Build a temp fixture with stub `direnv`/`nix`/`nix-shell`/real-shell binaries
 * so unit tests can assert the exact argv the wrapper execs without touching
 * real nix/direnv.
 */
export function createShellHarness(): ShellHarness {
  const root = mkdtempSync(join(tmpdir(), "belayd-shell-test-"));
  const stubDir = join(root, "stub-bin");
  const bashDir = join(root, "bash-bin");
  mkdirSync(stubDir);
  mkdirSync(bashDir);

  const writeStub = (dir: string, name: string, body: string): string => {
    const path = join(dir, name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
    return path;
  };

  const realShell = writeStub(stubDir, "real-shell", REAL_SHELL_STUB);
  writeStub(stubDir, "direnv", DIRENV_STUB);
  writeStub(stubDir, "nix", NIX_STUB);
  writeStub(stubDir, "nix-shell", NIX_STUB);

  // `#!/usr/bin/env bash` needs bash on PATH; symlink the one running the tests.
  const bashPath = spawnSync("sh", ["-c", "command -v bash"], { encoding: "utf-8" }).stdout.trim();
  if (bashPath) {
    symlinkSync(bashPath, join(bashDir, "bash"));
  }

  const argvLog = join(root, "argv.log");
  const pwdLog = join(root, "pwd.log");
  const direnvLog = join(root, "direnv.log");
  const jqPath = findJq();
  if (jqPath === null) {
    throw new Error("belayd-script-harness: no jq found (set BELAYD_TEST_JQ)");
  }

  return {
    root,
    stubDir,
    bashDir,
    realShell,
    jqPath,
    argvLog,
    pwdLog,
    direnvLog,
    env: {
      ...process.env,
      PATH: `${stubDir}:${bashDir}:${process.env.PATH ?? ""}`,
      BELAYD_TEST_ARGV_LOG: argvLog,
      BELAYD_TEST_PWD_LOG: pwdLog,
      BELAYD_TEST_DIRENV_LOG: direnvLog,
      BELAYD_TEST_DIRENV_STATUS: '{"state":{"foundRC":{"allowed":0}}}',
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function runScript(
  scriptPath: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutInMs?: number },
): RunResult {
  const result = spawnSync(scriptPath, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf-8",
    timeout: options.timeoutInMs ?? 20_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function readArgvLog(path: string): string[] {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((line) => line !== "");
}

/** Locate a real jq binary: env override, PATH, or a nix store copy. */
export function findJq(): string | null {
  const explicit = process.env.BELAYD_TEST_JQ;
  if (explicit && existsSync(explicit)) {
    return explicit;
  }
  const onPath = spawnSync("sh", ["-c", "command -v jq"], { encoding: "utf-8" }).stdout.trim();
  if (onPath) {
    return onPath;
  }
  const store = "/nix/store";
  if (!existsSync(store)) {
    return null;
  }
  for (const entry of readdirSync(store)) {
    if (!entry.includes("-jq-")) {
      continue;
    }
    const candidate = join(store, entry, "bin", "jq");
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}
