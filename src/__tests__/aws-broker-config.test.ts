import { describe, expect, it } from "vitest";
import {
  matchScope,
  parseAllowlist,
  parseRepoConfig,
  resolveScope,
  worktreeMatchesGlob,
} from "../aws-broker/config.js";

const VALID_ALLOWLIST = [
  "region: eu-north-1",
  "scopes:",
  "  - worktree: /home/hugo/git/acme-*",
  "    profiles: [agent-readonly, agent-deploy]",
  "    default: agent-readonly",
  "",
].join("\n");

describe("aws-broker config: allowlist", () => {
  it("parses a flow-list allowlist with a top-level region", () => {
    const result = parseAllowlist(VALID_ALLOWLIST);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.region).toBe("eu-north-1");
    expect(result.value.scopes).toHaveLength(1);
    const scope = result.value.scopes[0];
    expect(scope).toHaveProperty("worktree", "/home/hugo/git/acme-*");
    expect(scope?.profiles).toEqual(["agent-readonly", "agent-deploy"]);
    expect(scope?.defaultProfile).toBe("agent-readonly");
  });

  it("parses block lists, comments, quoted scalars, and per-scope regions", () => {
    const text = [
      "# operator allowlist",
      "scopes:",
      "  - worktree: '/home/hugo/git/belayd-agent-harness'",
      "    profiles:",
      "      - agent-readonly",
      "      - agent-deploy   # trailing comment",
      '    region: "us-east-1"',
    ].join("\n");
    const result = parseAllowlist(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.scopes[0]?.profiles).toEqual(["agent-readonly", "agent-deploy"]);
    expect(result.value.scopes[0]?.region).toBe("us-east-1");
  });

  it("refuses an unknown top-level key", () => {
    const result = parseAllowlist("scopes:\n  - worktree: /x\n    profiles: [a]\nprofile: oops\n");
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toContain("unknown top-level key");
  });

  it("refuses a scope without a worktree", () => {
    const result = parseAllowlist("scopes:\n  - profiles: [a]\n");
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toContain("missing `worktree`");
  });

  it("refuses a scope without profiles", () => {
    const result = parseAllowlist("scopes:\n  - worktree: /x\n");
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toContain("missing `profiles`");
  });

  it("refuses a default that is not one of the scope's profiles", () => {
    const result = parseAllowlist("scopes:\n  - worktree: /x\n    profiles: [a]\n    default: b\n");
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toContain('default "b" is not one of its profiles');
  });

  it("refuses an empty allowlist (AWS stays disabled)", () => {
    const result = parseAllowlist("scopes:\n");
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toContain("defines no scopes");
  });

  it("refuses tabs, unknown scope keys, and invalid profile names", () => {
    expect(parseAllowlist("scopes:\n\t- worktree: /x\n")).toHaveProperty("ok", false);
    expect(
      parseAllowlist("scopes:\n  - worktree: /x\n    profiles: [a]\n    nope: 1\n"),
    ).toHaveProperty("ok", false);
    const invalid = parseAllowlist('scopes:\n  - worktree: /x\n    profiles: ["bad name"]\n');
    expect(invalid).toHaveProperty("ok", false);
    if (invalid.ok) return;
    expect(invalid.reason).toContain("invalid profile name");
  });

  it("refuses a non-list profiles value", () => {
    const result = parseAllowlist("scopes:\n  - worktree: /x\n    profiles: agent\n");
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toContain("`profiles` must be a flow list");
  });
});

describe("aws-broker config: repo file", () => {
  it("parses a literal profile", () => {
    const result = parseRepoConfig("profile: agent-deploy\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.profile).toBe("agent-deploy");
  });

  it("refuses a missing profile (fail closed)", () => {
    const result = parseRepoConfig("# nothing here\n");
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toContain("no `profile` entry");
  });

  it("refuses unknown keys, duplicates, and indentation", () => {
    expect(parseRepoConfig("region: x\n")).toHaveProperty("ok", false);
    expect(parseRepoConfig("profile: a\nprofile: b\n")).toHaveProperty("ok", false);
    expect(parseRepoConfig("  profile: a\n")).toHaveProperty("ok", false);
  });

  it("refuses a profile value that is not a valid name", () => {
    const result = parseRepoConfig('profile: "bad name"\n');
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toContain("invalid profile name");
  });

  it("treats a bare scalar as a string, not a number", () => {
    const result = parseRepoConfig("profile: 42\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.profile).toBe("42");
  });
});

describe("aws-broker config: globs and resolution", () => {
  it("matches * within one path segment and ** across segments", () => {
    expect(worktreeMatchesGlob("/home/hugo/git/acme-*", "/home/hugo/git/acme-web")).toBe(true);
    expect(worktreeMatchesGlob("/home/hugo/git/acme-*", "/home/hugo/git/acme-web/sub")).toBe(false);
    expect(worktreeMatchesGlob("/home/hugo/git/**", "/home/hugo/git/a/b")).toBe(true);
    expect(worktreeMatchesGlob("/home/hugo/git/acme-?", "/home/hugo/git/acme-1")).toBe(true);
    expect(worktreeMatchesGlob("/home/hugo/git/acme-?", "/home/hugo/git/acme-12")).toBe(false);
  });

  it("ignores a trailing slash on either side", () => {
    expect(worktreeMatchesGlob("/home/hugo/git/acme/", "/home/hugo/git/acme")).toBe(true);
    expect(worktreeMatchesGlob("/home/hugo/git/acme", "/home/hugo/git/acme/")).toBe(true);
  });

  it("picks the first matching scope and refuses an unmatched worktree", () => {
    const parsed = parseAllowlist(
      [
        "scopes:",
        "  - worktree: /home/hugo/git/acme-*",
        "    profiles: [agent-readonly]",
        "  - worktree: /home/hugo/git/**",
        "    profiles: [agent-wide]",
      ].join("\n"),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const match = matchScope(parsed.value, "/home/hugo/git/acme-web");
    expect(match.ok).toBe(true);
    if (!match.ok) return;
    expect(match.value.profiles).toEqual(["agent-readonly"]);

    const unmatched = matchScope(parsed.value, "/srv/other");
    expect(unmatched).toHaveProperty("ok", false);
    if (unmatched.ok) return;
    expect(unmatched.reason).toContain("not covered by any scope");
  });

  it("refuses a profile the scope does not grant, naming the allowed list", () => {
    const parsed = parseAllowlist(
      "region: eu-north-1\nscopes:\n  - worktree: /repo\n    profiles: [agent-readonly]\n",
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = resolveScope({
      allowlist: parsed.value,
      repo: { profile: "agent-deploy" },
      worktreeRoot: "/repo",
    });
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toContain('profile "agent-deploy" is not permitted');
    expect(result.reason).toContain("agent-readonly");
  });

  it("never substitutes the allowlist default for a repo file's literal profile", () => {
    const parsed = parseAllowlist(
      [
        "scopes:",
        "  - worktree: /repo",
        "    profiles: [agent-readonly, agent-deploy]",
        "    default: agent-readonly",
      ].join("\n"),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = resolveScope({
      allowlist: parsed.value,
      repo: { profile: "agent-deploy" },
      worktreeRoot: "/repo",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.profile).toBe("agent-deploy");
  });

  it("carries the per-scope region, then the allowlist region", () => {
    const parsed = parseAllowlist(
      [
        "region: eu-north-1",
        "scopes:",
        "  - worktree: /a",
        "    profiles: [agent-readonly]",
        "  - worktree: /b",
        "    profiles: [agent-readonly]",
        "    region: us-east-1",
      ].join("\n"),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const withOverride = resolveScope({
      allowlist: parsed.value,
      repo: { profile: "agent-readonly" },
      worktreeRoot: "/b",
    });
    expect(withOverride.ok).toBe(true);
    if (!withOverride.ok) return;
    expect(withOverride.value.region).toBe("us-east-1");

    const withDefault = resolveScope({
      allowlist: parsed.value,
      repo: { profile: "agent-readonly" },
      worktreeRoot: "/a",
    });
    expect(withDefault.ok).toBe(true);
    if (!withDefault.ok) return;
    expect(withDefault.value.region).toBe("eu-north-1");
  });
});
