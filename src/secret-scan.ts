/**
 * Outbound text scan: refuse to post a comment, note or body that carries a
 * credential (bd-286).
 *
 * Secrets are a scanner's job, never a hand-written rule table: this module is a
 * thin adapter over `betterleaks` (the same binary `pnpm scan:secrets` and the
 * pre-push hook run over the tree). It exists because the *repo* scan cannot see
 * text that is about to leave the machine — an agent that pastes a token into a
 * question would still be publishing it.
 *
 * The scan is advisory on infrastructure, hard on content: a hit refuses the
 * post, while a missing or broken binary only warns (once per session) and lets
 * the post through, because a config gap must not wedge every workflow. The hard
 * enforcement is the repo gate and the pre-push hook.
 *
 * Rule ids only, never the match: the caller's refusal message is itself posted
 * somewhere (a bead, a session prompt), so echoing the secret would defeat the
 * scan.
 *
 * The scanner's **exit code** is the hit decision, never the report: a body dense
 * with matches (a pasted log) is exactly when the JSON report is largest, so
 * parsing it as the authority would turn a truncated report into "unavailable"
 * and let the post through. The report only enriches the refusal with rule ids.
 */
import { execFile } from "node:child_process";

/** The binary the devShell and `pi-web-runtime-env` provide (flake `betterleaks`). */
export const SECRET_SCAN_BINARY = "betterleaks";

/**
 * Bound the run so a pathological body cannot hang a post.
 *
 * A timeout is `unavailable` (warn and post), not a refusal: the scan is the
 * advisory half of the guard and the repo gate is the enforced one, so a slow
 * machine must not be able to stop every comment. A real hit exits in
 * milliseconds, so this bound only ever fires on a hung process.
 */
const SCAN_TIMEOUT_MS = 20_000;

/**
 * Generous, but not load-bearing: `maxBuffer` overflow is classified as a hit, so
 * raising it only avoids losing the rule ids. Sized for a large pasted log.
 */
const SCAN_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/**
 * What the scan decided.
 *
 * `unavailable` is its own variant rather than a silent `ok: true`: the caller
 * must be able to say "the scanner never ran" without pretending the text was
 * checked, and it must not refuse either.
 */
export type OutboundTextScan =
  | { ok: true }
  | { ok: false; rules: readonly string[] }
  | { ok: false; unavailable: string };

/**
 * The caller-owned warn-once budget for {@link warnScanUnavailable}.
 *
 * Deliberately a structural type rather than module state: AGENTS.md freezes the
 * modules allowed module-level state, and a session (`CoreSessionState`) is the
 * natural owner — the human-answer warnings keep their budgets there for the same
 * reason. A caller passes its session state and this module only reads/sets the
 * flag, so the warning fires once per session and never leaks across sessions.
 */
export interface SecretScanWarnBudget {
  secretScanWarned?: boolean;
}

/** One `betterleaks stdin` run's raw outcome. */
type ScanRun =
  | { kind: "clean" }
  | { kind: "leaks"; stdout: string }
  | { kind: "unavailable"; error: string };

/**
 * True when an `execFile` failure means "the report outran `maxBuffer`".
 *
 * Node aborts the child and reports this code; the workflow is identical to a hit
 * (a huge report means many matches) so it must not be read as a missing binary.
 */
function isMaxBufferOverflow(error: { code?: string | number; message: string }): boolean {
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return true;
  return error.message.includes("maxBuffer");
}

/**
 * Run `betterleaks stdin` over `text`, never throwing.
 *
 * Classification, in order: no error → clean; the scanner's configured hit exit
 * (1) **or** a truncated report → hit; anything else (a spawn error such as
 * `ENOENT`/`EACCES`, a bad config, a timeout) → unavailable.
 */
function runStdinScan(options: { text: string; cwd: string }): Promise<ScanRun> {
  return new Promise((resolve) => {
    const child = execFile(
      SECRET_SCAN_BINARY,
      // `--exit-code 1` names the hit exit explicitly: a later default change in
      // the scanner must not silently turn a hit into "clean".
      ["stdin", "--redact", "--no-banner", "--exit-code", "1", "-f", "json", "-r", "-"],
      {
        cwd: options.cwd,
        timeout: SCAN_TIMEOUT_MS,
        maxBuffer: SCAN_MAX_BUFFER_BYTES,
        encoding: "utf8",
      },
      (error, stdout) => {
        if (error === null) {
          resolve({ kind: "clean" });
          return;
        }
        const partialStdout = typeof stdout === "string" ? stdout : "";
        if (error.code === 1 || isMaxBufferOverflow(error)) {
          resolve({ kind: "leaks", stdout: partialStdout });
          return;
        }
        resolve({ kind: "unavailable", error: error.message });
      },
    );
    if (child.stdin === null) {
      resolve({ kind: "unavailable", error: "stdin was not available to the scanner" });
      return;
    }
    // A child that exits before reading stdin turns the pending write into an
    // EPIPE; without a listener that surfaces as an unhandled stream error.
    child.stdin.on("error", () => {});
    child.stdin.end(options.text);
  });
}

/** The rule ids a truncated or truncated-looking report can still offer. */
function ruleIdsOf(stdout: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return [];
    const ids = new Set<string>();
    for (const entry of parsed) {
      const ruleId = (entry as { RuleID?: unknown }).RuleID;
      if (typeof ruleId === "string" && ruleId !== "") ids.add(ruleId);
    }
    return [...ids];
  } catch {
    // A hit whose report could not be parsed (truncated by maxBuffer, or not
    // JSON at all) is still a hit: the caller refuses with the rule unnamed
    // rather than posting the text it could not read.
    return [];
  }
}

/**
 * Scan text that is about to leave the harness (a comment, a note, a question).
 *
 * Errors are values: the caller posts on `ok: true` **and** on `unavailable`
 * (after calling {@link warnScanUnavailable}), and refuses on a hit.
 */
export async function scanOutboundText(options: {
  text: string;
  cwd: string;
}): Promise<OutboundTextScan> {
  const run = await runStdinScan(options);
  switch (run.kind) {
    case "clean":
      return { ok: true };
    case "leaks":
      return { ok: false, rules: ruleIdsOf(run.stdout) };
    case "unavailable":
      return { ok: false, unavailable: run.error };
  }
}

/**
 * Warn once per session that the outbound scan cannot run.
 *
 * Callers own the budget (see {@link SecretScanWarnBudget}): the failure is
 * environmental and repeats on every post, so an unthrottled warn would bury the
 * daemon log.
 */
export function warnScanUnavailable(options: {
  budget: SecretScanWarnBudget;
  reason: string;
}): void {
  if (options.budget.secretScanWarned === true) return;
  options.budget.secretScanWarned = true;
  console.warn(
    `[belayd-harness] outbound secret scan is unavailable (${options.reason}): comments are ` +
      "posted unscanned. The scanner is the flake's `betterleaks` package; read a terminal " +
      "through `pi-web-runtime-env` or run `nix build .#pi-web-runtime-env` and restart the " +
      "session.",
  );
}

/**
 * The one refusal sentence, shared by every outbound post.
 *
 * It names the rule ids and never the match, and it tells the author what to do
 * instead: describing the location in prose carries the same information a
 * reader needs without moving the credential.
 */
export function secretRefusalText(rules: readonly string[]): string {
  const named = rules.length === 0 ? "an unnamed rule" : rules.join(", ");
  return (
    `refused to post: the text matches secret scanner rule ${named}. Do not paste the value; ` +
    'name the location in prose instead ("the token in the file at line N") and post again.'
  );
}
