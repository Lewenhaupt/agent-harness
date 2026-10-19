import { describe, expect, it } from "vitest";
import { parseBelaydCommandArgs } from "../belayd-command-args.js";

describe("parseBelaydCommandArgs", () => {
  it("parses a bare task id", () => {
    expect(parseBelaydCommandArgs("bd-42")).toEqual({
      ok: true,
      args: {
        taskId: "bd-42",
        noWorktree: false,
        typeArg: undefined,
        handoff: undefined,
        handoffFlagPresent: false,
        force: false,
      },
    });
  });

  it("parses an explicit type and --no-worktree", () => {
    const result = parseBelaydCommandArgs("bd-42 feature --no-worktree");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.args.taskId).toBe("bd-42");
    expect(result.args.typeArg).toBe("feature");
    expect(result.args.noWorktree).toBe(true);
    expect(result.args.handoff).toBeUndefined();
  });

  it("keeps quoted multi-word handoff text intact", () => {
    const result = parseBelaydCommandArgs('bd-42 --handoff "Follow the retry plan closely"');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.args.handoff).toBe("Follow the retry plan closely");
    expect(result.args.typeArg).toBeUndefined();
    expect(result.args.noWorktree).toBe(false);
  });

  it("joins unquoted multi-word handoff text instead of truncating it", () => {
    // Documented grammar: `--handoff` is terminal, so everything after it is
    // the value. A one-word truncation silently dropped the actual plan.
    const result = parseBelaydCommandArgs("bd-42 --handoff Follow the retry plan closely");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.args.handoff).toBe("Follow the retry plan closely");
    expect(result.args.typeArg).toBeUndefined();
    expect(result.args.noWorktree).toBe(false);
  });

  it("treats a flag-looking handoff value as text, not as a flag", () => {
    const result = parseBelaydCommandArgs("bd-42 --handoff --no-worktree");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.args.handoff).toBe("--no-worktree");
    expect(result.args.noWorktree).toBe(false);
  });

  it("still honours --no-worktree when it appears before the handoff", () => {
    const result = parseBelaydCommandArgs("bd-42 --no-worktree --handoff the plan");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.args.noWorktree).toBe(true);
    expect(result.args.handoff).toBe("the plan");
  });

  it("accepts an inline --handoff value, including @path", () => {
    const fileResult = parseBelaydCommandArgs("bd-42 --handoff=@plan.md");
    expect(fileResult.ok).toBe(true);
    if (!fileResult.ok) return;
    expect(fileResult.args.handoff).toBe("@plan.md");

    const textResult = parseBelaydCommandArgs("bd-42 --handoff=the plan continues");
    expect(textResult.ok).toBe(true);
    if (!textResult.ok) return;
    expect(textResult.args.handoff).toBe("the plan continues");
  });

  it("parses --force as a boolean override, in any position", () => {
    const leading = parseBelaydCommandArgs("--force bd-42 bugfix");
    expect(leading.ok).toBe(true);
    if (!leading.ok) return;
    expect(leading.args.force).toBe(true);
    expect(leading.args.taskId).toBe("bd-42");
    expect(leading.args.typeArg).toBe("bugfix");

    const trailing = parseBelaydCommandArgs("bd-42 --no-worktree --force");
    expect(trailing.ok).toBe(true);
    if (!trailing.ok) return;
    expect(trailing.args.force).toBe(true);
    expect(trailing.args.noWorktree).toBe(true);
    expect(trailing.args.typeArg).toBeUndefined();
  });

  it("treats --force after --handoff as handoff text, not a flag", () => {
    // `--handoff` is documented as terminal, so the value wins over flag-ness.
    const result = parseBelaydCommandArgs("bd-42 --handoff stop --force now");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.args.handoff).toBe("stop --force now");
    expect(result.args.force).toBe(false);
  });

  it("flags a bare --handoff as present with no value", () => {
    const result = parseBelaydCommandArgs("bd-42 --handoff");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.args.handoffFlagPresent).toBe(true);
    expect(result.args.handoff).toBeUndefined();
  });

  it("reports an unterminated quote instead of guessing", () => {
    const result = parseBelaydCommandArgs('bd-42 --handoff "never closed');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Unterminated double quote");
  });
});
