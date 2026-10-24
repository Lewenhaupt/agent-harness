import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultClientEntryPath,
  planCommandArgv,
  renderShim,
  renderSyntheticAwsConfig,
  resolveSandboxPlan,
} from "../aws-broker/plan.js";
import {
  BROKER_RUNTIME_BASE_ENV_KEY,
  SANDBOX_ACTIVE_ENV_KEY,
  syntheticAwsConfigPathFor,
} from "../aws-broker/scope.js";

/** Write an executable stub and return its path. */
function writeStub(path: string, body: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body, { mode: 0o755 });
  return path;
}

describe("aws-broker plan: generated files", () => {
  it("quotes the shim and socket paths for botocore's shlex.split", () => {
    const config = renderSyntheticAwsConfig({
      shimPath: "/run/belayd/aws/scope dir/credential-process",
      socketPath: "/run/belayd/aws/scope dir/sock",
      region: "eu-north-1",
    });
    expect(config).toContain(
      "credential_process = '/run/belayd/aws/scope dir/credential-process' --socket '/run/belayd/aws/scope dir/sock'",
    );
    expect(config).toContain("region = eu-north-1");
    expect(config).toContain("[profile agent]");
  });

  it("quotes a prebuilt client wrapper and falls back to node + source", () => {
    const withBinary = renderShim({
      shimPath: "/scope/credential-process",
      nodeBinary: "/nix/store/node/bin/node",
      clientEntryPath: "/src/client.ts",
      clientBinary: "/nix/store/h/bin/belayd-aws-credential-process",
    });
    expect(withBinary).toContain(`exec '/nix/store/h/bin/belayd-aws-credential-process' "$@"`);

    const withoutBinary = renderShim({
      shimPath: "/scope/credential-process",
      nodeBinary: "/nix/store/node/bin/node",
      clientEntryPath: "/src/client.ts",
    });
    expect(withoutBinary).toContain(`exec '/nix/store/node/bin/node' '/src/client.ts' "$@"`);
  });

  it("finds the in-repo client entry point", () => {
    expect(defaultClientEntryPath()).toMatch(/client\.(ts|js)$/);
  });
});

describe("aws-broker plan: resolution", () => {
  let root: string;
  let home: string;
  let configHome: string;
  let runtimeBaseDir: string;
  let repo: string;
  let bin: string;
  let gitStub: string;
  let bwrapStub: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "belayd-aws-plan-"));
    home = join(root, "home");
    configHome = join(root, "config");
    runtimeBaseDir = join(root, "runtime", "belayd", "aws");
    repo = join(root, "repo");
    bin = join(root, "bin");
    mkdirSync(join(home, ".aws"), { recursive: true });
    mkdirSync(join(configHome, "belayd"), { recursive: true });
    mkdirSync(join(repo, ".belayd"), { recursive: true });
    gitStub = writeStub(join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' '${repo}'\n`);
    bwrapStub = writeStub(join(bin, "bwrap"), "#!/bin/sh\nexit 0\n");
    writeFileSync(join(repo, ".belayd", "aws.yaml"), "profile: agent-readonly\n");
    writeFileSync(
      join(configHome, "belayd", "aws.yaml"),
      `region: eu-north-1\nscopes:\n  - worktree: ${repo}\n    profiles: [agent-readonly]\n`,
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
      HOME: home,
      XDG_CONFIG_HOME: configHome,
      [BROKER_RUNTIME_BASE_ENV_KEY]: runtimeBaseDir,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      ...extra,
    };
  }

  it("resolves a configured worktree into a sandboxed plan", () => {
    const outcome = resolveSandboxPlan({
      worktree: repo,
      env: env(),
      gitBinary: gitStub,
      bwrapPath: bwrapStub,
      nodeBinary: process.execPath,
      clientEntryPath: defaultClientEntryPath(),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.profile).toBe("agent-readonly");
    expect(outcome.plan.region).toBe("eu-north-1");
    expect(outcome.plan.argvPrefix).toContain("--unshare-user");
    expect(outcome.plan.argvPrefix).toContain(runtimeBaseDir);
    // The generated synthetic config is quoted so a space in the runtime base
    // (this fixture has none, but a HOME can) cannot break botocore.
    const config = readFileSync(syntheticAwsConfigPathFor(outcome.plan.scopeDir), "utf-8");
    expect(config).toContain(`'${outcome.plan.socketPath}'`);
    expect(planCommandArgv(outcome.plan, ["pi", "--mode", "json"]).slice(-4)).toEqual([
      "--",
      "pi",
      "--mode",
      "json",
    ]);
  });

  it("reports not-configured when there is no allowlist or no repo file", () => {
    const noAllowlist = resolveSandboxPlan({
      worktree: repo,
      env: env({ XDG_CONFIG_HOME: join(root, "empty") }),
      gitBinary: gitStub,
      bwrapPath: bwrapStub,
    });
    expect(noAllowlist).toHaveProperty("ok", false);
    if (noAllowlist.ok) return;
    expect(noAllowlist.kind).toBe("not-configured");

    rmSync(join(repo, ".belayd", "aws.yaml"));
    const noRepoFile = resolveSandboxPlan({
      worktree: repo,
      env: env(),
      gitBinary: gitStub,
      bwrapPath: bwrapStub,
    });
    expect(noRepoFile).toHaveProperty("ok", false);
    if (noRepoFile.ok) return;
    expect(noRepoFile.kind).toBe("not-configured");
    expect(noRepoFile.reason).toContain(".belayd/aws.yaml");
  });

  it("refuses an ungranted profile, naming the allowed list", () => {
    writeFileSync(join(repo, ".belayd", "aws.yaml"), "profile: agent-deploy\n");
    const outcome = resolveSandboxPlan({
      worktree: repo,
      env: env(),
      gitBinary: gitStub,
      bwrapPath: bwrapStub,
    });
    expect(outcome).toHaveProperty("ok", false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("refused");
    expect(outcome.reason).toContain('profile "agent-deploy" is not permitted');
    expect(outcome.reason).toContain("agent-readonly");
  });

  it("refuses a missing region and points at the allowlist, not the repo file", () => {
    writeFileSync(
      join(configHome, "belayd", "aws.yaml"),
      `scopes:\n  - worktree: ${repo}\n    profiles: [agent-readonly]\n`,
    );
    const outcome = resolveSandboxPlan({
      worktree: repo,
      env: env({ AWS_REGION: "", AWS_DEFAULT_REGION: "" }),
      gitBinary: gitStub,
      bwrapPath: bwrapStub,
    });
    expect(outcome).toHaveProperty("ok", false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("refused");
    expect(outcome.reason).toContain("allowlist scope");
    expect(outcome.reason).not.toContain("repo file's scope");
  });

  it("resolves allowlist masks into tmpfs and /dev/null binds, in argv order", () => {
    // The IAM RolesAnywhere shape: the broker reads the cert/key, the sandbox
    // must not. A symlinked directory exercises the realpath rule (bwrap cannot
    // create a mount point through an unresolved symlink).
    const secrets = join(root, "secrets");
    mkdirSync(join(secrets, "nested"), { recursive: true });
    const certPath = join(secrets, "nested", "cert.pem");
    writeFileSync(certPath, "CERT\n");
    const link = join(root, "secrets-link");
    symlinkSync(secrets, link);
    const maskDir = join(root, "agent-cache");
    mkdirSync(maskDir);
    const sharedDir = join(root, "shared");
    mkdirSync(sharedDir);
    const resolvedCertPath = realpathSync(certPath);
    const resolvedMaskDir = realpathSync(maskDir);
    const resolvedSharedDir = realpathSync(sharedDir);

    writeFileSync(
      join(configHome, "belayd", "aws.yaml"),
      [
        "region: eu-north-1",
        `mask: [${sharedDir}]`,
        "scopes:",
        `  - worktree: ${repo}`,
        "    profiles: [agent-readonly]",
        "    mask:",
        `      - ${join(link, "nested", "cert.pem")}`,
        `      - ${maskDir}`,
        `      - ${sharedDir}`,
      ].join("\n"),
    );

    const outcome = resolveSandboxPlan({
      worktree: repo,
      env: env(),
      gitBinary: gitStub,
      bwrapPath: bwrapStub,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.masks).toEqual([
      { kind: "tmpfs", path: join(home, ".aws") },
      { kind: "tmpfs", path: join(home, ".config", "aws") },
      // Top-level first, then per-scope, de-duplicated, resolved.
      { kind: "tmpfs", path: resolvedSharedDir },
      { kind: "null-bind", path: resolvedCertPath },
      { kind: "tmpfs", path: resolvedMaskDir },
    ]);

    const argv = outcome.plan.argvPrefix;
    const baseBind = argv.indexOf("--bind");
    const certIndex = argv.indexOf(resolvedCertPath);
    expect(certIndex).toBeGreaterThan(baseBind);
    expect(argv[certIndex - 1]).toBe("/dev/null");
    expect(argv[certIndex - 2]).toBe("--ro-bind");
    const runtimeMask = argv.indexOf(runtimeBaseDir);
    expect(runtimeMask).toBeGreaterThan(certIndex);
    expect(argv[runtimeMask - 1]).toBe("--tmpfs");
    // The unresolved entry must never reach argv: bwrap rejects it.
    expect(argv).not.toContain(join(link, "nested", "cert.pem"));
  });

  it("mounts a path once when a symlink and its target are both listed", () => {
    // The raw-text dedupe in `mergeMaskEntries` cannot see that `/link` and
    // `/target` are the same mount, so the resolved-path dedupe has to.
    const certStore = join(root, "cert-store");
    mkdirSync(certStore);
    const link = join(root, "cert-store-link");
    symlinkSync(certStore, link);
    const resolvedCertStore = realpathSync(certStore);
    writeFileSync(
      join(configHome, "belayd", "aws.yaml"),
      [
        "region: eu-north-1",
        "scopes:",
        `  - worktree: ${repo}`,
        "    profiles: [agent-readonly]",
        "    mask:",
        `      - ${link}`,
        `      - ${certStore}`,
        `      - ${certStore}/`,
      ].join("\n"),
    );

    const outcome = resolveSandboxPlan({
      worktree: repo,
      env: env(),
      gitBinary: gitStub,
      bwrapPath: bwrapStub,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.masks).toEqual([
      { kind: "tmpfs", path: join(home, ".aws") },
      { kind: "tmpfs", path: join(home, ".config", "aws") },
      { kind: "tmpfs", path: resolvedCertStore },
    ]);
  });

  it("refuses a mask entry that does not exist, naming it and the allowlist", () => {
    const missing = join(root, "no-such-dir", "cert.pem");
    writeFileSync(
      join(configHome, "belayd", "aws.yaml"),
      `region: eu-north-1\nscopes:\n  - worktree: ${repo}\n    profiles: [agent-readonly]\n    mask: [${missing}]\n`,
    );
    const outcome = resolveSandboxPlan({
      worktree: repo,
      env: env(),
      gitBinary: gitStub,
      bwrapPath: bwrapStub,
    });
    expect(outcome).toHaveProperty("ok", false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("refused");
    expect(outcome.reason).toContain(missing);
    expect(outcome.reason).toContain(join(configHome, "belayd", "aws.yaml"));
  });

  it("refuses a mask entry inside the worktree", () => {
    const inside = join(repo, "cert.pem");
    writeFileSync(inside, "CERT\n");
    writeFileSync(
      join(configHome, "belayd", "aws.yaml"),
      `region: eu-north-1\nscopes:\n  - worktree: ${repo}\n    profiles: [agent-readonly]\n    mask: [${inside}]\n`,
    );
    const outcome = resolveSandboxPlan({
      worktree: repo,
      env: env(),
      gitBinary: gitStub,
      bwrapPath: bwrapStub,
    });
    expect(outcome).toHaveProperty("ok", false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("refused");
    expect(outcome.reason).toContain("inside the worktree");
  });

  it("refuses a dangling symlink inside the worktree as missing, not as a worktree path", () => {
    // `realpath()` fails for a dangling link, so only the literal path is left;
    // the refusal must still say the entry does not resolve rather than blame
    // the worktree containment rule.
    const dangling = join(repo, "dangling-cert.pem");
    symlinkSync(join(repo, "no-such-target.pem"), dangling);
    writeFileSync(
      join(configHome, "belayd", "aws.yaml"),
      `region: eu-north-1\nscopes:\n  - worktree: ${repo}\n    profiles: [agent-readonly]\n    mask: [${dangling}]\n`,
    );
    const outcome = resolveSandboxPlan({
      worktree: repo,
      env: env(),
      gitBinary: gitStub,
      bwrapPath: bwrapStub,
    });
    expect(outcome).toHaveProperty("ok", false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("refused");
    expect(outcome.reason).toContain("does not exist or cannot be resolved");
    expect(outcome.reason).toContain(dangling);
    expect(outcome.reason).not.toContain("inside the worktree");
  });

  it("reports unavailable when bubblewrap or the runtime base is missing", () => {
    const noBwrap = resolveSandboxPlan({
      worktree: repo,
      env: env(),
      gitBinary: gitStub,
      bwrapPath: join(root, "does-not-exist", "bwrap"),
    });
    expect(noBwrap).toHaveProperty("ok", false);
    if (noBwrap.ok) return;
    expect(noBwrap.kind).toBe("unavailable");

    // A runtime base that cannot be created (its parent is a file) is a value,
    // never a throw: the caller must still be able to run the command loudly.
    const filePath = join(root, "not-a-dir");
    writeFileSync(filePath, "");
    const noBase = resolveSandboxPlan({
      worktree: repo,
      env: env({ [BROKER_RUNTIME_BASE_ENV_KEY]: join(filePath, "belayd", "aws") }),
      gitBinary: gitStub,
      bwrapPath: bwrapStub,
    });
    expect(noBase).toHaveProperty("ok", false);
    if (noBase.ok) return;
    expect(noBase.kind).toBe("unavailable");
    expect(noBase.reason).toContain("could not prepare the AWS sandbox");
  });

  it("skips with a distinct kind when already inside a scoped sandbox", () => {
    const outcome = resolveSandboxPlan({
      worktree: repo,
      env: env({ [SANDBOX_ACTIVE_ENV_KEY]: "1" }),
      gitBinary: gitStub,
      bwrapPath: bwrapStub,
    });
    expect(outcome).toHaveProperty("ok", false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("already-sandboxed");
  });
});
