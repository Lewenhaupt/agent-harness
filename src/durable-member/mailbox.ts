/**
 * File transport for durable-member commands (bd-186).
 *
 * The fleet mailbox (store notes, read at turn start) already survives a member
 * being down, so cold-start delivery reuses that idea instead of
 * inventing a second one: a command that must survive is written to
 * `<memberStateDir>/commands/<requestId>.json`, drained at start/turn start,
 * applied through the same `dispatch` + `dedupe` path as the socket, and
 * acknowledged with `<memberStateDir>/receipts/<requestId>.json`.
 *
 * The **queue origin** decides the tier: `drainDurableCommands` takes the tier
 * the owner configured for this mailbox, and a file whose `authority` field
 * disagrees is refused (`authority-mismatch`). A queued JSON body never picks
 * its own authority, exactly like a socket frame cannot.
 *
 * A file transport cannot present a credential — the payload is just bytes on
 * disk, with no handshake to prove who wrote it. The tier therefore comes from
 * the owner's queue-origin configuration (which mailbox directory is drained by
 * which tier), and the claim check catches a file that was mis-tiered or copied
 * between queues. That is a coordination boundary, not proof of authorship: a
 * same-uid process that can write the queue can write any tier's command, which
 * is exactly the same trust level as reading the other tier's socket credential.
 *
 * Dispositions keep a failed command honest:
 *
 * - applied (or already a duplicate) -> receipt + command file removed;
 * - transient writer failure -> failure receipt, **command file retained** so
 *   the next drain retries it (dedupe is recorded only after an apply succeeds);
 * - applied-but-unrecorded, or a permanent refusal (bad shape, wrong member,
 *   wrong authority, unknown submission) -> receipt + file quarantined under
 *   `rejected/`, so it is retained as evidence but never redelivered.
 *
 * Writing is atomic (tmp + rename, mode 0600) because a member may drain while a
 * sender writes. Files are ordered by `issuedAt`, not filename, so a queued
 * steer-then-followup pair keeps its order regardless of how ids sort.
 */

import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { bindOwnerAuthority, type VerifiedAuthority, verifyAuthorityClaim } from "./authority.js";
import type { DurableAuthority, DurableCommand, DurableCommandKind } from "./commands.js";
import { DURABLE_COMMAND_KINDS, validateDurableCommand } from "./commands.js";
import type { DurableDispatcher, DurableDispatchResult } from "./dispatch.js";

/** Command mailbox directory inside the member state dir. */
export const MEMBER_COMMANDS_DIR = "commands";

/** Receipt directory inside the member state dir. */
export const MEMBER_RECEIPTS_DIR = "receipts";

/** Quarantine directory for refused or unrecorded commands. */
export const MEMBER_REJECTED_DIR = "rejected";

const COMMAND_SUFFIX = ".json";

export function memberCommandsDir(stateDir: string): string {
  return join(stateDir, MEMBER_COMMANDS_DIR);
}

export function memberReceiptsDir(stateDir: string): string {
  return join(stateDir, MEMBER_RECEIPTS_DIR);
}

export function memberRejectedDir(stateDir: string): string {
  return join(stateDir, MEMBER_REJECTED_DIR);
}

/** What the owner writes after attempting one queued command. */
export interface DurableCommandReceipt {
  readonly requestId: string;
  readonly memberId: string;
  readonly kind: DurableCommandKind | "unknown";
  readonly appliedAt: number;
  readonly ok: boolean;
  readonly duplicate?: boolean;
  readonly code?: string;
  readonly error?: string;
}

export interface DrainResult {
  readonly applied: number;
  readonly duplicates: number;
  readonly rejected: number;
  /** Commands left in `commands/` for redelivery after a transient failure. */
  readonly retained: number;
  /** Commands (and refusals) moved to `rejected/`. */
  readonly quarantined: number;
  readonly receipts: readonly DurableCommandReceipt[];
}

export type DrainOutcome =
  | { readonly ok: true; readonly result: DrainResult }
  | { readonly ok: false; readonly error: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

/** Atomic write: the rename is what makes a drained command never half-written. */
function writeJsonAtomically(path: string, value: unknown): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

/**
 * Queue one command for a member that may be down or not yet started.
 *
 * Validation happens here as well as at drain time: a caller that sends an
 * oversized or malformed command should learn it now, not discover it as a
 * rejected receipt on the member's next start.
 */
export function enqueueDurableCommand(options: {
  readonly stateDir: string;
  readonly command: DurableCommand;
}): { readonly ok: true; readonly path: string } | { readonly ok: false; readonly error: string } {
  const validated = validateDurableCommand(options.command);
  if (!validated.ok) return { ok: false, error: validated.error };
  const path = join(
    memberCommandsDir(options.stateDir),
    `${validated.value.requestId}${COMMAND_SUFFIX}`,
  );
  try {
    ensureDir(memberCommandsDir(options.stateDir));
    writeJsonAtomically(path, validated.value);
    return { ok: true, path };
  } catch (error) {
    return { ok: false, error: `could not queue ${path}: ${errorMessage(error)}` };
  }
}

interface QueuedCommand {
  readonly file: string;
  readonly command: DurableCommand;
}

interface RejectedFile {
  readonly file: string;
  readonly requestId: string;
  readonly code: string;
  readonly error: string;
}

/** Where a drained file goes after its receipt is written. */
type Disposition = "remove" | "retain" | "quarantine";

/**
 * Apply every queued command for this member, then settle its file.
 *
 * The tier comes from `options.authority` (the queue origin configured by the
 * owner), never from the queued JSON body.
 */
export async function drainDurableCommands(options: {
  readonly stateDir: string;
  readonly memberId: string;
  /** The tier this mailbox was configured to carry. */
  readonly authority: DurableAuthority;
  readonly dispatcher: DurableDispatcher;
  readonly clock?: () => number;
}): Promise<DrainOutcome> {
  const clock = options.clock ?? (() => Date.now());
  const commandsDir = memberCommandsDir(options.stateDir);
  const listed = listCommandFiles(commandsDir);
  if (!listed.ok) return listed;

  const boundAuthority = bindOwnerAuthority(options.authority);
  const classified = listed.files.map((file) =>
    classifyQueuedFile(commandsDir, file, options.memberId, boundAuthority),
  );
  const rejected = classified.flatMap(rejectedFile);
  const queued = orderCommands(classified.flatMap(queuedEntry));

  const refused = refuseQueuedFiles({
    stateDir: options.stateDir,
    commandsDir,
    memberId: options.memberId,
    rejected,
    clock,
  });
  if (!refused.ok) return refused;

  const settled = await applyQueuedCommands({
    stateDir: options.stateDir,
    commandsDir,
    queued,
    dispatcher: options.dispatcher,
    clock,
  });
  if (!settled.ok) return settled;

  const receipts = [...refused.receipts, ...settled.receipts];
  return {
    ok: true,
    result: {
      applied: settled.applied,
      duplicates: settled.duplicates,
      rejected: receipts.filter((receipt) => !receipt.ok).length,
      retained: settled.retained,
      quarantined: refused.quarantined + settled.quarantined,
      receipts,
    },
  };
}

interface RefuseOptions {
  readonly stateDir: string;
  readonly commandsDir: string;
  readonly memberId: string;
  readonly rejected: readonly RejectedFile[];
  readonly clock: () => number;
}

type RefuseOutcome =
  | {
      readonly ok: true;
      readonly receipts: readonly DurableCommandReceipt[];
      readonly quarantined: number;
    }
  | { readonly ok: false; readonly error: string };

/** Poison files are refused (and quarantined) before any command runs. */
function refuseQueuedFiles(options: RefuseOptions): RefuseOutcome {
  const receipts: DurableCommandReceipt[] = [];
  for (const invalid of options.rejected) {
    const receipt: DurableCommandReceipt = {
      requestId: invalid.requestId,
      memberId: options.memberId,
      kind: "unknown",
      appliedAt: options.clock(),
      ok: false,
      code: invalid.code,
      error: invalid.error,
    };
    const settled = settle(
      options.stateDir,
      options.commandsDir,
      invalid.file,
      receipt,
      "quarantine",
    );
    if (!settled.ok) return settled;
    receipts.push(receipt);
  }
  return { ok: true, receipts, quarantined: receipts.length };
}

interface ApplyOptions {
  readonly stateDir: string;
  readonly commandsDir: string;
  readonly queued: readonly QueuedCommand[];
  readonly dispatcher: DurableDispatcher;
  readonly clock: () => number;
}

type ApplyOutcome =
  | {
      readonly ok: true;
      readonly receipts: readonly DurableCommandReceipt[];
      readonly applied: number;
      readonly duplicates: number;
      readonly retained: number;
      readonly quarantined: number;
    }
  | { readonly ok: false; readonly error: string };

async function applyQueuedCommands(options: ApplyOptions): Promise<ApplyOutcome> {
  const receipts: DurableCommandReceipt[] = [];
  let applied = 0;
  let duplicates = 0;
  let retained = 0;
  let quarantined = 0;

  for (const entry of options.queued) {
    const result = await options.dispatcher.dispatch(entry.command);
    const receipt = dispatchReceipt(entry.command, result, options.clock());
    const disposition = dispositionFor(result);
    const settled = settle(options.stateDir, options.commandsDir, entry.file, receipt, disposition);
    if (!settled.ok) return settled;
    receipts.push(receipt);
    if (result.ok && result.duplicate) duplicates += 1;
    else if (result.ok) applied += 1;
    if (disposition === "quarantine") quarantined += 1;
    if (disposition === "retain") retained += 1;
  }

  return { ok: true, receipts, applied, duplicates, retained, quarantined };
}

/**
 * `writer-failed` is the one retryable outcome (the writer may recover); an
 * applied-but-unrecorded command must never be redelivered, and a permanent
 * refusal must not be retried either.
 */
function dispositionFor(result: DurableDispatchResult): Disposition {
  if (result.ok) return "remove";
  return result.code === "writer-failed" ? "retain" : "quarantine";
}

function listCommandFiles(
  commandsDir: string,
):
  | { readonly ok: true; readonly files: readonly string[] }
  | { readonly ok: false; readonly error: string } {
  try {
    return {
      ok: true,
      files: readdirSync(commandsDir)
        .filter((name) => name.endsWith(COMMAND_SUFFIX))
        .sort(),
    };
  } catch (error) {
    if (isMissingFile(error)) return { ok: true, files: [] };
    return { ok: false, error: `could not read ${commandsDir}: ${errorMessage(error)}` };
  }
}

type ClassifiedFile =
  | { readonly kind: "queued"; readonly entry: QueuedCommand }
  | { readonly kind: "rejected"; readonly rejected: RejectedFile };

function classifyQueuedFile(
  commandsDir: string,
  file: string,
  memberId: string,
  authority: VerifiedAuthority,
): ClassifiedFile {
  const requestId = file.slice(0, -COMMAND_SUFFIX.length);
  const reject = (code: string, error: string): ClassifiedFile => ({
    kind: "rejected",
    rejected: { file, requestId, code, error },
  });

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(commandsDir, file), "utf8"));
  } catch (error) {
    return reject("invalid-command", `not valid JSON: ${errorMessage(error)}`);
  }
  const validated = validateDurableCommand(raw, { memberId });
  if (!validated.ok) return reject(validated.code, validated.error);
  const claim = verifyAuthorityClaim(authority, validated.value.authority);
  if (!claim.ok) return reject(claim.reason, claim.error);
  return { kind: "queued", entry: { file, command: validated.value } };
}

function queuedEntry(classified: ClassifiedFile): QueuedCommand[] {
  return classified.kind === "queued" ? [classified.entry] : [];
}

function rejectedFile(classified: ClassifiedFile): RejectedFile[] {
  return classified.kind === "rejected" ? [classified.rejected] : [];
}

/** Queue order is `issuedAt`, then requestId, never filename order. */
function orderCommands(entries: readonly QueuedCommand[]): QueuedCommand[] {
  return [...entries].sort((left, right) => {
    if (left.command.issuedAt !== right.command.issuedAt) {
      return left.command.issuedAt - right.command.issuedAt;
    }
    return left.command.requestId < right.command.requestId ? -1 : 1;
  });
}

function dispatchReceipt(
  command: DurableCommand,
  result: DurableDispatchResult,
  appliedAt: number,
): DurableCommandReceipt {
  return result.ok
    ? {
        requestId: result.requestId,
        memberId: command.memberId,
        kind: command.kind,
        appliedAt,
        ok: true,
        duplicate: result.duplicate,
      }
    : {
        requestId: result.requestId,
        memberId: command.memberId,
        kind: command.kind,
        appliedAt,
        ok: false,
        code: result.code,
        error: result.error,
      };
}

/** Persist the receipt, then remove/retain/quarantine the command file. */
function settle(
  stateDir: string,
  commandsDir: string,
  file: string,
  receipt: DurableCommandReceipt,
  disposition: Disposition,
): { readonly ok: true } | { readonly ok: false; readonly error: string } {
  const written = writeReceipt(stateDir, receipt);
  if (!written.ok) return written;
  if (disposition === "remove") removeCommandFile(commandsDir, file);
  if (disposition === "quarantine") quarantineCommandFile(stateDir, commandsDir, file);
  return { ok: true };
}

function writeReceipt(
  stateDir: string,
  receipt: DurableCommandReceipt,
): { readonly ok: true } | { readonly ok: false; readonly error: string } {
  const dir = memberReceiptsDir(stateDir);
  const path = join(dir, `${receipt.requestId}${COMMAND_SUFFIX}`);
  try {
    ensureDir(dir);
    writeJsonAtomically(path, receipt);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `could not write ${path}: ${errorMessage(error)}` };
  }
}

function removeCommandFile(commandsDir: string, file: string): void {
  try {
    unlinkSync(join(commandsDir, file));
  } catch {
    // A receipt is already written, so a leftover file re-drains as a duplicate
    // (the dedupe ledger answers it) instead of applying twice.
  }
}

/**
 * Move a settled command out of the drain path without deleting it.
 *
 * Renaming into `rejected/` keeps the evidence for the operator/panel while
 * making sure the same poison file is not re-applied on every start.
 */
function quarantineCommandFile(stateDir: string, commandsDir: string, file: string): void {
  const dir = memberRejectedDir(stateDir);
  try {
    ensureDir(dir);
    renameSync(join(commandsDir, file), join(dir, file));
  } catch {
    // Never delete a file whose receipt is a failure: keep it in commands/ as
    // evidence. Re-draining it is safe because a refused command never applies.
  }
}

/**
 * Read every receipt in the member state dir.
 *
 * Receipts are append-only history for the panel and the supervisor; a
 * malformed receipt is skipped rather than failing the whole listing.
 */
export function readCommandReceipts(stateDir: string): readonly DurableCommandReceipt[] {
  const dir = memberReceiptsDir(stateDir);
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((name) => name.endsWith(COMMAND_SUFFIX))
      .sort();
  } catch {
    // A member with no receipts yet has no history to show.
    return [];
  }
  const receipts: DurableCommandReceipt[] = [];
  for (const file of files) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(dir, file), "utf8"));
    } catch {
      continue;
    }
    const receipt = parseReceipt(raw);
    if (receipt !== undefined) receipts.push(receipt);
  }
  return receipts;
}

/** Membership-check an untrusted receipt kind; anything else is `unknown`. */
function readReceiptKind(value: unknown): DurableCommandReceipt["kind"] {
  return DURABLE_COMMAND_KINDS.find((kind) => kind === value) ?? "unknown";
}

function parseReceipt(raw: unknown): DurableCommandReceipt | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.requestId !== "string" || raw.requestId === "") return undefined;
  if (typeof raw.memberId !== "string") return undefined;
  if (typeof raw.appliedAt !== "number" || !Number.isFinite(raw.appliedAt)) return undefined;
  if (typeof raw.ok !== "boolean") return undefined;
  return {
    requestId: raw.requestId,
    memberId: raw.memberId,
    kind: readReceiptKind(raw.kind),
    appliedAt: raw.appliedAt,
    ok: raw.ok,
    ...(typeof raw.duplicate === "boolean" ? { duplicate: raw.duplicate } : {}),
    ...(typeof raw.code === "string" ? { code: raw.code } : {}),
    ...(typeof raw.error === "string" ? { error: raw.error } : {}),
  };
}
