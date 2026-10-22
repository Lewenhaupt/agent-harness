import { describe, expect, it } from "vitest";
import {
  isPathWithin,
  type MaskPathStat,
  type MaskValidationContext,
  matchScope,
  mergeMaskEntries,
  parseAllowlist,
  parseRepoConfig,
  resolveScope,
  validateMaskEntry,
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

describe("aws-broker config: mask entries", () => {
  it("parses a per-scope flow list and a per-scope block list", () => {
    const flow = parseAllowlist(
      "scopes:\n  - worktree: /repo\n    profiles: [a]\n    mask: [/srv/cert, /srv/key]\n",
    );
    expect(flow.ok).toBe(true);
    if (!flow.ok) return;
    expect(flow.value.scopes[0]?.mask).toEqual(["/srv/cert", "/srv/key"]);

    const block = parseAllowlist(
      [
        "scopes:",
        "  - worktree: /repo",
        "    profiles: [a]",
        "    mask:",
        "      - /srv/cert",
        "      - '/srv/with space/key'",
      ].join("\n"),
    );
    expect(block.ok).toBe(true);
    if (!block.ok) return;
    expect(block.value.scopes[0]?.mask).toEqual(["/srv/cert", "/srv/with space/key"]);
  });

  it("parses a top-level flow list and block list", () => {
    const flow = parseAllowlist(
      "mask: [/srv/shared]\nscopes:\n  - worktree: /repo\n    profiles: [a]\n",
    );
    expect(flow.ok).toBe(true);
    if (!flow.ok) return;
    expect(flow.value.mask).toEqual(["/srv/shared"]);
    expect(flow.value.scopes[0]?.mask).toEqual([]);

    // Indent-2 items after a top-level `mask:` are mask entries, not scopes —
    // the state disambiguates them, and `scopes:` ends the block.
    const block = parseAllowlist(
      [
        "mask:",
        "  - /srv/one",
        "  - /srv/two",
        "scopes:",
        "  - worktree: /repo",
        "    profiles: [a]",
      ].join("\n"),
    );
    expect(block.ok).toBe(true);
    if (!block.ok) return;
    expect(block.value.mask).toEqual(["/srv/one", "/srv/two"]);
    expect(block.value.scopes).toHaveLength(1);
  });

  it("accepts a top-level mask block indented deeper than two spaces", () => {
    // Four-space habits are common; the items must not be refused as broken
    // scope entries. The open top-level `mask` block disambiguates them.
    const block = parseAllowlist(
      [
        "mask:",
        "    - /srv/one",
        "    - /srv/two",
        "scopes:",
        "  - worktree: /repo",
        "    profiles: [a]",
      ].join("\n"),
    );
    expect(block.ok).toBe(true);
    if (!block.ok) return;
    expect(block.value.mask).toEqual(["/srv/one", "/srv/two"]);
    expect(block.value.scopes).toHaveLength(1);
  });

  it("still refuses an indented scope entry when the open block is not mask", () => {
    // The relaxed top-level mask indent must not make a mis-indented `scopes:`
    // entry parse as something else.
    const result = parseAllowlist("scopes:\n    - worktree: /repo\n      profiles: [a]\n");
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toContain("expected a `- ` scope entry at indent 2");
  });

  it("does not reattribute an indent-2 `- worktree:` line to the scope sequence", () => {
    // W2: while a top-level `mask:` block is open, an indent-2 item belongs to
    // that block, so a missing `scopes:` key must fail as a bad mask entry
    // instead of silently becoming the first scope.
    const result = parseAllowlist(["mask:", "  - worktree: /repo", "    profiles: [a]"].join("\n"));
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toContain("line 2");
    expect(result.reason).toContain("must be an absolute path");
  });

  it("refuses a per-scope block-list item at indent 1 and accepts indent 3", () => {
    // The documented contract is indent >= 3 (deeper than the scope entry at
    // indent 2); indent 1 is a typo and must not be quietly accepted.
    const tooShallow = parseAllowlist(
      ["scopes:", "  - worktree: /repo", "    profiles:", " - agent-readonly"].join("\n"),
    );
    expect(tooShallow).toHaveProperty("ok", false);
    if (tooShallow.ok) return;
    expect(tooShallow.reason).toContain("line 4");
    expect(tooShallow.reason).toContain("must be indented at least 3 spaces");

    const atThree = parseAllowlist(
      ["scopes:", "  - worktree: /repo", "    profiles:", "   - agent-readonly"].join("\n"),
    );
    expect(atThree).toHaveProperty("ok", true);
    if (!atThree.ok) return;
    expect(atThree.value.scopes[0]?.profiles).toEqual(["agent-readonly"]);
  });

  it("requires a scope entry at exactly indent 2", () => {
    // The documented contract is indent 2 for `- ` scope entries; indent 1 (a
    // typo) and indent 3 (a four-space habit misapplied) must both be refused
    // rather than silently starting a scope at an offset the parser guesses.
    for (const text of [
      "scopes:\n - worktree: /repo\n   profiles: [a]\n",
      "scopes:\n   - worktree: /repo\n     profiles: [a]\n",
    ]) {
      const result = parseAllowlist(text);
      expect(result).toHaveProperty("ok", false);
      if (result.ok) continue;
      expect(result.reason).toContain("expected a `- ` scope entry at indent 2");
    }
  });

  it("refuses a top-level mask item indented less than two spaces", () => {
    // The relaxed indent for a top-level mask block is `>= 2`; indent 1 is not
    // a mask entry and must not be quietly reattributed to the scope sequence.
    const result = parseAllowlist(
      ["mask:", " - /srv/cert", "scopes:", "  - worktree: /repo", "    profiles: [a]"].join("\n"),
    );
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toContain("line 2");
    expect(result.reason).toContain("expected a `- ` scope entry at indent 2");
  });

  it("defaults to an empty mask list when none is configured", () => {
    const result = parseAllowlist(VALID_ALLOWLIST);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mask).toEqual([]);
    expect(result.value.scopes[0]?.mask).toEqual([]);
  });

  it("merges top-level then per-scope masks, de-duplicated", () => {
    expect(mergeMaskEntries(["/a", "/b"], ["/b", "/c"])).toEqual(["/a", "/b", "/c"]);
    expect(mergeMaskEntries([], [])).toEqual([]);
    expect(mergeMaskEntries(["/a"], [])).toEqual(["/a"]);
  });

  it("refuses a mask entry that is not an absolute path", () => {
    for (const entry of ["relative/cert", "~/cert", "$HOME/.ssh", ""]) {
      const result = parseAllowlist(
        `scopes:\n  - worktree: /repo\n    profiles: [a]\n    mask: ["${entry}"]\n`,
      );
      expect(result).toHaveProperty("ok", false);
      if (result.ok) continue;
      expect(result.reason).toMatch(/must be an absolute path|must not be empty/);
    }
  });

  it('refuses mask entry "/" and a non-list mask value', () => {
    const root = parseAllowlist("scopes:\n  - worktree: /repo\n    profiles: [a]\n    mask: [/]\n");
    expect(root).toHaveProperty("ok", false);
    if (root.ok) return;
    expect(root.reason).toContain("entire filesystem");

    const scalar = parseAllowlist(
      "scopes:\n  - worktree: /repo\n    profiles: [a]\n    mask: /srv/cert\n",
    );
    expect(scalar).toHaveProperty("ok", false);
    if (scalar.ok) return;
    expect(scalar.reason).toContain("flow list");
  });

  it("refuses an unexpected list item that belongs to no block key", () => {
    const result = parseAllowlist(
      "scopes:\n  - worktree: /repo\n    region: eu-north-1\n      - /srv/cert\n",
    );
    expect(result).toHaveProperty("ok", false);
  });

  it("keeps mask out of the repo file, so a repo cannot widen its sandbox", () => {
    const result = parseRepoConfig("profile: a\nmask: [/srv/cert]\n");
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toContain('unknown key "mask"');
  });
});

describe("aws-broker config: mask validation", () => {
  const context: MaskValidationContext = {
    worktreeRoot: "/home/op/git/repo",
    homeDir: "/home/op",
    runtimeBaseDir: "/run/belayd/aws",
    scopeDir: "/run/belayd/aws/abc123",
    allowlistPath: "/home/op/.config/belayd/aws.yaml",
  };

  function validate(
    entry: string,
    resolvedPath: string,
    stat: MaskPathStat,
    overrides: Partial<MaskValidationContext> = {},
  ) {
    return validateMaskEntry({
      entry,
      resolvedPath,
      stat,
      context: { ...context, ...overrides },
    });
  }

  it("maps a directory to tmpfs and a regular file to a /dev/null bind", () => {
    const dir = validate("/srv/keys", "/srv/keys", { kind: "directory" });
    expect(dir.ok).toBe(true);
    if (!dir.ok) return;
    expect(dir.value).toEqual({ entry: "/srv/keys", path: "/srv/keys", kind: "tmpfs" });

    const file = validate("/srv/keys/cert", "/srv/keys/cert", { kind: "file" });
    expect(file.ok).toBe(true);
    if (!file.ok) return;
    expect(file.value).toEqual({
      entry: "/srv/keys/cert",
      path: "/srv/keys/cert",
      kind: "null-bind",
    });
  });

  it("emits the resolved path, not the entry as written", () => {
    // A symlinked directory is the case that matters: bwrap cannot create the
    // mount point for the unresolved path.
    const result = validate("/run/secrets/aws-cert", "/run/secrets.d/2/aws-cert", {
      kind: "file",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.path).toBe("/run/secrets.d/2/aws-cert");
    expect(result.value.entry).toBe("/run/secrets/aws-cert");
  });

  it("refuses the filesystem root, the home dir, a relative path, and an empty entry", () => {
    const cases: [string, string, MaskPathStat][] = [
      ["/", "/", { kind: "directory" }],
      ["/home/op", "/home/op", { kind: "directory" }],
      ["srv/cert", "/srv/cert", { kind: "file" }],
      ["", "/srv/cert", { kind: "file" }],
    ];
    for (const [entry, path, stat] of cases) {
      const result = validate(entry, path, stat);
      expect(result).toHaveProperty("ok", false);
      if (result.ok) continue;
      expect(result.reason).toContain(context.allowlistPath);
    }
  });

  it("refuses a path equal to or inside the worktree", () => {
    for (const path of ["/home/op/git/repo", "/home/op/git/repo/cert"]) {
      const result = validate(path, path, { kind: "file" });
      expect(result).toHaveProperty("ok", false);
      if (result.ok) continue;
      expect(result.reason).toContain("inside the worktree");
    }
  });

  it("refuses a path equal to or inside the scope dir or the runtime base", () => {
    const scopeDir = validate("/run/belayd/aws/abc123/sock", "/run/belayd/aws/abc123/sock", {
      kind: "other",
      description: "socket",
    });
    expect(scopeDir).toHaveProperty("ok", false);
    if (scopeDir.ok) return;
    expect(scopeDir.reason).toContain("runtime dir");

    const base = validate("/run/belayd/aws/control.sock", "/run/belayd/aws/control.sock", {
      kind: "other",
      description: "socket",
    });
    expect(base).toHaveProperty("ok", false);
    if (base.ok) return;
    expect(base.reason).toContain("broker runtime base");
  });

  it("refuses a missing path and any non-regular, non-directory path", () => {
    // Fail closed: a typo in `mask:` must never leave a cert readable.
    const missing = validate("/srv/typo", "/srv/typo", { kind: "missing" });
    expect(missing).toHaveProperty("ok", false);
    if (missing.ok) return;
    expect(missing.reason).toContain("does not exist");

    for (const description of ["socket", "fifo", "character device", "block device"]) {
      const other = validate("/srv/thing", "/srv/thing", { kind: "other", description });
      expect(other).toHaveProperty("ok", false);
      if (other.ok) continue;
      expect(other.reason).toContain(description);
    }
  });

  it("reports a dangling symlink inside the worktree as missing, not as a worktree path", () => {
    // A dangling symlink is what a failed `realpath()` hands us: the entry text
    // is inside the worktree, but the accurate reason is that it does not
    // resolve — blaming the worktree would hide the real fix.
    const entry = "/home/op/git/repo/link-to-nowhere";
    const result = validate(entry, entry, { kind: "missing" });
    expect(result).toHaveProperty("ok", false);
    if (result.ok) return;
    expect(result.reason).toContain("does not exist or cannot be resolved");
    expect(result.reason).toContain(entry);
    expect(result.reason).not.toContain("inside the worktree");
  });

  it("refuses a mask that is an ancestor of the home dir, worktree, scope dir, or runtime base", () => {
    // The inverse containment direction: a mask over a *parent* would hide the
    // protected path wholesale instead of leaving it visible.
    const worktreeParent = validate("/home/op/git", "/home/op/git", { kind: "directory" });
    expect(worktreeParent).toHaveProperty("ok", false);
    if (worktreeParent.ok) return;
    expect(worktreeParent.reason).toContain("hides the worktree");

    const runtimeParent = validate("/run/belayd", "/run/belayd", { kind: "directory" });
    expect(runtimeParent).toHaveProperty("ok", false);
    if (runtimeParent.ok) return;
    expect(runtimeParent.reason).toContain("hides the broker runtime base");

    const scopeParent = validate(
      "/run/other",
      "/run/other",
      { kind: "directory" },
      {
        scopeDir: "/run/other/scope",
      },
    );
    expect(scopeParent).toHaveProperty("ok", false);
    if (scopeParent.ok) return;
    expect(scopeParent.reason).toContain("hides this scope's runtime dir");

    // The worktree check fires first for a real worktree (it lives under
    // $HOME), so pin a worktree outside the home dir to reach the home check.
    const homeParent = validate(
      "/home",
      "/home",
      { kind: "directory" },
      {
        worktreeRoot: "/srv/repo",
      },
    );
    expect(homeParent).toHaveProperty("ok", false);
    if (homeParent.ok) return;
    expect(homeParent.reason).toContain("hides the home directory");
  });

  it("keeps a sibling directory of the worktree maskable", () => {
    const result = validate("/home/op/git/other/cert", "/home/op/git/other/cert", {
      kind: "file",
    });
    expect(result.ok).toBe(true);
  });

  it("compares paths with trailing slashes normalized", () => {
    expect(isPathWithin("/srv/keys", "/srv/keys/")).toBe(true);
    expect(isPathWithin("/srv/keys/cert", "/srv/keys")).toBe(true);
    expect(isPathWithin("/srv/keys2", "/srv/keys")).toBe(false);
    expect(isPathWithin("/anything", "/")).toBe(true);
  });
});
