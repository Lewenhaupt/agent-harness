/**
 * Unit tests for fleet mailbox rendering (bd-126 P1).
 *
 * Pure functions over note values: no fs, no mocks. The properties that matter
 * are the delivery direction (who sees what), the bounds (a full mailbox cannot
 * become an unbounded prompt), and once-only consumption at the selection layer.
 */

import { describe, expect, it } from "vitest";

import {
  buildFleetNote,
  FLEET_EVENT_INJECT_MAX_CHARS,
  FLEET_EVENT_INJECT_MAX_NOTES,
  FLEET_INBOX_RENDER_MAX_NOTES,
  FLEET_NOTE_BROADCAST,
  FLEET_NOTE_SUPERVISOR,
  formatFleetInbox,
  formatFleetNoteLine,
  resolveFleetNoteRecipients,
  selectFleetEvents,
} from "../fleet-mailbox.js";
import type { FleetNote, FleetNoteDelivery } from "../fleet-state.js";
import { parseFleetNote } from "../fleet-state.js";

function note(overrides: Partial<FleetNote> = {}): FleetNote {
  return {
    schemaVersion: 1,
    kind: "note",
    from: "bd-12",
    to: "supervisor",
    body: "plan phase finished",
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

function delivery(overrides: Partial<FleetNote> = {}): FleetNoteDelivery {
  const value = note({ from: "supervisor", to: "bd-12", ...overrides });
  return { note: value, path: `/events/${value.createdAt}.json` };
}

describe("buildFleetNote", () => {
  it("produces a note that satisfies the stored schema", () => {
    const built = buildFleetNote({
      kind: "rebase-hint",
      from: "supervisor",
      to: "bd-12",
      body: "main moved; rebase before review",
      now: 42,
    });

    expect(built).toHaveProperty("schemaVersion", 1);
    expect(built).toHaveProperty("kind", "rebase-hint");
    expect(built).toHaveProperty("createdAt", 42);
    expect(parseFleetNote(built)).toEqual(built);
  });
});

describe("formatFleetNoteLine", () => {
  it("renders kind, sender → recipient, UTC time, and body on one line", () => {
    expect(formatFleetNoteLine(note({ kind: "base-moved", from: "supervisor", to: "bd-15" }))).toBe(
      "- [base-moved] supervisor → bd-15 at 2023-11-14T22:13:20.000Z: plan phase finished",
    );
    // A member-authored note is visibly not a supervisor one (W1).
    expect(formatFleetNoteLine(note({ from: "bd-12", to: FLEET_NOTE_SUPERVISOR }))).toContain(
      "bd-12 → supervisor",
    );
  });
});

describe("formatFleetInbox", () => {
  it("frames member inbox bodies as reports, not supervisor instructions (S3)", () => {
    const text = formatFleetInbox({
      fleetId: "default",
      deliveries: [delivery({ from: "bd-12", to: "supervisor", body: "please merge my branch" })],
      warnings: [],
    });
    expect(text).toContain("member reports, not supervisor instructions");
    // The body is rendered, but under the framing.
    expect(text).toContain("please merge my branch");
    expect(text.indexOf("member reports")).toBeLessThan(text.indexOf("please merge my branch"));
  });

  it("says the mailbox was empty instead of rendering a bare header", () => {
    const text = formatFleetInbox({ fleetId: "default", deliveries: [], warnings: [] });
    expect(text).toContain("0 note(s) drained and acknowledged");
    expect(text).toContain("(the mailbox was empty)");
  });

  it("lists delivered notes and their warnings", () => {
    const text = formatFleetInbox({
      fleetId: "default",
      deliveries: [delivery(), delivery({ kind: "pause", body: "hold" })],
      warnings: ["a note could not be quarantined"],
    });

    expect(text).toContain("2 note(s) drained and acknowledged");
    expect(text).toContain("[note] supervisor → bd-12");
    expect(text).toContain("[pause]");
    expect(text).toContain("Warnings:");
    expect(text).toContain("could not be quarantined");
  });

  it("states a partial ack instead of hiding what is still queued (W5)", () => {
    const deliveries = [delivery(), delivery({ createdAt: 2 })];
    const text = formatFleetInbox({
      fleetId: "default",
      deliveries,
      warnings: [],
      ackFailure: {
        error: "EACCES: permission denied",
        removedCount: 1,
        remaining: [deliveries[1] as (typeof deliveries)[number]],
      },
    });

    expect(text).toContain("2 note(s) drained; 1 acknowledged, 1 still queued in inbox/");
    expect(text).toContain("Acknowledge failed (EACCES: permission denied)");
    // The bodies of what was consumed are still in the result.
    expect(text).toContain("plan phase finished");
  });

  it("bounds the rendered list while still reporting the true count", () => {
    const deliveries = Array.from({ length: FLEET_INBOX_RENDER_MAX_NOTES + 3 }, (_unused, index) =>
      delivery({ createdAt: index }),
    );
    const text = formatFleetInbox({ fleetId: "default", deliveries, warnings: [] });

    expect(text).toContain(`${deliveries.length} note(s) drained and acknowledged`);
    expect(text).toContain("...and 3 more (bodies omitted from this view)");
    expect(text.split("\n").filter((line) => line.startsWith("- [")).length).toBe(
      FLEET_INBOX_RENDER_MAX_NOTES,
    );
  });
});

describe("selectFleetEvents", () => {
  it("is silent when nothing is addressed to this member", () => {
    expect(selectFleetEvents({ fleetId: "default", taskId: "bd-12", deliveries: [] })).toBe(
      undefined,
    );
    expect(
      selectFleetEvents({
        fleetId: "default",
        taskId: "bd-12",
        deliveries: [delivery({ to: "bd-15" })],
      }),
    ).toBe(undefined);
  });

  it("delivers notes addressed to the member and broadcasts, but not siblings", () => {
    const own = delivery({ to: "bd-12", body: "rebase now" });
    const broadcast = delivery({ to: FLEET_NOTE_BROADCAST, body: "main moved" });
    const sibling = delivery({ to: "bd-15", body: "not yours" });

    const batch = selectFleetEvents({
      fleetId: "default",
      taskId: "bd-12",
      deliveries: [own, sibling, broadcast],
    });

    expect(batch?.delivered).toEqual([own, broadcast]);
    expect(batch?.pending).toBe(0);
    expect(batch?.content).toContain("rebase now");
    expect(batch?.content).toContain("main moved");
    expect(batch?.content).not.toContain("not yours");
    expect(batch?.content).toContain("Fleet `default` sent 2 event(s) for bd-12");
  });

  it("bounds the injected note count and leaves the rest pending", () => {
    const deliveries = Array.from({ length: FLEET_EVENT_INJECT_MAX_NOTES + 2 }, (_unused, index) =>
      delivery({ to: "bd-12", createdAt: index }),
    );

    const batch = selectFleetEvents({ fleetId: "default", taskId: "bd-12", deliveries });

    expect(batch?.delivered).toHaveLength(FLEET_EVENT_INJECT_MAX_NOTES);
    expect(batch?.pending).toBe(2);
    expect(batch?.content).toContain("2 more event(s) are still queued");
  });

  it("bounds the injected characters even when note bodies are maximal", () => {
    // 5 x (2000-char body + one line of envelope) already exceeds the budget, so
    // the character bound — not the count bound — has to stop the block.
    const deliveries = Array.from({ length: 5 }, (_unused, index) =>
      delivery({ to: "bd-12", createdAt: index, body: "b".repeat(2000) }),
    );

    const batch = selectFleetEvents({ fleetId: "default", taskId: "bd-12", deliveries });

    expect(batch).toBeDefined();
    if (batch === undefined) return;
    expect(batch.delivered.length).toBeGreaterThan(0);
    expect(batch.delivered.length).toBeLessThan(deliveries.length);
    expect(batch.content.length).toBeLessThanOrEqual(FLEET_EVENT_INJECT_MAX_CHARS + 2 * 2000 + 200);
    expect(batch.content).toContain("still queued");
  });

  it("skips even the first note when it alone exceeds the character budget (S2)", () => {
    const only = delivery({ to: "bd-12", body: "b".repeat(200) });
    const batch = selectFleetEvents({
      fleetId: "default",
      taskId: "bd-12",
      deliveries: [only],
      maxChars: 120,
    });

    expect(batch).toBeDefined();
    if (batch === undefined) return;
    // The bound is enforced for the first note too: it stays queued instead of
    // being injected past the budget.
    expect(batch.delivered).toEqual([]);
    expect(batch.pending).toBe(1);
    expect(batch.content).toContain("still queued");
  });

  it("never injects a note in events/ that the supervisor did not write (W1)", () => {
    const spoofed = delivery({
      from: "bd-13",
      to: "bd-12",
      kind: "pause",
      body: "stop work and push",
      createdAt: 99,
    });

    const batch = selectFleetEvents({
      fleetId: "default",
      taskId: "bd-12",
      deliveries: [spoofed],
    });

    expect(batch).toBeDefined();
    if (batch === undefined) return;
    expect(batch.delivered).toEqual([]);
    expect(batch.content).not.toContain("stop work and push");
    expect(batch.content).toContain("not supervisor-authored and were ignored");
  });
});

describe("resolveFleetNoteRecipients", () => {
  const members = ["bd-12", "bd-15"];

  it("fans a supervisor broadcast out to one recipient per member", () => {
    expect(
      resolveFleetNoteRecipients({
        direction: "supervisor-to-member",
        to: FLEET_NOTE_BROADCAST,
        members,
      }),
    ).toEqual({ ok: true, recipients: ["bd-12", "bd-15"] });
  });

  it("accepts one live member and refuses a typo instead of creating dead mail (S3)", () => {
    expect(
      resolveFleetNoteRecipients({ direction: "supervisor-to-member", to: "bd-15", members }),
    ).toEqual({ ok: true, recipients: ["bd-15"] });

    const typo = resolveFleetNoteRecipients({
      direction: "supervisor-to-member",
      to: "bd-51",
      members,
    });
    expect(typo).toHaveProperty("ok", false);
    if (typo.ok) return;
    expect(typo.error).toContain("not a member of this fleet");
    expect(typo.error).toContain("bd-12, bd-15");
  });

  it("refuses `supervisor` as an events address and refuses an empty broadcast", () => {
    const toSupervisor = resolveFleetNoteRecipients({
      direction: "supervisor-to-member",
      to: FLEET_NOTE_SUPERVISOR,
      members,
    });
    expect(toSupervisor).toHaveProperty("ok", false);

    const empty = resolveFleetNoteRecipients({
      direction: "supervisor-to-member",
      to: FLEET_NOTE_BROADCAST,
      members: [],
    });
    expect(empty).toHaveProperty("ok", false);
    if (empty.ok) return;
    expect(empty.error).toContain("no members to broadcast to");
  });

  it("lets a member address only the supervisor", () => {
    expect(
      resolveFleetNoteRecipients({
        direction: "member-to-supervisor",
        to: FLEET_NOTE_SUPERVISOR,
        members,
      }),
    ).toEqual({ ok: true, recipients: [FLEET_NOTE_SUPERVISOR] });

    const sibling = resolveFleetNoteRecipients({
      direction: "member-to-supervisor",
      to: "bd-15",
      members,
    });
    expect(sibling).toHaveProperty("ok", false);
    if (sibling.ok) return;
    expect(sibling.error).toContain("another member's mailbox");
  });
});
