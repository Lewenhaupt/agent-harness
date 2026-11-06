/**
 * Extension-surface tests for the review-findings delivery (bd-175, bd-219).
 *
 * `deliverReviewFindings` is exercised directly against a stubbed `bd`, the way
 * the human-answer suite exercises `belayd_ask_human`. Ordinary findings are a
 * trace, not a question: the record is written and the findings are posted as an
 * authored comment, and no gate/wait/poll exists, so the orchestrator can run the
 * fix loop in the same turn — and no review ever opens a gate (bd-286). A clean
 * review stays on the fast path and writes nothing.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runBdCommand } from "../../extensions/capabilities/context.js";
import {
  deliverReviewFindings,
  type HumanGateDeps,
  humanAnswerGuidanceLines,
  nextStepBlockLines,
} from "../../extensions/capabilities/human-gate.js";
import {
  runCompleteLoopHint,
  tryDeliverReviewFindings,
  warnOnSkippedReviewFindings,
} from "../../extensions/capabilities/phase-run.js";
import {
  HUMAN_ESCALATION_LINES,
  reviewFindingsGuidanceLines,
} from "../../extensions/capabilities/review.js";
import { createInitialSessionState } from "../../extensions/capabilities/session-state.js";
import { lookupOpenHumanGate } from "../bead-gates.js";
import {
  REVIEW_FIX_LOOP_REASON,
  REVIEW_NO_FINDINGS_REASON,
  REVIEW_NO_SEAM_REASON,
  type ReviewFindingsRecord,
  readReviewFindingsRecord,
} from "../review-findings.js";
import { installTempRepoState } from "./helpers/repo-state.js";

// The disposition record is a store row now (bd-281); these tests run in temp
// directories, so they point the store at a fresh file per test.
installTempRepoState();

/** The persisted record for the test's task, or a loud failure. */
function recordFor(cwd: string, taskId = "bd-1"): ReviewFindingsRecord {
  const record = readReviewFindingsRecord({ cwd, taskId });
  if (record === undefined) throw new Error(`no review-findings record for ${taskId}`);
  return record;
}

import type { RunDelivery } from "../run-detached.js";

const ACTOR = "belayd:bd-1:orchestrator";

interface BdReply {
  stdout?: string;
  error?: string;
  /** The exit code on the exec error; 1 is betterleaks' "leaks found". */
  code?: number;
}

const bd = vi.hoisted(() => {
  const calls: Array<{ argv: readonly string[]; stdin: string }> = [];
  const replies = new Map<string, BdReply | undefined>();

  const keyOf = (argv: readonly string[]): string => {
    const kept: string[] = [];
    for (let i = 0; i < argv.length; i += 1) {
      if (argv[i] === "--actor") {
        i += 1;
        continue;
      }
      kept.push(argv[i] ?? "");
    }
    return kept.join(" ");
  };

  const execFile = vi.fn(
    (
      _file: string,
      args: readonly string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const record = { argv: [...args], stdin: "" };
      calls.push(record);
      const childStdin = {
        on: () => {},
        end: (chunk?: string) => {
          record.stdin = chunk ?? "";
          const reply = replies.get(keyOf(args)) ?? {};
          if (reply.error !== undefined) {
            const failure = Object.assign(new Error(reply.error), { code: reply.code });
            callback(failure, reply.stdout ?? "", "");
            return;
          }
          callback(null, reply.stdout ?? "", "");
        },
      };
      return { stdin: childStdin };
    },
  );

  return {
    keyOf,
    calls,
    execFile,
    reply: (key: string, value: BdReply | undefined) => replies.set(key, value),
    reset: () => {
      calls.length = 0;
      replies.clear();
    },
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (...args: unknown[]) =>
      (bd.execFile as unknown as (...rest: unknown[]) => unknown)(...args),
    exec: vi.fn((_command: string, _options: unknown, callback: unknown) => {
      (callback as (error: Error | null, stdout: string) => void)(null, "");
    }),
    execFileSync: vi.fn(() => ""),
    execSync: vi.fn(() => ""),
  };
});

const REVIEW_WITH_FINDINGS = [
  "## Critical (must fix)",
  "- `src/a.ts:12` — off-by-one in the loop bound",
  "",
  "## Warnings (should fix)",
  "None",
].join("\n");

const CLEAN_REVIEW = ["## Critical (must fix)", "None"].join("\n");

const COMMENT_KEY = "comment --stdin -- bd-1";

describe("deliverReviewFindings", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "belayd-review-gate-"));
    bd.reset();
    bd.reply(COMMENT_KEY, { stdout: "" });
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  function makeState() {
    const state = createInitialSessionState();
    state.gateActive = true;
    state.currentTaskId = "bd-1";
    return state;
  }

  function makeDeps(state: ReturnType<typeof makeState>): HumanGateDeps {
    return {
      getSessionState: () => state,
      resolveSessionBdActor: () => ACTOR,
      resolveGithubAnswerTarget: () => ({ kind: "local" }),
      sendUserMessage: () => {},
    };
  }

  const ctx = {
    cwd: "",
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionName: () => "belayd-bd-1",
      getSessionFile: () => "/tmp/belayd-bd-1.jsonl",
    },
    ui: { notify: () => {} },
  } as unknown as ExtensionContext;

  it("records ordinary findings and leaves the member working (bd-219)", async () => {
    const state = makeState();
    const deps = makeDeps(state);
    ctx.cwd = cwd;

    const outcome = await deliverReviewFindings({
      state,
      ctx,
      deps,
      taskId: "bd-1",
      reviewText: REVIEW_WITH_FINDINGS,
    });

    expect(outcome).toEqual({
      recorded: true,
      reason: REVIEW_FIX_LOOP_REASON,
    });
    // No gate, no wait, no poll: the orchestrator can start the fix loop now.
    expect(state.awaitingHuman).toBeUndefined();
    expect(state.humanAnswerTimer).toBeUndefined();
    expect(bd.calls.some((call) => bd.keyOf(call.argv).startsWith("gate create"))).toBe(false);

    // The trace still exists: an authored comment a human can read.
    const comment = bd.calls.find((call) => bd.keyOf(call.argv) === COMMENT_KEY);
    expect(comment?.stdin.startsWith("[belayd:review]\n")).toBe(true);
    expect(comment?.stdin).toContain("src/a.ts:12");
    expect(comment?.stdin).toContain("## Review findings (round 1)");
    expect(comment?.stdin).toContain("### Next step");
    expect(comment?.stdin).toContain("No human decision is required");
    expect(comment?.stdin).not.toContain("### Question");

    const record = recordFor(cwd);
    expect(record.round).toBe(1);
    expect(record.reason).toBe(REVIEW_FIX_LOOP_REASON);
    expect(record.findings).toHaveLength(1);
    expect(record.findings[0]).toHaveProperty("disposition", {
      kind: "deferred",
      reason: REVIEW_FIX_LOOP_REASON,
    });
  });

  it("leaves a Suggestions-only review ungated too", async () => {
    // Triage of a suggestion is the orchestrator's decision, not a human's
    // (bd-219): every one of the 12 gates the field data recorded was answered
    // "address/fix", so asking only cost the wait.
    const state = makeState();
    ctx.cwd = cwd;
    const outcome = await deliverReviewFindings({
      state,
      ctx,
      deps: makeDeps(state),
      taskId: "bd-1",
      reviewText: ["## Suggestions (consider)", "- `src/c.ts:3` — rename `x` to `count`"].join(
        "\n",
      ),
    });
    expect(outcome).toMatchObject({ recorded: true });
    expect(state.awaitingHuman).toBeUndefined();
    expect(bd.calls.some((call) => bd.keyOf(call.argv).startsWith("gate create"))).toBe(false);
    expect(recordFor(cwd).findings).toHaveLength(1);
  });

  it("leaves bd gate list empty after an ordinary findings review (acceptance)", async () => {
    const state = makeState();
    ctx.cwd = cwd;
    bd.reply("gate list bd-1 --json", { stdout: JSON.stringify([]) });
    await deliverReviewFindings({
      state,
      ctx,
      deps: makeDeps(state),
      taskId: "bd-1",
      reviewText: REVIEW_WITH_FINDINGS,
    });
    const gates = await lookupOpenHumanGate({
      beadId: "bd-1",
      cwd,
      runBd: (argv, options) => runBdCommand(argv, options),
    });
    expect(gates).toEqual({ ok: true, status: "none" });
  });

  it("stays on the fast path for a clean review and writes nothing to bd", async () => {
    const state = makeState();
    ctx.cwd = cwd;
    const outcome = await deliverReviewFindings({
      state,
      ctx,
      deps: makeDeps(state),
      taskId: "bd-1",
      reviewText: CLEAN_REVIEW,
    });
    expect(outcome).toEqual({
      recorded: false,
      reason: REVIEW_NO_FINDINGS_REASON,
    });
    expect(state.awaitingHuman).toBeUndefined();
    expect(bd.calls).toHaveLength(0);
    expect(readReviewFindingsRecord({ cwd, taskId: "bd-1" })).toBeUndefined();
  });

  it("records a review that arrives while a human answer is already pending", async () => {
    // An open ask-human wait must not be replaced or duplicated by a review, but
    // the review's own findings are still a trace the orchestrator will need.
    const state = makeState();
    ctx.cwd = cwd;
    const pending = { beadId: "bd-1", askedAt: 1_000 };
    state.awaitingHuman = pending;
    const outcome = await deliverReviewFindings({
      state,
      ctx,
      deps: makeDeps(state),
      taskId: "bd-1",
      reviewText: REVIEW_WITH_FINDINGS,
    });
    expect(outcome).toMatchObject({ recorded: true });
    expect(state.awaitingHuman).toEqual(pending);
    expect(bd.calls.some((call) => bd.keyOf(call.argv).startsWith("gate create"))).toBe(false);
    expect(bd.calls.some((call) => bd.keyOf(call.argv) === COMMENT_KEY)).toBe(true);
  });

  it("does not open a gate for a narration-only review", async () => {
    const state = makeState();
    ctx.cwd = cwd;
    const outcome = await deliverReviewFindings({
      state,
      ctx,
      deps: makeDeps(state),
      taskId: "bd-1",
      reviewText: [
        "## Critical (must fix)",
        "- verified `src/x.ts:10` handles null correctly",
      ].join("\n"),
    });
    expect(outcome).toEqual({
      recorded: false,
      reason: REVIEW_NO_FINDINGS_REASON,
    });
    expect(state.awaitingHuman).toBeUndefined();
    expect(bd.calls).toHaveLength(0);
  });

  it("rejects an invalid task id before any bd call", async () => {
    const state = makeState();
    ctx.cwd = cwd;
    const outcome = await deliverReviewFindings({
      state,
      ctx,
      deps: makeDeps(state),
      taskId: "not a bead id",
      reviewText: REVIEW_WITH_FINDINGS,
    });
    expect(outcome).toMatchObject({ recorded: false });
    expect(outcome.reason).toContain("invalid task id");
    expect(bd.calls).toHaveLength(0);
  });

  it("warns but still posts the comment when the record write fails", async () => {
    const state = makeState();
    ctx.cwd = cwd;
    // An unusable store path is the failure the seam can express now that the
    // record is a row: a regular file where the directory belongs, so the store
    // cannot be created. The comment is the human-visible trace and must survive it.
    writeFileSync(join(cwd, "blocked"), "not a directory");
    process.env.BELAYD_REPO_STATE_FILE = join(cwd, "blocked", "state.sqlite");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const outcome = await deliverReviewFindings({
        state,
        ctx,
        deps: makeDeps(state),
        taskId: "bd-1",
        reviewText: REVIEW_WITH_FINDINGS,
      });
      expect(outcome).toMatchObject({ recorded: false });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not record"));
      expect(bd.calls.some((call) => bd.keyOf(call.argv) === COMMENT_KEY)).toBe(true);
      expect(state.awaitingHuman).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  it("refuses to post a findings comment that the outbound scan flags (bd-286)", async () => {
    // The comment is outbound text: a credential in it would leave the machine on
    // a bead every fleet member and human reads. The scan refuses the post and
    // the delivery reports the refused comment; the record still lands, because a
    // failed post must not lose the fix loop.
    const state = makeState();
    ctx.cwd = cwd;
    bd.reply("stdin --redact --no-banner --exit-code 1 -f json -r -", {
      stdout: JSON.stringify([{ RuleID: "github-pat", Match: "REDACTED" }]),
      error: "Command failed: betterleaks stdin",
      code: 1,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const outcome = await deliverReviewFindings({
        state,
        ctx,
        deps: makeDeps(state),
        taskId: "bd-1",
        reviewText: REVIEW_WITH_FINDINGS,
      });
      expect(outcome).toMatchObject({ recorded: true });
      expect(bd.calls.some((call) => bd.keyOf(call.argv) === COMMENT_KEY)).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("refused to post"));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("github-pat"));
      expect(state.awaitingHuman).toBeUndefined();
      expect(recordFor(cwd).round).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("still posts when the outbound scanner is unavailable (bd-286)", async () => {
    // A missing binary is a config gap, not a hit: it must never wedge every
    // workflow. The hard enforcement is the repo gate and the pre-push hook.
    const state = makeState();
    ctx.cwd = cwd;
    bd.reply("stdin --redact --no-banner --exit-code 1 -f json -r -", {
      error: "spawn betterleaks ENOENT",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const outcome = await deliverReviewFindings({
        state,
        ctx,
        deps: makeDeps(state),
        taskId: "bd-1",
        reviewText: REVIEW_WITH_FINDINGS,
      });
      expect(outcome).toMatchObject({ recorded: true });
      expect(bd.calls.some((call) => bd.keyOf(call.argv) === COMMENT_KEY)).toBe(true);

      // Once per session, not once per post: a second delivery reuses the same
      // budget, so the daemon log keeps one line naming the missing binary.
      await deliverReviewFindings({
        state,
        ctx,
        deps: makeDeps(state),
        taskId: "bd-1",
        reviewText: REVIEW_WITH_FINDINGS,
      });
      expect(
        warn.mock.calls.filter(([message]) => String(message).includes("outbound secret scan")),
      ).toHaveLength(1);
      // A fresh session gets its own budget (e.g. after a rebuild).
      await deliverReviewFindings({
        state: makeState(),
        ctx,
        deps: makeDeps(makeState()),
        taskId: "bd-1",
        reviewText: REVIEW_WITH_FINDINGS,
      });
      expect(
        warn.mock.calls.filter(([message]) => String(message).includes("outbound secret scan")),
      ).toHaveLength(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("records an increasing round across re-reviews without a gate", async () => {
    const state = makeState();
    ctx.cwd = cwd;
    const first = await deliverReviewFindings({
      state,
      ctx,
      deps: makeDeps(state),
      taskId: "bd-1",
      reviewText: REVIEW_WITH_FINDINGS,
    });
    expect(first).toMatchObject({ recorded: true });
    const second = await deliverReviewFindings({
      state,
      ctx,
      deps: makeDeps(state),
      taskId: "bd-1",
      reviewText: REVIEW_WITH_FINDINGS,
    });
    expect(second).toMatchObject({ recorded: true });
    const record = recordFor(cwd);
    expect(record.round).toBe(2);
    expect(record.findings.every((finding: { round: number }) => finding.round === 2)).toBe(true);
    // Two rounds of trace, zero gates: the round counter is not tied to a wait.
    expect(bd.calls.some((call) => bd.keyOf(call.argv).startsWith("gate create"))).toBe(false);
    expect(bd.calls.filter((call) => bd.keyOf(call.argv) === COMMENT_KEY)).toHaveLength(2);
  });
});

describe("runCompleteLoopHint", () => {
  const delivered: RunDelivery = {
    runId: "run-1",
    phaseName: "review",
    success: true,
    result: {
      content: [
        {
          type: "text",
          text: "## Critical (must fix)\n- `src/a.ts:12` — off-by-one in the loop bound",
        },
      ],
      details: {
        messages: [],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          turns: 1,
          toolCalls: 1,
        },
        exitCode: 0,
      },
      sessionName: "belayd-bd-1-sub-review-run-1",
    },
  };
  const makeState = () => {
    const state = createInitialSessionState();
    state.gateActive = true;
    state.currentTaskId = "bd-1";
    state.completedPhaseNames = ["implement", "review"];
    return state;
  };

  it("always emits the resumable-fix directive when no human wait is live", () => {
    // bd-219: a findings review no longer gates, so withholding the directive
    // only teaches the orchestrator that it cannot act. The next incomplete phase
    // after review is named, not review's successor literal.
    const hint = runCompleteLoopHint({ delivered, state: makeState() });
    expect(hint).toContain("**When review findings remain:**");
    expect(hint).toContain("belayd_test");
  });

  it("emits the directive for a clean review too", () => {
    const cleanDelivered: RunDelivery = {
      ...delivered,
      result: {
        ...delivered.result,
        content: [{ type: "text", text: CLEAN_REVIEW }],
      },
    };
    expect(runCompleteLoopHint({ delivered: cleanDelivered, state: makeState() })).toContain(
      "**When review findings remain:**",
    );
  });

  it("withholds the directive while a blocking human wait is live", () => {
    // A member blocked by `belayd_ask_human` cannot call the next phase tool, so
    // the run-complete content must not offer it. A gate is not a function of the
    // review text.
    const state = makeState();
    state.awaitingHuman = { beadId: "bd-1", askedAt: 1_000 };
    expect(runCompleteLoopHint({ delivered, state })).toBe("");
  });
});

describe("blocking human wait guidance (bd-152)", () => {
  const makeState = () => {
    const state = createInitialSessionState();
    state.gateActive = true;
    state.currentTaskId = "bd-1";
    return state;
  };

  it("blocks the next step and says why for an ask wait", () => {
    const state = makeState();
    state.awaitingHuman = { beadId: "bd-1", askedAt: 1_000 };
    expect(nextStepBlockLines(state, "**Next:** belayd_implement")).toEqual([]);
    const guidance = humanAnswerGuidanceLines(state).join("\n");
    expect(guidance).toContain("phase tools are refused until the answer arrives");
  });
});

describe("tryDeliverReviewFindings", () => {
  it("returns the seam's verdict and swallows a throwing seam", async () => {
    const state = createInitialSessionState();
    const ctx = { cwd: "", sessionManager: {} } as unknown as ExtensionContext;
    expect(
      await tryDeliverReviewFindings({
        deliver: async () => ({ recorded: true, reason: "ok" }),
        state,
        ctx,
        taskId: "bd-1",
        reviewText: "x",
      }),
    ).toEqual({ recorded: true, reason: "ok" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(
        await tryDeliverReviewFindings({
          deliver: async () => {
            throw new Error("bd exploded");
          },
          state,
          ctx,
          taskId: "bd-1",
          reviewText: "x",
        }),
      ).toEqual({ recorded: false, reason: "bd exploded" });
      expect(warn).toHaveBeenCalledWith(
        "[belayd-harness] could not record the review findings",
        expect.any(Error),
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe("warnOnSkippedReviewFindings", () => {
  it("logs a skipped record and stays silent for every expected outcome (bd-219 review)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      warnOnSkippedReviewFindings({
        recorded: false,
        reason: 'invalid task id "not a bead id"',
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("not fully delivered"));

      // Every other outcome is expected: the clean review, a host without the
      // seam, and an ordinary fix-loop delivery.
      warn.mockClear();
      const expected = [
        { recorded: false, reason: REVIEW_NO_FINDINGS_REASON },
        { recorded: false, reason: REVIEW_NO_SEAM_REASON },
        { recorded: true, reason: REVIEW_FIX_LOOP_REASON },
      ];
      for (const delivery of expected) warnOnSkippedReviewFindings(delivery);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("surfaces a throwing seam's reason without throwing and keeps the delivery result", async () => {
    const state = createInitialSessionState();
    const ctx = { cwd: "", sessionManager: {} } as unknown as ExtensionContext;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const delivery = await tryDeliverReviewFindings({
        deliver: async () => {
          throw new Error("bd exploded");
        },
        state,
        ctx,
        taskId: "bd-1",
        reviewText: "x",
      });
      expect(delivery).toEqual({ recorded: false, reason: "bd exploded" });
      expect(() => warnOnSkippedReviewFindings(delivery)).not.toThrow();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("bd exploded"));
    } finally {
      warn.mockRestore();
    }
  });
});

describe("human escalation policy (bd-219)", () => {
  const CONDITIONS = [
    "Critical finding you believe must NOT be implemented",
    "contradiction you cannot resolve from the bead and the repo",
    "Never escalate for what you can decide",
    "Suggestions triage",
    // The do-not-ask list is what stops a suggestion or a fix choice becoming a
    // gate; a list that silently shrinks to one item would read as permission.
    "findings you can fix",
    "which fix to do",
    "how to proceed",
    "grooming/merge/close choices",
  ];

  it("names only the two escalation conditions and the do-not-ask list, in both blocks", () => {
    // Both guidance sites must state the same two conditions; a model that read
    // "ask whenever you feel blocked" in one of them kept gating every review.
    const blocks = {
      review: reviewFindingsGuidanceLines("belayd_test").join("\n"),
      human: humanAnswerGuidanceLines(createInitialSessionState()).join("\n"),
    };
    for (const [name, text] of Object.entries(blocks)) {
      for (const needle of CONDITIONS) {
        expect(text, `${name} guidance should name "${needle}"`).toContain(needle);
      }
      // The list must be exhaustive, not open-ended.
      expect(text).toContain("Two conditions, nothing else");
      for (const coercion of [
        "Never guess and never proceed",
        "Always ask",
        "always ask",
        "ask whenever",
      ]) {
        expect(text, `${name} guidance should not coerce: "${coercion}"`).not.toContain(coercion);
      }
      // Both sites emit the shared policy verbatim, so they cannot drift.
      for (const line of HUMAN_ESCALATION_LINES) expect(text).toContain(line);
    }
    // Exactly two conditions: a third bullet silently widens the escalation rule.
    expect(HUMAN_ESCALATION_LINES.filter((line) => line.startsWith("- "))).toHaveLength(2);
  });
});
