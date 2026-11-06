/**
 * Unit tests for fleet pause/resume (bd-126 P4).
 *
 * Mutations are asserted on the record that actually landed in the in-memory
 * fleet fs, and every call is checked against `audit.log`: pausing or resuming is a
 * cross-tree authority decision, so "it happened but was not audited" is a failure.
 */

import { describe, expect, it } from "vitest";
import { pauseFleet, resumeFleet } from "../fleet-pause.js";
import type { FleetStateFs } from "../fleet-state.js";
import { readRecentFleetAuditEntries } from "../fleet-state.js";
import type { FleetIntent } from "../fleet-status.js";
import { FLEET_SCHEMA_VERSION } from "../fleet-status.js";
import type { RepoStateStore } from "../repo-state-store.js";
import { createFakeFleetFs } from "./helpers/fake-fleet-fs.js";

const commonDir = "/repo/.git";
const fleetId = "default";

function seed(options: Partial<FleetIntent> = {}): ReturnType<typeof createFakeFleetFs> {
  const fs = createFakeFleetFs();
  // bd-281: the intent is a store row, so the fixture seeds the row the real
  // `writeFleetIntent` would have written.
  const written = fs.store.writeFleetIntent({
    fleetId,
    intent: {
      schemaVersion: 1,
      fleetId,
      taskIds: ["bd-12", "bd-15"],
      createdAt: 1,
      updatedAt: 1,
      baseBranch: "main",
      ...options,
    },
  });
  if (!written.ok) throw new Error(written.error);
  return fs;
}

function intentOf(fs: ReturnType<typeof createFakeFleetFs>): FleetIntent {
  const row = fs.store.readFleet(fleetId);
  return (row.ok && row.value !== null ? row.value.intent : {}) as FleetIntent;
}

/** Seed a row this version cannot parse (a newer schema, a torn write). */
function seedCorrupt(fs: ReturnType<typeof createFakeFleetFs>, raw: string): void {
  const written = fs.store.writeFleetIntent({ fleetId, intent: raw });
  if (!written.ok) throw new Error(written.error);
}

function rowOf(fs: ReturnType<typeof createFakeFleetFs>): unknown {
  const row = fs.store.readFleet(fleetId);
  return row.ok ? row.value?.intent : undefined;
}

/** The fs with an intent store that fails to read (S1/F2 cases). */
function unreadableStore(fs: ReturnType<typeof createFakeFleetFs>): FleetStateFs {
  return {
    ...fs,
    store: {
      ...fs.store,
      readFleet: () => ({ ok: false, error: "EIO: cannot read intent" }),
    } satisfies RepoStateStore,
  };
}

function auditActions(fs: FleetStateFs & { files: Map<string, string> }): string[] {
  // bd-281: audit entries are store rows, not lines in audit.log.
  return readRecentFleetAuditEntries({ gitCommonDir: commonDir, fleetId, since: 0, fs }).map(
    (entry) => entry.action,
  );
}

describe("pauseFleet", () => {
  it("sets the flag and the reason, and audits it", () => {
    const fs = seed();
    const paused = pauseFleet({
      gitCommonDir: commonDir,
      fleetId,
      sessionId: "supervisor-session",
      now: 100,
      reason: "operator is stepping away",
      fs,
    });

    expect(paused).toHaveProperty("ok", true);
    const intent = intentOf(fs);
    expect(intent.paused).toBe(true);
    expect(intent.note).toBe("operator is stepping away");
    expect(intent.updatedAt).toBe(100);
    expect(auditActions(fs)).toEqual(["fleet-paused"]);
    expect(paused.ok && paused.text).toContain("belayd_fleet_resume");
  });

  it("does not rewrite the reason when the fleet is already paused", () => {
    const fs = seed({ paused: true, note: "first reason" });
    const paused = pauseFleet({
      gitCommonDir: commonDir,
      fleetId,
      sessionId: "supervisor-session",
      now: 200,
      reason: "second reason",
      fs,
    });

    expect(paused).toHaveProperty("ok", true);
    if (!paused.ok) return;
    expect(paused.alreadyPaused).toBe(true);
    expect(intentOf(fs).note).toBe("first reason");
    expect(auditActions(fs)).toEqual([]);
  });

  it("refuses when there is no fleet intent", () => {
    const fs = createFakeFleetFs();
    const paused = pauseFleet({
      gitCommonDir: commonDir,
      fleetId,
      sessionId: "supervisor-session",
      now: 100,
      fs,
    });
    expect(paused).toHaveProperty("ok", false);
    if (paused.ok) return;
    expect(paused.reason).toBe("no-intent");
  });
});

describe("resumeFleet", () => {
  it("clears paused, park, and note through the CAS path, audited", () => {
    const fs = seed({
      paused: true,
      note: "root restore conflicted",
      park: { reason: "root restore conflicted", recordedAt: 5 },
    });
    const resumed = resumeFleet({
      gitCommonDir: commonDir,
      fleetId,
      sessionId: "supervisor-session",
      now: 300,
      fs,
    });

    expect(resumed).toHaveProperty("ok", true);
    if (!resumed.ok) return;
    expect(resumed.unparked).toBe(true);
    // The fields are removed, not set to false: a resumed fleet carries no stale
    // park reason for `belayd_fleet_status` to report.
    const intent = intentOf(fs);
    expect(intent).not.toHaveProperty("paused");
    expect(intent).not.toHaveProperty("park");
    expect(intent).not.toHaveProperty("note");
    expect(intent.updatedAt).toBe(300);
    expect(auditActions(fs)).toEqual(["fleet-resumed", "fleet-unparked"]);
  });

  it("refuses to clear a park that still names a stash, naming the way out", () => {
    const fs = seed({
      paused: true,
      park: { reason: "restore conflicted", stashRef: "abc123", recordedAt: 5 },
    });
    const resumed = resumeFleet({
      gitCommonDir: commonDir,
      fleetId,
      sessionId: "supervisor-session",
      now: 300,
      fs,
    });

    expect(resumed).toHaveProperty("ok", false);
    if (resumed.ok) return;
    expect(resumed.reason).toBe("parked-stash");
    expect(resumed.error).toContain("belayd_fleet_reconcile");
    expect(resumed.error).toContain("abc123");
    // Nothing changed, and the refusal is in the history.
    expect(intentOf(fs).paused).toBe(true);
    expect(auditActions(fs)).toContain("fleet-resume-refused");
  });

  it("clears a parked fleet with force and leaves the stash alone", () => {
    const fs = seed({
      paused: true,
      park: { reason: "restore conflicted", stashRef: "abc123", recordedAt: 5 },
    });
    const resumed = resumeFleet({
      gitCommonDir: commonDir,
      fleetId,
      sessionId: "supervisor-session",
      now: 300,
      force: true,
      fs,
    });

    expect(resumed).toHaveProperty("ok", true);
    if (!resumed.ok) return;
    expect(resumed.text).toContain("abc123");
    expect(resumed.text).toContain("nothing was deleted");
    expect(intentOf(fs)).not.toHaveProperty("park");
    expect(auditActions(fs)).toEqual(["fleet-resumed", "fleet-unparked"]);
  });

  it("reports a fleet that is not paused as already running", () => {
    const fs = seed();
    const resumed = resumeFleet({
      gitCommonDir: commonDir,
      fleetId,
      sessionId: "supervisor-session",
      now: 300,
      fs,
    });
    expect(resumed).toHaveProperty("ok", true);
    if (!resumed.ok) return;
    expect(resumed.alreadyResumed).toBe(true);
    expect(resumed.text).toContain("already running");
  });

  it("reports an already-running fleet as a successful no-op (S4)", () => {
    const fs = seed();
    const resumed = resumeFleet({
      gitCommonDir: commonDir,
      fleetId,
      sessionId: "supervisor-session",
      now: 300,
      fs,
    });
    expect(resumed).toHaveProperty("ok", true);
    if (!resumed.ok) return;
    expect(resumed.alreadyResumed).toBe(true);
    expect(resumed.unparked).toBe(false);
    expect(resumed.text).toContain("already running");
    // Nothing new happened, so the history stays clean — mirroring pause, which
    // also skips `fleet-paused` when it was already paused.
    expect(auditActions(fs)).toEqual([]);
    expect(intentOf(fs).updatedAt).toBe(1);
  });

  it("forwards a read failure as a read failure, not a write failure (S1)", () => {
    const fs = seed();
    const paused = pauseFleet({
      gitCommonDir: commonDir,
      fleetId,
      sessionId: "supervisor-session",
      now: 100,
      fs: unreadableStore(fs),
    });
    expect(paused).toHaveProperty("ok", false);
    if (paused.ok) return;
    expect(paused.reason).toBe("read-failed");
    expect(paused.error).toContain("cannot read intent");
  });

  it("leaves every other intent field untouched", () => {
    // A v2 record on purpose: the frozen landing contract is present, so the
    // resume must carry it rather than re-derive (or drop) it.
    const fs = seed({
      schemaVersion: FLEET_SCHEMA_VERSION,
      paused: true,
      maxConcurrent: 2,
      baseBranch: "trunk",
      publish: { mode: "pr", remote: "origin", base: "trunk" },
      supervisor: { sessionId: "supervisor-session", pid: 4242, armToken: "token" },
      deferred: [{ taskId: "bd-19", reason: "capacity", detail: "no slot" }],
    });
    resumeFleet({
      gitCommonDir: commonDir,
      fleetId,
      sessionId: "supervisor-session",
      now: 300,
      fs,
    });

    const intent = intentOf(fs);
    expect(intent.taskIds).toEqual(["bd-12", "bd-15"]);
    expect(intent.maxConcurrent).toBe(2);
    expect(intent.baseBranch).toBe("trunk");
    expect(intent.publish).toEqual({ mode: "pr", remote: "origin", base: "trunk" });
    expect(intent.createdAt).toBe(1);
    expect(intent.deferred).toEqual([{ taskId: "bd-19", reason: "capacity", detail: "no slot" }]);
  });

  it("reports a corrupt intent as corrupt-intent on resume, and never overwrites it (F2)", () => {
    const fs = seed();
    // A record this version cannot parse may have been written by a newer schema:
    // replacing it would erase operator intent, and calling it a write failure
    // would send the operator to the wrong remedy.
    seedCorrupt(fs, "{not json");

    const resumed = resumeFleet({
      gitCommonDir: commonDir,
      fleetId,
      sessionId: "supervisor-session",
      now: 300,
      fs,
    });

    expect(resumed).toHaveProperty("ok", false);
    if (resumed.ok) return;
    expect(resumed.reason).toBe("corrupt-intent");
    expect(resumed.error).toContain("not a fleet intent");
    expect(rowOf(fs)).toBe("{not json");
    expect(auditActions(fs)).toEqual(["fleet-resume-refused"]);
  });

  it("forwards a read failure as a read failure on resume, not a write failure (F2)", () => {
    const fs = seed({ paused: true });
    const resumed = resumeFleet({
      gitCommonDir: commonDir,
      fleetId,
      sessionId: "supervisor-session",
      now: 300,
      fs: unreadableStore(fs),
    });

    expect(resumed).toHaveProperty("ok", false);
    if (resumed.ok) return;
    expect(resumed.reason).toBe("read-failed");
    expect(resumed.error).toContain("cannot read intent");
  });

  it("refuses to resume a fleet with no intent record", () => {
    const fs = createFakeFleetFs();
    const resumed = resumeFleet({
      gitCommonDir: commonDir,
      fleetId,
      sessionId: "supervisor-session",
      now: 300,
      fs,
    });

    expect(resumed).toHaveProperty("ok", false);
    if (resumed.ok) return;
    expect(resumed.reason).toBe("no-intent");
    expect(resumed.error).toContain("no fleet intent");
    // No intent row was invented for a fleet that does not exist; the refusal
    // itself is the only thing written, so it is discoverable in the history.
    expect(fs.store.readFleet(fleetId)).toHaveProperty("value", null);
    // Nothing was written to the fake filesystem: the refusal is an audit row.
    expect([...fs.files.keys()]).toEqual([]);
    expect(auditActions(fs)).toEqual(["fleet-resume-refused"]);
  });

  it("surfaces a failed audit append as a warning instead of undoing the pause", () => {
    const fs = seed();
    // The flag is the enforceable half; a broken audit.log must not roll it back.
    fs.store = {
      ...fs.store,
      appendAudit: () => ({ ok: false, error: "EIO: audit store is read-only" }),
    };

    const paused = pauseFleet({
      gitCommonDir: commonDir,
      fleetId,
      sessionId: "supervisor-session",
      now: 100,
      fs,
    });

    expect(paused).toHaveProperty("ok", true);
    if (!paused.ok) return;
    expect(paused.warnings.join("\n")).toContain("could not append the audit entry");
    expect(paused.warnings.join("\n")).toContain("EIO");
    expect(intentOf(fs).paused).toBe(true);
  });

  it("surfaces a failed audit append on resume and still unparks", () => {
    const fs = seed({
      paused: true,
      park: { reason: "root restore conflicted", recordedAt: 5 },
    });
    fs.store = {
      ...fs.store,
      appendAudit: () => ({ ok: false, error: "EIO: audit store is read-only" }),
    };

    const resumed = resumeFleet({
      gitCommonDir: commonDir,
      fleetId,
      sessionId: "supervisor-session",
      now: 300,
      fs,
    });

    expect(resumed).toHaveProperty("ok", true);
    if (!resumed.ok) return;
    expect(resumed.unparked).toBe(true);
    expect(resumed.warnings.join("\n")).toContain("could not append the audit entry");
    expect(intentOf(fs)).not.toHaveProperty("park");
  });

  it("never overwrites a corrupt intent record, on pause or on resume", () => {
    // A record the supervisor cannot read is refused, not replaced: overwriting it
    // would erase operator intent (task list, supervisor identity, park pointer).
    const corrupt = "{not json";
    const fs = createFakeFleetFs();
    seedCorrupt(fs, corrupt);

    const paused = pauseFleet({
      gitCommonDir: commonDir,
      fleetId,
      sessionId: "supervisor-session",
      now: 100,
      fs,
    });
    expect(paused).toHaveProperty("ok", false);
    expect(rowOf(fs)).toBe(corrupt);

    const resumed = resumeFleet({
      gitCommonDir: commonDir,
      fleetId,
      sessionId: "supervisor-session",
      now: 300,
      fs,
    });
    expect(resumed).toHaveProperty("ok", false);
    expect(rowOf(fs)).toBe(corrupt);
  });
});
