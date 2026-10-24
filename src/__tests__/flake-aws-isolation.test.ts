import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Resolve the repo root from this test file's location (src/__tests__ -> repo root)
// rather than process.cwd(), so the test is invariant to the Vitest working directory.
const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, "..", "..");
const flakePath = join(repoRoot, "flake.nix");

// Read once; a missing file surfaces a clear failure rather than a skip, because
// flake.nix is the artifact this regression guard exists to protect.
let flakeContents: string | null = null;
try {
  flakeContents = readFileSync(flakePath, "utf8");
} catch {
  flakeContents = null;
}

function flake(): string {
  if (flakeContents === null) {
    throw new Error(`could not read flake.nix at ${flakePath}`);
  }
  return flakeContents;
}

/**
 * Assemble a Nix interpolation. The expected substrings must never spell
 * `${...}` in one literal, or biome's noTemplateCurlyInString fires.
 */
function nixInterp(name: string): string {
  return ["${", name, "}"].join("");
}

/** Slice from `start` up to (but excluding) `end`; throws when either is absent. */
function sliceBetween(start: string, end: string): string {
  const contents = flake();
  const startIndex = contents.indexOf(start);
  if (startIndex === -1) throw new Error(`flake.nix is missing the anchor: ${start}`);
  const endIndex = contents.indexOf(end, startIndex + start.length);
  if (endIndex === -1) throw new Error(`flake.nix is missing the end anchor: ${end}`);
  return contents.slice(startIndex, endIndex);
}

/**
 * bd-125 flake wiring: the AWS sandbox tools, the masked session daemon, the
 * unsandboxed broker unit, and the broker entry-point wrappers. These are text
 * assertions on purpose — the flake is not evaluated by the unit suite, and a
 * rename that silently drops the mask must fail here rather than at
 * `nixos-rebuild` time.
 */
describe("bd-125: flake AWS isolation wiring", () => {
  it("puts bubblewrap, awscli2 and aws-signing-helper in devShellTools (so both PATHs get them)", () => {
    const tools = sliceBetween("devShellTools = [", "];");
    expect(tools).toContain("pkgs.bubblewrap");
    expect(tools).toContain("pkgs.awscli2");
    // `aws configure export-credentials` shells out to a RolesAnywhere
    // profile's credential_process helper, so the *broker* needs it on PATH
    // (the sandbox never runs it). Without this every request fails with
    // "command not found".
    expect(tools).toContain("pkgs.aws-signing-helper");
  });

  it("routes devShellTools into the devShell and the pi-web runtime env", () => {
    // devShellTools feeds devShells.default, pi-web-runtime-env, and the package
    // list; the AWS tools must ride that one list rather than a second PATH entry.
    expect(flake()).toContain("paths = devShellTools ++ [");
    expect(flake()).toContain("packages = devShellTools ++ [");
  });

  it("reaches the broker's PATH through pi-web-runtime-env (devShellTools → broker unit)", () => {
    // devShellTools membership alone proves nothing: `aws configure
    // export-credentials` finds `aws_signing_helper` only because the broker
    // unit's own environment puts pi-web-runtime-env/bin (built from
    // devShellTools) on PATH. Pin both links so a PATH edit that drops the
    // runtime env fails here instead of at the first RolesAnywhere request.
    const environment = sliceBetween("environment = [", "piWebSessiondSetup = pkgs");
    expect(environment).toContain(`"PATH=\${pi-web-runtime-env}/bin:`);
    const broker = sliceBetween(
      "systemd.services.pi-web-aws-broker = {",
      "systemd.services.pi-web = {",
    );
    expect(broker).toContain("Environment = environment;");
  });

  it("runs pi-web-sessiond under a minimal bwrap mask", () => {
    const sessiond = sliceBetween(
      "systemd.services.pi-web-sessiond = {",
      "systemd.services.pi-web-aws-broker = {",
    );
    expect(sessiond).toContain(`"${nixInterp("pkgs.bubblewrap")}/bin/bwrap"`);
    expect(sessiond).toContain('"--unshare-user"');
    expect(sessiond).toContain('"--die-with-parent"');
    // A writable base, not `--ro-bind / /`: the daemon writes its ownership
    // marker and socket into the data dir, and sessions must write their
    // worktrees and /tmp. The AWS mask is the security boundary.
    expect(sessiond).toContain('"--bind"');
    expect(sessiond).not.toContain('"--ro-bind"');
    expect(sessiond).toContain('"--tmpfs"');
    expect(sessiond).toContain(`"${nixInterp("userHome")}/.aws"`);
    expect(sessiond).toContain(`"${nixInterp("userHome")}/.config/aws"`);
    expect(sessiond).toContain(`"${nixInterp("pi-web")}/bin/pi-web-sessiond"`);
    // bd's dolt liveness check shells out to `ps`, and terminals/nix builds need
    // the host /tmp and host network: unsharing only the user namespace is the
    // property that matters and the only one that stays safe here.
    for (const forbidden of ["--unshare-pid", "--unshare-ipc", "--unshare-net", "--tmpfs /tmp"]) {
      expect(sessiond).not.toContain(forbidden);
    }
    // The session daemon must NOT mark its children as already sandboxed, or a
    // spawned agent would skip its own stricter per-repo scope.
    expect(sessiond).not.toContain("BELAYD_SANDBOX_ACTIVE");
  });

  it("keeps pi-web-server unsandboxed", () => {
    const server = sliceBetween("systemd.services.pi-web = {", "};\n          };\n        };");
    expect(server).toContain(`ExecStart = "${nixInterp("pi-web")}/bin/pi-web-server"`);
    expect(server).not.toContain("bubblewrap");
  });

  it("starts the broker as its own unwrapped unit", () => {
    const broker = sliceBetween(
      "systemd.services.pi-web-aws-broker = {",
      "systemd.services.pi-web = {",
    );
    expect(broker).toContain(`ExecStart = "${nixInterp("belayd-harness")}/bin/belayd-aws-broker"`);
    expect(broker).toContain('Restart = "on-failure"');
    expect(broker).not.toContain("bwrap");
    // The broker reads the operator's ~/.aws, so it can never be sandboxed.
    expect(broker).not.toContain("--tmpfs");
  });

  it("pre-creates the mask and data destinations before the session daemon starts", () => {
    const setup = sliceBetween("piWebSessiondSetup = pkgs.writeShellScriptBin", "'';");
    expect(setup).toContain("install -d -m 0700");
    expect(setup).toContain(`${nixInterp("userHome")}/.aws`);
    expect(setup).toContain(`${nixInterp("userHome")}/.config/aws`);
    // The writable state dir must exist before the daemon claims ownership.
    expect(setup).toContain(`install -d -m 0700 ${nixInterp("lib.escapeShellArg dataDir")}`);
  });

  it("exports XDG_RUNTIME_DIR and the shim wrapper to both units", () => {
    const environment = sliceBetween("environment = [", "piWebSessiondSetup = pkgs");
    expect(environment).toContain(`"XDG_RUNTIME_DIR=/run/user/${nixInterp("toString userUid")}"`);
    expect(environment).toContain(
      `BELAYD_AWS_CREDENTIAL_PROCESS_BIN=${nixInterp("belayd-harness")}/bin/`,
    );
    expect(environment).toContain(`BELAYD_AWS_BIN=${nixInterp("belayd-harness")}/bin/belayd-aws`);
    // The broker runtime base must not depend on XDG_RUNTIME_DIR (a system
    // service user has no logind session), so it is its own env entry.
    expect(environment).toContain(
      `"BELAYD_AWS_RUNTIME_BASE_DIR=${nixInterp("awsRuntimeBaseDir")}"`,
    );
    expect(flake()).toContain('awsRuntimeBaseDir = "/run/belayd/aws";');
  });

  it("derives the uid without throwing and only warns for an undeclared user", () => {
    // A raw `.uid` selection throws at eval time and takes the whole rebuild
    // down; `or null` plus a warning degrades to "no XDG_RUNTIME_DIR". A null
    // uid is also the normal `isNormalUser` shape, so the warning keys off the
    // declared attribute, not the uid.
    expect(flake()).toContain(`userUid = config.users.users.${nixInterp("cfg.user")}.uid or null;`);
    expect(flake()).toContain("userDeclared = builtins.hasAttr cfg.user config.users.users;");
    expect(flake()).toContain("warnings = lib.optional (!userDeclared)");
    expect(flake()).toContain('lib.optional (userUid != null) "XDG_RUNTIME_DIR=/run/user/');
  });

  it("gives the broker a systemd-owned runtime base and a tolerant audit dir", () => {
    const broker = sliceBetween(
      "systemd.services.pi-web-aws-broker = {",
      "systemd.services.pi-web = {",
    );
    expect(broker).toContain('RuntimeDirectory = "belayd/aws"');
    expect(broker).toContain('RuntimeDirectoryMode = "0700"');
    expect(broker).toContain('RuntimeDirectoryPreserve = "restart"');
    // Non-fatal: a read-only home must not crash-loop the broker.
    expect(broker).toContain(
      `ExecStartPre = "-${nixInterp("pkgs.coreutils")}/bin/install -d -m 0700`,
    );
    expect(broker).toContain(".local/state/belayd");
  });

  it("leaves the broker runtime base visible to the session daemon (orchestrator)", () => {
    // The orchestrator pi process legitimately needs the control socket to run
    // `ensure-scope` for spawned agents, so the sessiond argv must NOT mask the
    // runtime base. The per-repo sandbox (scope.ts) does, and the scope unit
    // tests pin that ordering.
    const sessiond = sliceBetween(
      "systemd.services.pi-web-sessiond = {",
      "# The AWS credential broker (bd-125).",
    );
    expect(sessiond).not.toContain("/run/belayd/aws");
  });

  it("substitutes the AWS planner into the shell wrapper", () => {
    expect(flake()).toContain(`s|@awsSandbox@|${nixInterp("belayd-harness")}/bin/belayd-aws|g`);
  });

  it("generates the three broker entry points from the harness src tree", () => {
    const install = sliceBetween("# AWS credential broker entry points", "runHook postInstall");
    expect(install).toContain("belayd-aws:src/aws-broker/main.ts");
    expect(install).toContain("belayd-aws-broker:src/aws-broker/main.ts");
    expect(install).toContain("belayd-aws-credential-process:src/aws-broker/main.ts");
    expect(install).toContain('subcommand="daemon"');
    expect(install).toContain('subcommand="credential-process"');
    expect(install).toContain("pkgs.nodejs_24");
  });
});
