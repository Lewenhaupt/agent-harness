/**
 * Extension-surface tests for the review human gate (bd-175).
 *
 * `openReviewHumanGate` is exercised directly against a stubbed `bd`, the way
 * the human-answer suite exercises `belayd_ask_human`: it must post the findings
 * as an authored comment, open a `human` gate carrying the shared reason, write
 * the durable disposition record, and arm the answer poll so resolving the gate
 * resumes the member. A clean review stays on the fast path and writes nothing.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type HumanGateDeps,
  openReviewHumanGate,
  stopHumanAnswerPoll,
} from "../../extensions/capabilities/human-gate.js";
import { runCompleteLoopHint, tryOpenReviewGate } from "../../extensions/capabilities/phase-run.js";
import { createInitialSessionState } from "../../extensions/capabilities/session-state.js";
import { REVIEW_HUMAN_GATE_REASON, reviewFindingsRecordPath } from "../review-findings.js";
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
