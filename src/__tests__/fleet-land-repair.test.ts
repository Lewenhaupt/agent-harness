/**
 * The repair-round classifier (bd-277).
 *
 * Pure: a reason in, a decision out. The point of these tests is the *partition* —
 * every `FleetMergeFailureReason` lands on exactly one side — because the whole fix
 * rests on a refusal the member can repair getting a round and a contradiction
 * keeping the terminal stop it had.
 */

import { describe, expect, it } from "vitest";
import {
  boundLandRepairRefusal,
  boundLandRepairText,
  FLEET_LAND_REPAIR_GRACE_MS,
  FLEET_REPAIRABLE_LAND_REFUSALS,
  fleetLandRepairTask,
  formatLandRepairStatus,
  isRepairableLandRefusal,
  LAND_REPAIR_REFUSAL_MAX_CHARS,
  LAND_REPAIR_TASK_MAX_LENGTH,
  MAX_LAND_REPAIR_ATTEMPTS,
  planLandRepair,
} from "../fleet-land-repair.js";
import type { FleetMergeFailureReason } from "../fleet-merge.js";
import { FLEET_MERGE_FAILURE_REASONS } from "../fleet-merge.js";
import { FLEET_NOTE_BODY_MAX_LENGTH } from "../fleet-state.js";

/** The reasons AC 3 names as still terminal, spelled out rather than derived. */
const TERMINAL_BY_AC: readonly FleetMergeFailureReason[] = [
  "rebase-failed",
  "fleet-paused",
  "queue-unreadable",
  "intent-unreadable",
  "lock-unavailable",
  "no-queued-entry",
  "entry-not-queued",
  "queue-write-failed",
  "intent-write-failed",
];

describe("isRepairableLandRefusal", () => {
  it("classifies every enumerated reason, so a new one cannot pass unclassified", () => {
    // The classifier's `never` default makes a new reason a typecheck failure; this
    // is the runtime half, so a reason added *and* typed as `string` by accident
    // still shows up as an unclassified value rather than a silent `false`.
    for (const reason of FLEET_MERGE_FAILURE_REASONS) {
      expect(typeof isRepairableLandRefusal(reason)).toBe("boolean");
    }
    const repairable = FLEET_MERGE_FAILURE_REASONS.filter(isRepairableLandRefusal);
    expect(repairable.sort()).toEqual([...FLEET_REPAIRABLE_LAND_REFUSALS].sort());
  });

  it("repairs exactly the refusals a commit in the member's own diff can clear", () => {
    expect([...FLEET_REPAIRABLE_LAND_REFUSALS].sort()).toEqual([
      "gate-failed",
      "paths-outside-scope",
      "proof-artifacts-in-diff",
    ]);
    for (const reason of FLEET_REPAIRABLE_LAND_REFUSALS) {
      expect(isRepairableLandRefusal(reason)).toBe(true);
    }
  });

  it("keeps a real conflict, a paused fleet and a queue/state error terminal", () => {
    for (const reason of TERMINAL_BY_AC) {
      expect(isRepairableLandRefusal(reason)).toBe(false);
    }
    // The complete set, not just the AC's examples: a delegation is already the
    // member's own work, and the rest are the supervisor's or the operator's.
    const terminal = FLEET_MERGE_FAILURE_REASONS.filter(
      (reason) => !isRepairableLandRefusal(reason),
    );
    expect(terminal.sort()).toEqual(
      FLEET_MERGE_FAILURE_REASONS.filter(
        (reason) => !FLEET_REPAIRABLE_LAND_REFUSALS.includes(reason),
      ).sort(),
    );
    expect(terminal).toContain("rebase-delegated");
    expect(terminal).toContain("member-worktree-dirty");
    expect(terminal).toContain("step-failed");
  });

  it("classifies by reason, never by what the refusal text happens to say", () => {
    // A conflict-shaped reason is terminal even when somebody words the refusal like
    // a proof problem, and a proof refusal is repairable even when its text talks
    // about a rebase: the drain's enumerated verdict is the artefact we control, and
    // prose is model- and caller-dependent text.
    const misleading = planLandRepair({ reason: "rebase-failed", attemptsSoFar: 0 });
    expect(misleading.kind).toBe("stop");
    expect(planLandRepair({ reason: "proof-artifacts-in-diff", attemptsSoFar: 0 })).toEqual({
      kind: "repair",
    });
  });
});

describe("planLandRepair", () => {
  it("repairs the first refusal of a repairable kind", () => {
    expect(planLandRepair({ reason: "proof-artifacts-in-diff", attemptsSoFar: 0 })).toEqual({
      kind: "repair",
    });
    expect(planLandRepair({ reason: "gate-failed", attemptsSoFar: 0 })).toEqual({ kind: "repair" });
  });

  it("stops on a second refusal after the one repair round", () => {
    const plan = planLandRepair({ reason: "proof-artifacts-in-diff", attemptsSoFar: 1 });
    expect(plan.kind).toBe("stop");
    if (plan.kind !== "stop") return;
    // A provenance *prefix*, so a long refusal cannot push it out of the bounded stop
    // detail (bd-277 review W2).
    expect(plan.detail.startsWith("repair 1 of 1 did not clear this")).toBe(true);
    expect(plan.detail).toContain("proof-artifacts-in-diff");
    // The one round is the whole budget: there is no second repair at attempts 2.
    expect(MAX_LAND_REPAIR_ATTEMPTS).toBe(1);
    expect(planLandRepair({ reason: "gate-failed", attemptsSoFar: 2 }).kind).toBe("stop");
  });

  it("stops immediately for a refusal no commit can change", () => {
    const plan = planLandRepair({ reason: "rebase-failed", attemptsSoFar: 0 });
    expect(plan.kind).toBe("stop");
    if (plan.kind !== "stop") return;
    expect(plan.detail).toContain("rebase-failed");
    expect(plan.detail).toContain("own diff");
  });
});

describe("fleetLandRepairTask", () => {
  it("carries the refusal verbatim and names the same refused paths", () => {
    const refusal =
      "publish gate refused: proof-artifacts-in-diff: docs/proof/run.png, docs/proof/log.txt;" +
      " proof is uploaded, never published as files";
    const task = fleetLandRepairTask({
      taskId: "bd-12",
      reason: "proof-artifacts-in-diff",
      refusal,
      paths: ["docs/proof/run.png", "docs/proof/log.txt"],
    });
    expect(task).toContain(refusal);
    expect(task).toContain("proof-artifacts-in-diff");
    expect(task).toContain("- docs/proof/run.png");
    expect(task).toContain("- docs/proof/log.txt");
    expect(task).toContain("Refused paths (2)");
    expect(task).toContain("Fix only the refused paths in your own diff");
    expect(task).toContain("Commit the fix on the same branch");
    expect(task).toContain("Do not merge");
    expect(task).toContain("bead's scope");
    // The instructions lead: they are the round's contract and must never be the
    // truncated half (bd-277 review W3).
    expect(task.startsWith("# Repair the refused landing of bd-12\n\n## What to do")).toBe(true);
    // A short refusal needs no truncation marker and no honest-count line.
    expect(task).not.toContain("did not fit");
    expect(task).not.toContain("…");
  });

  it("omits the path section when the refusal named none", () => {
    const task = fleetLandRepairTask({
      taskId: "bd-15",
      reason: "gate-failed",
      refusal: "gate `test` failed",
    });
    expect(task).not.toContain("Refused paths");
    expect(task).toContain("gate `test` failed");
  });

  it("fits a 50-path refusal into the note budget with the instructions intact", () => {
    // The note body is truncated at `FLEET_NOTE_BODY_MAX_LENGTH` on write, so a task
    // that is longer than that loses its tail — and its tail used to be the contract
    // (bd-277 review W3). The instruction block must survive whole, the refusal must be
    // present and bounded, and the path list must state how many paths it actually
    // names rather than claiming completeness.
    const paths = Array.from(
      { length: 50 },
      (_, index) => `docs/proof/run-${String(index).padStart(3, "0")}-capture.png`,
    );
    const refusal = `publish gate refused: proof-artifacts-in-diff: ${Array.from(
      { length: 50 },
      (_, index) => `C:evidencecapture-${index}.png is not allowed`,
    ).join("; ")}`;
    expect(refusal.length).toBeGreaterThan(FLEET_NOTE_BODY_MAX_LENGTH);
    const task = fleetLandRepairTask({
      taskId: "bd-12",
      reason: "proof-artifacts-in-diff",
      refusal,
      paths,
    });

    expect(LAND_REPAIR_TASK_MAX_LENGTH).toBeLessThanOrEqual(FLEET_NOTE_BODY_MAX_LENGTH);
    expect(task.length).toBeLessThanOrEqual(FLEET_NOTE_BODY_MAX_LENGTH);
    // The instructions, verbatim, in every case.
    for (const line of [
      "# Repair the refused landing of bd-12",
      "## What to do",
      "- Fix only the refused paths in your own diff. Nothing outside them belongs to this task.",
      "- Commit the fix on the same branch you already work on. Do not merge, do not rebase onto the base branch, and do not touch any other branch.",
      "- Do not change the bead's scope (its title, plan, or acceptance), and do not edit the fleet record.",
      "- When the fix is committed, end your turn: the fleet drains the same entry again.",
      "This is a single repair round (the fleet asks 1 time(s)). If the landing is refused again after your commit, the member stops for a human instead of asking again.",
    ]) {
      expect(task).toContain(line);
    }
    // The refusal is present but bounded, and the list states its own honesty.
    expect(task).toContain("publish gate refused: proof-artifacts-in-diff:");
    expect(task).toContain("…");
    expect(task).toMatch(/Refused paths \(\d+ of 50, the rest did not fit\):/);
    // Every path the list names is whole: a cut path would send the member hunting.
    const named = task.split("\n").filter((line) => line.startsWith("- docs/proof/"));
    expect(named.length).toBeGreaterThan(0);
    for (const line of named) expect(paths).toContain(line.slice(2));
  });
});

describe("formatLandRepairStatus", () => {
  it("renders the attempt count against the budget", () => {
    expect(formatLandRepairStatus({ attempts: 1, refusal: "publish gate refused" })).toBe(
      "repair 1 of 1 — publish gate refused",
    );
  });

  it("bounds a long refusal on one line", () => {
    const refusal = `publish gate refused: ${"docs/proof/".repeat(80)}`;
    const rendered = formatLandRepairStatus({ attempts: 1, refusal });
    expect(rendered.length).toBeLessThanOrEqual(LAND_REPAIR_REFUSAL_MAX_CHARS + 20);
    expect(rendered).toContain("repair 1 of 1 — ");
    expect(rendered.endsWith("…")).toBe(true);
    expect(rendered).not.toContain("\n");
    expect(boundLandRepairRefusal("  a\nb  ")).toBe("a b");
  });

  it("bounds a text to an explicit budget, never splitting a path", () => {
    // The budgeted form is what a stop detail and a repair task reserve room with, so
    // the cut is a word boundary and the result never exceeds the budget.
    const text = "gate refused: docs/proof/a.png docs/proof/b.png docs/proof/c.png";
    const bounded = boundLandRepairText(text, 40);
    expect(bounded.length).toBeLessThanOrEqual(40);
    expect(bounded.endsWith("…")).toBe(true);
    expect(text.startsWith(bounded.slice(0, -1))).toBe(true);
    expect(boundLandRepairText("short", 400)).toBe("short");
  });

  it("keeps the grace long enough for a gated repair but bounded", () => {
    expect(FLEET_LAND_REPAIR_GRACE_MS).toBe(30 * 60 * 1000);
  });
});
