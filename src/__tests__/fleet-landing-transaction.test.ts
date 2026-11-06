/**
 * The landing transaction (bd-281 round 7).
 *
 * Round 5/6 moved every fleet fact into the repository store; this is the write that
 * commits a landing's facts **together**: the member marked landed on the run, the
 * member pruned out of the intent, the ordering-gate records it resolved, the audit
 * row and the intent revision bump. The store owns the `BEGIN IMMEDIATE`; the tests
 * here drive the real store through a real `gitCommonDir`, so the rollback they assert
 * is SQLite's, not a mock's.
 *
 * The merge and the bd gate calls live outside this transaction by design (git and bd
 * cannot join it), so nothing here stubs them: the landing is exercised as the pure
 * plan fold it is.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recordRunMemberLanded, startFleetRun } from "../fleet-run.js";
import {
  createFleetIntent,
  dropFleetOrderingGates,
  landFleetMember,
  pruneLandedFleetMember,
  readFleetIntent,
  readRecentFleetAuditEntries,
  writeFleetIntent,
} from "../index.js";
import { openRepoStateStore, repoStatePathForCommonDir } from "../repo-state-store.js";

const fleetId = "fleet-1";
const now = 1_700_000_000_000;

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A temp git common dir with one seeded fleet row: three members, two gate records. */
function seedFleet(): string {
  const gitCommonDir = mkdtempSync(join(tmpdir(), "belayd-landing-"));
  cleanup.push(gitCommonDir);
  const run = startFleetRun({
    now,
    accept: false,
    members: [{ taskId: "bd-12" }, { taskId: "bd-15" }, { taskId: "bd-99" }],
  });
  const written = writeFleetIntent({
    gitCommonDir,
    fleetId,
    intent: {
      ...createFleetIntent({
        fleetId,
        taskIds: ["bd-12", "bd-15", "bd-99"],
        now,
        baseBranch: "main",
      }),
      orderingGates: [
        { blocker: "bd-12", blocked: "bd-99", gateId: "bd-900" },
        { blocker: "bd-15", blocked: "bd-99", gateId: "bd-901" },
      ],
      run,
    },
  });
  if (!written.ok) throw new Error(written.error);
  return gitCommonDir;
}

/** The stored row's revision, read through a second handle on the same file. */
function revisionOf(gitCommonDir: string): number {
  const opened = openRepoStateStore({ path: repoStatePathForCommonDir(gitCommonDir) });
  if (!opened.ok) throw new Error(opened.error);
  try {
    const row = opened.store.readFleet(fleetId);
    if (!row.ok || row.value === null) throw new Error("fleet row unreadable");
    return row.value.revision;
  } finally {
    opened.store.close();
  }
}

/** Every audit row for the fleet, oldest first. */
function auditRows(gitCommonDir: string) {
  return readRecentFleetAuditEntries({ gitCommonDir, fleetId, since: 0 });
}

/** The stored record, throwing when it is not readable. */
function record(gitCommonDir: string) {
  const loaded = readFleetIntent({ gitCommonDir, fleetId });
  if (!loaded.ok || loaded.intent === undefined) throw new Error("intent unreadable");
  return loaded.intent;
}

describe("the landing transaction", () => {
  it("folds two landings and two gate-record drops into exactly one revision bump", () => {
    const gitCommonDir = seedFleet();
    const before = revisionOf(gitCommonDir);

    const landed = landFleetMember({
      gitCommonDir,
      fleetId,
      now,
      plan: ({ intent, run }) => {
        if (run === undefined) return { kind: "conflict", error: "no run record" };
        const pruned = pruneLandedFleetMember(
          pruneLandedFleetMember(intent, "bd-12", now),
          "bd-15",
          now,
        );
        const marked = recordRunMemberLanded({
          run: recordRunMemberLanded({ run, taskId: "bd-12", now }),
          taskId: "bd-15",
          now,
        });
        return {
          kind: "write",
          intent: dropFleetOrderingGates(pruned, ["bd-900", "bd-901"], now),
          run: marked,
        };
      },
      audit: {
        timestamp: now,
        fleetId,
        actor: "session-1",
        action: "fleet-landed",
        taskIds: ["bd-12", "bd-15"],
        detail: "landed two members in one transaction",
      },
    });

    // ONE bump for the whole landing: the store applies the plan once, so neither the
    // second member nor the second gate record can bump it again.
    expect(landed).toHaveProperty("ok", true);
    if (!landed.ok) return;
    expect(landed.revision).toBe(before + 1);
    expect(revisionOf(gitCommonDir)).toBe(before + 1);

    const stored = record(gitCommonDir);
    expect(stored.taskIds).toEqual(["bd-99"]);
    expect(stored.orderingGates).toBeUndefined();
    const landedMembers = (stored.run?.members ?? []).filter(
      (member) => member.landedAt !== undefined,
    );
    expect(landedMembers.map((member) => member.taskId).sort()).toEqual(["bd-12", "bd-15"]);
    // The unlanded member keeps its slot: a landing only forgets what it landed.
    expect((stored.run?.members ?? []).find((member) => member.taskId === "bd-99")?.landedAt).toBe(
      undefined,
    );

    // The audit row committed with it, once.
    const landings = auditRows(gitCommonDir).filter((entry) => entry.action === "fleet-landed");
    expect(landings).toHaveLength(1);
    expect(landings[0]?.taskIds).toEqual(["bd-12", "bd-15"]);
  });

  it("rolls back completely when the plan refuses", () => {
    const gitCommonDir = seedFleet();
    const before = revisionOf(gitCommonDir);
    const beforeRecord = record(gitCommonDir);
    const beforeAudit = auditRows(gitCommonDir).length;

    const refused = landFleetMember({
      gitCommonDir,
      fleetId,
      now,
      plan: () => ({ kind: "conflict", error: "the stored run was replaced" }),
      audit: {
        timestamp: now,
        fleetId,
        actor: "session-1",
        action: "fleet-landed",
        taskIds: ["bd-12"],
        detail: "must never be written",
      },
    });

    expect(refused).toHaveProperty("ok", false);
    expect(refused).toHaveProperty("reason", "conflict");

    // Nothing committed: no bump, no pruned member, no dropped gate record, no run
    // mark and — the part a separate audit write would have got wrong — no audit row.
    expect(revisionOf(gitCommonDir)).toBe(before);
    const stored = record(gitCommonDir);
    expect(stored.taskIds).toEqual(beforeRecord.taskIds);
    expect(stored.orderingGates).toEqual(beforeRecord.orderingGates);
    expect(stored.run?.members).toEqual(beforeRecord.run?.members);
    expect(auditRows(gitCommonDir)).toHaveLength(beforeAudit);
  });

  it("rolls back a plan whose record would be refused by the schema", () => {
    const gitCommonDir = seedFleet();
    const before = revisionOf(gitCommonDir);
    const beforeAudit = auditRows(gitCommonDir).length;

    const refused = landFleetMember({
      gitCommonDir,
      fleetId,
      now,
      plan: ({ intent, run }) => ({
        kind: "write",
        // An intent no reader accepts: the wrapper validates before it writes, so this
        // is the same all-or-nothing path as a caller's own refusal.
        intent: { ...intent, baseBranch: "", taskIds: [...intent.taskIds] },
        run: run ?? startFleetRun({ now, accept: false, members: [{ taskId: "bd-12" }] }),
      }),
      audit: {
        timestamp: now,
        fleetId,
        actor: "session-1",
        action: "fleet-landed",
        taskIds: ["bd-12"],
        detail: "must never be written",
      },
    });

    expect(refused).toHaveProperty("ok", false);
    expect(refused).toHaveProperty("reason", "write-failed");
    expect(revisionOf(gitCommonDir)).toBe(before);
    expect(record(gitCommonDir).taskIds).toEqual(["bd-12", "bd-15", "bd-99"]);
    expect(auditRows(gitCommonDir)).toHaveLength(beforeAudit);
  });
});
