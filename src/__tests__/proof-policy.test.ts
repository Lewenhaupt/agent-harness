import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROOF_ARTIFACT_POLICY,
  PROOF_ARTIFACT_POLICIES,
  readRepoProofPolicy,
} from "../proof-policy.js";

const repoRoot = "/repo";
const configPath = "/repo/.belayd/config.json";

/** A `.belayd/config.json` seam: the one path the reader may read. */
function fsWith(content: string | undefined) {
  const requested: string[] = [];
  return {
    requested,
    fs: {
      readFileSync: (path: string) => {
        requested.push(path);
        if (content === undefined) {
          const error = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        return content;
      },
    },
  };
}

describe("readRepoProofPolicy", () => {
  it("defaults to the strict policy when there is no config file", () => {
    const seam = fsWith(undefined);
    expect(readRepoProofPolicy({ repoRoot, fs: seam.fs })).toEqual({
      policy: "forbid",
      declared: false,
      warnings: [],
    });
    expect(seam.requested).toEqual([configPath]);
  });

  it("defaults to the strict policy when the file declares no proof key", () => {
    const seam = fsWith(JSON.stringify({ publish: { mode: "local" } }));
    expect(readRepoProofPolicy({ repoRoot, fs: seam.fs })).toEqual({
      policy: "forbid",
      declared: false,
      warnings: [],
    });
  });

  it("reads a declared policy and reports it as declared", () => {
    for (const policy of PROOF_ARTIFACT_POLICIES) {
      const seam = fsWith(JSON.stringify({ proof: { artifacts: policy } }));
      const result = readRepoProofPolicy({ repoRoot, fs: seam.fs });
      expect(result.policy).toBe(policy);
      expect(result.declared).toBe(true);
      expect(result.warnings).toEqual([]);
    }
  });

  it("warns and falls back to the strict policy for an unknown value", () => {
    const seam = fsWith(JSON.stringify({ proof: { artifacts: "in-git" } }));
    const result = readRepoProofPolicy({ repoRoot, fs: seam.fs });
    expect(result).toHaveProperty("policy", DEFAULT_PROOF_ARTIFACT_POLICY);
    expect(result.declared).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(configPath);
    expect(result.warnings[0]).toContain("invalid proof policy");
    expect(result.warnings[0]).toContain('assuming "forbid"');
  });

  it("warns on a misspelled key instead of reading it as no declaration", () => {
    const seam = fsWith(JSON.stringify({ proof: { artifact: "in-tree" } }));
    const result = readRepoProofPolicy({ repoRoot, fs: seam.fs });
    expect(result.policy).toBe("forbid");
    expect(result.declared).toBe(false);
    // `strict` on purpose: the missing `artifacts` key is named, so the operator
    // sees a typo rather than a silent fallback.
    expect(result.warnings[0]).toContain("artifacts: Invalid option");
    expect(result.warnings[0]).toContain('Unrecognized key: "artifact"');
  });

  it("warns on a non-object proof value", () => {
    for (const value of ['"in-tree"', "true", "[]", "null"]) {
      const seam = fsWith(`{"proof": ${value}}`);
      const result = readRepoProofPolicy({ repoRoot, fs: seam.fs });
      expect(result, value).toHaveProperty("policy", "forbid");
      expect(result.declared).toBe(false);
      expect(result.warnings, value).toHaveLength(1);
    }
  });

  it("surfaces the shared reader's warning for an unparsable file", () => {
    const result = readRepoProofPolicy({ repoRoot, fs: fsWith("{").fs });
    expect(result.policy).toBe("forbid");
    expect(result.declared).toBe(false);
    expect(result.warnings[0]).toContain("invalid JSON");
  });
});
