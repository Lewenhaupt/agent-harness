/**
 * Append-only bd policy for phase agents in a GitHub-primary repo (bd-180).
 *
 * When GitHub Issues is authoritative, a phase sub-agent must not write the
 * work graph: no status, assignee, priority, blocked-by edge, or closure. Those
 * belong to GitHub, and a local mutation would either be overwritten by the next
 * projection or silently diverge from it. What a phase agent *may* do is append:
 * comments, notes, and artifacts (including new local beads for follow-up work).
 *
 * This is a pure classification over argv. `authority:"bd"` never refuses — local
 * mode keeps exactly today's behaviour — and the human-facing orchestrator is not
 * subject to the policy at all. The caller decides *who* is a phase agent; this
 * module only decides *what* an argv does.
 */

import type { BdFlagForm } from "./bd-command.js";
import {
  BD_ASSIGNEE_FLAG,
  BD_DEFER_FLAG,
  BD_OWNER_FLAG,
  BD_PARENT_FLAG,
  BD_PRIORITY_FLAG,
  BD_REMOVE_LABEL_FLAG,
  BD_SET_LABELS_FLAG,
  BD_STATUS_FLAG,
  bdArgvHasFlag,
  isBdReadArgv,
} from "./bd-command.js";
import type { GithubAuthority } from "./github-authority.js";

/** Why a write is refused in a GitHub-primary repo. */
export type BdWriteRefusalReason =
  | "status"
  | "assignee"
  | "priority"
  | "dependency"
  | "close"
  | "reopen"
  | "label"
  | "unclassified-write";

/** The policy verdict for one argv. */
export type BdWriteVerdict =
  | { verdict: "append-only-allowed"; mode: "read" | "append" }
  | { verdict: "refused"; reason: BdWriteRefusalReason; message: string };

/** Append-only bd verbs: they add a record but never rewrite the work graph. */
const APPEND_SUBCOMMANDS: readonly string[] = ["comment", "create", "note", "remember", "tag"];

/** First positional token after the subcommand, skipping flags and `--actor`'s value. */
function childArgv(argv: readonly string[]): string {
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (token === "--actor") {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) continue;
    return token;
  }
  return "";
}

function refuse(reason: BdWriteRefusalReason, message: string): BdWriteVerdict {
  return { verdict: "refused", reason, message };
}

/** One update flag that rewrites graph state, with the authority GitHub owns. */
interface UpdateGraphFlagRule {
  form: BdFlagForm;
  reason: BdWriteRefusalReason;
  message: string;
}

/**
 * The update flags a phase agent must not use, in one table.
 *
 * The spellings live in `bd-command.ts` so option validation and this policy
 * cannot drift: a new shorthand or attached form is added once and both layers
 * see it. Label mutations are included because `update --set-labels` can strip
 * or replace the whole label set without going through `bd label`.
 */
const UPDATE_GRAPH_FLAGS: readonly UpdateGraphFlagRule[] = [
  {
    form: BD_STATUS_FLAG,
    reason: "status",
    message: "GitHub owns status; a phase agent must not change it",
  },
  {
    form: BD_ASSIGNEE_FLAG,
    reason: "assignee",
    message: "GitHub owns assignment; a phase agent must not change it",
  },
  {
    form: BD_OWNER_FLAG,
    reason: "assignee",
    message: "GitHub owns assignment; a phase agent must not change it",
  },
  {
    form: BD_PRIORITY_FLAG,
    reason: "priority",
    message: "GitHub owns priority; a phase agent must not change it",
  },
  {
    form: BD_PARENT_FLAG,
    reason: "dependency",
    message: "GitHub owns the dependency graph; a phase agent must not change it",
  },
  {
    form: BD_DEFER_FLAG,
    reason: "status",
    message: "GitHub owns status; a phase agent must not defer it locally",
  },
  {
    form: BD_REMOVE_LABEL_FLAG,
    reason: "label",
    message: "removing a label rewrites shared state; append instead",
  },
  {
    form: BD_SET_LABELS_FLAG,
    reason: "label",
    message: "replacing the label set rewrites shared state; append instead",
  },
];

function classifyUpdate(argv: readonly string[]): BdWriteVerdict {
  for (const rule of UPDATE_GRAPH_FLAGS) {
    if (bdArgvHasFlag(argv, rule.form)) return refuse(rule.reason, rule.message);
  }
  if (argv.includes("parent-child")) {
    return refuse(
      "dependency",
      "GitHub owns the dependency graph; a phase agent must not change it",
    );
  }
  return { verdict: "append-only-allowed", mode: "append" };
}

function classifyDep(argv: readonly string[]): BdWriteVerdict {
  const child = childArgv(argv);
  if (child === "list" || child === "tree" || child === "cycles") {
    return { verdict: "append-only-allowed", mode: "read" };
  }
  return refuse("dependency", "GitHub owns blocked-by edges; a phase agent must not change them");
}

/** `bd label` children that only read labels. */
const LABEL_READ_SUBCOMMANDS: readonly string[] = ["list", "list-all"];
/** `bd label` children that append a label without rewriting an existing one. */
const LABEL_APPEND_SUBCOMMANDS: readonly string[] = ["add"];

function classifyLabel(argv: readonly string[]): BdWriteVerdict {
  const child = childArgv(argv);
  if (LABEL_READ_SUBCOMMANDS.includes(child)) {
    return { verdict: "append-only-allowed", mode: "read" };
  }
  if (LABEL_APPEND_SUBCOMMANDS.includes(child)) {
    return { verdict: "append-only-allowed", mode: "append" };
  }
  return refuse(
    "label",
    `bd label ${child === "" ? "(write)" : child} rewrites shared label state; append instead`,
  );
}

/**
 * Classify one bd argv under the GitHub-primary append-only policy.
 *
 * Reads are always allowed. The refused writes name the exact authority GitHub
 * owns, so the phase agent gets an actionable reason rather than a generic "not
 * allowed". Anything unrecognised is refused rather than assumed safe.
 */
export function classifyBdWrite(argv: readonly string[]): BdWriteVerdict {
  if (isBdReadArgv(argv)) return { verdict: "append-only-allowed", mode: "read" };

  const subcommand = argv[0] ?? "";
  if (APPEND_SUBCOMMANDS.includes(subcommand)) {
    return { verdict: "append-only-allowed", mode: "append" };
  }
  switch (subcommand) {
    case "update":
      return classifyUpdate(argv);
    case "assign":
      return refuse("assignee", "GitHub owns assignment; a phase agent must not change it");
    case "priority":
      return refuse("priority", "GitHub owns priority; a phase agent must not change it");
    case "dep":
      return classifyDep(argv);
    case "link":
      return refuse(
        "dependency",
        "GitHub owns the dependency graph; a phase agent must not change it",
      );
    case "label":
      return classifyLabel(argv);
    case "close":
      return refuse("close", "GitHub owns closure; merge closes the bead, a phase agent must not");
    case "reopen":
      return refuse("reopen", "GitHub owns lifecycle; a phase agent must not reopen work");
    case "set-state":
    case "defer":
    case "undefer":
      return refuse("status", "GitHub owns status; a phase agent must not change it");
    case "heartbeat":
      return { verdict: "append-only-allowed", mode: "append" };
    default:
      return refuse(
        "unclassified-write",
        `bd "${subcommand}" is not an append-only operation; a phase agent must not run it`,
      );
  }
}

/**
 * Authority-aware verdict: `bd` mode allows everything (today's behaviour), and
 * only a GitHub-primary repo applies the append-only policy.
 */
export function classifyBdWriteForAuthority(input: {
  argv: readonly string[];
  authority: GithubAuthority;
}): BdWriteVerdict {
  if (input.authority === "bd") {
    return isBdReadArgv(input.argv)
      ? { verdict: "append-only-allowed", mode: "read" }
      : { verdict: "append-only-allowed", mode: "append" };
  }
  return classifyBdWrite(input.argv);
}
