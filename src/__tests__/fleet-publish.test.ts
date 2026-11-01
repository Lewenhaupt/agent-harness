import { describe, expect, it } from "vitest";
import {
  DEFAULT_FLEET_PUBLISH,
  FLEET_PUBLISH_MODES,
  type FleetPublishRequest,
  FleetPublishSchema,
  formatFleetPublish,
  parseFleetPublish,
  readFleetPublishConfig,
  resolveFleetPublish,
} from "../fleet-publish.js";

/** A `git config --get` that failed because the key is unset (exit 1). */
function missingKeyError(): Error {
  const error = new Error("command failed with exit code 1") as Error & { status?: number };
  error.status = 1;
  return error;
}

/** A genuine git failure (spawn error, timeout): not "the operator set nothing". */
function realFailure(): Error {
  return new Error("spawn git ENOENT");
}

/** Exec seam that returns the mapped key and treats everything else as unset. */
function gitValues(values: Record<string, string>) {
  return (args: readonly string[]): string => {
    const key = args[args.length - 1] ?? "";
    const value = values[key];
    if (value === undefined) throw missingKeyError();
    return value;
  };
}

const noGit = () => {
  throw missingKeyError();
};

describe("FleetPublishSchema", () => {
  it("validates every mode", () => {
    for (const mode of FLEET_PUBLISH_MODES) {
      const sample =
        mode === "pr"
          ? { mode, remote: "origin", base: "main" }
          : mode === "push"
            ? { mode, remote: "origin" }
            : { mode };
      expect(FleetPublishSchema.safeParse(sample).success).toBe(true);
    }
  });

  it("rejects a pr publish without remote or base", () => {
    expect(FleetPublishSchema.safeParse({ mode: "pr" }).success).toBe(false);
    expect(FleetPublishSchema.safeParse({ mode: "pr", remote: "origin" }).success).toBe(false);
    expect(FleetPublishSchema.safeParse({ mode: "pr", base: "main" }).success).toBe(false);
  });

  it("rejects an unknown mode and an unknown stack composition", () => {
    expect(FleetPublishSchema.safeParse({ mode: "publish" }).success).toBe(false);
    expect(
      FleetPublishSchema.safeParse({
        mode: "pr",
        remote: "origin",
        base: "main",
        stacks: "per-fleet",
      }).success,
    ).toBe(false);
  });

  it("accepts an optional boolean ready flag", () => {
    const base = { mode: "pr", remote: "origin", base: "main" };
    expect(FleetPublishSchema.safeParse(base).success).toBe(true);
    expect(FleetPublishSchema.safeParse({ ...base, ready: true })).toHaveProperty(
      "data.ready",
      true,
    );
    expect(FleetPublishSchema.safeParse({ ...base, ready: "yes" }).success).toBe(false);
  });

  it("rejects flag-shaped and control-character reference values", () => {
    for (const remote of ["--upload-pack=evil", "-x", "a\u0000b", "a\u001fb", "a\u007fb"]) {
      expect(
        FleetPublishSchema.safeParse({ mode: "push", remote }).success,
        `remote ${JSON.stringify(remote)} must be rejected`,
      ).toBe(false);
    }
    expect(
      FleetPublishSchema.safeParse({ mode: "pr", remote: "origin", base: "feat-x" }).success,
    ).toBe(true);
  });
});

describe("parseFleetPublish", () => {
  it("returns the contract for a valid value", () => {
    expect(parseFleetPublish({ mode: "pr", remote: "origin", base: "main", ready: true })).toEqual({
      mode: "pr",
      remote: "origin",
      base: "main",
      ready: true,
    });
  });

  it("returns undefined for anything unrecognised", () => {
    for (const raw of [undefined, null, "pr", 1, [], {}, { mode: "pr" }, { mode: "nope" }]) {
      expect(parseFleetPublish(raw)).toBe(undefined);
    }
  });
});

describe("resolveFleetPublish", () => {
  const flag = { mode: "pr", remote: "fork", base: "develop" } as const;
  const configFile = { mode: "push", remote: "config-remote" } as const;
  const gitConfig = { mode: "local" } as const;

  it("prefers the flag, then the config file, then git config, then local", () => {
    expect(resolveFleetPublish({ flag, baseBranch: "main" })).toEqual({
      ok: true,
      publish: { mode: "pr", remote: "fork", base: "develop" },
      source: "flag",
    });
    expect(resolveFleetPublish({ configFile, baseBranch: "main" })).toEqual({
      ok: true,
      publish: { mode: "push", remote: "config-remote" },
      source: "config-file",
    });
    expect(resolveFleetPublish({ gitConfig, baseBranch: "main" })).toEqual({
      ok: true,
      publish: { mode: "local" },
      source: "git-config",
    });
    expect(resolveFleetPublish({ baseBranch: "main" })).toEqual({
      ok: true,
      publish: DEFAULT_FLEET_PUBLISH,
      source: "default",
    });
  });

  it("lets the flag override one field of a config-file mode", () => {
    expect(
      resolveFleetPublish({
        flag: { remote: "fork" },
        configFile: { mode: "pr", base: "develop" },
        baseBranch: "main",
      }),
    ).toEqual({
      ok: true,
      publish: { mode: "pr", remote: "fork", base: "develop" },
      source: "config-file",
    });
  });

  it("completes a pr request from the passed base branch and origin remote", () => {
    expect(resolveFleetPublish({ flag: { mode: "pr" }, baseBranch: "develop" })).toEqual({
      ok: true,
      publish: { mode: "pr", remote: "origin", base: "develop" },
      source: "flag",
    });
    expect(resolveFleetPublish({ flag: { mode: "push" }, baseBranch: "main" })).toEqual({
      ok: true,
      publish: { mode: "push", remote: "origin" },
      source: "flag",
    });
  });

  it("accepts every pr field at once (positive control)", () => {
    expect(
      resolveFleetPublish({
        flag: {
          mode: "pr",
          remote: "fork",
          base: "develop",
          ready: true,
          stacks: "per-chain",
        },
        baseBranch: "main",
      }),
    ).toEqual({
      ok: true,
      publish: {
        mode: "pr",
        remote: "fork",
        base: "develop",
        ready: true,
        stacks: "per-chain",
      },
      source: "flag",
    });
  });

  it("refuses a field the resolved mode cannot carry, one per field", () => {
    const cases: readonly { flag: FleetPublishRequest; field: string }[] = [
      { flag: { mode: "local", remote: "fork" }, field: "remote" },
      { flag: { mode: "push", base: "develop" }, field: "base" },
      { flag: { mode: "push", ready: true }, field: "ready" },
      { flag: { mode: "local", stacks: "per-chain" }, field: "stacks" },
    ];
    for (const { flag: offending, field } of cases) {
      const result = resolveFleetPublish({ flag: offending, baseBranch: "main" });
      expect(result).toHaveProperty("ok", false);
      if (!result.ok) {
        expect(result.error).toContain(`"${field}"`);
        expect(result.error).toContain("only applies to mode");
      }
    }
  });

  it("refuses an inapplicable field from every source", () => {
    const fromFlag = resolveFleetPublish({
      flag: { mode: "local", remote: "fork" },
      baseBranch: "main",
    });
    expect(fromFlag).toHaveProperty("ok", false);

    // The config object carries `base` under a mode that cannot use it.
    const fromConfig = resolveFleetPublish({
      configFile: { mode: "push", base: "develop" },
      baseBranch: "main",
    });
    expect(fromConfig).toHaveProperty("ok", false);
    if (!fromConfig.ok) expect(fromConfig.error).toContain('"base"');

    // A git-config key supplies a field the resolved mode cannot carry.
    const fromGit = resolveFleetPublish({
      gitConfig: { mode: "local", ready: true },
      baseBranch: "main",
    });
    expect(fromGit).toHaveProperty("ok", false);
    if (!fromGit.ok) expect(fromGit.error).toContain('"ready"');
  });

  it("refuses a source whose own declared mode cannot carry its field", () => {
    const result = resolveFleetPublish({
      flag: { mode: "pr" },
      configFile: { mode: "push", base: "develop" },
      baseBranch: "main",
    });
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) {
      expect(result.error).toContain('"base"');
      expect(result.error).toContain('declares "push"');
    }
  });

  it("refuses flag-shaped and control-character values before freezing", () => {
    const flagShaped = resolveFleetPublish({
      flag: { mode: "push", remote: "--upload-pack=evil" },
      baseBranch: "main",
    });
    expect(flagShaped).toHaveProperty("ok", false);
    const control = resolveFleetPublish({
      flag: { mode: "pr", remote: "origin", base: "a\nb" },
      baseBranch: "main",
    });
    expect(control).toHaveProperty("ok", false);
  });
});

describe("formatFleetPublish", () => {
  it("renders one line per mode", () => {
    expect(formatFleetPublish({ mode: "local" })).toBe("local");
    expect(formatFleetPublish({ mode: "pr", remote: "origin", base: "main" })).toBe(
      "pr → origin/main",
    );
    expect(formatFleetPublish({ mode: "push", remote: "origin" })).toBe("push → origin");
  });
});

describe("readFleetPublishConfig", () => {
  const repoRoot = "/repo";
  const configPath = "/repo/.belayd/config.json";

  function fsWith(content: string | undefined): {
    readFileSync: (path: string) => string;
  } {
    return {
      readFileSync: (path) => {
        if (content === undefined) {
          const error = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        return content;
      },
    };
  }

  it("reads a full publish object from .belayd/config.json", () => {
    const result = readFleetPublishConfig({
      repoRoot,
      fs: fsWith(JSON.stringify({ publish: { mode: "pr", remote: "fork", base: "develop" } })),
      exec: noGit,
    });
    expect(result.configFile).toEqual({ mode: "pr", remote: "fork", base: "develop" });
    expect(result.warnings).toEqual([]);
  });

  it("accepts the shorthand publish string", () => {
    const result = readFleetPublishConfig({
      repoRoot,
      fs: fsWith(JSON.stringify({ publish: "push" })),
      exec: noGit,
    });
    expect(result.configFile).toEqual({ mode: "push" });
    expect(result.warnings).toEqual([]);
  });

  it("warns and ignores a publish key of an unexpected type", () => {
    // Anything but an object or a mode string is an operator error in the repo
    // config, not a reason to refuse a launch: warn, ignore the key, keep going.
    for (const publish of [
      42,
      null,
      ["pr"],
      true,
      { mode: "pr", remote: "origin", base: "main", approvals: 2 },
    ]) {
      const result = readFleetPublishConfig({
        repoRoot,
        fs: fsWith(JSON.stringify({ publish })),
        exec: noGit,
      });
      expect(result.configFile).toBe(undefined);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain(configPath);
      expect(result.warnings[0]).toContain("invalid publish");
    }

    // An unknown shorthand string names the value it ignores, so a typo is
    // actionable instead of silent.
    const shorthand = readFleetPublishConfig({
      repoRoot,
      fs: fsWith(JSON.stringify({ publish: "sometimes" })),
      exec: noGit,
    });
    expect(shorthand.configFile).toBe(undefined);
    expect(shorthand.warnings[0]).toContain('unknown publish "sometimes"');
  });

  it("warns and ignores a config file whose root is not an object", () => {
    const result = readFleetPublishConfig({
      repoRoot,
      fs: fsWith(JSON.stringify(["pr"])),
      exec: noGit,
    });
    expect(result.configFile).toBe(undefined);
    expect(result.warnings[0]).toContain("expected a JSON object");
  });

  it("warns and ignores invalid JSON", () => {
    const result = readFleetPublishConfig({
      repoRoot,
      fs: fsWith("{ not json"),
      exec: noGit,
    });
    expect(result.configFile).toBe(undefined);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(configPath);
  });

  it("warns and ignores an invalid publish value", () => {
    const result = readFleetPublishConfig({
      repoRoot,
      fs: fsWith(JSON.stringify({ publish: { mode: "nope" } })),
      exec: noGit,
    });
    expect(result.configFile).toBe(undefined);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("invalid publish");
  });

  it("warns and ignores a flag-shaped or control-character config value", () => {
    for (const publish of [
      { mode: "pr", remote: "--upload-pack=evil", base: "main" },
      { mode: "pr", remote: "origin", base: "a\nb" },
    ]) {
      const result = readFleetPublishConfig({
        repoRoot,
        fs: fsWith(JSON.stringify({ publish })),
        exec: noGit,
      });
      expect(result.configFile).toBe(undefined);
      expect(result.warnings.some((warning) => warning.includes("invalid publish"))).toBe(true);
    }
  });

  it("reads every git config key", () => {
    const result = readFleetPublishConfig({
      repoRoot,
      fs: fsWith(undefined),
      exec: gitValues({
        "belayd.publish": "pr",
        "belayd.publish.remote": "fork",
        "belayd.publish.base": "develop",
        "belayd.publish.ready": "true",
        "belayd.publish.stacks": "per-chain",
      }),
    });
    expect(result.gitConfig).toEqual({
      mode: "pr",
      remote: "fork",
      base: "develop",
      ready: true,
      stacks: "per-chain",
    });
    expect(result.warnings).toEqual([]);
  });

  it("warns about an unknown git config mode without failing", () => {
    const result = readFleetPublishConfig({
      repoRoot,
      fs: fsWith(undefined),
      exec: (args) => {
        if (args[args.length - 1] === "belayd.publish") return "publish";
        throw missingKeyError();
      },
    });
    expect(result.gitConfig).toBe(undefined);
    expect(result.warnings.some((warning) => warning.includes("belayd.publish"))).toBe(true);
  });

  it("warns and ignores an over-long, flag-shaped, or control-character git value", () => {
    const cases: readonly { key: string; value: string }[] = [
      { key: "belayd.publish.base", value: "x".repeat(300) },
      { key: "belayd.publish.remote", value: "--upload-pack=evil" },
      { key: "belayd.publish.base", value: "a\nb" },
    ];
    for (const { key, value } of cases) {
      const result = readFleetPublishConfig({
        repoRoot,
        fs: fsWith(undefined),
        exec: (args) => {
          const requested = args[args.length - 1] ?? "";
          if (requested === "belayd.publish") return "pr";
          if (requested === key) return value;
          throw missingKeyError();
        },
      });
      // The bad key is ignored (a warning, not a refusal), the source survives.
      expect(result.gitConfig).toEqual({ mode: "pr" });
      expect(result.warnings.some((warning) => warning.includes(key))).toBe(true);
    }
  });

  it("reports a genuine git failure as a warning and does not treat the key as unset", () => {
    const result = readFleetPublishConfig({
      repoRoot,
      fs: fsWith(undefined),
      exec: () => {
        throw realFailure();
      },
    });
    expect(result.gitConfig).toBe(undefined);
    expect(result.warnings.some((warning) => warning.includes("belayd.publish"))).toBe(true);
  });

  it("treats exit 1 as unset with no warning", () => {
    const result = readFleetPublishConfig({
      repoRoot,
      fs: fsWith(undefined),
      exec: noGit,
    });
    expect(result).toEqual({ warnings: [] });
  });

  it("returns an empty result with no warnings when no config exists", () => {
    const result = readFleetPublishConfig({
      repoRoot,
      fs: fsWith(undefined),
      exec: noGit,
    });
    expect(result).toEqual({ warnings: [] });
  });
});
