import { afterEach, describe, expect, it } from "vitest";
import type { DurableAgentConfig, DurableAuthority } from "../durable-member/commands.js";
import type { DedupeLedger } from "../durable-member/dedupe.js";
import { createDedupeLedger } from "../durable-member/dedupe.js";
import type {
  DurableDispatcher,
  DurableSubmission,
  DurableSubmitInput,
  DurableWriter,
} from "../durable-member/dispatch.js";
import { createDurableDispatcher } from "../durable-member/dispatch.js";
import { makeCommand, makeStateDir, removeStateDir, TEST_MEMBER_ID } from "./durable-fixtures.js";

interface WriterCall {
  readonly method: string;
  readonly input: unknown;
}

/** Recording writer: asserts the mapping, not a real pi-durable. */
function recordingWriter(options?: {
  submissions?: Record<string, DurableSubmission>;
  /** Number of applies that return a writer error before succeeding. */
  failSubmits?: number;
  /** Number of applies that throw before succeeding. */
  throwSubmits?: number;
}): {
  writer: DurableWriter;
  calls: WriterCall[];
} {
  const calls: WriterCall[] = [];
  let failSubmits = options?.failSubmits ?? 0;
  let throwSubmits = options?.throwSubmits ?? 0;
  const writer: DurableWriter = {
    submit(input: DurableSubmitInput) {
      calls.push({ method: "submit", input });
      if (throwSubmits > 0) {
        throwSubmits -= 1;
        throw new Error("submit exploded");
      }
      if (failSubmits > 0) {
        failSubmits -= 1;
        return { ok: false, error: "busy" };
      }
      return { ok: true, submissionId: "sub-1" };
    },
    submission(submissionId: string) {
      calls.push({ method: "submission", input: submissionId });
      return options?.submissions?.[submissionId] ?? null;
    },
    abort() {
      calls.push({ method: "abort", input: undefined });
    },
    configure(config: DurableAgentConfig) {
      calls.push({ method: "configure", input: config });
    },
    compact(compactOptions: { instructions?: string }) {
      calls.push({ method: "compact", input: compactOptions });
    },
    reset(resetOptions: { keepHistory: boolean }) {
      calls.push({ method: "reset", input: resetOptions });
    },
  };
  return { writer, calls };
}

const stateDirs: string[] = [];

function dispatcherFor(
  writer: DurableWriter,
  authority: DurableAuthority = "panel-human",
): DurableDispatcher {
  const stateDir = makeStateDir();
  stateDirs.push(stateDir);
  const opened = createDedupeLedger({ stateDir });
  if (!opened.ok) throw new Error(opened.error);
  return createDurableDispatcher({
    memberId: TEST_MEMBER_ID,
    authority,
    writer,
    ledger: opened.ledger,
  });
}

function ledgerFor(): DedupeLedger {
  const stateDir = makeStateDir();
  stateDirs.push(stateDir);
  const opened = createDedupeLedger({ stateDir });
  if (!opened.ok) throw new Error(opened.error);
  return opened.ledger;
}

afterEach(() => {
  for (const dir of stateDirs.splice(0)) removeStateDir(dir);
});

describe("createDurableDispatcher command mapping", () => {
  it("maps steer to submit({ type: message, whenBusy: steer })", async () => {
    const { writer, calls } = recordingWriter();
    const result = await dispatcherFor(writer).dispatch(
      makeCommand("steer", { text: "join after the tool round" }),
    );

    expect(result).toEqual({ ok: true, requestId: "req-steer-1", duplicate: false });
    expect(calls).toEqual([
      {
        method: "submit",
        input: { type: "message", text: "join after the tool round", whenBusy: "steer" },
      },
    ]);
  });

  it("maps followup to submit({ type: message, whenBusy: followup })", async () => {
    const { writer, calls } = recordingWriter();
    await dispatcherFor(writer).dispatch(makeCommand("followup", { text: "start the next run" }));
    expect(calls).toEqual([
      {
        method: "submit",
        input: { type: "message", text: "start the next run", whenBusy: "followup" },
      },
    ]);
  });

  it("maps write to submit({ type: write, entry })", async () => {
    const { writer, calls } = recordingWriter();
    await dispatcherFor(writer).dispatch(makeCommand("write"));
    expect(calls[0]).toMatchObject({
      method: "submit",
      input: {
        type: "write",
        entry: { role: "system", text: "operator note", kind: "note" },
      },
    });
  });

  it("maps abort-submission to that submission's abort()", async () => {
    const aborted: string[] = [];
    const { writer } = recordingWriter({
      submissions: {
        "sub-1": {
          abort() {
            aborted.push("sub-1");
          },
        },
      },
    });
    const result = await dispatcherFor(writer).dispatch(makeCommand("abort-submission"));
    expect(result.ok).toBe(true);
    expect(aborted).toEqual(["sub-1"]);
  });

  it("refuses an abort-submission for a submission that is not in flight", async () => {
    const { writer, calls } = recordingWriter();
    const result = await dispatcherFor(writer).dispatch(makeCommand("abort-submission"));
    expect(result).toMatchObject({ ok: false, code: "unknown-submission" });
    expect(calls.some((call) => call.method === "submit")).toBe(false);
  });

  it("maps abort, configure, compact and reset to the writer methods", async () => {
    const { writer, calls } = recordingWriter();
    const dispatcher = dispatcherFor(writer);

    await dispatcher.dispatch(makeCommand("abort", { reason: "stop" }));
    await dispatcher.dispatch(makeCommand("configure"));
    await dispatcher.dispatch(makeCommand("compact", { instructions: "keep the ACs" }));
    await dispatcher.dispatch(makeCommand("reset", { keepHistory: true }));

    expect(calls).toEqual([
      { method: "abort", input: undefined },
      { method: "configure", input: { model: "anthropic/claude-sonnet" } },
      { method: "compact", input: { instructions: "keep the ACs" } },
      { method: "reset", input: { keepHistory: true } },
    ]);
  });

  it("defaults reset to keepHistory: false", async () => {
    const { writer, calls } = recordingWriter();
    await dispatcherFor(writer).dispatch(makeCommand("reset", { keepHistory: undefined }));
    expect(calls).toEqual([{ method: "reset", input: { keepHistory: false } }]);
  });
});

describe("createDurableDispatcher dedupe", () => {
  it("applies the same requestId once and reports duplicate on the retry", async () => {
    const { writer, calls } = recordingWriter();
    const dispatcher = dispatcherFor(writer);
    const command = makeCommand("steer");

    const first = await dispatcher.dispatch(command);
    const second = await dispatcher.dispatch(command);

    expect(first).toEqual({ ok: true, requestId: "req-steer-1", duplicate: false });
    expect(second).toEqual({ ok: true, requestId: "req-steer-1", duplicate: true });
    expect(calls).toHaveLength(1);
  });

  it("dedupes across a dispatcher restart through the ledger", async () => {
    const { writer, calls } = recordingWriter();
    const ledger = ledgerFor();
    const command = makeCommand("steer");

    await createDurableDispatcher({
      memberId: TEST_MEMBER_ID,
      authority: "panel-human",
      writer,
      ledger,
    }).dispatch(command);
    const restarted = createDurableDispatcher({
      memberId: TEST_MEMBER_ID,
      authority: "panel-human",
      writer,
      ledger,
    });
    const replay = await restarted.dispatch(command);

    expect(replay).toMatchObject({ ok: true, duplicate: true });
    expect(calls).toHaveLength(1);
  });
});

describe("createDurableDispatcher refusals", () => {
  it("never calls the writer for a supervisor content steer", async () => {
    const { writer, calls } = recordingWriter();
    const result = await dispatcherFor(writer, "fleet-supervisor").dispatch(
      makeCommand("steer", { authority: "fleet-supervisor" }),
    );
    expect(result).toMatchObject({ ok: false, code: "role-not-permitted" });
    expect(calls).toHaveLength(0);
  });

  it("never calls the writer for a phase sub-agent", async () => {
    const { writer, calls } = recordingWriter();
    const result = await dispatcherFor(writer, "phase-subagent").dispatch(
      makeCommand("abort", { authority: "phase-subagent" }),
    );
    expect(result).toMatchObject({ ok: false, code: "role-not-permitted" });
    expect(calls).toHaveLength(0);
  });

  it("refuses reset without confirmation even though the command is well formed", async () => {
    const { writer, calls } = recordingWriter();
    const result = await dispatcherFor(writer).dispatch(
      makeCommand("reset", { confirmation: undefined }),
    );
    expect(result).toMatchObject({ ok: false, code: "confirmation-required" });
    expect(calls).toHaveLength(0);
  });

  it("refuses a command for another member", async () => {
    const { writer, calls } = recordingWriter();
    const result = await dispatcherFor(writer).dispatch(
      makeCommand("steer", { memberId: "member-b" }),
    );
    expect(result).toMatchObject({ ok: false, code: "member-mismatch" });
    expect(calls).toHaveLength(0);
  });

  it("turns a writer failure and a thrown writer error into error values", async () => {
    const failing = recordingWriter();
    failing.writer.submit = () => ({ ok: false, error: "busy" });
    expect(await dispatcherFor(failing.writer).dispatch(makeCommand("steer"))).toMatchObject({
      ok: false,
      code: "writer-failed",
      error: "busy",
    });

    const throwing = recordingWriter();
    throwing.writer.abort = () => {
      throw new Error("writer exploded");
    };
    expect(await dispatcherFor(throwing.writer).dispatch(makeCommand("abort"))).toMatchObject({
      ok: false,
      code: "writer-failed",
      error: "writer exploded",
    });
  });
});

describe("createDurableDispatcher retry and identity semantics", () => {
  it("retries a failed apply instead of acking a duplicate of nothing", async () => {
    const { writer } = recordingWriter({ failSubmits: 1 });
    const dispatcher = dispatcherFor(writer);
    const command = makeCommand("steer");

    const failed = await dispatcher.dispatch(command);
    expect(failed).toMatchObject({ ok: false, code: "writer-failed", error: "busy" });

    // The ledger must not remember a failed apply: the retry is applied.
    const retried = await dispatcher.dispatch(command);
    expect(retried).toEqual({ ok: true, requestId: "req-steer-1", duplicate: false });

    // Once applied, the same requestId is a duplicate again.
    const replay = await dispatcher.dispatch(command);
    expect(replay).toEqual({ ok: true, requestId: "req-steer-1", duplicate: true });
  });

  it("retries after the writer throws", async () => {
    const { writer } = recordingWriter({ throwSubmits: 1 });
    const dispatcher = dispatcherFor(writer);
    const command = makeCommand("followup");

    expect(await dispatcher.dispatch(command)).toMatchObject({
      ok: false,
      code: "writer-failed",
      error: "submit exploded",
    });
    expect(await dispatcher.dispatch(command)).toEqual({
      ok: true,
      requestId: "req-followup-1",
      duplicate: false,
    });
  });

  it("refuses a direct dispatch whose claim disagrees with the bound tier", async () => {
    const { writer, calls } = recordingWriter();
    const result = await dispatcherFor(writer, "fleet-supervisor").dispatch(
      makeCommand("steer", { authority: "panel-human" }),
    );
    expect(result).toMatchObject({ ok: false, code: "authority-mismatch" });
    expect(calls).toHaveLength(0);
  });

  it("exposes the bound identity the owner configured", () => {
    const { writer } = recordingWriter();
    expect(dispatcherFor(writer, "fleet-supervisor").authority).toBe("fleet-supervisor");
  });
});
