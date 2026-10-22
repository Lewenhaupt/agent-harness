import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupRenderedScripts,
  findJq,
  renderScript,
  runScript,
} from "../src/__tests__/helpers/belayd-script-harness.js";
import {
  prepareScopeFiles,
  resolveMaskEntries,
  shellQuote,
  toSandboxMask,
} from "../src/aws-broker/plan.js";
import {
  buildSandboxArgv,
  type SandboxMask,
  scopeDirFor,
  scopeIdFor,
  socketPathFor,
} from "../src/aws-broker/scope.js";
import { createSocketBindLock, startUnixSocketServer } from "../src/aws-broker/server.js";

const BWRAP = which("bwrap");
const DIRENV = which("direnv");
const GIT = which("git");
const JQ = findJq();
const REPO_ROOT = resolve(import.meta.dirname, "..");

function which(binary: string): string | null {
  const result = spawnSync("sh", ["-c", `command -v ${binary}`], { encoding: "utf-8" });
  const stdout = result.stdout?.trim() ?? "";
  return stdout === "" ? null : stdout;
}

/** bwrap path, or a clear failure: `it.skipIf` already guards every caller. */
function requireBwrap(): string {
  if (BWRAP === null) throw new Error("bubblewrap is required for this test");
  return BWRAP;
}

/**
 * Strip direnv per-directory state and the wrapper guard, mirroring
 * src/spawn.ts: without this the harness process own devShell state leaks in
 * and `direnv export bash` returns a diff relative to the wrong .envrc.
 */
function cleanEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    if (key.startsWith("DIRENV_") || key === "BELAYD_SHELL_ACTIVE") delete env[key];
  }
  return env;
}

/** jq path, or a clear failure: `it.skipIf` already guards every caller. */
function requireJq(): string {
  if (JQ === null) throw new Error("jq is required for this test");
  return JQ;
}

/**
 * Real-binary integration coverage for the per-repo bwrap sandbox (bd-125).
 *
 * `it.skipIf` (not an early `return`) marks the tests as skipped when a
 * prerequisite is missing, so the report never shows a skip as a pass.
 */
describe("aws sandbox masking (integration, real bwrap)", () => {
  let root: string;
  let home: string;
  let runtimeBaseDir: string;
  let scopeDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "belayd-aws-sandbox-"));
    home = join(root, "home");
    runtimeBaseDir = join(root, "runtime", "belayd", "aws");
    mkdirSync(join(home, ".aws", "sso", "cache"), { recursive: true });
    mkdirSync(join(home, ".config", "aws"), { recursive: true });
    mkdirSync(runtimeBaseDir, { recursive: true });
    writeFileSync(join(home, ".aws", "sso", "cache", "x.json"), '{"accessToken":"CANARY"}\n');
    scopeDir = scopeDirFor({ runtimeBaseDir, scopeId: scopeIdFor("/repo") });
    prepareScopeFiles({
      scopeDir,
      socketPath: socketPathFor(scopeDir),
      region: "eu-north-1",
      shimContents: "#!/bin/sh\nexit 0\n",
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    cleanupRenderedScripts();
  });

  function sandboxArgv(command: string[], masks?: readonly SandboxMask[]): string[] {
    return buildSandboxArgv({
      bwrapPath: requireBwrap(),
      homeDir: home,
      runtimeBaseDir,
      scopeDir,
      masks: masks ?? [
        { kind: "tmpfs", path: join(home, ".aws") },
        { kind: "tmpfs", path: join(home, ".config", "aws") },
      ],
      region: "eu-north-1",
      command,
    });
  }

  function runSandboxed(
    command: string[],
    masks?: readonly SandboxMask[],
  ): {
    status: number | null;
    stdout: string;
    stderr: string;
  } {
    const argv = sandboxArgv(command, masks);
    const binary = argv[0];
    if (binary === undefined) throw new Error("empty sandbox argv");
    const result = spawnSync(binary, argv.slice(1), {
      encoding: "utf-8",
      env: process.env,
      // A sandboxed client that never exits must fail the test, not hang it.
      timeout: 15_000,
    });
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }

  it.skipIf(BWRAP === null)(
    "cannot read the SSO cache, sees only the synthetic profile, and hides sibling scopes",
    () => {
      // Control: the canary is readable outside the sandbox.
      expect(readFileSync(join(home, ".aws", "sso", "cache", "x.json"), "utf-8")).toContain(
        "CANARY",
      );

      const sibling = scopeDirFor({ runtimeBaseDir, scopeId: "deadbeefcafe" });
      mkdirSync(sibling, { recursive: true });
      writeFileSync(join(sibling, "canary.json"), "SIBLING\n");

      const script = [
        `cat ${shellQuote(join(home, ".aws", "sso", "cache", "x.json"))} 2>&1 || true`,
        `cat ${shellQuote(join(home, ".config", "aws", "config"))} 2>&1 || true`,
        `cat /proc/self/root${home}/.aws/sso/cache/x.json 2>&1 || true`,
        `cat ${shellQuote(join(home, ".aws", "config"))}`,
        `ls -A ${shellQuote(runtimeBaseDir)}`,
        `if [ -e ${shellQuote(join(sibling, "canary.json"))} ]; then echo SIBLING-VISIBLE; else echo SIBLING-HIDDEN; fi`,
      ].join("\n");

      const result = runSandboxed(["sh", "-c", script]);
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain("CANARY");
      expect(result.stdout).toContain("SIBLING-HIDDEN");
      expect(result.stdout).not.toContain("SIBLING-VISIBLE");
      expect(result.stdout).toContain("No such file or directory");
      expect(result.stdout).toContain("[profile agent]");
      expect(result.stdout).toContain("credential_process =");
      expect(result.stdout).toContain("region = eu-north-1");
      // Only this scope's directory survives the runtime-base mask.
      expect(result.stdout).toContain(scopeIdFor("/repo"));
      expect(result.stdout).not.toContain("deadbeefcafe");
    },
  );

  it.skipIf(BWRAP === null)(
    "cannot reach the broker control socket or a sibling scope socket, but can reach its own",
    async () => {
      // The real topology: one live control socket plus two scope sockets. The
      // sandbox masks the base that holds all three and re-binds only this
      // worktree's scope dir.
      const controlSocketPath = join(runtimeBaseDir, "control.sock");
      const siblingScopeDir = scopeDirFor({ runtimeBaseDir, scopeId: "deadbeefcafe" });
      mkdirSync(siblingScopeDir, { recursive: true });
      const siblingSocketPath = socketPathFor(siblingScopeDir);
      const ownSocketPath = socketPathFor(scopeDir);

      // One broker instance's sockets share a bind lock (see server.ts).
      const bindLock = createSocketBindLock();
      const servers = await Promise.all(
        [controlSocketPath, siblingSocketPath, ownSocketPath].map((socketPath) =>
          startUnixSocketServer({ socketPath, onLine: async () => "{}", bindLock }),
        ),
      );
      for (const server of servers) expect(server.ok).toBe(true);
      try {
        const clientScript = join(root, "connect.cjs");
        writeFileSync(
          clientScript,
          [
            "const net = require('node:net');",
            "const socket = net.connect(process.argv[2]);",
            // process.exit: the parent (this test) is blocked in spawnSync, so a
            // half-closed socket waiting on an accept would keep node alive.
            "socket.on('connect', () => { console.log('CONNECT-OK'); socket.destroy(); process.exit(0); });",
            "socket.on('error', (error) => { console.log('CONNECT-FAIL', error.code); process.exit(0); });",
            "",
          ].join("\n"),
        );

        const connect = (socketPath: string): string => {
          const result = runSandboxed([process.execPath, clientScript, socketPath]);
          return result.stdout.trim();
        };

        expect(connect(ownSocketPath)).toBe("CONNECT-OK");
        expect(connect(controlSocketPath)).toBe("CONNECT-FAIL ENOENT");
        expect(connect(siblingSocketPath)).toBe("CONNECT-FAIL ENOENT");
      } finally {
        for (const server of servers) {
          if (server.ok) await server.value.close();
        }
      }
    },
  );

  it.skipIf(BWRAP === null)("unsets inherited AWS credential env vars inside the sandbox", () => {
    const argv = sandboxArgv(["sh", "-c", 'env | grep "^AWS_SECRET_ACCESS_KEY=" || echo unset']);
    const binary = argv[0];
    if (binary === undefined) throw new Error("empty sandbox argv");
    const result = spawnSync(binary, argv.slice(1), {
      encoding: "utf-8",
      env: { ...process.env, AWS_SECRET_ACCESS_KEY: "operator-secret" },
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("unset");
    expect(result.stdout).not.toContain("operator-secret");
  });

  it.skipIf(BWRAP === null)(
    "keeps the sandbox identity while dropping inherited AWS config paths",
    () => {
      const argv = sandboxArgv([
        "sh",
        "-c",
        'printf \'profile=%s region=%s active=%s\\n\' "$AWS_PROFILE" "$AWS_REGION" "$BELAYD_SANDBOX_ACTIVE"',
      ]);
      const binary = argv[0];
      if (binary === undefined) throw new Error("empty sandbox argv");
      const result = spawnSync(binary, argv.slice(1), {
        encoding: "utf-8",
        env: { ...process.env, AWS_PROFILE: "operator", AWS_CONFIG_FILE: "/home/x/.aws/config" },
      });
      expect(result.stdout).toBe("profile=agent region=eu-north-1 active=1\n");
    },
  );

  it.skipIf(BWRAP === null)("keeps a reachable host /tmp and a shared pid namespace", () => {
    // bd's dolt liveness check shells out to `ps`, and terminals/nix builds need
    // the host /tmp, so both must survive the mask.
    const marker = join(root, "tmp-marker");
    writeFileSync(marker, "ok\n");
    const script = [`cat ${shellQuote(marker)}`, "ps -axo pid 2>&1 | head -3"].join("\n");
    const result = runSandboxed(["sh", "-c", script]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ok");
    expect(result.stdout).toMatch(/PID\s+1\b/);
  });

  it.skipIf(BWRAP === null)("still sees an unrelated host path (the mask is surgical)", () => {
    const marker = join(root, "outside.txt");
    writeFileSync(marker, "reachable\n");
    const result = runSandboxed(["sh", "-c", `cat ${shellQuote(marker)}`]);
    expect(result.stdout).toContain("reachable");
  });

  it.skipIf(BWRAP === null)(
    "masks allowlisted files (EACCES) and directories (empty), through a symlinked path",
    () => {
      // The IAM RolesAnywhere hole this closes: the broker must read the cert
      // and key, so they live outside ~/.aws and were previously readable from
      // inside the sandbox (an agent could call aws_signing_helper directly and
      // bypass the allowlist entirely).
      const secrets = join(root, "secrets");
      mkdirSync(secrets, { recursive: true });
      const certPath = join(secrets, "agent-cert.pem");
      const keyPath = join(secrets, "agent-key.pem");
      const siblingPath = join(secrets, "unlisted.pem");
      writeFileSync(certPath, "CERT-CANARY\n");
      writeFileSync(keyPath, "KEY-CANARY\n");
      writeFileSync(siblingPath, "UNLISTED-VISIBLE\n");
      const cacheDir = join(root, "agent-cache");
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(join(cacheDir, "token"), "CACHE-CANARY\n");
      // `/run/secrets` on the real host is a symlink, so resolution matters:
      // bwrap refuses an unresolved path through a symlinked directory.
      const secretsLink = join(root, "secrets-link");
      symlinkSync(secrets, secretsLink);

      const resolved = resolveMaskEntries({
        entries: [join(secretsLink, "agent-cert.pem"), keyPath, cacheDir],
        context: {
          worktreeRoot: join(root, "repo"),
          homeDir: home,
          runtimeBaseDir,
          scopeDir,
          allowlistPath: join(root, "config", "belayd", "aws.yaml"),
        },
      });
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;
      expect(resolved.value.map((mask) => mask.kind)).toEqual(["null-bind", "null-bind", "tmpfs"]);
      const masks: SandboxMask[] = [
        { kind: "tmpfs", path: join(home, ".aws") },
        { kind: "tmpfs", path: join(home, ".config", "aws") },
        ...resolved.value.map(toSandboxMask),
      ];

      // Control: the material is readable outside the sandbox.
      expect(readFileSync(certPath, "utf-8")).toContain("CERT-CANARY");

      const script = [
        `cat ${shellQuote(certPath)} 2>&1 || true`,
        `cat ${shellQuote(keyPath)} 2>&1 || true`,
        `cat ${shellQuote(`${secretsLink}/agent-cert.pem`)} 2>&1 || true`,
        `cat /proc/self/root${certPath} 2>&1 || true`,
        `if [ -e ${shellQuote(join(cacheDir, "token"))} ]; then echo CACHE-VISIBLE; else echo CACHE-HIDDEN; fi`,
        `cat ${shellQuote(siblingPath)}`,
      ].join("\n");
      const result = runSandboxed(["sh", "-c", script], masks);

      expect(result.status).toBe(0);
      // File masks read EACCES (a `/dev/null` bind is a regular file that
      // cannot be opened), never the canary.
      expect(result.stdout.match(/Permission denied/g) ?? []).toHaveLength(4);
      expect(result.stdout).not.toContain("CERT-CANARY");
      expect(result.stdout).not.toContain("KEY-CANARY");
      // Directory mask: an empty tmpfs, so the token inside is gone.
      expect(result.stdout).toContain("CACHE-HIDDEN");
      expect(result.stdout).not.toContain("CACHE-VISIBLE");
      expect(result.stdout).not.toContain("CACHE-CANARY");
      // Unlisted sibling stays readable: the mask is per-entry, not per-dir.
      expect(result.stdout).toContain("UNLISTED-VISIBLE");
    },
  );

  it.skipIf(BWRAP === null || GIT === null || JQ === null)(
    "propagates a mask refusal: runs unwrapped, without AWS, and says why",
    () => {
      // Fail-closed through the real wrapper, not just the planner: a scope
      // whose `mask:` entry does not exist must NOT fall back to a sandbox
      // without that mask (the certificate would stay readable), and must not
      // fall back to an AWS profile either. The command still runs — the
      // operator's shell keeps working — with the reason on stderr.
      const repo = join(root, "aws-mask-refusal-repo");
      const configHome = join(root, "refusal-config");
      const refusalRuntime = join(root, "refusal-runtime");
      mkdirSync(join(repo, ".belayd"), { recursive: true });
      mkdirSync(join(configHome, "belayd"), { recursive: true });
      mkdirSync(refusalRuntime, { recursive: true });
      writeFileSync(join(repo, ".belayd", "aws.yaml"), "profile: agent-readonly\n");
      const missingMask = join(root, "missing-cert.pem");
      writeFileSync(
        join(configHome, "belayd", "aws.yaml"),
        [
          "region: eu-north-1",
          "scopes:",
          `  - worktree: ${repo}`,
          "    profiles: [agent-readonly]",
          `    mask: [${missingMask}]`,
        ].join("\n"),
      );

      const env = cleanEnv({
        HOME: home,
        XDG_CONFIG_HOME: configHome,
        XDG_RUNTIME_DIR: refusalRuntime,
        BELAYD_AWS_RUNTIME_BASE_DIR: refusalRuntime,
        BELAYD_BWRAP_BIN: requireBwrap(),
        BELAYD_AWS_BIN: join(root, "missing-belayd-aws"),
      });

      // A wrapper whose planner is the real CLI (node + main.ts), so the
      // refusal comes from the production code path.
      const planner = join(root, "belayd-aws-refusal-stub");
      writeFileSync(
        planner,
        `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(REPO_ROOT, "src", "aws-broker", "main.ts"))} "$@"\n`,
        { mode: 0o755 },
      );
      const wrapper = renderScript("belayd-shell", {
        realShell: which("bash") ?? "/bin/sh",
        jqPath: requireJq(),
        awsSandboxPath: planner,
      }).path;

      const initialized = spawnSync("git", ["init", "-q", repo], { env, encoding: "utf-8" });
      expect(initialized.status).toBe(0);

      const result = runScript(
        wrapper,
        ["-c", `printf "active=%s\\n" "\${BELAYD_SANDBOX_ACTIVE:-none}"`],
        { cwd: repo, env },
      );

      expect(result.status).toBe(0);
      // Unwrapped: no sandbox marker, so no scoped profile was handed out.
      expect(result.stdout.trim()).toBe("active=none");
      // …and loud: the wrapper relays the planner's refusal, naming the entry.
      expect(result.stderr).toContain("belayd-shell:");
      expect(result.stderr).toContain(missingMask);
      expect(result.stderr).toContain("does not exist or cannot be resolved");
    },
  );

  it.skipIf(BWRAP === null || DIRENV === null || GIT === null || JQ === null)(
    "still resolves the repo devShell (direnv) inside the sandbox",
    () => {
      // Regression for the routing order: the AWS block used to exec the real
      // shell directly, silently skipping the devShell for a repo that carries
      // both `.belayd/aws.yaml` and `.envrc`.
      const repo = join(root, "aws-direnv-repo");
      const configHome = join(root, "config");
      const dataHome = join(root, "data");
      const xdgRuntimeDir = join(root, "xdg-runtime");
      mkdirSync(join(repo, ".belayd"), { recursive: true });
      mkdirSync(join(configHome, "belayd"), { recursive: true });
      mkdirSync(dataHome, { recursive: true });
      mkdirSync(xdgRuntimeDir, { recursive: true });
      writeFileSync(join(repo, ".belayd", "aws.yaml"), "profile: agent-readonly\n");
      writeFileSync(
        join(configHome, "belayd", "aws.yaml"),
        `region: eu-north-1\nscopes:\n  - worktree: ${repo}\n    profiles: [agent-readonly]\n`,
      );
      writeFileSync(join(repo, ".envrc"), "export BELAYD_TEST_DEVSHELL_ENV=ok\n");

      const env = cleanEnv({
        HOME: home,
        XDG_CONFIG_HOME: configHome,
        XDG_DATA_HOME: dataHome,
        XDG_RUNTIME_DIR: xdgRuntimeDir,
        BELAYD_BWRAP_BIN: requireBwrap(),
        // Deliberately missing: the planner then warns about the broker and
        // still prints the plan (the mask is the security property).
        BELAYD_AWS_BIN: join(root, "missing-belayd-aws"),
      });

      // A wrapper whose planner is the real CLI (node + main.ts).
      const planner = join(root, "belayd-aws-stub");
      writeFileSync(
        planner,
        `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(REPO_ROOT, "src", "aws-broker", "main.ts"))} "$@"\n`,
        { mode: 0o755 },
      );
      const wrapper = renderScript("belayd-shell", {
        realShell: which("bash") ?? "/bin/sh",
        jqPath: requireJq(),
        awsSandboxPath: planner,
      }).path;

      // The plan resolver needs a real git toplevel for the fixture repo.
      const initialized = spawnSync("git", ["init", "-q", repo], { env, encoding: "utf-8" });
      expect(initialized.status).toBe(0);
      const allowed = spawnSync("direnv", ["allow", repo], { cwd: repo, env, encoding: "utf-8" });
      expect(allowed.status).toBe(0);

      const result = runScript(
        wrapper,
        ["-c", 'printf "%s %s\\n" "$BELAYD_TEST_DEVSHELL_ENV" "$BELAYD_SANDBOX_ACTIVE"'],
        { cwd: repo, env },
      );

      expect(result.status).toBe(0);
      // The direnv-exported devShell env survived into the sandbox, and the
      // sandbox marker is set, so routing ran *before* the wrap. The broker
      // warning on stderr proves the planner actually resolved a plan (the
      // broker CLI is deliberately missing in this fixture).
      expect(result.stdout.trim()).toBe("ok 1");
      expect(result.stderr).toContain("could not ensure the AWS scope socket");
    },
  );
});
