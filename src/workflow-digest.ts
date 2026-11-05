/**
 * Deterministic workflow digest for one fleet member (bd-189, tier 2).
 *
 * The supervisor must answer "what is going on with X" and "is Y stuck" without
 * pulling a transcript into its own context. Everything here is derived from
 * facts the fleet read path already gathered — workflow state, run manifests,
 * the orchestrator lease, bd gates, telemetry — so **no model call is involved**
 * and the input type deliberately carries no spawn seam. The digest is a pure
 * formatting/verdict layer: the capability passes facts in, and tests can seed a
 * stuck member without a process, a worktree, or a session directory.
 *
 * The verdict is the load-bearing part. Its causes are ranked deterministically
 * (failed phase > open human gate > ordering wait > unknown liveness > expired
 * lease > no progress), because a supervisor that re-derives "why does this look
 * stuck" on every poll invents a different answer each time. "Unknown" is a
 * first-class answer: a lease whose heartbeat cannot be read is not evidence of
 * progress, so the digest says so instead of guessing "running".
 */

import type { ModelPhaseStats, ModelTelemetryTotals } from "./model-telemetry.js";
import { formatModelTelemetrySummary } from "./model-telemetry.js";
import { ORCHESTRATOR_CLAIM_STALE_MS } from "./orchestrator-claim.js";
import { RunStatus } from "./run-manifest.js";

/** Coarse member state, mirrored structurally from the fleet status view. */
export const SUPERVISION_MEMBER_STATES = [
  "active",
  "blocked",
  "awaiting-human",
  "interrupted",
  "idle",
  "missing-state",
] as const;

export type SupervisionMemberState = (typeof SUPERVISION_MEMBER_STATES)[number];

/** The worktree's orchestrator lease, clock-free (the digest applies the clock). */
export interface SupervisionLeaseFacts {
  state: "absent" | "held" | "corrupt";
  taskId?: string;
  sessionId?: string;
  heartbeatAt?: number;
  error?: string;
}

/** The bd waits that block a member: a person, or another member's landing. */
export interface SupervisionGateFacts {
  humanGateId?: string;
  /** bd's gate `created_at` in epoch ms; absent when bd did not report one. */
  humanGateCreatedAtMs?: number;
  /** The member this bead is ordered behind (bd-158 fleet ordering gate). */
  orderingBlocker?: string;
  /**
   * bd answered, but returned records that are not this wait's answer (an
   * escalation gate, a timer gate, a renamed status). Kept apart from
   * {@link readError} so the digest does not report a read failure that did not
   * happen (bd-279 S2).
   */
  unrecognizedGateState?: string;
  /** The gate read itself failed; the digest says so instead of guessing "none". */
  readError?: string;
}

/** One run manifest, reduced to what a digest needs. */
export interface SupervisionRunFacts {
  phase: string;
  status: string;
  startedAt: number;
  completedAt?: number;
  failureReason?: string;
}

/** One member's spend, from `.belayd/telemetry.json`. */
export interface SupervisionTelemetryFacts {
  stats: readonly ModelPhaseStats[];
  totals: ModelTelemetryTotals;
}

/** Everything the digest knows about one member. */
export interface SupervisionMemberFacts {
  taskId: string;
  worktreePath: string;
  branch?: string;
  memberState: SupervisionMemberState;
  phaseOrder: readonly string[];
  completedPhases: readonly string[];
  pendingPhases: readonly string[];
  /**
   * The review phase flag recorded in `workflow.json`. It is a *phase* fact and is
   * deliberately not a wait trigger: since bd-219 it is set on every review
   * completion while the member runs its own fix loop, so treating it as a wait
   * described a human decision nobody was asked for. Kept on the facts so a reader
   * sees what the state file says; {@link formatWaitingOn} ignores it.
   */
  awaitingReviewResponse: boolean;
  /** workflow.json `updatedAt`, raised to the newest run timestamp when later. */
  updatedAt?: number;
  lease: SupervisionLeaseFacts;
  gates: SupervisionGateFacts;
  bead?: { title?: string; status?: string };
  /** The bead read failed, so the bead columns are unknown rather than absent. */
  beadError?: string;
  runs: readonly SupervisionRunFacts[];
  telemetry?: SupervisionTelemetryFacts;
  /**
   * Epoch ms of the newest commit on the member's branch, from one read-only
   * `git log` call in the seam. The "no commits" evidence the bead's AC names.
   */
  branchHeadCommitAt?: number;
}

/** The seam's answer: one member's facts, or a bounded refusal. */
export type SupervisionInputResult =
  | { ok: true; member: SupervisionMemberFacts }
  | { ok: false; error: string };

/** Digest input. There is no spawn/model seam here by design, not by omission. */
export interface WorkflowDigestInput {
  member: SupervisionMemberFacts;
  now: number;
}

/** Hard cap on one digest's text, so a digest can never become a transcript. */
export const WORKFLOW_DIGEST_MAX_BYTES = 8_000;

/** Silence longer than this counts as "no progress", not as "working". */
export const NO_PROGRESS_STUCK_MS = 10 * 60_000;

/**
 * The one-line verdict.
 *
 * `stuck` is deliberately tri-state: `true` (a named cause), `false` (healthy),
 * or `"unknown"` when the digest lacks the liveness input it would need to say
 * either — a lease whose heartbeat cannot be read is not a healthy member, and
 * claiming "running" there would be a guess.
 */
export interface StuckVerdict {
  stuck: boolean | "unknown";
  line: string;
}

/** Human duration, unit-suffixed: `45s`, `22m`, `3h`, `2d`. */
export function formatDurationInMs(durationInMs: number): string {
  const seconds = Math.max(0, Math.round(durationInMs / 1000));
  if (seconds < 60) return `${seconds.toString()}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes.toString()}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours.toString()}h`;
  return `${Math.round(hours / 24).toString()}d`;
}

/**
 * The member's runs in start order.
 *
 * The seam already dropped manifests of another task (a copied `.belayd/`
 * carries the primary checkout's runs), so this only orders them.
 */
function memberRuns(member: SupervisionMemberFacts): SupervisionRunFacts[] {
  return [...member.runs].sort((left, right) => left.startedAt - right.startedAt);
}

function newestRun(runs: readonly SupervisionRunFacts[]): SupervisionRunFacts | undefined {
  return runs[runs.length - 1];
}

/** Latest run per phase, newest first start time — what "latest runs" shows. */
export function latestRunPerPhase(
  runs: readonly SupervisionRunFacts[],
  phaseOrder: readonly string[],
): SupervisionRunFacts[] {
  const byPhase = new Map<string, SupervisionRunFacts>();
  for (const run of runs) {
    const current = byPhase.get(run.phase);
    if (current === undefined || run.startedAt >= current.startedAt) byPhase.set(run.phase, run);
  }
  const order = (phase: string): number => {
    const index = phaseOrder.indexOf(phase);
    return index === -1 ? phaseOrder.length : index;
  };
  return [...byPhase.values()].sort(
    (left, right) =>
      order(left.phase) - order(right.phase) || left.phase.localeCompare(right.phase),
  );
}

/** The newest failed run of a phase that has not completed since. */
export function newestFailedRun(member: SupervisionMemberFacts): SupervisionRunFacts | undefined {
  const completed = new Set(member.completedPhases);
  const failed = memberRuns(member).filter(
    (run) => run.status === RunStatus.Failed && !completed.has(run.phase),
  );
  return newestRun(failed);
}

/**
 * When this member last produced any evidence of progress.
 *
 * The orchestrator heartbeat is included because it is the strongest liveness
 * signal on the read path: a member 25 minutes into one long phase writes no new
 * run, manifest or workflow update, yet its session renews the lease every
 * `ORCHESTRATOR_CLAIM_HEARTBEAT_INTERVAL_MS`. Leaving it out made a live member
 * read as `stuck: no progress` while the same digest printed `lease: live`.
 *
 * `branchHeadCommitAt` is the "no commits" evidence: a member can be silent in
 * every file it writes and still land work on its branch. It is absent when the
 * seam could not read the branch, which only removes an input — it never makes
 * the digest claim progress it did not observe.
 */
export function lastProgressAt(member: SupervisionMemberFacts): number | undefined {
  const candidates: number[] = [];
  if (member.updatedAt !== undefined) candidates.push(member.updatedAt);
  if (member.branchHeadCommitAt !== undefined) candidates.push(member.branchHeadCommitAt);
  if (member.lease.state === "held" && member.lease.heartbeatAt !== undefined) {
    candidates.push(member.lease.heartbeatAt);
  }
  for (const run of member.runs) {
    candidates.push(run.completedAt ?? run.startedAt);
  }
  const finite = candidates.filter((value) => Number.isFinite(value));
  return finite.length === 0 ? undefined : Math.max(...finite);
}

/** What the lease says about liveness, computed against one clock. */
export type LeaseLiveness =
  | { kind: "absent" }
  | { kind: "live"; ageInMs: number }
  | { kind: "expired"; expiredInMs: number }
  | { kind: "unknown"; reason: string };

/**
 * Classify the lease exactly the way the takeover authority does.
 *
 * `src/orchestrator-claim.ts` (`classifyOrchestratorClaim`) treats a lease whose
 * age equals the stale bound as **stale** (`age < staleAfter ? live : stale`),
 * so the digest must expire at `>=` too: one instant must not be "live" to the
 * view and "stale" to the tool that takes the worktree over.
 *
 * A held lease without a readable `heartbeatAt`, and a corrupt lease record, are
 * `unknown`: nothing on the read path proves either liveness or its absence.
 */
export function leaseLiveness(lease: SupervisionLeaseFacts, now: number): LeaseLiveness {
  if (lease.state === "absent") return { kind: "absent" };
  if (lease.state === "corrupt") {
    return { kind: "unknown", reason: `lease unreadable (${lease.error ?? "no error recorded"})` };
  }
  const heartbeatAt = lease.heartbeatAt;
  if (heartbeatAt === undefined || !Number.isFinite(heartbeatAt)) {
    return { kind: "unknown", reason: "lease heartbeat missing" };
  }
  const ageInMs = now - heartbeatAt;
  return ageInMs >= ORCHESTRATOR_CLAIM_STALE_MS
    ? { kind: "expired", expiredInMs: ageInMs - ORCHESTRATOR_CLAIM_STALE_MS }
    : { kind: "live", ageInMs };
}

/**
 * How long the pending phase's own run has been going.
 *
 * Derived from that run's `startedAt`, not from the silence window: once the
 * heartbeat counts as progress, the silence window collapses to one heartbeat
 * interval and would describe a 25-minute run as "running 20s".
 */
function runningForInMs(
  member: SupervisionMemberFacts,
  phase: string | undefined,
  now: number,
  silentInMs: number | undefined,
): number | undefined {
  if (phase === undefined) return silentInMs;
  const current = [...member.runs]
    .reverse()
    .find((run) => run.phase === phase && run.status === RunStatus.Running);
  if (current === undefined) return silentInMs;
  return Math.max(0, now - current.startedAt);
}

function humanGateAgeInMs(gates: SupervisionGateFacts, now: number): number | undefined {
  if (gates.humanGateCreatedAtMs === undefined) return undefined;
  return now - gates.humanGateCreatedAtMs;
}

/**
 * The single deterministic verdict line.
 *
 * Ranking (first match wins): failed pending phase > open human gate > fleet
 * ordering wait > unknown liveness > expired lease > no progress > running. A
 * failed phase outranks an open gate because it is the thing a person must fix;
 * an ordering wait is not a stuck member at all; and `unknown` sits above the
 * clock-based causes because it means the clock cannot be trusted.
 */
export function computeStuckVerdict(input: WorkflowDigestInput): StuckVerdict {
  const { member, now } = input;
  const failed = newestFailedRun(member);
  if (failed !== undefined) {
    const since = failed.completedAt ?? failed.startedAt;
    return {
      stuck: true,
      line: `phase ${failed.phase} failed ${formatDurationInMs(now - since)} ago`,
    };
  }
  if (member.gates.humanGateId !== undefined) {
    const age = humanGateAgeInMs(member.gates, now);
    return {
      stuck: true,
      line:
        age === undefined
          ? `gate open (${member.gates.humanGateId})`
          : `gate open ${formatDurationInMs(age)} (${member.gates.humanGateId})`,
    };
  }
  if (member.gates.orderingBlocker !== undefined) {
    return {
      stuck: false,
      line: `not stuck: waiting on ${member.gates.orderingBlocker} (fleet ordering gate)`,
    };
  }
  const lease = leaseLiveness(member.lease, now);
  if (lease.kind === "unknown") {
    return {
      stuck: "unknown",
      line: `unknown: ${lease.reason}, so liveness cannot be judged`,
    };
  }
  if (lease.kind === "expired") {
    return {
      stuck: true,
      line: `lease expired ${formatDurationInMs(lease.expiredInMs)} ago`,
    };
  }
  const progressAt = lastProgressAt(member);
  const silentInMs = progressAt === undefined ? undefined : now - progressAt;
  const runningPhase = member.pendingPhases[0];
  if (silentInMs !== undefined && silentInMs >= NO_PROGRESS_STUCK_MS) {
    return { stuck: true, line: `no progress ${formatDurationInMs(silentInMs)}` };
  }
  if (runningPhase !== undefined) {
    const runningInMs = runningForInMs(member, runningPhase, now, silentInMs);
    return {
      stuck: false,
      line:
        runningInMs === undefined
          ? `not stuck: phase ${runningPhase} running`
          : `not stuck: phase ${runningPhase} running ${formatDurationInMs(runningInMs)}`,
    };
  }
  return {
    stuck: false,
    line: `not stuck: no pending phase (state ${member.memberState})`,
  };
}

function formatLeaseLine(member: SupervisionMemberFacts, now: number): string {
  const { lease } = member;
  switch (lease.state) {
    case "absent":
      return "- lease: none";
    case "corrupt":
      return `- lease: unreadable (${lease.error ?? "unknown error"})`;
    case "held": {
      const liveness = leaseLiveness(lease, now);
      const verdict =
        liveness.kind === "live"
          ? `live, heartbeat ${formatDurationInMs(liveness.ageInMs)} ago`
          : liveness.kind === "expired"
            ? `expired ${formatDurationInMs(liveness.expiredInMs)} ago`
            : "heartbeat unknown";
      return (
        `- lease: held by session ${lease.sessionId ?? "unknown"} ` +
        `for ${lease.taskId ?? "unknown"} — ${verdict}`
      );
    }
  }
}

function formatWaitingOn(member: SupervisionMemberFacts, now: number): string {
  const { gates } = member;
  if (gates.humanGateId !== undefined) {
    const age = humanGateAgeInMs(gates, now);
    const ageText = age === undefined ? "" : `, open ${formatDurationInMs(age)}`;
    return `- waiting on: ${gates.humanGateId} (human gate${ageText})`;
  }
  if (gates.orderingBlocker !== undefined) {
    return `- waiting on: ${gates.orderingBlocker} (fleet ordering gate)`;
  }
  if (gates.unrecognizedGateState !== undefined) {
    return `- waiting on: unknown (gate state unrecognized: ${gates.unrecognizedGateState})`;
  }
  if (gates.readError !== undefined) {
    return `- waiting on: unknown (gate read failed: ${gates.readError})`;
  }
  // `member.awaitingReviewResponse` is deliberately not consulted (bd-219): it is a
  // persisting review phase flag, not an open question, and a "waiting on" line for
  // it contradicts the digest's own `- state: active`.
  return "- waiting on: nothing (no open gate)";
}

function formatLastError(member: SupervisionMemberFacts, now: number): string | undefined {
  const failed = newestFailedRun(member);
  if (failed === undefined) return undefined;
  const since = failed.completedAt ?? failed.startedAt;
  const reason = failed.failureReason ?? "(no failure reason recorded)";
  return `- last error: phase ${failed.phase} failed: ${reason} (${formatDurationInMs(now - since)} ago)`;
}

function formatSpend(member: SupervisionMemberFacts): string | undefined {
  const telemetry = member.telemetry;
  if (telemetry === undefined) return undefined;
  // One summary line plus at most three per-phase rows: the totals answer
  // "what did this cost", the rows only matter when a phase stands out.
  const summary = formatModelTelemetrySummary(
    telemetry.stats.slice(0, 3),
    telemetry.totals,
  ).replace(/^\[belayd model telemetry\] /u, "");
  return `- spend: ${summary.replace(/\n\s+/gu, "; ").trim()}`;
}

function formatBeadLine(member: SupervisionMemberFacts): string[] {
  if (member.bead !== undefined) {
    return [
      `- bead: ${member.bead.title ?? "(no title)"} (${member.bead.status ?? "status unknown"})`,
    ];
  }
  if (member.beadError === undefined) return [];
  // Mirrors the gate read: a failed bd read is reported as unknown. Dropping the
  // line would read as "this bead has nothing to show", which is a different fact.
  return [`- bead: unknown (bd read failed: ${bounded(member.beadError, 160)})`];
}

function bounded(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  return collapsed.length <= maxChars ? collapsed : `${collapsed.slice(0, maxChars)}…`;
}

function truncateToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const marker = "\n… truncated";
  let used = Buffer.byteLength(marker, "utf8");
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const size = Buffer.byteLength(line, "utf8") + 1;
    if (used + size > maxBytes) break;
    used += size;
    kept.push(line);
  }
  return [...kept, marker].join("\n");
}

/**
 * Render one member's digest: identity, phases, waits, error, lease, spend, and
 * the verdict. Markdown, bounded to {@link WORKFLOW_DIGEST_MAX_BYTES}.
 */
export function buildWorkflowDigest(input: WorkflowDigestInput): string {
  const { member, now } = input;
  const branch = member.branch === undefined ? "detached HEAD" : member.branch;
  const lines: string[] = [
    `**Workflow digest — ${member.taskId}**`,
    "",
    `- worktree: ${member.worktreePath} (branch ${branch})`,
    `- state: ${member.memberState}`,
  ];
  lines.push(...formatBeadLine(member));
  lines.push(
    `- phases: ${member.completedPhases.length.toString()}/${member.phaseOrder.length.toString()} complete`,
  );
  lines.push(`- completed: ${member.completedPhases.join(", ")}`);
  lines.push(`- pending: ${member.pendingPhases.join(", ")}`);

  const latest = latestRunPerPhase(memberRuns(member), member.phaseOrder);
  lines.push(
    `- latest runs: ${
      latest.length === 0 ? "none" : latest.map((run) => `${run.phase}=${run.status}`).join(", ")
    }`,
  );
  lines.push(formatWaitingOn(member, now));
  const lastError = formatLastError(member, now);
  if (lastError !== undefined) lines.push(lastError);
  lines.push(formatLeaseLine(member, now));
  const spend = formatSpend(member);
  if (spend !== undefined) lines.push(spend);
  lines.push(
    `- interrupted runs: ${member.runs.filter((run) => run.status === RunStatus.Interrupted).length.toString()}`,
  );
  const verdict = computeStuckVerdict(input);
  lines.push(`- **stuck verdict:** ${verdict.line}`);

  return truncateToBytes(lines.join("\n"), WORKFLOW_DIGEST_MAX_BYTES);
}
