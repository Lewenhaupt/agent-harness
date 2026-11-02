/**
 * Extension-surface tests for the review human gate (bd-175).
 *
 * `openReviewHumanGate` is exercised directly against a stubbed `bd`, the way
 * the human-answer suite exercises `belayd_ask_human`: it must post the findings
 * as an authored comment, open a `human` gate carrying the shared reason, write
 * the durable disposition record, and arm the answer poll so resolving the gate
 * resumes the member. A clean review stays on the fast path and writes nothing.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type HumanGateDeps,
  humanAnswerMessage,
  openReviewHumanGate,
  stopHumanAnswerPoll,
} from "../../extensions/capabilities/human-gate.js";
import { runCompleteLoopHint, tryOpenReviewGate } from "../../extensions/capabilities/phase-run.js";
import { createInitialSessionState } from "../../extensions/capabilities/session-state.js";
import {
  evaluateDeferredFindingsGate,
  renderDeferredFindingsSection,
} from "../finding-publication.js";
import type { FindingSensitivity } from "../finding-sensitivity.js";
import type { GithubAnswerTarget } from "../github-answer-target.js";
import {
  buildReviewFindingsRecord,
  carryForwardSensitivity,
  REVIEW_FINDINGS_ARTIFACT_RELATIVE_PATH,
  REVIEW_HUMAN_GATE_REASON,
  type ReviewFindingsRecord,
  reviewFindingsGateReason,
  reviewFindingsGateTitle,
  reviewFindingsRecordPath,
} from "../review-findings.js";
import type { RunDelivery } from "../run-detached.js";

const ACTOR = "belayd:bd-1:orchestrator";

interface BdReply {
  stdout?: string;
  error?: string;
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
            callback(new Error(reply.error), "", "");
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

const GATE_CREATE_KEY =
  `gate create --blocks bd-1 --type=human ` +
  `--title belayd-review: bd-1 findings (round 1) ` +
  `--reason ${REVIEW_HUMAN_GATE_REASON} --json`;
const COMMENT_KEY = "comment --stdin -- bd-1";

describe("openReviewHumanGate", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "belayd-review-gate-"));
    bd.reset();
    bd.reply(GATE_CREATE_KEY, { stdout: JSON.stringify({ id: "bd-160", status: "open" }) });
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

  it("opens the gate, posts the findings, writes the record, and blocks", async () => {
    const state = makeState();
    const deps = makeDeps(state);
    ctx.cwd = cwd;

    const outcome = await openReviewHumanGate({
      state,
      ctx,
      deps,
      taskId: "bd-1",
      reviewText: REVIEW_WITH_FINDINGS,
    });

    expect(outcome).toEqual({ opened: true, reason: REVIEW_HUMAN_GATE_REASON });
    expect(state.awaitingHuman).toMatchObject({ beadId: "bd-1", gateId: "bd-160" });
    // The answer poll is armed, so resolving the gate resumes the member.
    expect(state.humanAnswerTimer).toBeDefined();

    const gateCall = bd.calls.find((call) => bd.keyOf(call.argv).startsWith("gate create"));
    expect(gateCall?.argv).toContain("--actor");
    expect(gateCall?.argv).toContain(ACTOR);
    expect(gateCall?.argv).toContain(REVIEW_HUMAN_GATE_REASON);

    const comment = bd.calls.find((call) => bd.keyOf(call.argv) === COMMENT_KEY);
    expect(comment?.stdin.startsWith("[belayd:review]\n")).toBe(true);
    expect(comment?.stdin).toContain("src/a.ts:12");

    const record = JSON.parse(readFileSync(reviewFindingsRecordPath(cwd), "utf8"));
    expect(record.findings).toHaveLength(1);
    expect(record.reason).toBe(REVIEW_HUMAN_GATE_REASON);

    stopHumanAnswerPoll(state);
  });

  it("stays on the fast path for a clean review and writes nothing to bd", async () => {
    const state = makeState();
    ctx.cwd = cwd;
    const outcome = await openReviewHumanGate({
      state,
      ctx,
      deps: makeDeps(state),
      taskId: "bd-1",
      reviewText: CLEAN_REVIEW,
    });
    expect(outcome).toEqual({ opened: false, reason: "the review reported no findings" });
    expect(state.awaitingHuman).toBeUndefined();
    expect(bd.calls).toHaveLength(0);
  });

  it("opens no second gate for a review while a human answer is already pending", async () => {
    const state = makeState();
    ctx.cwd = cwd;
    state.awaitingHuman = { beadId: "bd-1", askedAt: 1_000 };
    const outcome = await openReviewHumanGate({
      state,
      ctx,
      deps: makeDeps(state),
      taskId: "bd-1",
      reviewText: REVIEW_WITH_FINDINGS,
    });
    expect(outcome.opened).toBe(false);
    expect(bd.calls).toHaveLength(0);
  });

  it("does not block the member when the gate could not be created", async () => {
    const state = makeState();
    ctx.cwd = cwd;
    bd.reply(GATE_CREATE_KEY, { error: "bd: command not found" });
    const outcome = await openReviewHumanGate({
      state,
      ctx,
      deps: makeDeps(state),
      taskId: "bd-1",
      reviewText: REVIEW_WITH_FINDINGS,
    });
    expect(outcome.opened).toBe(false);
    expect(outcome.reason).toContain("could not open a human gate");
    expect(state.awaitingHuman).toBeUndefined();
  });

  it("keeps the gate and the wait when only the comment write fails", async () => {
    const state = makeState();
    ctx.cwd = cwd;
    bd.reply(COMMENT_KEY, { error: "bd: comment write failed" });
    const outcome = await openReviewHumanGate({
      state,
      ctx,
      deps: makeDeps(state),
      taskId: "bd-1",
      reviewText: REVIEW_WITH_FINDINGS,
    });
    // The gate's reason is itself the visible wait, so a failed comment must not
    // silently unblock a member the human can still see stopped in bd.
    expect(outcome.opened).toBe(true);
    expect(state.awaitingHuman).toBeDefined();
    stopHumanAnswerPoll(state);
  });

  it("does not open a gate for a narration-only review", async () => {
    const state = makeState();
    ctx.cwd = cwd;
    const outcome = await openReviewHumanGate({
      state,
      ctx,
      deps: makeDeps(state),
      taskId: "bd-1",
      reviewText: [
        "## Critical (must fix)",
        "- verified `src/x.ts:10` handles null correctly",
      ].join("\n"),
    });
    expect(outcome).toEqual({ opened: false, reason: "the review reported no findings" });
    expect(state.awaitingHuman).toBeUndefined();
    expect(bd.calls).toHaveLength(0);
  });

  it("rejects an invalid task id before any bd call", async () => {
    const state = makeState();
    ctx.cwd = cwd;
    const outcome = await openReviewHumanGate({
      state,
      ctx,
      deps: makeDeps(state),
      taskId: "not a bead id",
      reviewText: REVIEW_WITH_FINDINGS,
    });
    expect(outcome.opened).toBe(false);
    expect(outcome.reason).toContain("invalid task id");
    expect(bd.calls).toHaveLength(0);
  });

  it("warns but still opens the gate when the record write fails", async () => {
    const state = makeState();
    ctx.cwd = cwd;
    // A directory where the record file belongs makes the temp-rename fail; the
    // gate and comment are the human-visible record and must survive it.
    mkdirSync(reviewFindingsRecordPath(cwd), { recursive: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const outcome = await openReviewHumanGate({
        state,
        ctx,
        deps: makeDeps(state),
        taskId: "bd-1",
        reviewText: REVIEW_WITH_FINDINGS,
      });
      expect(outcome.opened).toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not record"));
      expect(state.awaitingHuman).toBeDefined();
    } finally {
      warn.mockRestore();
      stopHumanAnswerPoll(state);
    }
  });

  it("opens exactly one gate when two review deliveries settle concurrently", async () => {
    const state = makeState();
    ctx.cwd = cwd;
    // Both calls start before either awaits: the synchronous reservation must make
    // the second bail, or it opens a duplicate gate nobody's poll watches.
    const first = openReviewHumanGate({
      state,
      ctx,
      deps: makeDeps(state),
      taskId: "bd-1",
      reviewText: REVIEW_WITH_FINDINGS,
    });
    // The reservation is a pending marker, never `awaitingHuman`: the gate does
    // not exist yet, so the answer poll must not read an empty list as resolved.
    expect(state.awaitingHuman).toBeUndefined();
    expect(state.reviewGatePending).toBe(true);
    const second = openReviewHumanGate({
      state,
      ctx,
      deps: makeDeps(state),
      taskId: "bd-1",
      reviewText: REVIEW_WITH_FINDINGS,
    });
    const [a, b] = await Promise.all([first, second]);
    expect(a.opened).toBe(true);
    expect(b.opened).toBe(false);
    expect(state.reviewGatePending).toBeUndefined();
    expect(bd.calls.filter((call) => bd.keyOf(call.argv).startsWith("gate create"))).toHaveLength(
      1,
    );
    stopHumanAnswerPoll(state);
  });

  it("clears the pending marker in finally and never touches awaitingHuman", async () => {
    const state = makeState();
    ctx.cwd = cwd;
    // The throw lands after the gate exists: arming the answer poll is the last
    // step in the gated section. The failed call must leave the reservation
    // cleared and the real wait set -- a `finally` that also cleared
    // `awaitingHuman` would silently unblock a member whose gate bd shows open.
    const throwingCtx = {
      ...ctx,
      sessionManager: {
        getSessionName: () => {
          throw new Error("session manager exploded");
        },
      },
    } as unknown as ExtensionContext;
    await expect(
      openReviewHumanGate({
        state,
        ctx: throwingCtx,
        deps: makeDeps(state),
        taskId: "bd-1",
        reviewText: REVIEW_WITH_FINDINGS,
      }),
    ).rejects.toThrow("session manager exploded");
    expect(state.reviewGatePending).toBeUndefined();
    expect(state.awaitingHuman).toMatchObject({ beadId: "bd-1", gateId: "bd-160" });
    // The poll never armed, because the call that arms it is the one that threw.
    expect(state.humanAnswerTimer).toBeUndefined();
    stopHumanAnswerPoll(state);
  });

  it("records an increasing round across re-reviews", async () => {
    const state = makeState();
    ctx.cwd = cwd;
    const first = await openReviewHumanGate({
      state,
      ctx,
      deps: makeDeps(state),
      taskId: "bd-1",
      reviewText: REVIEW_WITH_FINDINGS,
    });
    expect(first.opened).toBe(true);
    stopHumanAnswerPoll(state);
    // The human answered: clear the wait, then a re-review opens round 2.
    state.awaitingHuman = undefined;
    const second = await openReviewHumanGate({
      state,
      ctx,
      deps: makeDeps(state),
      taskId: "bd-1",
      reviewText: REVIEW_WITH_FINDINGS,
    });
    expect(second.opened).toBe(true);
    const record = JSON.parse(readFileSync(reviewFindingsRecordPath(cwd), "utf8"));
    expect(record.round).toBe(2);
    expect(record.findings.every((finding: { round: number }) => finding.round === 2)).toBe(true);
    const titles = bd.calls
      .filter((call) => bd.keyOf(call.argv).startsWith("gate create"))
      .map((call) => call.argv.join(" "));
    expect(titles.some((title) => title.includes("round 2"))).toBe(true);
    stopHumanAnswerPoll(state);
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

  it("withholds the resumable-fix hint when the review gate opened", () => {
    // A member blocked by the gate cannot call the next phase tool, so the
    // run-complete content must not offer it (bd-175 review).
    expect(runCompleteLoopHint({ delivered, state: makeState(), reviewGateOpened: true })).toBe("");
  });

  it("keeps the resumable-fix hint for a clean review or an absent gate seam", () => {
    // Both reach the delivery as `reviewGateOpened: false`: a clean review wrote
    // nothing, and a host with no seam never called the opener. The hint names the
    // next incomplete phase after review, not review's successor literal.
    const hint = runCompleteLoopHint({ delivered, state: makeState(), reviewGateOpened: false });
    expect(hint).toContain("**When review findings remain:**");
    expect(hint).toContain("belayd_test");
  });
});

describe("tryOpenReviewGate", () => {
  it("returns the opener's verdict and swallows a throwing opener", async () => {
    const state = createInitialSessionState();
    const ctx = { cwd: "", sessionManager: {} } as unknown as ExtensionContext;
    expect(
      await tryOpenReviewGate({
        open: async () => ({ opened: true, reason: "ok" }),
        state,
        ctx,
        taskId: "bd-1",
        reviewText: "x",
      }),
    ).toBe(true);
    expect(
      await tryOpenReviewGate({
        open: async () => ({ opened: false, reason: "no" }),
        state,
        ctx,
        taskId: "bd-1",
        reviewText: "x",
      }),
    ).toBe(false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(
        await tryOpenReviewGate({
          open: async () => {
            throw new Error("bd exploded");
          },
          state,
          ctx,
          taskId: "bd-1",
          reviewText: "x",
        }),
      ).toBe(false);
      expect(warn).toHaveBeenCalledWith(
        "[belayd-harness] could not open the review human gate",
        expect.any(Error),
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe("sensitive review findings (bd-183)", () => {
  let cwd: string;

  const SENSITIVE_REVIEW = [
    "## Critical (must fix)",
    "- `src/auth/session.ts:42` — the session token is logged in plaintext",
  ].join("\n");

  /** A review the current rule table calls clean — the "weakened table" case. */
  const PLAIN_REVIEW = [
    "## Critical (must fix)",
    "- `src/a.ts:12` — off-by-one in the loop bound",
  ].join("\n");

  /** The gate argv this review must produce, built from the same pure helpers. */
  function sensitiveGateKey(options?: {
    round?: number;
    previousDecisionsReset?: boolean;
  }): string {
    const record = buildReviewFindingsRecord({
      taskId: "bd-1",
      text: SENSITIVE_REVIEW,
      round: options?.round ?? 1,
    });
    if (record === undefined) throw new Error("expected a record");
    const previousDecisionsReset = options?.previousDecisionsReset === true;
    const title = reviewFindingsGateTitle({
      taskId: "bd-1",
      round: record.round,
      sensitive: true,
      previousDecisionsReset,
    });
    const reason = reviewFindingsGateReason(record, { previousDecisionsReset });
    return `gate create --blocks bd-1 --type=human --title ${title} --reason ${reason} --json`;
  }

  /** bd's reply for an open human gate, created at `createdAt`. */
  function openGate(createdAt: string, id = "bd-160"): string {
    return JSON.stringify([
      { id, status: "open", issue_type: "gate", await_type: "human", created_at: createdAt },
    ]);
  }

  /** bd's reply for one bead comment thread: the review comment plus a human answer. */
  function answerThread(createdAt: string, text: string): string {
    return JSON.stringify([
      {
        id: "c-1",
        issue_id: "bd-1",
        author: ACTOR,
        created_at: "2026-10-26T20:00:01Z",
        text: "review findings",
      },
      { id: "c-2", issue_id: "bd-1", author: "hugo", created_at: createdAt, text },
    ]);
  }

  /** The record as bd-183 persisted it (a missing file is a test failure). */
  function readRecord(): ReviewFindingsRecord {
    const parsed: ReviewFindingsRecord = JSON.parse(
      readFileSync(reviewFindingsRecordPath(cwd), "utf8"),
    );
    return parsed;
  }

  /** Answer the open review wait as `hugo` and return the delivered message. */
  async function deliverAnswer(deps: HumanGateDeps, text: string): Promise<string | undefined> {
    bd.reply("gate list bd-1 --json", { stdout: openGate("2026-10-26T20:00:00Z") });
    bd.reply("comments bd-1 --json", { stdout: answerThread("2026-10-26T20:05:00Z", text) });
    bd.reply("gate resolve bd-160", { stdout: "resolved" });
    const delivered = await humanAnswerMessage(ctx, deps);
    return delivered?.message.content;
  }

  function makeState() {
    const state = createInitialSessionState();
    state.gateActive = true;
    state.currentTaskId = "bd-1";
    return state;
  }

  function makeDeps(
    state: ReturnType<typeof makeState>,
    answerTarget: GithubAnswerTarget = { kind: "local" },
  ): HumanGateDeps {
    return {
      getSessionState: () => state,
      resolveSessionBdActor: () => ACTOR,
      resolveGithubAnswerTarget: () => answerTarget,
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

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "belayd-review-gate-sensitive-"));
    bd.reset();
    bd.reply(sensitiveGateKey(), {
      stdout: JSON.stringify({ id: "bd-160", status: "open" }),
    });
    bd.reply(COMMENT_KEY, { stdout: "" });
    ctx.cwd = cwd;
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("opens one gate with the disclosure wording and blocks publishing", async () => {
    const state = makeState();
    const outcome = await openReviewHumanGate({
      state,
      ctx,
      deps: makeDeps(state),
      taskId: "bd-1",
      reviewText: SENSITIVE_REVIEW,
    });
    try {
      expect(outcome.opened).toBe(true);
      const gateCall = bd.calls.find((call) => bd.keyOf(call.argv).startsWith("gate create"));
      expect(gateCall?.argv.join(" ")).toContain("sensitive findings (round 1)");
      expect(gateCall?.argv.join(" ")).toContain("publication decision");
      // The shared wait reason is still the prefix, so the fleet detail survives.
      expect(gateCall?.argv.some((arg) => arg.startsWith(REVIEW_HUMAN_GATE_REASON))).toBe(true);

      // The comment names the three options; the record blocks publishing.
      const comment = bd.calls.find((call) => bd.keyOf(call.argv) === COMMENT_KEY);
      expect(comment?.stdin).toContain("publish a redacted one-liner");
      const record = JSON.parse(readFileSync(reviewFindingsRecordPath(cwd), "utf8"));
      expect(record.findings[0].sensitivity.sensitive).toBe(true);
      expect(record.findings[0].publication).toBeUndefined();
      expect(evaluateDeferredFindingsGate(record)).toMatchObject({
        ok: false,
        reason: "sensitive-findings-awaiting-human",
      });
    } finally {
      stopHumanAnswerPoll(state);
    }
  });

  it("records the human's publication choice when the answer is delivered", async () => {
    const state = makeState();
    const deps = makeDeps(state);
    const opened = await openReviewHumanGate({
      state,
      ctx,
      deps,
      taskId: "bd-1",
      reviewText: SENSITIVE_REVIEW,
    });
    expect(opened.opened).toBe(true);
    try {
      bd.reply("gate list bd-1 --json", {
        stdout: JSON.stringify([
          {
            id: "bd-160",
            status: "open",
            issue_type: "gate",
            await_type: "human",
            created_at: "2026-10-26T20:00:00Z",
          },
        ]),
      });
      bd.reply("comments bd-1 --json", {
        stdout: JSON.stringify([
          {
            id: "c-1",
            issue_id: "bd-1",
            author: ACTOR,
            created_at: "2026-10-26T20:00:01Z",
            text: "review findings",
          },
          {
            id: "c-2",
            issue_id: "bd-1",
            author: "hugo",
            created_at: "2026-10-26T20:05:00Z",
            text: "publish as-is",
          },
        ]),
      });
      bd.reply("gate resolve bd-160", { stdout: "resolved" });

      const delivered = await humanAnswerMessage(ctx, deps);
      expect(delivered?.message.content).toContain("hugo answered: publish as-is");
      // The orchestrator is told the recorded choice, so it knows whether it may
      // publish without re-deriving the record itself.
      expect(delivered?.message.content).toContain("Sensitive findings: publication choice");
      expect(state.awaitingHuman).toBeUndefined();

      const record = JSON.parse(readFileSync(reviewFindingsRecordPath(cwd), "utf8"));
      expect(record.findings[0].publication.kind).toBe("publish");
      expect(evaluateDeferredFindingsGate(record).ok).toBe(true);
    } finally {
      stopHumanAnswerPoll(state);
    }
  });

  it("records a redact answer on the bd comment channel, never the raw finding", async () => {
    // The choice is in the answer text, not in the channel: the bd-comment path
    // must persist the one-liner exactly as the GitHub path does, because the
    // written record is what bd-184 renders from. Redact is the one kind whose
    // body is neither empty (withhold) nor the finding (publish), so it needs its
    // own assertion on each channel.
    const state = makeState();
    const deps = makeDeps(state);
    const opened = await openReviewHumanGate({
      state,
      ctx,
      deps,
      taskId: "bd-1",
      reviewText: SENSITIVE_REVIEW,
    });
    expect(opened.opened).toBe(true);
    try {
      const content = await deliverAnswer(deps, "redact");
      expect(content).toContain('publication choice "redact" is recorded');

      const record = readRecord();
      const publication = record.findings[0]?.publication;
      if (publication?.kind !== "redact") throw new Error("expected a redact decision");
      expect(publication.source).toBe("human");
      expect(publication.oneLiner).toContain("[redacted]");
      expect(publication.oneLiner).not.toContain("src/auth/session.ts");
      expect(evaluateDeferredFindingsGate(record).ok).toBe(true);

      const section = renderDeferredFindingsSection(record);
      expect(section).toContain("[redacted]");
      expect(section).not.toContain("src/auth/session.ts");
      expect(section).not.toContain(SENSITIVE_REVIEW.split("\n")[1] ?? "");
      expect(state.awaitingHuman).toBeUndefined();
    } finally {
      stopHumanAnswerPoll(state);
    }
  });

  it("records a publication choice answered on a GitHub issue", async () => {
    // The recording is keyed on the wait's review marker, not on the channel, so
    // the GitHub path (bd-182's issue-comment read) must record the same choice
    // and release the same finding. The answer is a real non-bot author; the
    // harness's own posted comment is excluded by id.
    const owner = "acme";
    const repo = "widgets";
    const issue = 7;
    const target: GithubAnswerTarget = { kind: "github", owner, repo, issue };
    const state = makeState();
    const deps = makeDeps(state, target);
    bd.reply("api user", { stdout: JSON.stringify({ login: "belayd-harness[bot]" }) });
    bd.reply(
      `api --method POST repos/${owner}/${repo}/issues/${issue.toString()}/comments --input -`,
      {
        stdout: JSON.stringify({ id: 700 }),
      },
    );

    const opened = await openReviewHumanGate({
      state,
      ctx,
      deps,
      taskId: "bd-1",
      reviewText: SENSITIVE_REVIEW,
    });
    expect(opened.opened).toBe(true);
    try {
      expect(state.awaitingHuman?.channel).toEqual({ kind: "github", owner, repo, issue });
      expect(state.awaitingHuman?.answerCommentId).toBe("700");
      expect(state.awaitingHuman?.reviewFindings).toEqual({ round: 1 });

      const since = encodeURIComponent(new Date("2026-10-26T20:00:00Z").toISOString());
      bd.reply(
        `api --paginate --slurp repos/${owner}/${repo}/issues/${issue.toString()}/comments?since=${since}`,
        {
          stdout: JSON.stringify([
            {
              id: 700,
              body: "Sensitive findings — publication decision required",
              created_at: "2026-10-26T20:00:01Z",
              user: { login: "belayd-harness[bot]", type: "Bot" },
            },
            {
              id: 701,
              body: "publish it",
              created_at: "2026-10-26T20:05:00Z",
              user: { login: "hugo", type: "User" },
            },
          ]),
        },
      );
      bd.reply("gate list bd-1 --json", { stdout: openGate("2026-10-26T20:00:00Z") });
      bd.reply("gate resolve bd-160", { stdout: "resolved" });

      const delivered = await humanAnswerMessage(ctx, deps);
      expect(delivered?.message.content).toContain("hugo answered: publish it");
      expect(delivered?.message.content).toContain(
        'Sensitive findings: publication choice "publish" is recorded',
      );

      const record = readRecord();
      expect(record.findings[0]?.publication).toMatchObject({ kind: "publish", source: "human" });
      expect(evaluateDeferredFindingsGate(record).ok).toBe(true);
      expect(state.awaitingHuman).toBeUndefined();
    } finally {
      stopHumanAnswerPoll(state);
    }
  });

  it("records redact and withhold choices answered on a GitHub issue", async () => {
    // The recording is channel-agnostic, but the choice is not: a redact reply
    // must persist the one-liner (never the raw finding) and a withhold must
    // persist a human withhold, both on the issue-comment channel bd-182 reads.
    const owner = "acme";
    const repo = "widgets";
    const issue = 7;
    const target: GithubAnswerTarget = { kind: "github", owner, repo, issue };
    const since = encodeURIComponent(new Date("2026-10-26T20:00:00Z").toISOString());
    const cases = [
      { answer: "redact", kind: "redact" },
      { answer: "withhold", kind: "withhold" },
    ] as const;

    for (const testCase of cases) {
      cwd = mkdtempSync(join(tmpdir(), "belayd-review-gate-sensitive-"));
      ctx.cwd = cwd;
      bd.reset();
      bd.reply("api user", { stdout: JSON.stringify({ login: "belayd-harness[bot]" }) });
      bd.reply(
        `api --method POST repos/${owner}/${repo}/issues/${issue.toString()}/comments --input -`,
        { stdout: JSON.stringify({ id: 700 }) },
      );
      bd.reply(sensitiveGateKey(), { stdout: JSON.stringify({ id: "bd-160", status: "open" }) });
      bd.reply(COMMENT_KEY, { stdout: "" });

      const state = makeState();
      const deps = makeDeps(state, target);
      const opened = await openReviewHumanGate({
        state,
        ctx,
        deps,
        taskId: "bd-1",
        reviewText: SENSITIVE_REVIEW,
      });
      expect(opened.opened).toBe(true);
      try {
        bd.reply(
          `api --paginate --slurp repos/${owner}/${repo}/issues/${issue.toString()}/comments?since=${since}`,
          {
            stdout: JSON.stringify([
              {
                id: 700,
                body: "Sensitive findings — publication decision required",
                created_at: "2026-10-26T20:00:01Z",
                user: { login: "belayd-harness[bot]", type: "Bot" },
              },
              {
                id: 701,
                body: testCase.answer,
                created_at: "2026-10-26T20:05:00Z",
                user: { login: "hugo", type: "User" },
              },
            ]),
          },
        );
        bd.reply("gate list bd-1 --json", { stdout: openGate("2026-10-26T20:00:00Z") });
        bd.reply("gate resolve bd-160", { stdout: "resolved" });

        const delivered = await humanAnswerMessage(ctx, deps);
        expect(delivered?.message.content).toContain(`hugo answered: ${testCase.answer}`);
        expect(delivered?.message.content).toContain(
          `publication choice "${testCase.kind}" is recorded`,
        );

        // The choice asserted on the written record file, not on the message.
        const record = readRecord();
        expect(record.findings[0]?.publication).toMatchObject({ kind: testCase.kind });
        expect(state.awaitingHuman).toBeUndefined();

        const section = renderDeferredFindingsSection(record);
        if (testCase.kind === "redact") {
          const publication = record.findings[0]?.publication;
          if (publication?.kind !== "redact") throw new Error("expected a redact decision");
          expect(publication.oneLiner).toContain("[redacted]");
          expect(publication.oneLiner).not.toContain("ghp_16C7e42F292c6912E7710c838347Ae178B4a");
          expect(evaluateDeferredFindingsGate(record).ok).toBe(true);
          // Only the one-liner may render; the raw finding never does.
          expect(section).toContain("[redacted]");
          expect(section).not.toContain(SENSITIVE_REVIEW.split("\n")[1] ?? "");
        } else {
          expect(record.findings[0]?.publication).toMatchObject({ source: "human" });
          expect(section).toBe("");
          expect(evaluateDeferredFindingsGate(record)).toMatchObject({
            ok: false,
            reason: "sensitive-findings-withheld",
          });
        }
      } finally {
        stopHumanAnswerPoll(state);
      }
    }
  });

  it("ignores an unrelated ask-human answer in the same worktree", async () => {
    // The record file exists for the whole worktree, so "a sensitive record exists"
    // must never be the discriminator: a later `belayd_ask_human` reply ("publish
    // it") would otherwise flip an explicit withhold to publish and bd-184 would
    // render the raw finding (bd-183 review, Critical).
    const state = makeState();
    const deps = makeDeps(state);
    const opened = await openReviewHumanGate({
      state,
      ctx,
      deps,
      taskId: "bd-1",
      reviewText: SENSITIVE_REVIEW,
    });
    expect(opened.opened).toBe(true);
    try {
      // 1. The review wait's own answer withholds.
      bd.reply("gate list bd-1 --json", { stdout: openGate("2026-10-26T20:00:00Z") });
      bd.reply("comments bd-1 --json", {
        stdout: answerThread("2026-10-26T20:05:00Z", "withhold"),
      });
      bd.reply("gate resolve bd-160", { stdout: "resolved" });
      await humanAnswerMessage(ctx, deps);
      expect(readRecord().findings[0]?.publication).toMatchObject({ kind: "withhold" });

      // 2. A later ask-style wait (no review marker) is answered with a publish.
      state.awaitingHuman = { beadId: "bd-1", askedAt: Date.now(), gateId: "bd-161" };
      bd.reply("gate list bd-1 --json", { stdout: openGate("2026-10-26T21:00:00Z", "bd-161") });
      bd.reply("comments bd-1 --json", {
        stdout: answerThread("2026-10-26T21:05:00Z", "publish it"),
      });
      bd.reply("gate resolve bd-161", { stdout: "resolved" });
      const delivered = await humanAnswerMessage(ctx, deps);

      expect(delivered?.message.content).toContain("hugo answered: publish it");
      // No publication line: this wait was not the review gate's own wait.
      expect(delivered?.message.content).not.toContain("Sensitive findings:");
      expect(readRecord().findings[0]?.publication).toMatchObject({ kind: "withhold" });
      expect(evaluateDeferredFindingsGate(readRecord())).toMatchObject({ ok: false });
    } finally {
      stopHumanAnswerPoll(state);
    }
  });

  it("announces and drops publication decisions when a re-review resets the round", async () => {
    const state = makeState();
    const deps = makeDeps(state);
    const roundOne = await openReviewHumanGate({
      state,
      ctx,
      deps,
      taskId: "bd-1",
      reviewText: SENSITIVE_REVIEW,
    });
    expect(roundOne.opened).toBe(true);
    try {
      bd.reply("gate list bd-1 --json", { stdout: openGate("2026-10-26T20:00:00Z") });
      bd.reply("comments bd-1 --json", {
        stdout: answerThread("2026-10-26T20:05:00Z", "publish it"),
      });
      bd.reply("gate resolve bd-160", { stdout: "resolved" });
      await humanAnswerMessage(ctx, deps);
      expect(evaluateDeferredFindingsGate(readRecord()).ok).toBe(true);
    } finally {
      stopHumanAnswerPoll(state);
    }

    // The re-review rebuilds the same findings for round 2: the round-1 decision
    // must not be consumed, and the reset has to be announced.
    bd.reply(sensitiveGateKey({ round: 2, previousDecisionsReset: true }), {
      stdout: JSON.stringify({ id: "bd-162", status: "open" }),
    });
    const roundTwo = await openReviewHumanGate({
      state,
      ctx,
      deps,
      taskId: "bd-1",
      reviewText: SENSITIVE_REVIEW,
    });
    try {
      expect(roundTwo.opened).toBe(true);
      const gateCreates = bd.calls.filter((call) => bd.keyOf(call.argv).startsWith("gate create"));
      expect(gateCreates.at(-1)?.argv.join(" ")).toContain("previous decisions reset");
      const comments = bd.calls.filter((call) => bd.keyOf(call.argv) === COMMENT_KEY);
      expect(comments.at(-1)?.stdin).toContain("previous publication decisions were reset");

      const record = readRecord();
      expect(record.round).toBe(2);
      expect(record.findings[0]?.publication).toBeUndefined();
      expect(evaluateDeferredFindingsGate(record)).toMatchObject({
        ok: false,
        reason: "sensitive-findings-awaiting-human",
      });
      expect(state.awaitingHuman?.reviewFindings).toEqual({ round: 2 });
    } finally {
      stopHumanAnswerPoll(state);
    }
  });

  it("withholds by default when the gate is resolved without an answer", async () => {
    // Scotty's Approve resolves the gate and leaves no note: for a security-class
    // finding that is not permission to publish.
    const state = makeState();
    const deps = makeDeps(state);
    const opened = await openReviewHumanGate({
      state,
      ctx,
      deps,
      taskId: "bd-1",
      reviewText: SENSITIVE_REVIEW,
    });
    expect(opened.opened).toBe(true);
    try {
      bd.reply("gate list bd-1 --json", { stdout: JSON.stringify([]) });
      bd.reply("gate list bd-1 --all --json", { stdout: JSON.stringify([]) });
      const delivered = await humanAnswerMessage(ctx, deps);
      expect(delivered?.message.content).toContain("resolved without a comment");
      expect(delivered?.message.content).toContain('publication choice "withhold"');
      const record = JSON.parse(readFileSync(reviewFindingsRecordPath(cwd), "utf8"));
      expect(record.findings[0].publication).toMatchObject({ kind: "withhold", source: "default" });
      expect(evaluateDeferredFindingsGate(record)).toMatchObject({ ok: false });
    } finally {
      stopHumanAnswerPoll(state);
    }
  });

  it("keeps today's gate and message for a non-sensitive review", async () => {
    const state = makeState();
    const deps = makeDeps(state);
    bd.reply(GATE_CREATE_KEY, { stdout: JSON.stringify({ id: "bd-160", status: "open" }) });
    const opened = await openReviewHumanGate({
      state,
      ctx,
      deps,
      taskId: "bd-1",
      reviewText: REVIEW_WITH_FINDINGS,
    });
    expect(opened).toEqual({ opened: true, reason: REVIEW_HUMAN_GATE_REASON });
    try {
      const gateCall = bd.calls.find((call) => bd.keyOf(call.argv).startsWith("gate create"));
      expect(gateCall?.argv).toContain("belayd-review: bd-1 findings (round 1)");
      expect(gateCall?.argv).toContain(REVIEW_HUMAN_GATE_REASON);

      bd.reply("gate list bd-1 --json", {
        stdout: JSON.stringify([
          {
            id: "bd-160",
            status: "open",
            issue_type: "gate",
            await_type: "human",
            created_at: "2026-10-26T20:00:00Z",
          },
        ]),
      });
      bd.reply("comments bd-1 --json", {
        stdout: JSON.stringify([
          {
            id: "c-2",
            issue_id: "bd-1",
            author: "hugo",
            created_at: "2026-10-26T20:05:00Z",
            text: "option b, ship it",
          },
        ]),
      });
      bd.reply("gate resolve bd-160", { stdout: "resolved" });
      const delivered = await humanAnswerMessage(ctx, deps);
      expect(delivered?.message.content).toBe("hugo answered: option b, ship it");
    } finally {
      stopHumanAnswerPoll(state);
    }
  });

  it("carries an earlier round's security verdict when the live table no longer matches", async () => {
    // The Critical shape: round 1 flagged a finding the current rule table calls
    // clean, and round 1 released it. Round 2 must store it as sensitive (so the
    // gate/reason/publication surface all keep treating it as such) and must not
    // silently publish the raw text.
    const PLAIN_FINDING = "`src/a.ts:12` — off-by-one in the loop bound";
    const previous: ReviewFindingsRecord = {
      schemaVersion: 1,
      taskId: "bd-1",
      phase: "review",
      round: 1,
      reason: REVIEW_HUMAN_GATE_REASON,
      artifactPath: REVIEW_FINDINGS_ARTIFACT_RELATIVE_PATH,
      findings: [
        {
          finding: PLAIN_FINDING,
          severity: "critical",
          phase: "review",
          round: 1,
          disposition: { kind: "deferred", reason: REVIEW_HUMAN_GATE_REASON },
          sensitivity: { sensitive: true, reasons: [{ kind: "security-topic", match: "auth" }] },
          publication: { kind: "publish", source: "human", answer: "publish it" },
        },
      ],
    };
    mkdirSync(join(cwd, ".belayd"), { recursive: true });
    writeFileSync(reviewFindingsRecordPath(cwd), JSON.stringify(previous));

    const rebuilt = buildReviewFindingsRecord({ taskId: "bd-1", text: PLAIN_REVIEW, round: 2 });
    if (rebuilt === undefined) throw new Error("expected a record");
    const carried = carryForwardSensitivity({ record: rebuilt, previous });
    const title = reviewFindingsGateTitle({
      taskId: "bd-1",
      round: 2,
      sensitive: true,
      previousDecisionsReset: true,
    });
    const reason = reviewFindingsGateReason(carried, { previousDecisionsReset: true });
    bd.reply(`gate create --blocks bd-1 --type=human --title ${title} --reason ${reason} --json`, {
      stdout: JSON.stringify({ id: "bd-163", status: "open" }),
    });

    const state = makeState();
    const opened = await openReviewHumanGate({
      state,
      ctx,
      deps: makeDeps(state),
      taskId: "bd-1",
      reviewText: PLAIN_REVIEW,
    });
    try {
      expect(opened.opened).toBe(true);
      const gateCall = bd.calls
        .filter((call) => bd.keyOf(call.argv).startsWith("gate create"))
        .at(-1);
      expect(gateCall?.argv.join(" ")).toContain("sensitive findings (round 2");
      expect(gateCall?.argv.join(" ")).toContain("previous publication decisions were reset");

      const record = readRecord();
      expect(record.findings[0]?.sensitivity?.sensitive).toBe(true);
      expect(record.findings[0]?.publication).toBeUndefined();
      expect(evaluateDeferredFindingsGate(record)).toMatchObject({
        ok: false,
        reason: "sensitive-findings-awaiting-human",
      });
      expect(state.awaitingHuman?.reviewFindings).toEqual({ round: 2 });
    } finally {
      stopHumanAnswerPoll(state);
    }
  });

  it("widens a shared key to a sensitive gate when the earlier verdict was sensitive", async () => {
    // Round 1 flagged one finding; round 2 reports two that differ only in casing
    // and emphasis. The carry cannot tell which candidate the earlier verdict
    // names, so both are marked sensitive: the disclosure question is asked and
    // nothing publishes raw. Refusing the carry here would store their clean live
    // verdicts and release the raw text with no decision.
    const STORED = "`src/a.ts:12` — off-by-one in the loop bound";
    const RECASED = "**src/a.ts:12** — Off-By-One In The Loop Bound";
    const COLLIDING_REVIEW = ["## Critical (must fix)", `- ${STORED}`, `- ${RECASED}`].join("\n");
    const verdict: FindingSensitivity = {
      sensitive: true,
      reasons: [{ kind: "security-topic", match: "auth" }],
    };
    const previous: ReviewFindingsRecord = {
      schemaVersion: 1,
      taskId: "bd-1",
      phase: "review",
      round: 1,
      reason: REVIEW_HUMAN_GATE_REASON,
      artifactPath: REVIEW_FINDINGS_ARTIFACT_RELATIVE_PATH,
      findings: [
        {
          finding: STORED,
          severity: "critical",
          phase: "review",
          round: 1,
          disposition: { kind: "deferred", reason: REVIEW_HUMAN_GATE_REASON },
          sensitivity: verdict,
        },
      ],
    };
    mkdirSync(join(cwd, ".belayd"), { recursive: true });
    writeFileSync(reviewFindingsRecordPath(cwd), JSON.stringify(previous));

    const rebuilt = buildReviewFindingsRecord({ taskId: "bd-1", text: COLLIDING_REVIEW, round: 2 });
    if (rebuilt === undefined) throw new Error("expected a record");
    bd.reply(sensitiveGateKey({ round: 2 }), {
      stdout: JSON.stringify({ id: "bd-165", status: "open" }),
    });

    const state = makeState();
    const opened = await openReviewHumanGate({
      state,
      ctx,
      deps: makeDeps(state),
      taskId: "bd-1",
      reviewText: COLLIDING_REVIEW,
    });
    try {
      expect(opened.opened).toBe(true);
      const gateCall = bd.calls
        .filter((call) => bd.keyOf(call.argv).startsWith("gate create"))
        .at(-1);
      expect(gateCall?.argv.join(" ")).toContain("sensitive findings (round 2");
      expect(gateCall?.argv.join(" ")).toContain("publication decision");

      const record = readRecord();
      expect(record.findings.map((finding) => finding.sensitivity)).toEqual([verdict, verdict]);
      // Widening must not invent a decision for the human.
      for (const finding of record.findings) {
        expect(finding.publication).toBeUndefined();
      }
      expect(evaluateDeferredFindingsGate(record)).toMatchObject({
        ok: false,
        reason: "sensitive-findings-awaiting-human",
      });
      expect(state.awaitingHuman?.reviewFindings).toEqual({ round: 2 });
    } finally {
      stopHumanAnswerPoll(state);
    }
  });

  it("does not announce a reset when the previous round only withheld", async () => {
    const state = makeState();
    const deps = makeDeps(state);
    const first = await openReviewHumanGate({
      state,
      ctx,
      deps,
      taskId: "bd-1",
      reviewText: SENSITIVE_REVIEW,
    });
    expect(first.opened).toBe(true);
    try {
      await deliverAnswer(deps, "withhold");
      expect(readRecord().findings[0]?.publication).toMatchObject({ kind: "withhold" });
    } finally {
      stopHumanAnswerPoll(state);
    }

    bd.reply(sensitiveGateKey({ round: 2 }), {
      stdout: JSON.stringify({ id: "bd-164", status: "open" }),
    });
    const second = await openReviewHumanGate({
      state,
      ctx,
      deps,
      taskId: "bd-1",
      reviewText: SENSITIVE_REVIEW,
    });
    try {
      expect(second.opened).toBe(true);
      const gateCall = bd.calls
        .filter((call) => bd.keyOf(call.argv).startsWith("gate create"))
        .at(-1);
      expect(gateCall?.argv.join(" ")).not.toContain("reset");
      const comment = bd.calls.filter((call) => bd.keyOf(call.argv) === COMMENT_KEY).at(-1);
      expect(comment?.stdin).not.toContain("reset");
    } finally {
      stopHumanAnswerPoll(state);
    }
  });

  it("says why a recording was refused, per cause", async () => {
    // Three distinct states, three distinct follow-ups. All stay withheld.
    const cases: ReadonlyArray<{ cause: string; prepare: () => void }> = [
      {
        cause: "no review record was found",
        prepare: () => rmSync(reviewFindingsRecordPath(cwd)),
      },
      {
        cause: "is no longer round 1",
        prepare: () => {
          const record = readRecord();
          writeFileSync(reviewFindingsRecordPath(cwd), JSON.stringify({ ...record, round: 2 }));
        },
      },
      {
        cause: "has no security-class finding any more",
        prepare: () => {
          const record = readRecord();
          const plain = buildReviewFindingsRecord({
            taskId: "bd-1",
            text: PLAIN_REVIEW,
            round: record.round,
          });
          if (plain === undefined) throw new Error("expected a record");
          writeFileSync(reviewFindingsRecordPath(cwd), JSON.stringify(plain));
        },
      },
    ];
    const contents: string[] = [];
    for (const testCase of cases) {
      const state = makeState();
      const deps = makeDeps(state);
      bd.reset();
      bd.reply(sensitiveGateKey(), { stdout: JSON.stringify({ id: "bd-160", status: "open" }) });
      bd.reply(COMMENT_KEY, { stdout: "" });
      const opened = await openReviewHumanGate({
        state,
        ctx,
        deps,
        taskId: "bd-1",
        reviewText: SENSITIVE_REVIEW,
      });
      expect(opened.opened).toBe(true);
      try {
        testCase.prepare();
        const content = (await deliverAnswer(deps, "publish it")) ?? "";
        expect(content).toContain("Sensitive findings:");
        expect(content).toContain(testCase.cause);
        contents.push(content);
      } finally {
        stopHumanAnswerPoll(state);
      }
    }
    // The three messages must be distinguishable, not one generic sentence.
    expect(new Set(contents).size).toBe(3);
  });
});
