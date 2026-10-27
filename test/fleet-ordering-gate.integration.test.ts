/**
 * Fleet ordering gates against a real `bd` (bd-158).
 *
 * The unit suites stub `bd`, so they can only prove the argv the harness builds
 * against what bd *should* answer. This test runs the real CLI in a throwaway
 * database and pins the property the whole design rests on: **resolving a gate
 * does not touch the work bead**.
 *
 * Concretely, the dependent is blocked while the blocker is `in_progress`, and
 * returns to `bd ready` the moment the gate is resolved — while `bd show` still
 * reports the blocker `in_progress`. That is what lets `accept` default to false:
 * ordering is the gate's job, acceptance stays the human's `bd close`.
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
  createFleetOrderingGates,
  lookupOpenHumanGate,
  resolveFleetOrderingGates,
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
    // Every write in this suite names no actor: keep the operator's identity and
    // the global default out of the audit trail.
    env: { ...process.env, BEADS_ACTOR: "" },
  });
  return { stdout: result.stdout };
}

async function bd(cwd: string, argv: readonly string[]): Promise<string> {
  const result = await execFileAsync("bd", [...argv], {
    cwd,
    env: { ...process.env, BEADS_ACTOR: "" },
  });
  return result.stdout;
}

/**
 * Ids from a `bd … --json` payload.
 *
 * `bd create` answers one record, `bd ready`/`bd show` answer an array, so both
 * shapes are accepted (the harness parsers do the same).
 */
function idsFromJson(stdout: string): string[] {
  const parsed: unknown = JSON.parse(stdout || "[]");
  const records = Array.isArray(parsed) ? parsed : [parsed];
  return records.flatMap((record) =>
    typeof record === "object" &&
    record !== null &&
    typeof (record as { id?: unknown }).id === "string"
      ? [(record as { id: string }).id]
      : [],
  );
}

async function createBead(cwd: string, title: string): Promise<string> {
  const created = await bd(cwd, ["create", title, "-t", "task", "--json"]);
  const id = idsFromJson(created)[0];
  if (id === undefined) throw new Error(`bd created no readable id for ${title}`);
  return id;
}

/** stderr of a rejected `execFile` promise, without trusting the rejection shape. */
function stderrOf(error: unknown): string {
  if (typeof error !== "object" || error === null || !("stderr" in error)) return "";
  const stderr: unknown = error.stderr;
  return typeof stderr === "string" ? stderr : "";
}

describe.skipIf(!bdAvailable)("fleet ordering gates against a real bd", () => {
  let dir: string;
  let blocker: string;
  let dependent: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "belayd-ordering-gates-it-"));
    await bd(dir, ["init"]);
    blocker = await createBead(dir, "blocker");
    dependent = await createBead(dir, "dependent");
    // Deliberately no `bd dep add`: the gate IS the ordering relationship, which
    // is the trade-off bd-158 accepts. A plain `blocks` edge would keep blocking
    // the dependent after the gate resolves, because bd derives blocked-ness from
    // the blocker bead's status — the exact behaviour this design replaces.
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lands the blocker's gate without touching either bead", async () => {
    const created = await createFleetOrderingGates({
      fleetId: "default",
      taskIds: [blocker, dependent],
      edges: [{ blocker, blocked: dependent }],
      cwd: dir,
      runBd,
    });
    if (!created.ok) throw new Error(created.error);
    expect(created.gates).toHaveLength(1);
    const gate = created.gates[0];
    if (gate === undefined) throw new Error("no gate recorded");

    // The blocker is actively being worked, exactly the state that used to make
    // the fleet close a bead just to unblock its dependent.
    await bd(dir, ["update", blocker, "--status", "in_progress"]);

    const blockedWhileWorking = await bd(dir, ["blocked"]);
    expect(blockedWhileWorking).toContain(dependent);
    expect(idsFromJson(await bd(dir, ["ready", "--json"]))).not.toContain(dependent);

    // The fleet's ordering gate is not a human question: the bd-152 human-wait
    // reader must report "no human gate" and name the member instead.
    const human = await lookupOpenHumanGate({ beadId: dependent, cwd: dir, runBd });
    if (!human.ok) throw new Error(human.error);
    expect(human).toMatchObject({ ok: true, status: "none", orderingBlocker: blocker });

    const resolved = await resolveFleetOrderingGates({ gates: created.gates, cwd: dir, runBd });
    expect(resolved).toEqual({ ok: true, resolved: created.gates, remaining: [] });

    // The dependent is free again, and the blocker's bead is untouched: gate
    // resolved, bead still in_progress. Two objects, two verbs.
    expect(await bd(dir, ["blocked"])).not.toContain(dependent);
    expect(idsFromJson(await bd(dir, ["ready", "--json"]))).toContain(dependent);
    const blockerRecord = JSON.parse(await bd(dir, ["show", blocker, "--json"])) as Array<{
      status?: string;
    }>;
    expect(blockerRecord[0]?.status).toBe("in_progress");

    // Idempotent: a supervisor retrying after a crash succeeds again (bd 1.3.0
    // exits 0 on a second resolve, so nothing has to guess).
    const again = await resolveFleetOrderingGates({ gates: created.gates, cwd: dir, runBd });
    expect(again).toEqual({ ok: true, resolved: created.gates, remaining: [] });
  });

  it("tolerates only bd's exact unknown-gate answer, which it captures here", async () => {
    // W2 grounds the predicate in the real CLI: the text a live gate resolve never
    // produces is `gate not found: <id>`, and *that* is the only failure treated as
    // already resolved. Anything wider would swallow a database or lock error.
    const created = await createFleetOrderingGates({
      fleetId: "default",
      taskIds: [blocker, dependent],
      edges: [{ blocker, blocked: dependent }],
      cwd: dir,
      runBd,
    });
    if (!created.ok) throw new Error(created.error);
    const recorded = created.gates[0];
    if (recorded === undefined) throw new Error("no gate recorded");

    // The real exchange, captured rather than assumed: a second resolve succeeds.
    await bd(dir, ["gate", "resolve", recorded.gateId]);
    const second = await resolveFleetOrderingGates({ gates: [recorded], cwd: dir, runBd });
    expect(second.ok).toBe(true);

    // An id bd never minted is an error whose text names that id.
    const unknownId = `${blocker}-gate-does-not-exist`;
    const failure: unknown = await execFileAsync("bd", ["gate", "resolve", unknownId], {
      cwd: dir,
    }).catch((error: unknown) => error);
    expect(stderrOf(failure)).toContain(`gate not found: ${unknownId}`);

    const vanished = await resolveFleetOrderingGates({
      gates: [{ ...recorded, gateId: unknownId }],
      cwd: dir,
      runBd,
    });
    expect(vanished).toEqual({
      ok: true,
      resolved: [{ ...recorded, gateId: unknownId }],
      remaining: [],
    });
  });
});
