/**
 * Authority policy for durable-member commands (bd-186).
 *
 * The policy lives here, in the owner, and not in the panel: a client-side
 * button state is a convenience, never an authorization decision. Two rules
 * shape the matrix:
 *
 * - A supervisor must not become a second author. It gets lifecycle only
 *   (abort, abort-submission), never content steers, writes or a new agent
 *   contract.
 * - `configure`/`reset` change the agent's contract mid-run, so a human must
 *   confirm with an explicit token equal to the member id: deterministic, hard
 *   to misfire, and the same token on every transport.
 *
 * The matrix is evaluated against the **tier the owner bound to this transport**,
 * never against `command.authority`. A command's authority field is a claim, and
 * a claim is only an integrity check: the transport that produced it must have
 * verified it against its bound tier first. {@link VerifiedAuthority} is branded
 * with an unexported unique symbol, so a raw `DurableAuthority` string cannot be
 * passed to {@link authorizeDurableCommand} — the type makes the escalation
 * impossible rather than asking reviewers to notice it.
 *
 * Phase sub-agents get nothing: they own their own child conversations, and
 * writes go child → parent, never sideways.
 *
 * // SYNC WARNING: the panel pre-checks this matrix to disable controls, and
 * // that pre-check lives in `pi-web-plugins/durable-member/contract.js`
 * // (`controlAvailability`). The panel is never the gate — the owner re-checks
 * // with this function — but the two lists must stay aligned so a control is
 * // not offered where the owner would refuse it.
 */

import type { DurableAuthority, DurableCommand, DurableCommandKind } from "./commands.js";

/** Why an owner refused a command. */
export type DurableAuthorizationRefusalReason =
  | "member-mismatch"
  | "authority-mismatch"
  | "role-not-permitted"
  | "confirmation-required"
  | "confirmation-mismatch";

const verifiedAuthorityBrand: unique symbol = Symbol("belayd.durable.verified-authority");

/**
 * The tier the owner bound to one transport, produced only by
 * {@link bindOwnerAuthority} (owner configuration: server option, mailbox queue
 * origin, panel server module) or {@link verifyAuthorityClaim} (transport
 * verification of a caller's claim).
 */
export interface VerifiedAuthority {
  readonly tier: DurableAuthority;
  readonly [verifiedAuthorityBrand]: true;
}

/**
 * Bind the tier the owner configured for a transport.
 *
 * Owner-side only: a socket server, mailbox drain or panel plugin calls this
 * with the tier it was configured to serve. Callers never derive it from a
 * frame or a queued JSON body.
 */
export function bindOwnerAuthority(tier: DurableAuthority): VerifiedAuthority {
  return { tier, [verifiedAuthorityBrand]: true };
}

export type AuthorityClaimVerification =
  | { readonly ok: true; readonly authority: VerifiedAuthority }
  | { readonly ok: false; readonly reason: "authority-mismatch"; readonly error: string };

/**
 * Integrity-check a caller's claimed tier against the bound identity.
 *
 * A claim that disagrees is refused, never honored: this is what stops a
 * supervisor-tier socket (or a queued file whose `authority` says
 * `panel-human`) from borrowing a higher tier.
 */
export function verifyAuthorityClaim(
  bound: VerifiedAuthority,
  claimed: DurableAuthority,
): AuthorityClaimVerification {
  if (claimed !== bound.tier) {
    return {
      ok: false,
      reason: "authority-mismatch",
      error: `command claims ${claimed}, this transport serves ${bound.tier}`,
    };
  }
  return { ok: true, authority: bound };
}

export interface DurableAuthorizationContext {
  /** The member whose storage this owner holds; per-member scoping by path. */
  readonly memberId: string;
  /** The owner-bound tier this command arrived on. */
  readonly authority: VerifiedAuthority;
}

export type DurableAuthorization =
  | { readonly ok: true; readonly command: DurableCommand }
  | {
      readonly ok: false;
      readonly reason: DurableAuthorizationRefusalReason;
      readonly error: string;
      /** Value the caller must send as `confirmation` for a gated kind. */
      readonly requiredConfirmation?: string;
    };

/** Human at the panel: may steer, follow up, write, abort and compact. */
const PANEL_ALLOWED: readonly DurableCommandKind[] = [
  "steer",
  "followup",
  "write",
  "abort-submission",
  "abort",
  "compact",
];

/** Fleet supervisor: lifecycle only, so it cannot author content. */
const SUPERVISOR_ALLOWED: readonly DurableCommandKind[] = ["abort-submission", "abort"];

/** Kinds that change the agent's contract and therefore need confirmation. */
const CONFIRMATION_REQUIRED: readonly DurableCommandKind[] = ["configure", "reset"];

function allows(allowed: readonly DurableCommandKind[], kind: DurableCommandKind): boolean {
  return allowed.some((candidate) => candidate === kind);
}

function asksForConfirmation(kind: DurableCommandKind): boolean {
  return CONFIRMATION_REQUIRED.some((candidate) => candidate === kind);
}

/**
 * Decide whether one command may run against this member.
 *
 * The effective tier comes from `context.authority` (verified/bound), never from
 * the command. The command's own claim is still checked here as a second line of
 * defence, so a caller that skipped transport verification cannot slip a
 * mismatched claim past this function either.
 */
export function authorizeDurableCommand(
  command: DurableCommand,
  context: DurableAuthorizationContext,
): DurableAuthorization {
  if (command.memberId !== context.memberId) {
    return {
      ok: false,
      reason: "member-mismatch",
      error: `command targets member ${command.memberId}, this owner holds ${context.memberId}`,
    };
  }

  const claim = verifyAuthorityClaim(context.authority, command.authority);
  if (!claim.ok) {
    return { ok: false, reason: claim.reason, error: claim.error };
  }

  const tier = context.authority.tier;
  const permitted = isPermitted(tier, command.kind);
  if (!permitted) {
    return {
      ok: false,
      reason: "role-not-permitted",
      error: `${tier} may not send ${command.kind}`,
    };
  }

  if (!asksForConfirmation(command.kind)) return { ok: true, command };

  if (command.confirmation === undefined) {
    return {
      ok: false,
      reason: "confirmation-required",
      error: `${command.kind} requires confirmation equal to the member id (${command.memberId})`,
      requiredConfirmation: command.memberId,
    };
  }
  if (command.confirmation !== command.memberId) {
    return {
      ok: false,
      reason: "confirmation-mismatch",
      error: `${command.kind} confirmation does not match the member id (${command.memberId})`,
      requiredConfirmation: command.memberId,
    };
  }
  return { ok: true, command };
}

function isPermitted(authority: DurableAuthority, kind: DurableCommandKind): boolean {
  switch (authority) {
    case "panel-human":
      return allows(PANEL_ALLOWED, kind) || asksForConfirmation(kind);
    case "fleet-supervisor":
      return allows(SUPERVISOR_ALLOWED, kind);
    case "phase-subagent":
      return false;
  }
}
