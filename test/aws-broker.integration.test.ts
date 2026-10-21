import { execFile, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startDaemon } from "../src/aws-broker/daemon.js";
import { defaultClientEntryPath, resolveSandboxPlan } from "../src/aws-broker/plan.js";

const execFileAsync = promisify(execFile);
const BWRAP = which("bwrap");
const REPO_ROOT = resolve(import.meta.dirname, "..");
const MAIN_TS = join(REPO_ROOT, "src", "aws-broker", "main.ts");

/** bwrap path, or a clear failure: `it.skipIf` already guards every caller. */
function requireBwrap(): string {
  if (BWRAP === null) throw new Error("bubblewrap is required for this test");
  return BWRAP;
}

function which(binary: string): string | null {
  const result = spawnSync("sh", ["-c", `command -v ${binary}`], { encoding: "utf-8" });
  const stdout = result.stdout?.trim() ?? "";
  return stdout === "" ? null : stdout;
}

/**
 * End-to-end broker coverage (bd-125) with real binaries: the daemon runs
 * in-process, the CLI runs as a real `node main.ts` child (exercising Node 24's
 * type stripping and the entry-point guard), and the shim is executed inside a
 * real bubblewrap sandbox. The AWS CLI is a stub that emits a fixture
 * `credential_process` document, so no live SSO session is needed.
 *
 * Self-skips (with a warning) when bubblewrap is not on PATH: a skip is not a
 * pass, it means the socket/masking path was not exercised on this machine.
 */
describe("aws broker end to end (integration, real bwrap)", () => {
  let root: string;
  let home: string;
  let configHome: string;
  let runtimeDir: string;
  let runtimeBaseDir: string;
  let repo: string;
  let bin: string;
  let auditPath: string;
  let stubAws: string;
  let stubGit: string;
  let env: NodeJS.ProcessEnv;
  let closeDaemon: (() => Promise<void>) | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "belayd-aws-broker-"));
    home = join(root, "home");
    configHome = join(root, "config");
    runtimeDir = join(root, "runtime");
    // Deliberately not under XDG_RUNTIME_DIR: the daemon gets its base from
    // BELAYD_AWS_RUNTIME_BASE_DIR (the systemd RuntimeDirectory shape).
    runtimeBaseDir = join(root, "runtime-base");
    repo = join(root, "repo");
    bin = join(root, "bin");
    auditPath = join(root, "state", "aws-audit.jsonl");
    mkdirSync(join(home, ".aws"), { recursive: true });
    mkdirSync(join(home, ".config", "aws"), { recursive: true });
    mkdirSync(join(configHome, "belayd"), { recursive: true });
    mkdirSync(join(repo, ".belayd"), { recursive: true });
    mkdirSync(runtimeDir, { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(repo, ".belayd", "aws.yaml"), "profile: agent-readonly\n");
    writeFileSync(
      join(configHome, "belayd", "aws.yaml"),
      `region: eu-north-1\nscopes:\n  - worktree: ${repo}\n    profiles: [agent-readonly]\n`,
    );
    stubAws = join(bin, "aws");
    writeFileSync(
      stubAws,
      [
        "#!/bin/sh",
        "cat <<'JSON'",
        '{"Version": 1, "AccessKeyId": "AKIAFIXTURE", "SecretAccessKey": "fixture-secret", "SessionToken": "fixture-token", "Expiration": "2099-01-01T00:00:00+00:00"}',
        "JSON",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    // The CLI the plan resolver calls to start the scope socket on demand,
    // mirroring the Nix wrapper (node + the TS entry point).
    const brokerCli = join(bin, "belayd-aws");
    writeFileSync(brokerCli, `#!/bin/sh\nexec "${process.execPath}" "${MAIN_TS}" "$@"\n`, {
      mode: 0o755,
    });
    stubGit = join(bin, "git");
    writeFileSync(stubGit, `#!/bin/sh\nprintf '%s\\n' '${repo}'\n`, { mode: 0o755 });

    env = {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: configHome,
      XDG_RUNTIME_DIR: runtimeDir,
      BELAYD_AWS_RUNTIME_BASE_DIR: runtimeBaseDir,
      BELAYD_AWS_BIN: brokerCli,
    };
    env.PATH = `${bin}:${process.env.PATH ?? ""}`;
    // The generated shim must fall back to node + the in-repo client, not to a
    // Nix wrapper that does not exist in this test environment.
    delete env.BELAYD_AWS_CREDENTIAL_PROCESS_BIN;
    delete env.BELAYD_BWRAP_BIN;
    delete env.BELAYD_SANDBOX_ACTIVE;
  });

  afterEach(async () => {
    if (closeDaemon !== undefined) await closeDaemon();
    closeDaemon = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * Run the CLI asynchronously. It must NOT be spawnSync: the daemon runs
   * in-process in this test, so blocking the event loop would deadlock the
   * child against the very daemon it is talking to.
   */
  async function runCli(
    args: string[],
  ): Promise<{ status: number; stdout: string; stderr: string }> {
    return runProcess(process.execPath, [MAIN_TS, ...args], env);
  }

  async function startBroker(): Promise<void> {
    const daemon = await startDaemon({
      env,
      awsBinary: stubAws,
      auditPath,
      runtimeBaseDir,
      planOverrides: {
        bwrapPath: requireBwrap(),
        gitBinary: stubGit,
        homeDir: home,
        runtimeBaseDir,
      },
    });
    expect(daemon.ok).toBe(true);
    if (!daemon.ok) return;
    closeDaemon = daemon.value.close;
  }

  it.skipIf(BWRAP === null)(
    "serves a credential document through the scope socket inside the sandbox",
    async () => {
      await startBroker();

      // The shell wrapper makes exactly one CLI call, so 'plan' must also start
      // the scope socket on demand (the control socket is masked inside the
      // sandbox, so the daemon can only be asked from outside).
      const plan = await runCli(["plan", "--worktree", repo, "--print0"]);
      expect(plan.stderr).toBe("");
      expect(plan.status).toBe(0);
      const argvPrefix = plan.stdout.split("\0").filter((token) => token !== "");
      expect(argvPrefix[0]).toBe(requireBwrap());
      expect(argvPrefix).toContain("--unshare-user");

      const ensure = await runCli(["ensure-scope", "--worktree", repo]);
      expect(ensure.status).toBe(0);
      const socketPath = ensure.stdout.trim();
      expect(socketPath).not.toBe("");
      expect(existsSync(socketPath)).toBe(true);
      const scopeDir = dirname(socketPath);
      expect(statSync(socketPath).mode & 0o777).toBe(0o600);
      expect(statSync(scopeDir).mode & 0o777).toBe(0o700);
      // The plan and the scope agree on the same directory.
      expect(argvPrefix).toContain(scopeDir);

      const shim = join(scopeDir, "credential-process");
      expect(existsSync(shim)).toBe(true);
      expect(existsSync(join(scopeDir, "aws", "config"))).toBe(true);

      // Run the generated shim *inside* the sandbox: the scope socket must be
      // reachable there, and the document must be a complete credential_process
      // payload.
      const binary = argvPrefix[0];
      if (binary === undefined) throw new Error("empty plan argv");
      const result = await runProcess(
        binary,
        [...argvPrefix.slice(1), "--", shim, "--socket", socketPath],
        env,
      );
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const lines = result.stdout.trim().split("\n");
      expect(lines).toHaveLength(1);
      const first = lines[0];
      if (first === undefined) throw new Error(`no document on stdout: ${result.stdout}`);
      const document = JSON.parse(first) as Record<string, unknown>;
      expect(document.Version).toBe(1);
      expect(document.AccessKeyId).toBe("AKIAFIXTURE");
      expect(document.Expiration).toBe("2099-01-01T00:00:00.000Z");

      // The plan resolved by the CLI and by the daemon must agree.
      const direct = resolveSandboxPlan({
        worktree: repo,
        env,
        bwrapPath: requireBwrap(),
        gitBinary: stubGit,
        homeDir: home,
        runtimeBaseDir,
      });
      expect(direct.ok).toBe(true);
      if (!direct.ok) return;
      expect(direct.plan.socketPath).toBe(socketPath);
    },
  );

  it.skipIf(BWRAP === null)("refuses a profile the allowlist does not grant", async () => {
    await startBroker();
    writeFileSync(join(repo, ".belayd", "aws.yaml"), "profile: agent-deploy\n");

    const ensure = await runCli(["ensure-scope", "--worktree", repo]);
    expect(ensure.status).toBe(1);
    expect(ensure.stderr).toContain('profile "agent-deploy" is not permitted');
    expect(ensure.stderr).toContain("agent-readonly");
    expect(ensure.stdout).toBe("");
  });

  it.skipIf(BWRAP === null)(
    "refuses an unexpected action on a scope socket without returning credentials",
    async () => {
      await startBroker();
      const ensure = await runCli(["ensure-scope", "--worktree", repo]);
      expect(ensure.status).toBe(0);
      const socketPath = ensure.stdout.trim();

      const response = await sendLine(socketPath, '{"action":"sts-assume-role"}');
      const parsed = JSON.parse(response) as { ok: boolean; error: string; credentials?: unknown };
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("unsupported action");
      expect(parsed.credentials).toBeUndefined();

      const whoami = JSON.parse(await sendLine(socketPath, '{"action":"whoami"}')) as {
        ok: boolean;
        profile: string;
      };
      expect(whoami.ok).toBe(true);
      expect(whoami.profile).toBe("agent-readonly");
    },
  );

  it.skipIf(BWRAP === null)(
    "writes one audit line per request and never credential material",
    async () => {
      await startBroker();
      const ensure = await runCli(["ensure-scope", "--worktree", repo]);
      const socketPath = ensure.stdout.trim();
      await sendLine(socketPath, '{"action":"credential_process"}');
      await sendLine(socketPath, '{"action":"whoami"}');

      const contents = readFileSync(auditPath, "utf-8");
      const lines = contents.trimEnd().split("\n");
      expect(lines.length).toBeGreaterThanOrEqual(3); // ensure-scope + 2 requests
      for (const line of lines) {
        const entry = JSON.parse(line) as Record<string, unknown>;
        expect(Object.keys(entry).sort()).toEqual(
          ["action", "outcome", "profile", "scope", "ts", "worktree"].sort(),
        );
      }
      expect(contents).not.toContain("fixture-secret");
      expect(contents).not.toContain("SecretAccessKey");
      expect(contents).not.toContain("AKIAFIXTURE");
      expect(statSync(auditPath).mode & 0o777).toBe(0o600);
    },
  );

  it.skipIf(BWRAP === null)(
    "serializes two concurrent ensure-scope requests for one scope",
    async () => {
      await startBroker();
      const originalUmask = process.umask();
      // Both requests must resolve to the same live socket (one listener), and
      // the process-global umask must be restored by the bind lock.
      const [first, second] = await Promise.all([
        runCli(["ensure-scope", "--worktree", repo]),
        runCli(["ensure-scope", "--worktree", repo]),
      ]);
      expect(first.status).toBe(0);
      expect(second.status).toBe(0);
      expect(first.stdout.trim()).toBe(second.stdout.trim());
      expect(existsSync(first.stdout.trim())).toBe(true);
      expect(process.umask()).toBe(originalUmask);
    },
  );

  it.skipIf(BWRAP === null)(
    "audits a refused ensure-scope with the requested worktree",
    async () => {
      await startBroker();
      writeFileSync(join(repo, ".belayd", "aws.yaml"), "profile: agent-deploy\n");

      const ensure = await runCli(["ensure-scope", "--worktree", repo]);
      expect(ensure.status).toBe(1);

      const lines = readFileSync(auditPath, "utf-8").trimEnd().split("\n");
      const refused = lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((entry) => entry.action === "ensure-scope");
      expect(refused).toBeDefined();
      expect(refused?.outcome).toBe("error:refused");
      expect(refused?.worktree).toBe(repo);
      expect(refused?.profile).toBe("");
      // Never credential material, even on the refusal path.
      expect(readFileSync(auditPath, "utf-8")).not.toContain("fixture-secret");
    },
  );

  it("has a client entry point that Node can execute directly", async () => {
    const clientEntry = defaultClientEntryPath();
    expect(existsSync(clientEntry)).toBe(true);
    const result = await runProcess(process.execPath, [clientEntry], env);
    // No --socket: the shim must fail loud with usage, never partial JSON.
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("usage");
  });
});

/** Run a child process asynchronously, normalizing the exit code. */
async function runProcess(
  binary: string,
  args: string[],
  childEnv: NodeJS.ProcessEnv,
): Promise<{ status: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(binary, args, { encoding: "utf-8", env: childEnv });
    return { status: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number | string; stdout?: string; stderr?: string };
    return {
      status: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

/** Send one NDJSON request and resolve with the first response line. */
function sendLine(socketPath: string, line: string): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    let buffer = "";
    const socket = connect(socketPath, () => {
      socket.write(`${line}\n`);
    });
    socket.on("data", (data: Buffer) => {
      buffer += data.toString("utf-8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      socket.end();
      resolvePromise(buffer.slice(0, newline));
    });
    socket.on("error", reject);
  });
}
