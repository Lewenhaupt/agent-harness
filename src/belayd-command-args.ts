/**
 * `/belayd` argument parsing.
 *
 * Kept out of `extensions/index.ts` so the tokenizer's edge cases (quoted
 * handoff text, a flag-looking handoff value, a bare `--handoff`) are unit
 * testable without loading pi.
 *
 * Grammar: `/belayd <taskId> [type] [--no-worktree] [--handoff <text|@path>]`.
 * `--handoff` is terminal: everything after it is its value. That choice is
 * deliberate — the handoff is free text (a plan summary can be several words),
 * and consuming the remainder means a value that looks like a flag
 * (`--handoff --no-worktree`) is treated as text instead of silently enabling
 * `--no-worktree`. Quote multi-word text (`--handoff "Follow the plan"`) or
 * point at a file (`--handoff @plan.md`); both produce the same value.
 */

import { parseArgv } from "./argv.js";

export interface BelaydCommandArgs {
  taskId: string;
  noWorktree: boolean;
  typeArg: string | undefined;
  handoff: string | undefined;
  /** True when `--handoff` was given, even with no value (a usage error). */
  handoffFlagPresent: boolean;
}

export type BelaydCommandArgsParse =
  | { ok: true; args: BelaydCommandArgs }
  | { ok: false; error: string };

const BELAYD_HANDOFF_FLAG = "--handoff";
const BELAYD_HANDOFF_PREFIX = `${BELAYD_HANDOFF_FLAG}=`;
const BELAYD_NO_WORKTREE_FLAG = "--no-worktree";

function joinHandoff(value: string, rest: readonly string[]): string | undefined {
  const joined = [value, ...rest].join(" ").trim();
  return joined === "" ? undefined : joined;
}

export function parseBelaydCommandArgs(raw: string): BelaydCommandArgsParse {
  const parsed = parseArgv(raw);
  if (!parsed.ok) {
    const name = parsed.quote === "'" ? "single" : "double";
    return { ok: false, error: `Unterminated ${name} quote in /belayd arguments.` };
  }

  const parts = parsed.argv;
  const positional: string[] = [];
  let noWorktree = false;
  let handoff: string | undefined;
  let handoffFlagPresent = false;

  let index = 0;
  while (index < parts.length) {
    const part = parts[index];
    index += 1;
    if (part === undefined) continue;
    if (part === BELAYD_NO_WORKTREE_FLAG) {
      noWorktree = true;
      continue;
    }
    if (part === BELAYD_HANDOFF_FLAG) {
      handoffFlagPresent = true;
      handoff = joinHandoff("", parts.slice(index));
      index = parts.length;
      continue;
    }
    if (part.startsWith(BELAYD_HANDOFF_PREFIX)) {
      handoffFlagPresent = true;
      handoff = joinHandoff(part.slice(BELAYD_HANDOFF_PREFIX.length), parts.slice(index));
      index = parts.length;
      continue;
    }
    positional.push(part);
  }

  return {
    ok: true,
    args: {
      taskId: positional[0] ?? "",
      noWorktree,
      typeArg: positional[1],
      handoff,
      handoffFlagPresent,
    },
  };
}
