import { describe, expect, it } from "vitest";
import {
  AWS_ENV_KEY_PREFIXES,
  AWS_ENV_KEYS,
  AWS_SANDBOX_UNSET_ENV_KEYS,
  awsRuntimeBaseDirFor,
  BROKER_RUNTIME_BASE_ENV_KEY,
  buildSandboxArgv,
  controlSocketPathFor,
  isSandboxActive,
  resolveBrokerRuntimeBaseDir,
  resolveRuntimeDir,
  SANDBOX_ACTIVE_ENV_KEY,
  SANDBOX_PROFILE_NAME,
  scopeDirFor,
  scopeIdFor,
  scrubAwsEnv,
  shimPathFor,
  socketPathFor,
  syntheticAwsConfigPathFor,
  withSandboxCommand,
} from "../aws-broker/scope.js";

const RUNTIME_BASE = "/run/belayd/aws";
const SCOPE_DIR = `${RUNTIME_BASE}/abcdef123456`;

function buildArgv(overrides: Partial<Parameters<typeof buildSandboxArgv>[0]> = {}): string[] {
  return buildSandboxArgv({
    bwrapPath: "/nix/store/bwrap/bin/bwrap",
    homeDir: "/home/hugo",
    runtimeBaseDir: RUNTIME_BASE,
    scopeDir: SCOPE_DIR,
    masks: [
      { kind: "tmpfs", path: "/home/hugo/.aws" },
      { kind: "tmpfs", path: "/home/hugo/.config/aws" },
    ],
    region: "eu-north-1",
    ...overrides,
  });
}

/** Index of the first occurrence of an exact token sequence. */
function indexOfSequence(argv: readonly string[], needle: readonly string[]): number {
  for (let index = 0; index <= argv.length - needle.length; index++) {
    const slice = argv.slice(index, index + needle.length);
    if (
      slice.length === needle.length &&
      slice.every((token, offset) => token === needle[offset])
    ) {
      return index;
    }
  }
  return -1;
}

describe("aws-broker scope: ids and paths", () => {
  it("derives a stable, path-distinct scope id", () => {
    const first = scopeIdFor("/home/hugo/git/acme");
    expect(first).toBe(scopeIdFor("/home/hugo/git/acme"));
    expect(first).toHaveLength(12);
    expect(first).toMatch(/^[0-9a-f]{12}$/);
    expect(scopeIdFor("/home/hugo/git/other")).not.toBe(first);
  });

  it("normalizes the scope id input path", () => {
    expect(scopeIdFor("/home/hugo/git/acme/")).toBe(scopeIdFor("/home/hugo/git/acme"));
  });

  it("places the socket inside the scope dir, under the runtime base", () => {
    expect(awsRuntimeBaseDirFor("/run/user/1000")).toBe("/run/user/1000/belayd/aws");
    const scopeDir = scopeDirFor({ runtimeBaseDir: "/run/user/1000/belayd/aws", scopeId: "abc" });
    expect(scopeDir).toBe("/run/user/1000/belayd/aws/abc");
    expect(socketPathFor(scopeDir)).toBe(`${scopeDir}/sock`);
    expect(shimPathFor(scopeDir)).toBe(`${scopeDir}/credential-process`);
    expect(syntheticAwsConfigPathFor(scopeDir)).toBe(`${scopeDir}/aws/config`);
    expect(controlSocketPathFor("/run/user/1000/belayd/aws")).toBe(
      "/run/user/1000/belayd/aws/control.sock",
    );
  });

  it("prefers XDG_RUNTIME_DIR and falls back to a per-uid temp dir", () => {
    expect(
      resolveRuntimeDir({ env: { XDG_RUNTIME_DIR: "/run/user/7" }, uid: 7, temporaryDir: "/tmp" }),
    ).toBe("/run/user/7");
    expect(resolveRuntimeDir({ env: {}, uid: 7, temporaryDir: "/tmp" })).toBe(
      "/tmp/belayd-aws-runtime-7",
    );
    expect(resolveRuntimeDir({ env: { XDG_RUNTIME_DIR: "" }, uid: 7, temporaryDir: "/tmp" })).toBe(
      "/tmp/belayd-aws-runtime-7",
    );
  });

  it("resolves the runtime base from the explicit override, then XDG_RUNTIME_DIR", () => {
    // The systemd unit's RuntimeDirectory path wins: it exists without logind.
    expect(
      resolveBrokerRuntimeBaseDir({
        env: { [BROKER_RUNTIME_BASE_ENV_KEY]: "/run/belayd/aws" },
        uid: 1000,
        temporaryDir: "/tmp",
      }),
    ).toBe("/run/belayd/aws");
    expect(
      resolveBrokerRuntimeBaseDir({
        env: { XDG_RUNTIME_DIR: "/run/user/7" },
        uid: 7,
        temporaryDir: "/tmp",
      }),
    ).toBe("/run/user/7/belayd/aws");
    expect(
      resolveBrokerRuntimeBaseDir({
        env: { [BROKER_RUNTIME_BASE_ENV_KEY]: "" },
        uid: 7,
        temporaryDir: "/tmp",
      }),
    ).toBe("/tmp/belayd-aws-runtime-7/belayd/aws");
  });
});

describe("aws-broker scope: sandbox argv", () => {
  it("binds the base root before any mask (a later --ro-bind / / would unmask)", () => {
    const argv = buildArgv();
    const baseBind = indexOfSequence(argv, ["--ro-bind", "/", "/"]);
    const firstMask = indexOfSequence(argv, ["--tmpfs", "/home/hugo/.aws"]);
    const secondMask = indexOfSequence(argv, ["--tmpfs", "/home/hugo/.config/aws"]);
    const runtimeMask = indexOfSequence(argv, ["--tmpfs", RUNTIME_BASE]);
    const scopeBind = indexOfSequence(argv, ["--ro-bind", SCOPE_DIR, SCOPE_DIR]);
    const configBind = indexOfSequence(argv, [
      "--ro-bind",
      `${SCOPE_DIR}/aws/config`,
      "/home/hugo/.aws/config",
    ]);

    expect(baseBind).toBeGreaterThanOrEqual(0);
    expect(firstMask).toBeGreaterThan(baseBind);
    expect(secondMask).toBeGreaterThan(firstMask);
    expect(runtimeMask).toBeGreaterThan(secondMask);
    expect(scopeBind).toBeGreaterThan(runtimeMask);
    expect(configBind).toBeGreaterThan(scopeBind);
    // Only one base bind exists, so no later one can unmask the tmpfs mounts.
    expect(
      argv.filter((token, index) => token === "/" && argv[index - 1] === "--ro-bind"),
    ).toHaveLength(1);
  });

  it("masks the broker runtime base, so the control socket and sibling scopes are gone", () => {
    const argv = buildArgv();
    const runtimeMask = indexOfSequence(argv, ["--tmpfs", RUNTIME_BASE]);
    const scopeBind = indexOfSequence(argv, ["--ro-bind", SCOPE_DIR, SCOPE_DIR]);
    // The control socket lives in the masked base, and only this scope dir is
    // re-exposed; the mask is what makes socket mode 0600 irrelevant.
    expect(controlSocketPathFor(RUNTIME_BASE)).toBe(`${RUNTIME_BASE}/control.sock`);
    expect(runtimeMask).toBeGreaterThanOrEqual(0);
    expect(scopeBind).toBeGreaterThan(runtimeMask);
    expect(argv.filter((token) => token === SCOPE_DIR)).toHaveLength(2);
    expect(argv).not.toContain(controlSocketPathFor(RUNTIME_BASE));
    expect(argv).not.toContain(
      scopeDirFor({ runtimeBaseDir: RUNTIME_BASE, scopeId: "deadbeefcafe" }),
    );
  });

  it("masks a regular file with a /dev/null bind, after the base bind", () => {
    // Verified on bubblewrap 0.11.2: `--tmpfs <file>` fails ("Not a
    // directory"), while `--ro-bind /dev/null <file>` reads EACCES — a masked
    // file still exists but cannot be opened.
    const argv = buildArgv({
      masks: [
        { kind: "tmpfs", path: "/home/hugo/.aws" },
        { kind: "null-bind", path: "/run/secrets.d/2/aws-pi-agent-cert" },
        { kind: "null-bind", path: "/run/secrets.d/2/aws-pi-agent-key" },
      ],
    });
    const baseBind = indexOfSequence(argv, ["--ro-bind", "/", "/"]);
    const certMask = indexOfSequence(argv, [
      "--ro-bind",
      "/dev/null",
      "/run/secrets.d/2/aws-pi-agent-cert",
    ]);
    const keyMask = indexOfSequence(argv, [
      "--ro-bind",
      "/dev/null",
      "/run/secrets.d/2/aws-pi-agent-key",
    ]);
    const runtimeMask = indexOfSequence(argv, ["--tmpfs", RUNTIME_BASE]);
    expect(certMask).toBeGreaterThan(baseBind);
    expect(keyMask).toBeGreaterThan(certMask);
    // Every mask stays before the runtime-base mask and the scope re-bind.
    expect(runtimeMask).toBeGreaterThan(keyMask);
    expect(indexOfSequence(argv, ["--ro-bind", SCOPE_DIR, SCOPE_DIR])).toBeGreaterThan(runtimeMask);
    // A file cannot be masked with --tmpfs: bwrap cannot mkdir it.
    expect(indexOfSequence(argv, ["--tmpfs", "/run/secrets.d/2/aws-pi-agent-cert"])).toBe(-1);
  });

  it("exports the sandbox profile, region, and the recursion guard", () => {
    const argv = buildArgv();
    expect(
      indexOfSequence(argv, ["--setenv", "AWS_PROFILE", SANDBOX_PROFILE_NAME]),
    ).toBeGreaterThanOrEqual(0);
    expect(indexOfSequence(argv, ["--setenv", "AWS_REGION", "eu-north-1"])).toBeGreaterThanOrEqual(
      0,
    );
    expect(indexOfSequence(argv, ["--setenv", SANDBOX_ACTIVE_ENV_KEY, "1"])).toBeGreaterThanOrEqual(
      0,
    );
  });

  it("unsets every inherited credential source inside the sandbox, but not AWS_PROFILE", () => {
    const argv = buildArgv();
    for (const key of AWS_SANDBOX_UNSET_ENV_KEYS) {
      expect(indexOfSequence(argv, ["--unsetenv", key])).toBeGreaterThanOrEqual(0);
    }
    expect(indexOfSequence(argv, ["--unsetenv", "AWS_PROFILE"])).toBe(-1);
    // Every unsetenv comes after the setenv that establishes the sandbox
    // identity, so ordering can never strip AWS_PROFILE/AWS_REGION.
    const lastSetenv = indexOfSequence(argv, ["--setenv", SANDBOX_ACTIVE_ENV_KEY, "1"]);
    const firstUnsetenv = argv.indexOf("--unsetenv");
    expect(firstUnsetenv).toBeGreaterThan(lastSetenv);
  });

  it("pins the exact --unsetenv list (nine keys, AWS_PROFILE excluded)", () => {
    // Literal, not derived from AWS_SANDBOX_UNSET_ENV_KEYS: a self-referential
    // loop would keep passing if a credential key were dropped from the
    // constant, which is exactly the regression this guards. The sandbox's own
    // --unsetenv is the last line of defense for a hand-run bwrap argv or the
    // belayd-shell re-exec, where the inherited environment is the caller's.
    const expected = [
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "AWS_SECURITY_TOKEN",
      "AWS_DEFAULT_PROFILE",
      "AWS_CONFIG_FILE",
      "AWS_SHARED_CREDENTIALS_FILE",
      "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
      "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    ];
    expect([...AWS_SANDBOX_UNSET_ENV_KEYS].sort()).toEqual([...expected].sort());
    const argv = buildArgv();
    for (const key of expected) {
      expect(indexOfSequence(argv, ["--unsetenv", key])).toBeGreaterThanOrEqual(0);
    }
    // Unsetting the synthetic profile would send the SDK looking for
    // [profile default], which does not exist in the generated config.
    expect(indexOfSequence(argv, ["--unsetenv", "AWS_PROFILE"])).toBe(-1);
  });

  it("unshares only the user namespace and never the pid/ipc/net/tmp ones", () => {
    const argv = buildArgv();
    expect(argv).toContain("--unshare-user");
    expect(argv).toContain("--die-with-parent");
    expect(argv).toContain("--new-session");
    for (const forbidden of [
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-net",
      "--unshare-uts",
      "--not-a-security-boundary",
      "--disable-userns",
    ]) {
      expect(argv).not.toContain(forbidden);
    }
    expect(indexOfSequence(argv, ["--tmpfs", "/tmp"])).toBe(-1);
    expect(indexOfSequence(argv, ["--tmpfs", "/run"])).toBe(-1);
  });

  it("appends the command after --, and returns a prefix without one", () => {
    const prefix = buildArgv();
    expect(prefix).not.toContain("--");
    const full = buildArgv({ command: ["pi", "--mode", "json"] });
    const separator = indexOfSequence(full, ["--", "pi", "--mode", "json"]);
    expect(separator).toBe(full.length - 4);
    expect(withSandboxCommand(prefix, ["pi", "--mode", "json"])).toEqual(full);
  });

  it("uses the default sandbox profile unless overridden", () => {
    const argv = buildArgv({ awsProfile: "custom" });
    expect(indexOfSequence(argv, ["--setenv", "AWS_PROFILE", "custom"])).toBeGreaterThanOrEqual(0);
  });
});

describe("aws-broker scope: env hygiene", () => {
  it("scrubs every exact credential key and the container-credential prefix", () => {
    const input: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      HOME: "/home/hugo",
      AWS_ACCESS_KEY_ID: "AKIA",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_SESSION_TOKEN: "token",
      AWS_SECURITY_TOKEN: "token",
      AWS_PROFILE: "operator",
      AWS_DEFAULT_PROFILE: "operator",
      AWS_CONFIG_FILE: "/home/hugo/.aws/config",
      AWS_SHARED_CREDENTIALS_FILE: "/home/hugo/.aws/credentials",
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials",
      AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://169.254.170.2",
      AWS_REGION: "eu-north-1",
      BELAYD_EXTRA: "kept",
    };
    const result = scrubAwsEnv(input);
    for (const key of AWS_ENV_KEYS) expect(result.env).not.toHaveProperty(key);
    for (const prefix of AWS_ENV_KEY_PREFIXES) {
      const leaked = Object.keys(result.env).filter((key) => key.startsWith(prefix));
      expect(leaked).toEqual([]);
    }
    expect(result.env).toHaveProperty("PATH", "/usr/bin");
    expect(result.env).toHaveProperty("BELAYD_EXTRA", "kept");
    expect(result.env).toHaveProperty("AWS_REGION", "eu-north-1");
    expect(result.removed).toContain("AWS_SECRET_ACCESS_KEY");
    // The input is never mutated.
    expect(input).toHaveProperty("AWS_SECRET_ACCESS_KEY", "secret");
  });

  it("detects the recursion guard", () => {
    expect(isSandboxActive({ [SANDBOX_ACTIVE_ENV_KEY]: "1" })).toBe(true);
    expect(isSandboxActive({ [SANDBOX_ACTIVE_ENV_KEY]: "0" })).toBe(false);
    expect(isSandboxActive({})).toBe(false);
  });
});
