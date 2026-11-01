/**
 * GitHub-primary readiness and stale-gate expiry (bd-180).
 *
 * Ready means: every GitHub `blockedBy` edge is closed, and every open local
 * gate is still genuinely waiting. The dangerous failure is the opposite — a
 * local gate whose GitHub condition was satisfied long ago still blocking the
 * bead — because the projection then reports "blocked" forever while GitHub says
 * the work is unblocked. Re-checking the gate's external condition, and expiring
 * it when GitHub proves it is done, is the fix; an actor label alone cannot
 * detect it.
 *
 * Gate kinds are read from bd's own records (bd 1.3.0: `human`, `gh:run`,
 * `gh:pr`). The `human` kind stays open by definition: GitHub cannot answer a
 * person's question (that channel is bd-182). A `gh:pr`/`gh:run` gate is matched
 * against injected evidence, and an answer that is not in the evidence is
 * `unknown`, which never frees the wait. Degrade, do not guess.
 *
 * Local mode (`authority:"bd"`) is unchanged and never reaches GitHub state: it
 * computes readiness from the local blocked-by edges alone.
 */

import { gateRecordList, openHumanGateFromRecord } from "./bead-gates.js";
import type { GithubAuthority } from "./github-authority.js";

/** A gate the projection understands, with its external condition made explicit. */
export type GithubGate =
  | { kind: "human"; gateId: string; beadId: string }
  | { kind: "gh-run"; gateId: string; beadId: string; run: string; createdAt?: string }
  | { kind: "gh-pr"; gateId: string; beadId: string; number: number; createdAt?: string }
  /** A GitHub gate whose `await_id` could not be parsed: never treated as absent. */
  | { kind: "unknown"; gateId: string; beadId: string; reason: string };

/** What GitHub says about one gate's external condition. */
export type GithubGateVerdict = "open" | "satisfied-externally" | "expired" | "unknown";

/** One PR as injected evidence (REST-shaped, narrowed). */
export interface GithubPrEvidence {
  number: number;
  state: "open" | "closed";
  merged: boolean;
}

/** One Actions run as injected evidence. `conclusion` is null while running. */
export interface GithubRunEvidence {
  name: string;
  /** The run/check id when the evidence carries one; stronger than a name. */
  id?: string;
  createdAt?: string;
  status?: "queued" | "in_progress" | "completed";
  conclusion?: string | null;
}

/** The external facts a gate is classified against. */
export interface GithubGateEvidence {
  prs?: readonly GithubPrEvidence[];
  runs?: readonly GithubRunEvidence[];
}

/** bd's own id grammar: decimal digits only, positive, no sign/space/exponent. */
const DECIMAL_ID = /^\d+$/u;

/** Parse a strict decimal id, or undefined for any looser spelling. */
function parseDecimalId(value: unknown): number | undefined {
  if (typeof value !== "string" || !DECIMAL_ID.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

/**
 * A run identity: a strict decimal run id when the value is all digits, or a
 * workflow name otherwise. A numeric-looking id that fails the strict grammar
 * is malformed rather than silently retargeted.
 */
function parseRunIdentity(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  if (!DECIMAL_ID.test(value)) return value;
  const number = parseDecimalId(value);
  return number === undefined ? undefined : number.toString();
}

function parseGhPrGate(
  gateId: string,
  beadId: string,
  awaitId: unknown,
  createdAt: string | undefined,
): GithubGate {
  const number = parseDecimalId(awaitId);
  if (number === undefined) {
    return unknownGate(gateId, beadId, "gh:pr", awaitId);
  }
  return {
    kind: "gh-pr",
    gateId,
    beadId,
    number,
    ...(createdAt === undefined ? {} : { createdAt }),
  };
}

function parseGhRunGate(
  gateId: string,
  beadId: string,
  awaitId: unknown,
  createdAt: string | undefined,
): GithubGate {
  const run = parseRunIdentity(awaitId);
  if (run === undefined) {
    return unknownGate(gateId, beadId, "gh:run", awaitId);
  }
  return {
    kind: "gh-run",
    gateId,
    beadId,
    run,
    ...(createdAt === undefined ? {} : { createdAt }),
  };
}

/**
 * Parse one bd gate record into a gate the projection understands.
 *
 * Only `open` records count, and the blocked bead's own id is rejected as a gate
 * id (same rule as the human-answer channel). `timer` and `bead` gates are not
 * GitHub conditions and are ignored here; ordering is handled by the fleet.
 */
export function parseGithubGate(
  record: Record<string, unknown>,
  beadId: string,
): GithubGate | undefined {
  const human = openHumanGateFromRecord(record, beadId);
  if (human !== undefined) return { kind: "human", gateId: human.gateId, beadId };

  const gateId = record.id;
  if (typeof gateId !== "string" || gateId === "" || gateId === beadId) return undefined;
  if (record.status !== "open") return undefined;

  const createdAt = typeof record.created_at === "string" ? record.created_at : undefined;
  const awaitId = record.await_id;
  if (record.await_type === "gh:pr") return parseGhPrGate(gateId, beadId, awaitId, createdAt);
  if (record.await_type === "gh:run") return parseGhRunGate(gateId, beadId, awaitId, createdAt);
  return undefined;
}

/**
 * A malformed GitHub gate is not a missing gate.
 *
 * Dropping it would let `computeReady` report `unblocked` while a real wait is
 * open, so the parse failure is carried as an `unknown` gate: it names the bad
 * `await_id` and keeps blocking until someone fixes or resolves it.
 */
function unknownGate(
  gateId: string,
  beadId: string,
  awaitType: "gh:pr" | "gh:run",
  awaitId: unknown,
): GithubGate {
  const rendered = typeof awaitId === "string" ? `"${awaitId}"` : "(missing)";
  return {
    kind: "unknown",
    gateId,
    beadId,
    reason: `${awaitType} gate has a malformed await_id ${rendered}`,
  };
}

/** Every gate the projection understands in `bd gate list <bead> --json` output. */
export function parseGithubGates(raw: unknown, beadId: string): readonly GithubGate[] {
  const gates: GithubGate[] = [];
  for (const record of gateRecordList(raw)) {
    const gate = parseGithubGate(record, beadId);
    if (gate !== undefined) gates.push(gate);
  }
  return gates;
}

const EXPIRED_RUN_CONCLUSIONS: readonly string[] = [
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
  "stale",
  "startup_failure",
];

function classifyPrGate(
  gate: Extract<GithubGate, { kind: "gh-pr" }>,
  evidence: GithubGateEvidence,
): GithubGateVerdict {
  const pr = (evidence.prs ?? []).find((candidate) => candidate.number === gate.number);
  if (pr === undefined) return "unknown";
  if (pr.merged) return "satisfied-externally";
  return pr.state === "closed" ? "expired" : "open";
}

function runMatchesGate(run: GithubRunEvidence, gate: Extract<GithubGate, { kind: "gh-run" }>) {
  return run.name === gate.run || (run.id !== undefined && run.id === gate.run);
}

/**
 * Whether the run is provably not older than the gate.
 *
 * Fail closed: a missing or unparseable timestamp on either side returns false,
 * so the run cannot satisfy the gate. The freshness guard exists precisely to
 * stop a stale success from answering a re-armed gate; "I cannot prove it is
 * fresh" must not read as "fresh".
 */
function runIsNotOlderThanGate(
  run: GithubRunEvidence,
  gate: Extract<GithubGate, { kind: "gh-run" }>,
): boolean {
  if (gate.createdAt === undefined || run.createdAt === undefined) return false;
  const gateTimeInMs = Date.parse(gate.createdAt);
  const runTimeInMs = Date.parse(run.createdAt);
  if (!Number.isFinite(gateTimeInMs) || !Number.isFinite(runTimeInMs)) return false;
  return runTimeInMs >= gateTimeInMs;
}

function runTime(run: GithubRunEvidence): number {
  if (run.createdAt === undefined) return 0;
  const timeInMs = Date.parse(run.createdAt);
  return Number.isFinite(timeInMs) ? timeInMs : 0;
}

function classifyRunGate(
  gate: Extract<GithubGate, { kind: "gh-run" }>,
  evidence: GithubGateEvidence,
): GithubGateVerdict {
  const matching = (evidence.runs ?? []).filter(
    (run) => runMatchesGate(run, gate) && runIsNotOlderThanGate(run, gate),
  );
  // A re-armed gate must not read a stale success from an earlier run of the
  // same workflow name: take the newest matching run, and no run at all when
  // every candidate predates the gate.
  const run = matching.reduce<GithubRunEvidence | undefined>(
    (latest, candidate) =>
      latest === undefined || runTime(candidate) > runTime(latest) ? candidate : latest,
    undefined,
  );
  if (run === undefined) return "unknown";
  if (run.conclusion === "success") return "satisfied-externally";
  if (run.conclusion !== null && run.conclusion !== undefined) {
    return EXPIRED_RUN_CONCLUSIONS.includes(run.conclusion) ? "expired" : "unknown";
  }
  return run.status === "completed" ? "unknown" : "open";
}

/**
 * Classify one gate against GitHub evidence.
 *
 * `satisfied-externally` frees the wait (GitHub proves the condition is met).
 * `expired` frees it too, but as a distinct outcome: the condition can never be
 * met any more (PR closed unmerged, run failed), so the projection reports the
 * gate instead of stalling forever. `unknown` deliberately does NOT free: a
 * missing PR/run in the evidence is an evidence gap, not a green light.
 */
export function classifyOpenGate(
  gate: GithubGate,
  evidence: GithubGateEvidence,
): GithubGateVerdict {
  switch (gate.kind) {
    case "human":
      return "open";
    case "gh-pr":
      return classifyPrGate(gate, evidence);
    case "gh-run":
      return classifyRunGate(gate, evidence);
    case "unknown":
      return "unknown";
  }
}

/** One gate plus its verdict, in the order the gates were read. */
export interface GithubGateClassification {
  gate: GithubGate;
  verdict: GithubGateVerdict;
}

/** Classify a whole gate list deterministically. */
export function classifyGates(
  gates: readonly GithubGate[],
  evidence: GithubGateEvidence,
): readonly GithubGateClassification[] {
  return gates.map((gate) => ({ gate, verdict: classifyOpenGate(gate, evidence) }));
}

/**
 * One GitHub `blockedBy` edge as readiness sees it.
 *
 * `unknown` (the dependency issue could not be read) keeps the bead blocked:
 * the same degrade rule as an unknown gate.
 */
export interface GithubBlockedByEdge {
  dependsOnBeadId: string;
  state: "open" | "closed" | "unknown";
}

/** Input for {@link computeReady}; every fact is injected. */
export interface ComputeGithubReadyInput {
  authority: GithubAuthority;
  beadId: string;
  blockedBy: readonly GithubBlockedByEdge[];
  gates: readonly GithubGate[];
  evidence: GithubGateEvidence;
}

/** Why a bead is or is not ready. */
export type GithubReadyResult =
  | { ready: true; reason: "unblocked"; clearedGates: readonly GithubGate[] }
  | {
      ready: false;
      reason: "blocked-by";
      blockers: readonly string[];
      clearedGates: readonly GithubGate[];
    }
  | {
      ready: false;
      reason: "waiting-on-gate";
      gate: GithubGate;
      verdict: "open" | "unknown";
      clearedGates: readonly GithubGate[];
    };

function openBlockers(blockedBy: readonly GithubBlockedByEdge[]): readonly string[] {
  return blockedBy.filter((edge) => edge.state !== "closed").map((edge) => edge.dependsOnBeadId);
}

/**
 * Compute readiness for a bead.
 *
 * Local mode returns the same blocked-by/unblocked answer it always has and
 * never classifies a gate or reads GitHub evidence. GitHub-primary mode clears
 * satisfied and expired gates, then reports the first remaining blocker (open
 * dependency edges before gates, matching bd's own precedence).
 */
export function computeReady(input: ComputeGithubReadyInput): GithubReadyResult {
  const blockers = openBlockers(input.blockedBy);
  if (input.authority === "bd") {
    return blockers.length === 0
      ? { ready: true, reason: "unblocked", clearedGates: [] }
      : { ready: false, reason: "blocked-by", blockers, clearedGates: [] };
  }

  const classifications = classifyGates(input.gates, input.evidence);
  const clearedGates = classifications
    .filter((entry) => entry.verdict === "satisfied-externally" || entry.verdict === "expired")
    .map((entry) => entry.gate);
  const waiting = classifications.find(
    (entry) => entry.verdict === "open" || entry.verdict === "unknown",
  );

  if (blockers.length > 0) {
    return { ready: false, reason: "blocked-by", blockers, clearedGates };
  }
  if (waiting !== undefined && (waiting.verdict === "open" || waiting.verdict === "unknown")) {
    return {
      ready: false,
      reason: "waiting-on-gate",
      gate: waiting.gate,
      verdict: waiting.verdict,
      clearedGates,
    };
  }
  return { ready: true, reason: "unblocked", clearedGates };
}
