/**
 * The one translation point from a validated+authorized command to the owner's
 * writer seam (bd-186).
 *
 * Injected {@link DurableWriter} is shaped like pi-durable's submit surface, so
 * this module can be tested without pi-durable installed and the mapping is
 * asserted rather than assumed:
 *
 *   steer             -> submit({ type: "message", whenBusy: "steer" })
 *   followup          -> submit({ type: "message", whenBusy: "followup" })
 *   write             -> submit({ type: "write", entry })
 *   abort-submission  -> submission(submissionId).abort()
 *   abort             -> abort()
 *   configure         -> configure(config)
 *   compact           -> compact({ instructions })
 *   reset             -> reset({ keepHistory })
 *
 * Order is authorization, dedupe check, apply, dedupe record. A `requestId` is
 * only recorded once the apply **succeeded**: a failed or throwing writer leaves
 * no ledger entry, so the retry is applied instead of being acked as a duplicate
 * of an effect that never happened. The cost is that a crash in the middle of an
 * apply can lose one command (retryable by a human); a doubled steer is worse.
 *
 * The dispatcher's tier comes from {@link DurableDispatcherOptions.authority},
 * bound by the owner. `command.authority` is only an integrity-checked claim.
 */

import { authorizeDurableCommand, bindOwnerAuthority } from "./authority.js";
import type {
  DurableAgentConfig,
  DurableAuthority,
  DurableCommand,
  DurableWriteEntry,
} from "./commands.js";
import type { DedupeLedger } from "./dedupe.js";

/** Exactly the two submit shapes the control plane needs. */
export type DurableSubmitInput =
  | {
      readonly type: "message";
      readonly text: string;
      /** `steer` joins after the current tool round; `followup` starts the next run. */
      readonly whenBusy: "steer" | "followup";
    }
  | { readonly type: "write"; readonly entry: DurableWriteEntry };

export type DurableSubmitResult =
  | { readonly ok: true; readonly submissionId?: string }
  | { readonly ok: false; readonly error: string };

/** One in-flight submission the owner can abort. */
export interface DurableSubmission {
  abort(): Promise<void> | void;
}

/**
 * The owner's write seam. Every method is what the member process does to its
 * own storage; nothing here is reachable from a reader.
 */
export interface DurableWriter {
  submit(input: DurableSubmitInput): DurableSubmitResult | Promise<DurableSubmitResult>;
  submission(submissionId: string): DurableSubmission | null;
  abort(): Promise<void> | void;
  configure(config: DurableAgentConfig): Promise<void> | void;
  compact(options: { readonly instructions?: string }): Promise<void> | void;
  reset(options: { readonly keepHistory: boolean }): Promise<void> | void;
}

/** Stable dispatch failure codes. */
export type DurableDispatchErrorCode =
  | "member-mismatch"
  | "authority-mismatch"
  | "role-not-permitted"
  | "confirmation-required"
  | "confirmation-mismatch"
  | "unknown-submission"
  | "applied-unrecorded"
  | "writer-failed";

export type DurableDispatchResult =
  | { readonly ok: true; readonly requestId: string; readonly duplicate: boolean }
  | {
      readonly ok: false;
      readonly requestId: string;
      readonly code: DurableDispatchErrorCode;
      readonly error: string;
    };

export interface DurableDispatcherOptions {
  readonly memberId: string;
  /** The tier this owner serves; never derived from a command's claim. */
  readonly authority: DurableAuthority;
  readonly writer: DurableWriter;
  readonly ledger: DedupeLedger;
  /** Injected clock, so the ledger stays deterministic in tests. */
  readonly clock?: () => number;
}

/** The only component allowed to call `writer` on behalf of an external caller. */
export interface DurableDispatcher {
  readonly memberId: string;
  readonly authority: DurableAuthority;
  dispatch(command: DurableCommand): Promise<DurableDispatchResult>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function applyCommand(
  writer: DurableWriter,
  command: DurableCommand,
): Promise<DurableDispatchResult> {
  switch (command.kind) {
    case "steer":
    case "followup": {
      const result = await writer.submit({
        type: "message",
        text: command.text,
        whenBusy: command.kind === "steer" ? "steer" : "followup",
      });
      return result.ok
        ? { ok: true, requestId: command.requestId, duplicate: false }
        : { ok: false, requestId: command.requestId, code: "writer-failed", error: result.error };
    }
    case "write": {
      const result = await writer.submit({ type: "write", entry: command.entry });
      return result.ok
        ? { ok: true, requestId: command.requestId, duplicate: false }
        : { ok: false, requestId: command.requestId, code: "writer-failed", error: result.error };
    }
    case "abort-submission": {
      const submission = writer.submission(command.submissionId);
      if (submission === null) {
        return {
          ok: false,
          requestId: command.requestId,
          code: "unknown-submission",
          error: `no submission ${command.submissionId} is in flight`,
        };
      }
      await submission.abort();
      return { ok: true, requestId: command.requestId, duplicate: false };
    }
    case "abort": {
      await writer.abort();
      return { ok: true, requestId: command.requestId, duplicate: false };
    }
    case "configure": {
      await writer.configure(command.config);
      return { ok: true, requestId: command.requestId, duplicate: false };
    }
    case "compact": {
      await writer.compact(
        command.instructions === undefined ? {} : { instructions: command.instructions },
      );
      return { ok: true, requestId: command.requestId, duplicate: false };
    }
    case "reset": {
      await writer.reset({ keepHistory: command.keepHistory === true });
      return { ok: true, requestId: command.requestId, duplicate: false };
    }
  }
}

/**
 * Build the owner-side dispatcher for one member and one bound tier.
 *
 * Both identities are constructor configuration: a direct `dispatch()` call
 * cannot borrow another member or another tier by changing the command body.
 */
export function createDurableDispatcher(options: DurableDispatcherOptions): DurableDispatcher {
  const clock = options.clock ?? (() => Date.now());
  const authority = bindOwnerAuthority(options.authority);

  return {
    memberId: options.memberId,
    authority: options.authority,
    async dispatch(command) {
      const authorization = authorizeDurableCommand(command, {
        memberId: options.memberId,
        authority,
      });
      if (!authorization.ok) {
        return {
          ok: false,
          requestId: command.requestId,
          code: authorization.reason,
          error: authorization.error,
        };
      }

      if (options.ledger.has(command.requestId)) {
        return { ok: true, requestId: command.requestId, duplicate: true };
      }

      let applied: DurableDispatchResult;
      try {
        applied = await applyCommand(options.writer, authorization.command);
      } catch (error) {
        return {
          ok: false,
          requestId: command.requestId,
          code: "writer-failed",
          error: errorMessage(error),
        };
      }
      if (!applied.ok) return applied;

      const recorded = options.ledger.record({
        requestId: command.requestId,
        kind: command.kind,
        appliedAt: clock(),
      });
      if (!recorded.ok) {
        // The side effect happened but cannot be remembered. Say so plainly:
        // retrying would apply it twice, so this is quarantined by mailbox.ts.
        return {
          ok: false,
          requestId: command.requestId,
          code: "applied-unrecorded",
          error: `command was applied but the dedupe ledger could not record it: ${recorded.error}`,
        };
      }
      return applied;
    },
  };
}
