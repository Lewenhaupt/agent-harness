/**
 * GitHub-primary readiness and gate expiry (bd-180).
 *
 * The point of these cases is the dangerous failure: a stale local gate whose
 * GitHub condition is already met must stop blocking, while a gate GitHub cannot
 * answer keeps the wait. Local mode must stay entirely free of the gh path.
 */
import { describe, expect, it } from "vitest";

import type { GithubGate, GithubGateEvidence, GithubRunEvidence } from "../github-ready.js";
import {
  classifyGates,
  classifyOpenGate,
  computeReady,
  parseGithubGate,
  parseGithubGates,
} from "../github-ready.js";

function gateRecord(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "gate-1",
    status: "open",
    await_type: "human",
    ...overrides,
  };
}

describe("parseGithubGate", () => {
  it("parses human, gh:pr, and gh:run gates", () => {
    expect(parseGithubGate(gateRecord({ await_type: "human" }), "bd-1")).toEqual({
      kind: "human",
      gateId: "gate-1",
      beadId: "bd-1",
    });
    expect(parseGithubGate(gateRecord({ await_type: "gh:pr", await_id: "42" }), "bd-1")).toEqual({
      kind: "gh-pr",
      gateId: "gate-1",
      beadId: "bd-1",
      number: 42,
    });
    expect(parseGithubGate(gateRecord({ await_type: "gh:run", await_id: "ci" }), "bd-1")).toEqual({
      kind: "gh-run",
      gateId: "gate-1",
      beadId: "bd-1",
      run: "ci",
    });
  });

  it("ignores closed, timer, bead, and non-GitHub gates", () => {
    const cases = [
      gateRecord({ status: "closed" }),
      gateRecord({ await_type: "timer" }),
      gateRecord({ await_type: "bead", await_id: "bd-2" }),
      gateRecord({ id: "bd-1" }),
    ];
    for (const record of cases) {
      expect(parseGithubGate(record, "bd-1")).toBeUndefined();
    }
  });

  it("keeps a malformed gh gate as an unknown wait, not a missing gate", () => {
    const pr = parseGithubGate(
      gateRecord({ await_type: "gh:pr", await_id: "not-a-number" }),
      "bd-1",
    );
    expect(pr).toMatchObject({ kind: "unknown", gateId: "gate-1" });
    expect(pr?.kind === "unknown" ? pr.reason : "").toContain("malformed await_id");
    expect(pr?.kind === "unknown" ? pr.reason : "").toContain("not-a-number");

    const run = parseGithubGate(gateRecord({ await_type: "gh:run", await_id: "" }), "bd-1");
    expect(run).toMatchObject({ kind: "unknown" });
    expect(run?.kind === "unknown" ? run.reason : "").toContain("gh:run");
  });

  it("accepts only bd's strict decimal PR id grammar", () => {
    for (const awaitId of ["0x10", "1e3", " 42 ", "+7", "4_2", "0", "-1", "42.0", ""]) {
      const gate = parseGithubGate(gateRecord({ await_type: "gh:pr", await_id: awaitId }), "bd-1");
      expect(gate, awaitId).toMatchObject({ kind: "unknown" });
    }
    expect(parseGithubGate(gateRecord({ await_type: "gh:pr", await_id: "42" }), "bd-1")).toEqual({
      kind: "gh-pr",
      gateId: "gate-1",
      beadId: "bd-1",
      number: 42,
    });
  });

  it("applies the strict grammar to numeric run ids but keeps workflow names", () => {
    expect(
      parseGithubGate(gateRecord({ await_type: "gh:run", await_id: "0" }), "bd-1"),
    ).toMatchObject({ kind: "unknown" });
    expect(
      parseGithubGate(gateRecord({ await_type: "gh:run", await_id: "42" }), "bd-1"),
    ).toMatchObject({ kind: "gh-run", run: "42" });
    expect(
      parseGithubGate(gateRecord({ await_type: "gh:run", await_id: "ci" }), "bd-1"),
    ).toMatchObject({ kind: "gh-run", run: "ci" });
  });

  it("parses a full bd gate list and skips unknown records", () => {
    const gates = parseGithubGates(
      [
        { id: "g-1", status: "open", await_type: "gh:pr", await_id: "3" },
        { id: "g-2", status: "open", await_type: "timer" },
        { id: "g-3", status: "open", await_type: "gh:run", await_id: "ci" },
      ],
      "bd-1",
    );
    expect(gates.map((gate) => gate.kind)).toEqual(["gh-pr", "gh-run"]);
  });

  it("accepts bd's json shapes for the gate list (single object, absent, scalar)", () => {
    expect(parseGithubGates(undefined, "bd-1")).toEqual([]);
    expect(parseGithubGates("not json", "bd-1")).toEqual([]);
    expect(
      parseGithubGates({ id: "g-1", status: "open", await_type: "gh:pr", await_id: "3" }, "bd-1"),
    ).toEqual([{ kind: "gh-pr", gateId: "g-1", beadId: "bd-1", number: 3 }]);
  });

  it("carries created_at only when bd recorded it", () => {
    const withTime = parseGithubGate(
      gateRecord({ await_type: "gh:run", await_id: "ci", created_at: "2026-01-01T00:00:00Z" }),
      "bd-1",
    );
    expect(withTime).toHaveProperty("createdAt", "2026-01-01T00:00:00Z");
    const withoutTime = parseGithubGate(
      gateRecord({ await_type: "gh:run", await_id: "ci" }),
      "bd-1",
    );
    expect(withoutTime).not.toHaveProperty("createdAt");
    // A non-string created_at is dropped rather than coerced into a timestamp.
    const numeric = parseGithubGate(
      gateRecord({ await_type: "gh:run", await_id: "ci", created_at: 1_767_225_600 }),
      "bd-1",
    );
    expect(numeric).not.toHaveProperty("createdAt");
  });
});

describe("classifyOpenGate", () => {
  const evidence: GithubGateEvidence = {
    prs: [
      { number: 1, state: "open", merged: false },
      { number: 2, state: "closed", merged: true },
      { number: 3, state: "closed", merged: false },
    ],
    runs: [
      {
        name: "green",
        createdAt: "2026-02-01T00:00:00Z",
        status: "completed",
        conclusion: "success",
      },
      {
        name: "red",
        createdAt: "2026-02-01T00:00:00Z",
        status: "completed",
        conclusion: "failure",
      },
      {
        name: "running",
        createdAt: "2026-02-01T00:00:00Z",
        status: "in_progress",
        conclusion: null,
      },
      {
        name: "weird",
        createdAt: "2026-02-01T00:00:00Z",
        status: "completed",
        conclusion: "neutral",
      },
    ],
  };

  const human: GithubGate = { kind: "human", gateId: "g", beadId: "bd-1" };

  it("keeps a human gate open (GitHub cannot answer a person)", () => {
    expect(classifyOpenGate(human, evidence)).toBe("open");
  });

  it("classifies PR evidence: merged, closed, open, missing", () => {
    expect(
      classifyOpenGate({ kind: "gh-pr", gateId: "g", beadId: "bd-1", number: 2 }, evidence),
    ).toBe("satisfied-externally");
    expect(
      classifyOpenGate({ kind: "gh-pr", gateId: "g", beadId: "bd-1", number: 3 }, evidence),
    ).toBe("expired");
    expect(
      classifyOpenGate({ kind: "gh-pr", gateId: "g", beadId: "bd-1", number: 1 }, evidence),
    ).toBe("open");
    expect(
      classifyOpenGate({ kind: "gh-pr", gateId: "g", beadId: "bd-1", number: 99 }, evidence),
    ).toBe("unknown");
  });

  it("classifies run evidence: success, failure, running, missing, unknown", () => {
    const runGate = (run: string): GithubGate => ({
      kind: "gh-run",
      gateId: "g",
      beadId: "bd-1",
      run,
      createdAt: "2026-01-01T00:00:00Z",
    });
    expect(classifyOpenGate(runGate("green"), evidence)).toBe("satisfied-externally");
    expect(classifyOpenGate(runGate("red"), evidence)).toBe("expired");
    expect(classifyOpenGate(runGate("running"), evidence)).toBe("open");
    expect(classifyOpenGate(runGate("missing"), evidence)).toBe("unknown");
    expect(classifyOpenGate(runGate("weird"), evidence)).toBe("unknown");
  });

  it("classifies an unknown gate as unknown, never satisfied", () => {
    expect(
      classifyOpenGate(
        { kind: "unknown", gateId: "g", beadId: "bd-1", reason: "malformed" },
        evidence,
      ),
    ).toBe("unknown");
  });

  it("does not read a stale successful run for a newer re-armed gate", () => {
    const gate: GithubGate = {
      kind: "gh-run",
      gateId: "g",
      beadId: "bd-1",
      run: "ci",
      createdAt: "2026-05-01T00:00:00Z",
    };
    const stale: GithubGateEvidence = {
      runs: [
        {
          name: "ci",
          createdAt: "2026-04-01T00:00:00Z",
          status: "completed",
          conclusion: "success",
        },
      ],
    };
    expect(classifyOpenGate(gate, stale)).toBe("unknown");

    const fresh: GithubGateEvidence = {
      runs: [
        {
          name: "ci",
          createdAt: "2026-05-02T00:00:00Z",
          status: "completed",
          conclusion: "success",
        },
      ],
    };
    expect(classifyOpenGate(gate, fresh)).toBe("satisfied-externally");
  });

  it("matches run evidence by run id when the gate names one", () => {
    const gate: GithubGate = {
      kind: "gh-run",
      gateId: "g",
      beadId: "bd-1",
      run: "12345",
      createdAt: "2026-01-01T00:00:00Z",
    };
    expect(
      classifyOpenGate(gate, {
        runs: [
          {
            id: "12345",
            name: "ci",
            createdAt: "2026-02-01T00:00:00Z",
            status: "completed",
            conclusion: "success",
          },
        ],
      }),
    ).toBe("satisfied-externally");
  });

  it("fails closed when the gate timestamp is unparseable", () => {
    const gate: GithubGate = {
      kind: "gh-run",
      gateId: "g",
      beadId: "bd-1",
      run: "ci",
      createdAt: "not-a-date",
    };
    expect(
      classifyOpenGate(gate, {
        runs: [
          {
            name: "ci",
            createdAt: "2026-02-01T00:00:00Z",
            status: "completed",
            conclusion: "success",
          },
        ],
      }),
    ).toBe("unknown");
  });

  it("fails closed when the run timestamp is missing", () => {
    const gate: GithubGate = {
      kind: "gh-run",
      gateId: "g",
      beadId: "bd-1",
      run: "ci",
      createdAt: "2026-01-01T00:00:00Z",
    };
    expect(
      classifyOpenGate(gate, {
        runs: [{ name: "ci", status: "completed", conclusion: "success" }],
      }),
    ).toBe("unknown");
  });

  it("classifies a whole list in order", () => {
    const gates: readonly GithubGate[] = [
      { kind: "gh-pr", gateId: "g-1", beadId: "bd-1", number: 2 },
      { kind: "human", gateId: "g-2", beadId: "bd-1" },
    ];
    expect(classifyGates(gates, evidence).map((entry) => entry.verdict)).toEqual([
      "satisfied-externally",
      "open",
    ]);
  });

  it("expires every failure-like run conclusion", () => {
    for (const conclusion of [
      "failure",
      "cancelled",
      "timed_out",
      "action_required",
      "stale",
      "startup_failure",
    ]) {
      expect(
        classifyOpenGate(
          {
            kind: "gh-run",
            gateId: "g",
            beadId: "bd-1",
            run: "ci",
            createdAt: "2026-01-01T00:00:00Z",
          },
          {
            runs: [
              {
                name: "ci",
                createdAt: "2026-02-01T00:00:00Z",
                status: "completed",
                conclusion,
              },
            ],
          },
        ),
        conclusion,
      ).toBe("expired");
    }
  });

  it("treats a completed run with no conclusion as unknown, not open", () => {
    // GitHub can report `completed` before the conclusion is visible; that is an
    // evidence gap, so it keeps the wait instead of reporting progress.
    expect(
      classifyOpenGate(
        {
          kind: "gh-run",
          gateId: "g",
          beadId: "bd-1",
          run: "ci",
          createdAt: "2026-01-01T00:00:00Z",
        },
        { runs: [{ name: "ci", createdAt: "2026-02-01T00:00:00Z", status: "completed" }] },
      ),
    ).toBe("unknown");
  });

  it("takes the newest matching run when several share the name", () => {
    const gate: GithubGate = {
      kind: "gh-run",
      gateId: "g",
      beadId: "bd-1",
      run: "ci",
      createdAt: "2026-05-01T00:00:00Z",
    };
    const olderFailure: GithubRunEvidence = {
      name: "ci",
      createdAt: "2026-05-02T00:00:00Z",
      status: "completed",
      conclusion: "failure",
    };
    const newerSuccess: GithubRunEvidence = {
      name: "ci",
      createdAt: "2026-05-03T00:00:00Z",
      status: "completed",
      conclusion: "success",
    };
    // Order in the evidence array must not decide the verdict.
    expect(classifyOpenGate(gate, { runs: [olderFailure, newerSuccess] })).toBe(
      "satisfied-externally",
    );
    expect(classifyOpenGate(gate, { runs: [newerSuccess, olderFailure] })).toBe(
      "satisfied-externally",
    );

    const olderSuccess: GithubRunEvidence = {
      name: "ci",
      createdAt: "2026-05-02T00:00:00Z",
      status: "completed",
      conclusion: "success",
    };
    const newerFailure: GithubRunEvidence = {
      name: "ci",
      createdAt: "2026-05-03T00:00:00Z",
      status: "completed",
      conclusion: "failure",
    };
    // The newest run is the gate's answer, even when an older one succeeded.
    expect(classifyOpenGate(gate, { runs: [olderSuccess, newerFailure] })).toBe("expired");
    expect(classifyOpenGate(gate, { runs: [newerFailure, olderSuccess] })).toBe("expired");
  });

  it("ignores every candidate run when all of them predate the gate", () => {
    expect(
      classifyOpenGate(
        {
          kind: "gh-run",
          gateId: "g",
          beadId: "bd-1",
          run: "ci",
          createdAt: "2026-05-01T00:00:00Z",
        },
        {
          runs: [
            {
              name: "ci",
              createdAt: "2026-04-01T00:00:00Z",
              status: "completed",
              conclusion: "success",
            },
            {
              name: "ci",
              createdAt: "2026-03-01T00:00:00Z",
              status: "completed",
              conclusion: "failure",
            },
          ],
        },
      ),
    ).toBe("unknown");
  });

  it("accepts a run whose timestamp equals the gate's", () => {
    expect(
      classifyOpenGate(
        {
          kind: "gh-run",
          gateId: "g",
          beadId: "bd-1",
          run: "ci",
          createdAt: "2026-05-01T00:00:00Z",
        },
        {
          runs: [
            {
              name: "ci",
              createdAt: "2026-05-01T00:00:00Z",
              status: "completed",
              conclusion: "success",
            },
          ],
        },
      ),
    ).toBe("satisfied-externally");
  });

  it("fails closed when the gate timestamp is absent entirely", () => {
    expect(
      classifyOpenGate(
        { kind: "gh-run", gateId: "g", beadId: "bd-1", run: "ci" },
        {
          runs: [
            {
              name: "ci",
              createdAt: "2026-02-01T00:00:00Z",
              status: "completed",
              conclusion: "success",
            },
          ],
        },
      ),
    ).toBe("unknown");
  });

  it("fails closed when the run timestamp is unparseable", () => {
    expect(
      classifyOpenGate(
        {
          kind: "gh-run",
          gateId: "g",
          beadId: "bd-1",
          run: "ci",
          createdAt: "2026-01-01T00:00:00Z",
        },
        {
          runs: [
            {
              name: "ci",
              createdAt: "not-a-date",
              status: "completed",
              conclusion: "success",
            },
          ],
        },
      ),
    ).toBe("unknown");
  });

  it("fails closed when neither side carries a timestamp", () => {
    expect(
      classifyOpenGate(
        { kind: "gh-run", gateId: "g", beadId: "bd-1", run: "ci" },
        { runs: [{ name: "ci", status: "completed", conclusion: "success" }] },
      ),
    ).toBe("unknown");
  });

  it("does not match a run whose id and name both differ from the gate", () => {
    expect(
      classifyOpenGate(
        {
          kind: "gh-run",
          gateId: "g",
          beadId: "bd-1",
          run: "12345",
          createdAt: "2026-01-01T00:00:00Z",
        },
        {
          runs: [
            {
              id: "999",
              name: "ci",
              createdAt: "2026-02-01T00:00:00Z",
              status: "completed",
              conclusion: "success",
            },
          ],
        },
      ),
    ).toBe("unknown");
  });
});

describe("computeReady", () => {
  const base = { beadId: "bd-1", evidence: {} } as const;

  it("frees readiness when a stale gh:pr gate is already merged", () => {
    const result = computeReady({
      authority: "github",
      ...base,
      blockedBy: [],
      gates: [{ kind: "gh-pr", gateId: "g", beadId: "bd-1", number: 7 }],
      evidence: { prs: [{ number: 7, state: "closed", merged: true }] },
    });
    expect(result).toHaveProperty("ready", true);
    if (!result.ready) return;
    expect(result.reason).toBe("unblocked");
    expect(result.clearedGates).toEqual([
      { kind: "gh-pr", gateId: "g", beadId: "bd-1", number: 7 },
    ]);
  });

  it("expires a gate whose GitHub condition failed and frees readiness", () => {
    const result = computeReady({
      authority: "github",
      ...base,
      blockedBy: [],
      gates: [
        {
          kind: "gh-run",
          gateId: "g",
          beadId: "bd-1",
          run: "ci",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
      evidence: {
        runs: [
          {
            name: "ci",
            createdAt: "2026-02-01T00:00:00Z",
            status: "completed",
            conclusion: "failure",
          },
        ],
      },
    });
    expect(result).toHaveProperty("ready", true);
    if (!result.ready) return;
    expect(result.clearedGates).toHaveLength(1);
  });

  it("keeps the wait when GitHub has no answer for the gate", () => {
    const result = computeReady({
      authority: "github",
      ...base,
      blockedBy: [],
      gates: [{ kind: "gh-pr", gateId: "g", beadId: "bd-1", number: 7 }],
      evidence: {},
    });
    expect(result).toHaveProperty("ready", false);
    if (result.ready) return;
    expect(result.reason).toBe("waiting-on-gate");
    if (result.reason !== "waiting-on-gate") return;
    expect(result.verdict).toBe("unknown");
  });

  it("keeps the wait for an unparsable gh gate instead of reporting unblocked", () => {
    const gate = parseGithubGate(
      { id: "g", status: "open", await_type: "gh:pr", await_id: "oops" },
      "bd-1",
    );
    expect(gate).toMatchObject({ kind: "unknown" });
    const result = computeReady({
      authority: "github",
      ...base,
      blockedBy: [],
      gates: gate === undefined ? [] : [gate],
      evidence: {},
    });
    expect(result).toHaveProperty("ready", false);
    if (result.ready) return;
    expect(result.reason).toBe("waiting-on-gate");
    if (result.reason !== "waiting-on-gate") return;
    expect(result.verdict).toBe("unknown");
  });

  it("waits on an open GitHub blockedBy edge before any gate", () => {
    const result = computeReady({
      authority: "github",
      ...base,
      blockedBy: [
        { dependsOnBeadId: "bd-2", state: "open" },
        { dependsOnBeadId: "bd-3", state: "unknown" },
        { dependsOnBeadId: "bd-4", state: "closed" },
      ],
      gates: [],
      evidence: {},
    });
    expect(result).toHaveProperty("ready", false);
    if (result.ready) return;
    expect(result.reason).toBe("blocked-by");
    if (result.reason !== "blocked-by") return;
    expect(result.blockers).toEqual(["bd-2", "bd-3"]);
  });

  it("keeps a human gate blocking", () => {
    const result = computeReady({
      authority: "github",
      ...base,
      blockedBy: [],
      gates: [{ kind: "human", gateId: "g", beadId: "bd-1" }],
      evidence: {},
    });
    expect(result).toHaveProperty("ready", false);
  });

  it("local mode is unchanged and never reads a gh gate or evidence", () => {
    // A gh:pr gate and an empty evidence set would be "unknown" (blocking) in
    // GitHub mode; under bd authority the gh path must not run at all.
    const result = computeReady({
      authority: "bd",
      ...base,
      blockedBy: [{ dependsOnBeadId: "bd-2", state: "closed" }],
      gates: [{ kind: "gh-pr", gateId: "g", beadId: "bd-1", number: 7 }],
      evidence: {},
    });
    expect(result).toEqual({ ready: true, reason: "unblocked", clearedGates: [] });
  });

  it("local mode still reports a blocked-by edge with no gh path", () => {
    const result = computeReady({
      authority: "bd",
      ...base,
      blockedBy: [{ dependsOnBeadId: "bd-2", state: "open" }],
      gates: [],
      evidence: {},
    });
    expect(result).toEqual({
      ready: false,
      reason: "blocked-by",
      blockers: ["bd-2"],
      clearedGates: [],
    });
  });

  it("is ready with no edges and no gates", () => {
    const result = computeReady({
      authority: "github",
      ...base,
      blockedBy: [],
      gates: [],
      evidence: {},
    });
    expect(result).toEqual({ ready: true, reason: "unblocked", clearedGates: [] });
  });

  it("never frees the wait when the gh evidence is empty", () => {
    // Every GitHub-side read failure (gh absent, unauthenticated, rate-limited,
    // unparsable) reaches this module as absent evidence; none of them may read
    // as an answer, so all three gate kinds keep the wait.
    const gates: readonly GithubGate[] = [
      { kind: "gh-pr", gateId: "g-1", beadId: "bd-1", number: 7 },
      {
        kind: "gh-run",
        gateId: "g-2",
        beadId: "bd-1",
        run: "ci",
        createdAt: "2026-01-01T00:00:00Z",
      },
      { kind: "unknown", gateId: "g-3", beadId: "bd-1", reason: "malformed await_id" },
      { kind: "human", gateId: "g-4", beadId: "bd-1" },
    ];
    for (const gate of gates) {
      const result = computeReady({
        authority: "github",
        ...base,
        blockedBy: [],
        gates: [gate],
        evidence: {},
      });
      expect(result, gate.gateId).toHaveProperty("ready", false);
      if (result.ready) continue;
      expect(result.reason).toBe("waiting-on-gate");
      expect(result.clearedGates).toEqual([]);
    }
  });

  it("reports cleared gates even while an open edge still blocks the bead", () => {
    const cleared: GithubGate = { kind: "gh-pr", gateId: "g", beadId: "bd-1", number: 7 };
    const result = computeReady({
      authority: "github",
      ...base,
      blockedBy: [{ dependsOnBeadId: "bd-2", state: "open" }],
      gates: [cleared],
      evidence: { prs: [{ number: 7, state: "closed", merged: true }] },
    });
    expect(result).toHaveProperty("ready", false);
    if (result.ready) return;
    expect(result.reason).toBe("blocked-by");
    if (result.reason !== "blocked-by") return;
    expect(result.blockers).toEqual(["bd-2"]);
    expect(result.clearedGates).toEqual([cleared]);
  });

  it("reports the first still-waiting gate and skips cleared ones before it", () => {
    const cleared: GithubGate = { kind: "gh-pr", gateId: "g-1", beadId: "bd-1", number: 7 };
    const waiting: GithubGate = { kind: "human", gateId: "g-2", beadId: "bd-1" };
    const later: GithubGate = { kind: "gh-pr", gateId: "g-3", beadId: "bd-1", number: 8 };
    const result = computeReady({
      authority: "github",
      ...base,
      blockedBy: [],
      gates: [cleared, waiting, later],
      evidence: {
        prs: [
          { number: 7, state: "closed", merged: true },
          { number: 8, state: "open", merged: false },
        ],
      },
    });
    expect(result).toHaveProperty("ready", false);
    if (result.ready) return;
    expect(result.reason).toBe("waiting-on-gate");
    if (result.reason !== "waiting-on-gate") return;
    expect(result.gate).toEqual(waiting);
    expect(result.verdict).toBe("open");
    expect(result.clearedGates).toEqual([cleared]);
  });
});
