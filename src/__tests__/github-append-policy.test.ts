/**
 * Append-only bd policy for phase agents in a GitHub-primary repo (bd-180).
 *
 * One table over argv so every allowed/refused verb is visible in one place. The
 * local-mode wrapper is asserted separately: it must never refuse, because local
 * mode keeps today's behaviour byte-for-byte.
 */
import { describe, expect, it } from "vitest";

import { classifyBdWrite, classifyBdWriteForAuthority } from "../github-append-policy.js";

describe("classifyBdWrite", () => {
  const allowed: readonly (readonly string[])[] = [
    ["show", "bd-1", "--json"],
    ["list"],
    ["ready"],
    ["search", "login"],
    ["comment", "bd-1", "hello"],
    ["note", "bd-1", "progress"],
    ["create", "--title=Fix"],
    ["remember", "key", "value"],
    ["tag", "bd-1", "reviewed"],
    ["label", "add", "bd-1", "reviewed"],
    ["label", "list", "bd-1"],
    ["label", "list-all"],
    ["update", "bd-1", "--add-label", "reviewed"],
    ["dep", "list", "bd-1", "--json"],
    ["dep", "tree", "bd-1"],
    ["gate", "list", "bd-1", "--json"],
    ["update", "bd-1", "--description", "clarify"],
    ["heartbeat", "bd-1"],
  ];

  const refused: readonly (readonly [readonly string[], string])[] = [
    [["update", "bd-1", "--status", "in_progress"], "status"],
    [["update", "bd-1", "--status=closed"], "status"],
    [["update", "bd-1", "-s", "closed"], "status"],
    [["update", "bd-1", "-s=closed"], "status"],
    [["update", "bd-1", "-sclosed"], "status"],
    [["update", "bd-1", "--assignee", "alice"], "assignee"],
    [["update", "bd-1", "--assignee=alice"], "assignee"],
    [["update", "bd-1", "-a", "alice"], "assignee"],
    [["update", "bd-1", "-a=alice"], "assignee"],
    [["update", "bd-1", "--owner", "alice"], "assignee"],
    [["update", "bd-1", "--priority", "1"], "priority"],
    [["update", "bd-1", "--priority=1"], "priority"],
    [["update", "bd-1", "-p", "1"], "priority"],
    [["update", "bd-1", "-p=1"], "priority"],
    [["update", "bd-1", "--defer", "+1d"], "status"],
    [["update", "bd-1", "--defer=+1d"], "status"],
    [["update", "bd-1", "--remove-label", "reviewed"], "label"],
    [["update", "bd-1", "--remove-label=reviewed"], "label"],
    [["update", "bd-1", "--set-labels", "reviewed"], "label"],
    [["update", "bd-1", "--set-labels=a,b"], "label"],
    [["update", "bd-1", "--owner=alice"], "assignee"],
    [["update", "bd-1", "--parent", "bd-2"], "dependency"],
    [["update", "bd-1", "--parent=bd-2"], "dependency"],
    [["update", "bd-1", "parent-child", "bd-2"], "dependency"],
    [["assign", "bd-1", "alice"], "assignee"],
    [["priority", "bd-1", "1"], "priority"],
    [["dep", "add", "bd-2", "bd-1"], "dependency"],
    [["dep", "remove", "bd-2", "bd-1"], "dependency"],
    [["dep", "relate", "bd-1", "bd-2"], "dependency"],
    [["link", "bd-1", "bd-2", "blocks"], "dependency"],
    [["close", "bd-1"], "close"],
    [["reopen", "bd-1"], "reopen"],
    [["set-state", "bd-1", "reviewing"], "status"],
    [["defer", "bd-1"], "status"],
    [["undefer", "bd-1"], "status"],
    [["label", "remove", "bd-1", "reviewed"], "label"],
    [["label", "rm", "bd-1", "reviewed"], "label"],
    [["label", "delete", "bd-1", "reviewed"], "label"],
    [["label", "rename", "old", "new"], "label"],
    [["label", "propagate", "bd-1", "reviewed"], "label"],
    [["label"], "label"],
    [["label", "bd-1"], "label"],
    [["gate", "create", "bd-1", "--type", "human"], "unclassified-write"],
    [["gate", "resolve", "bd-1"], "unclassified-write"],
    [["delete", "bd-1"], "unclassified-write"],
    [["edit", "bd-1"], "unclassified-write"],
    [["sql", "select 1"], "unclassified-write"],
    [[], "unclassified-write"],
  ];

  it("allows reads and append-only verbs", () => {
    for (const argv of allowed) {
      expect(classifyBdWrite(argv), argv.join(" ")).toMatchObject({
        verdict: "append-only-allowed",
      });
    }
  });

  it("refuses every graph-owning write with its typed reason", () => {
    for (const [argv, reason] of refused) {
      const verdict = classifyBdWrite(argv);
      expect(verdict, argv.join(" ")).toMatchObject({ verdict: "refused", reason });
    }
  });

  it("names the owner in the refusal message", () => {
    const verdict = classifyBdWrite(["close", "bd-1"]);
    expect(verdict.verdict).toBe("refused");
    if (verdict.verdict !== "refused") return;
    expect(verdict.message).toContain("GitHub");
  });

  it("skips --actor's value when it looks for the child subcommand", () => {
    // The actor is injected at index 1, so a flag-value pair must not be read as
    // the child (otherwise every attributed bd label/dep call would misclassify).
    expect(classifyBdWrite(["dep", "--actor", "bot", "list", "bd-1"])).toEqual({
      verdict: "append-only-allowed",
      mode: "read",
    });
    expect(classifyBdWrite(["label", "--actor", "bot", "add", "bd-1", "reviewed"])).toEqual({
      verdict: "append-only-allowed",
      mode: "append",
    });
    expect(classifyBdWrite(["dep", "--actor", "bot", "add", "bd-1", "bd-2"])).toMatchObject({
      verdict: "refused",
      reason: "dependency",
    });
    expect(classifyBdWrite(["label", "--actor", "bot", "remove", "bd-1", "x"])).toMatchObject({
      verdict: "refused",
      reason: "label",
    });
  });

  it("is pure: the verdict is stable and argv is not mutated", () => {
    const argv = ["update", "bd-1", "--status=closed"];
    const before = [...argv];
    expect(classifyBdWrite(argv)).toEqual(classifyBdWrite(argv));
    expect(argv).toEqual(before);
  });
});

describe("classifyBdWriteForAuthority", () => {
  it("never refuses in local (bd) mode", () => {
    const writes: readonly (readonly string[])[] = [
      ["close", "bd-1"],
      ["dep", "add", "bd-2", "bd-1"],
      ["update", "bd-1", "--status", "closed"],
      ["assign", "bd-1", "alice"],
    ];
    for (const argv of writes) {
      expect(classifyBdWriteForAuthority({ argv, authority: "bd" })).toMatchObject({
        verdict: "append-only-allowed",
      });
    }
  });

  it("applies the policy under github authority", () => {
    expect(
      classifyBdWriteForAuthority({ argv: ["close", "bd-1"], authority: "github" }),
    ).toMatchObject({ verdict: "refused", reason: "close" });
    expect(
      classifyBdWriteForAuthority({ argv: ["comment", "bd-1", "hi"], authority: "github" }),
    ).toMatchObject({ verdict: "append-only-allowed" });
  });

  it("reports local mode reads as reads without consulting the policy", () => {
    expect(classifyBdWriteForAuthority({ argv: ["show", "bd-1"], authority: "bd" })).toEqual({
      verdict: "append-only-allowed",
      mode: "read",
    });
    // `gate create` and `sql` are refused everywhere else; local mode keeps the
    // tool's own allowlist as the only gate.
    for (const argv of [
      ["gate", "create", "bd-1"],
      ["gate", "resolve", "bd-1"],
      ["sql", "select 1"],
      ["delete", "bd-1"],
      ["label", "remove", "bd-1", "x"],
      ["reopen", "bd-1"],
    ]) {
      expect(classifyBdWriteForAuthority({ argv, authority: "bd" }), argv.join(" ")).toMatchObject({
        verdict: "append-only-allowed",
      });
    }
  });
});
