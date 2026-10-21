/**
 * Append-only broker audit log (bd-125).
 *
 * One JSONL line per request at `$XDG_STATE_HOME/belayd/aws-audit.jsonl`
 * (mode 0600). The entry shape is intentionally tiny — timestamp, scope id,
 * worktree, source profile, action, outcome — because the log is only
 * forensics ("which repo asked for credentials, and did it get them"), never
 * attribution: one socket per scope means there is no caller identity.
 *
 * Credential material is never logged. The entry type has no field that can
 * carry it, and the formatter serializes only that type.
 */

import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { BROKER_DIR_MODE } from "./scope.ts";

/** One audit line. Never contains credential material. */
export interface AwsAuditEntry {
  ts: string;
  scope: string;
  worktree: string;
  profile: string;
  action: string;
  outcome: string;
}

/** Sink signature the scope server writes to. */
export type AwsAuditSink = (entry: AwsAuditEntry) => void;

/** `$XDG_STATE_HOME` (or `~/.local/state`) + the belayd audit path. */
export function resolveAuditPath(options: { env: NodeJS.ProcessEnv; homeDir?: string }): string {
  const stateHome = options.env.XDG_STATE_HOME;
  const base =
    stateHome !== undefined && stateHome !== ""
      ? stateHome
      : join(options.homeDir ?? options.env.HOME ?? homedir(), ".local", "state");
  return join(base, "belayd", "aws-audit.jsonl");
}

/** Serialize one entry as a single JSONL line (no trailing newline). */
export function formatAuditLine(entry: AwsAuditEntry): string {
  return JSON.stringify({
    ts: entry.ts,
    scope: entry.scope,
    worktree: entry.worktree,
    profile: entry.profile,
    action: entry.action,
    outcome: entry.outcome,
  });
}

/**
 * Append one line, creating the directory 0700 and the file 0600.
 *
 * Failure to write the audit log must never fail the request: the broker is
 * the only credential path, and a read-only state dir is not a reason to break
 * every agent. A write failure is reported by the caller's `log`; a mode that
 * could not be tightened is returned as a warning so a 0700-dir / unreadable-log
 * situation is diagnosable instead of silent.
 */
export function appendAuditLine(options: {
  auditPath: string;
  entry: AwsAuditEntry;
}): AuditAppendResult {
  const directory = dirname(options.auditPath);
  const warnings: string[] = [];
  mkdirSync(directory, { recursive: true, mode: BROKER_DIR_MODE });
  const directoryWarning = chmodBestEffort(directory, BROKER_DIR_MODE);
  if (directoryWarning !== undefined) warnings.push(directoryWarning);
  appendFileSync(options.auditPath, `${formatAuditLine(options.entry)}\n`, {
    mode: 0o600,
  });
  const fileWarning = chmodBestEffort(options.auditPath, 0o600);
  if (fileWarning !== undefined) warnings.push(fileWarning);
  return { warnings };
}

/** Outcome of {@link appendAuditLine}: the line was written, plus diagnostics. */
export interface AuditAppendResult {
  /** Non-fatal problems, e.g. a pre-existing mode that could not be tightened. */
  warnings: readonly string[];
}

/**
 * Best-effort `chmod` that reports instead of throwing.
 *
 * Returns a warning message on failure (the audit line itself is already
 * written), so the sink can log it through `onError`.
 */
export function chmodBestEffort(path: string, mode: number): string | undefined {
  try {
    chmodSync(path, mode);
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `aws-broker: could not set mode ${mode.toString(8)} on ${path}: ${message}`;
  }
}

/** Build a sink that appends to `auditPath`, tolerating write failures. */
export function createAuditSink(options: {
  auditPath: string;
  now?: () => number;
  onError?: (message: string) => void;
}): AwsAuditSink {
  const now = options.now ?? Date.now;
  return (entry) => {
    try {
      const result = appendAuditLine({
        auditPath: options.auditPath,
        entry: { ...entry, ts: entry.ts === "" ? new Date(now()).toISOString() : entry.ts },
      });
      for (const warning of result.warnings) options.onError?.(warning);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.onError?.(`aws-broker: could not write audit log: ${message}`);
    }
  };
}
