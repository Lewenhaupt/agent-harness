/**
 * The human answer channel against a real `bd` (bd-152).
 *
 * The unit suites stub `bd`, so they can only prove the argv the harness builds
 * against what bd *should* answer. This test runs the real CLI in a throwaway
 * database and pins the parts that would break silently on a bd upgrade: the
 * `gate create --json` record, `gate list <bead> --json` (open gates only, with
 * `await_type`), the comment record shape and its `author`, and the fact that
 * resolving the gate leaves the work bead open (the gate is the wait, not the
 * acceptance signal).
 *
 * `bd` is not on every host that runs these suites, so the whole file skips when
 * the binary is missing rather than failing.
 */

import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildBeadCommentsArgv,
  buildGateCreateArgv,
  buildGateListArgv,
  buildGateResolveArgv,
  commentTimeInMs,
  isHumanComment,
  lookupBeadComments,
  lookupOpenHumanGate,
  parseCreatedGateId,
} from "../src/index.js";

const execFileAsync = promisify(execFile);

const bdAvailable = (() => {
  try {
    execFileSync("bd", ["version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();

const HARNESS_ACTOR = "belayd:bd-test:orchestrator";

/** The injected bd runner: the same `bd <argv>` call the extension makes. */
async function runBd(
  argv: readonly string[],
  options: {
    cwd: string;
    stdin: string | undefined;
    timeoutInMs: number;
    maxBufferInBytes: number;
  },
): Promise<{ stdout: string }> {
  const result = await execFileAsync("bd", [...argv], {
    cwd: options.cwd,
    timeout: options.timeoutInMs,
    maxBuffer: options.maxBufferInBytes,
    // Keep the human/global actor out of the way: every write names its actor.
    env: { ...process.env, BEADS_ACTOR: "" },
  });
  return { stdout: result.stdout };
}

/** `bd <argv>` with a stdin body, as the harness writes comments/notes. */
async function runBdWithStdin(
  argv: readonly string[],
  cwd: string,
  stdin: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "bd",
      [...argv],
      { cwd, env: { ...process.env, BEADS_ACTOR: "" }, timeout: 30_000 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(stdin);
  });
}

describe.skipIf(!bdAvailable)("human answer channel against a real bd", () => {
  let dir: string;
  let beadId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "belayd-human-answer-it-"));
    await execFileAsync("bd", ["init"], { cwd: dir, env: { ...process.env, BEADS_ACTOR: "" } });
    const created = await execFileAsync(
      "bd",
      ["create", "human answer probe", "-t", "task", "--json"],
      { cwd: dir, env: { ...process.env, BEADS_ACTOR: "" } },
    );
    beadId = (JSON.parse(created.stdout) as { id: string }).id;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("ask → human comment → resolve, with the bead left open", async () => {
    // 1. The gate the ask tool creates.
    const createdGate = await execFileAsync(
      "bd",
      [
        "gate",
        "--actor",
        HARNESS_ACTOR,
        ...buildGateCreateArgv({ beadId, reason: "which option?" }).slice(1),
        "--json",
      ],
      { cwd: dir, env: { ...process.env, BEADS_ACTOR: "" } },
    );
    const gateId = parseCreatedGateId(createdGate.stdout, beadId);
    expect(gateId).toBeDefined();
    expect(gateId).not.toBe(beadId);
    if (gateId === undefined) return;

    // 2. The question is an authored comment, never an answer.
    await runBdWithStdin(
      ["comment", "--actor", HARNESS_ACTOR, "--stdin", "--", beadId],
      dir,
      "which option?",
    );
    const asked = await lookupBeadComments({ beadId, cwd: dir, runBd });
    if (!asked.ok) throw new Error(asked.error);
    expect(asked.comments.map((comment) => comment.text)).toEqual(["which option?"]);
    expect(asked.comments.every((comment) => !isHumanComment(comment))).toBe(true);

    // 3. The open gate is what gates the workflow, and bd reports it as human.
    const open = await lookupOpenHumanGate({ beadId, cwd: dir, runBd });
    if (!open.ok) throw new Error(open.error);
    expect(open.status).toBe("open");
    if (open.status !== "open") return;
    expect(open.gate.gateId).toBe(gateId);
    expect(open.gate.createdAt).toBeDefined();

    // 4. A human reply in the thread is the answer, newer than the gate.
    await runBdWithStdin(["comment", "--actor", "hugo", "--stdin", "--", beadId], dir, "option b");
    const answered = await lookupBeadComments({ beadId, cwd: dir, runBd });
    if (!answered.ok) throw new Error(answered.error);
    const human = answered.comments.find((comment) => isHumanComment(comment));
    expect(human?.author).toBe("hugo");
    expect(human?.text).toBe("option b");
    // bd timestamps are second-granularity, so the answer is only guaranteed to
    // be >= the gate's creation time.
    if (human !== undefined && open.gate.createdAt !== undefined) {
      expect(commentTimeInMs(human)).toBeGreaterThanOrEqual(Date.parse(open.gate.createdAt));
    }

    // 5. Resolving the gate clears the wait but leaves the bead open: close stays
    // the acceptance signal.
    await execFileAsync(
      "bd",
      ["gate", "--actor", HARNESS_ACTOR, ...buildGateResolveArgv(gateId).slice(1)],
      {
        cwd: dir,
        env: { ...process.env, BEADS_ACTOR: "" },
      },
    );
    const resolved = await lookupOpenHumanGate({ beadId, cwd: dir, runBd });
    if (!resolved.ok) throw new Error(resolved.error);
    // "none" is the genuine-resolution state; "unrecognized" would keep waiting.
    expect(resolved).toEqual({ ok: true, status: "none" });

    const bead = await execFileAsync("bd", ["show", beadId, "--json"], {
      cwd: dir,
      env: { ...process.env, BEADS_ACTOR: "" },
    });
    const record = (JSON.parse(bead.stdout) as Array<{ status: string }>)[0];
    expect(record?.status).toBe("open");
  });

  it("builds the argv the real CLI accepts for every gate read and comment read", async () => {
    // The builders themselves are exercised end to end, so a renamed flag fails
    // here instead of in a live workflow.
    const listResult = await execFileAsync("bd", [...buildGateListArgv(beadId)], { cwd: dir });
    expect(JSON.parse(listResult.stdout || "null")).toBe(null);

    const commentsResult = await execFileAsync("bd", [...buildBeadCommentsArgv(beadId)], {
      cwd: dir,
    });
    expect(JSON.parse(commentsResult.stdout)).toEqual([]);
  });
});
