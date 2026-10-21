import { describe, expect, it, vi } from "vitest";
import {
  BROKER_CLI_ENV_KEY,
  CREDENTIAL_PROCESS_BIN_ENV_KEY,
  ensureScopeSync,
  resolveBrokerCliPath,
} from "../aws-broker/ensure.js";

describe("aws-broker ensure (on-demand scope)", () => {
  it("resolves the CLI from BELAYD_AWS_BIN, then from the shim's sibling", () => {
    expect(resolveBrokerCliPath({ [BROKER_CLI_ENV_KEY]: "/nix/h/bin/belayd-aws" })).toBe(
      "/nix/h/bin/belayd-aws",
    );
    expect(
      resolveBrokerCliPath({
        [CREDENTIAL_PROCESS_BIN_ENV_KEY]: "/nix/h/bin/belayd-aws-credential-process",
      }),
    ).toBe("/nix/h/bin/belayd-aws");
    expect(resolveBrokerCliPath({})).toBeUndefined();
    expect(resolveBrokerCliPath({ [BROKER_CLI_ENV_KEY]: "" })).toBeUndefined();
  });

  it("runs `ensure-scope --worktree <path>` and returns the socket path", () => {
    const run = vi.fn(() => "/run/user/1000/belayd/aws/abc/sock\n");
    const result = ensureScopeSync({
      worktree: "/repo",
      env: { [BROKER_CLI_ENV_KEY]: "/nix/h/bin/belayd-aws" },
      run,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.socketPath).toBe("/run/user/1000/belayd/aws/abc/sock");
    expect(run).toHaveBeenCalledWith([
      "/nix/h/bin/belayd-aws",
      "ensure-scope",
      "--worktree",
      "/repo",
    ]);
  });

  it("fails as a value when the CLI is not configured", () => {
    const result = ensureScopeSync({ worktree: "/repo", env: {} });
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.error).toContain(BROKER_CLI_ENV_KEY);
  });

  it("fails as a value on an empty response or a thrown error", () => {
    const empty = ensureScopeSync({
      worktree: "/repo",
      env: { [BROKER_CLI_ENV_KEY]: "/bin/belayd-aws" },
      run: () => "\n",
    });
    expect(empty).toHaveProperty("ok", false);
    if (empty.ok) return;
    expect(empty.error).toContain("no socket path");

    const thrown = ensureScopeSync({
      worktree: "/repo",
      env: { [BROKER_CLI_ENV_KEY]: "/bin/belayd-aws" },
      run: () => {
        throw new Error("Command failed: broker not reachable");
      },
    });
    expect(thrown).toHaveProperty("ok", false);
    if (thrown.ok) return;
    expect(thrown.error).toContain("could not ensure the AWS scope socket");
    expect(thrown.error).toContain("broker not reachable");
  });
});
