// SYNC WARNING: this server entry is the read side of the proof receipt, whose
// one source of truth is the per-repository execution store in
// `src/repo-state-store.ts` (bd-281) and the receipt contract in
// `src/proof-receipt.ts` (bd-181, bd-303). The browser entry cannot read
// `<git-common-dir>/belayd/state.sqlite` — pi-web's browser file API only sees
// the workspace — so the panel asks this module, which resolves the store the
// same way the harness does:
//
//   - `${BELAYD_REPO_STATE_FILE}` when set and non-empty, else
//     `<git-common-dir>/belayd/state.sqlite`;
//   - the git common dir from `git rev-parse --path-format=absolute
//     --git-common-dir` run in the requested workspace with the inherited
//     git-context variables unset (`GIT_CONTEXT_ENV_KEYS`, mirroring
//     `gitContextFreeEnv()` in `src/worktree-list.ts`), so every linked worktree
//     of one repository reads the one store whatever the daemon's environment;
//   - the task id from the workspace's `workflow_binding` row — the request
//     cannot name another bead's row;
//   - the row in `proof_receipt` keyed by that task id.
//
// Failure modes mirror the harness's too: a store file that does not exist is
// "no receipt" (the harness creates it on first write), while a store that
// exists but cannot be read is a failure; and a git probe that was killed or
// timed out is `indeterminate`, never "not a repository".
//
// What must stay in sync in both directions is exactly that list plus the
// `state.sqlite`/`belayd` names, the git-context key list, and the two table
// names (`workflow_binding`, `proof_receipt`) with their columns —
// `store-reader.js` carries the SQL and the same warning.
//
// The receipt document itself is NOT validated here: `normalizeProofReceipt` in
// `discovery.js` mirrors `ProofReceiptSchema`, and duplicating the shape rules
// in a second browser-adjacent module would give the contract two places to
// drift. This module moves the row's payload text and nothing else.
//
// There is no write path, no cache and no fallback file: the store is opened
// read-only per request and closed in `finally`, because the harness may replace
// the file between requests and `.belayd/proof-receipt.json` is retired (a
// mirror of it would be the copied state bd-281 exists to remove).

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { openProofReceiptReader, REPO_STATE_DIR_NAME, REPO_STATE_FILE_ENV, REPO_STATE_FILE_NAME } from "./store-reader.js";

/** The one operation this peer serves; `discovery.js` sends the same name. */
export const PROOF_RECEIPT_OPERATION = "receipt";

/**
 * Inherited git-context variables the probe must ignore, mirroring
 * `GIT_CONTEXT_ENV_KEYS` in `src/worktree-list.ts`.
 *
 * A daemon that inherited `GIT_DIR`/`GIT_WORK_TREE`/`GIT_COMMON_DIR` would make
 * `rev-parse` report another repository's common dir and read another store, so
 * both probes pass the same unset list. The parity obligation is recorded in the
 * SYNC WARNING above; `gitContextFreeEnv()` in `src/worktree-list.ts` is the
 * other side of it.
 */
export const GIT_CONTEXT_ENV_KEYS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
];

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The operation's input, which must be an object but must not name a task.
 *
 * The receipt read is the workspace's bound task's receipt. An input field that
 * named a bead would let any peer request with workspace scope read another
 * task's row, so an unexpected `taskId` is ignored instead of honoured.
 */
function validateInput(input) {
  if (!isRecord(input)) throw new Error("the proof receipt input must be an object");
}

/**
 * Whether `cwd` or an ancestor carries a repository marker, mirroring
 * `hasRepositoryMarker` in `src/git-common-dir.ts`.
 *
 * A git that ran and exited non-zero is only *absence* when no marker exists:
 * git exits 128 both for a plain directory and for broken repository metadata,
 * and a broken repository is a failure, not "no receipt".
 */
function hasRepositoryMarker(cwd) {
  let current = resolve(cwd);
  for (;;) {
    if (existsSync(join(current, ".git"))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * Production git probe: the host's bounded `execFile` seam with the request's
 * own signal, so a cancelled panel request cancels git too.
 */
function hostGitCommonDirProbe(context) {
  return async ({ workspacePath, signal }) => {
    const result = await context.execFile({
      file: "git",
      args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      cwd: workspacePath,
      unsetEnv: GIT_CONTEXT_ENV_KEYS,
      signal,
    });
    // A killed or timed-out child is `indeterminate`, exactly as
    // `classifyProbeFailure` reads it: "I could not ask git" is never an
    // observed absence, so it must not render as "no receipt".
    if (result.exitCode === null || result.signal !== null) {
      const how = result.signal === null ? "without an exit status" : `by ${result.signal}`;
      return {
        ok: false,
        exited: false,
        error: `git rev-parse --git-common-dir in ${workspacePath} was killed ${how}`,
      };
    }
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() === "" ? `exit ${String(result.exitCode)}` : result.stderr.trim();
      return {
        ok: false,
        exited: true,
        error: `git rev-parse --git-common-dir failed in ${workspacePath}: ${detail}`,
      };
    }
    return { ok: true, commonDir: result.stdout };
  };
}

/**
 * The store path for a workspace, mirroring `resolveRepoStatePath`.
 *
 * `none` means git observed that this directory is not inside a repository, so
 * no receipt row can exist; it is an ordinary "no receipt", not an error.
 */
async function resolveReceiptStorePath({ workspacePath, signal, env, probe }) {
  const override = env[REPO_STATE_FILE_ENV];
  if (typeof override === "string" && override !== "") return { ok: true, path: override };

  let probed;
  try {
    probed = await probe({ workspacePath, signal });
  } catch (error) {
    return { ok: false, kind: "unavailable", detail: errorMessage(error) };
  }

  if (!isRecord(probed) || probed.ok !== true) {
    if (isRecord(probed) && probed.exited === true && !hasRepositoryMarker(workspacePath)) {
      return { ok: false, kind: "none" };
    }
    const detail = isRecord(probed) && typeof probed.error === "string" ? probed.error : undefined;
    return {
      ok: false,
      kind: "unavailable",
      detail: detail ?? `git rev-parse returned no common dir for ${workspacePath}`,
    };
  }

  const raw = typeof probed.commonDir === "string" ? probed.commonDir.trim() : "";
  if (raw === "") {
    return {
      ok: false,
      kind: "unavailable",
      detail: `git rev-parse returned an empty common dir for ${workspacePath}`,
    };
  }
  // `--path-format=absolute` already yields an absolute dir; resolving against
  // the workspace keeps a git that ignores the flag from producing a path
  // relative to the daemon's cwd.
  return {
    ok: true,
    path: join(resolve(workspacePath, raw), REPO_STATE_DIR_NAME, REPO_STATE_FILE_NAME),
  };
}

/**
 * Read one workspace's receipt for the panel.
 *
 * Returns `{ kind: "receipt", payload, updatedAt }`, `{ kind: "none" }` (the
 * normal case: no binding or no row) or `{ kind: "unavailable", detail }`.
 */
async function readReceipt(context, overrides, { scope, input, signal }) {
  if (!isRecord(scope) || scope.kind !== "workspace") {
    // A receipt belongs to a repository, so a request that is not scoped to a
    // workspace has no file to look in. Refusing beats guessing a directory.
    throw new Error("the proof receipt is per repository: a workspace scope is required");
  }
  const workspacePath = scope.workspace.path;
  if (typeof workspacePath !== "string" || workspacePath === "") {
    throw new Error("the proof receipt request has no workspace path");
  }
  validateInput(input);

  const resolved = await resolveReceiptStorePath({
    workspacePath,
    signal,
    env: overrides.env ?? process.env,
    probe: overrides.probe ?? hostGitCommonDirProbe(context),
  });
  if (!resolved.ok) {
    return resolved.kind === "none" ? { kind: "none" } : { kind: "unavailable", detail: resolved.detail };
  }

  const opened = openProofReceiptReader({ path: resolved.path });
  // The store file is created by the harness's first write, so "not there yet"
  // is the ordinary no-receipt case, not an unreadable one.
  if (!opened.ok) return opened.absent ? { kind: "none" } : { kind: "unavailable", detail: opened.error };

  try {
    const taskId = opened.store.readBoundTaskId(workspacePath);
    if (taskId === null) return { kind: "none" };
    const row = opened.store.readReceipt(taskId);
    if (row === null) return { kind: "none" };
    return { kind: "receipt", payload: row.payload, updatedAt: row.updatedAt };
  } catch (error) {
    return { kind: "unavailable", detail: errorMessage(error) };
  } finally {
    opened.store.close();
  }
}

/**
 * Build the plugin peer handlers.
 *
 * Separated from `activate()` so tests can drive the operation with a fixture
 * store and an injected git probe, with no host runtime.
 *
 * @param {object} context activation context (only `execFile` is used)
 * @param {{ env?: Record<string, string | undefined>, probe?: Function }} [overrides]
 */
export function createProofOfWorkPeer(context, overrides = {}) {
  return {
    async request({ operation, scope, input, signal }) {
      if (operation !== PROOF_RECEIPT_OPERATION) {
        throw new Error(`unknown proof-of-work operation: ${String(operation)}`);
      }
      return readReceipt(context, overrides, { scope, input, signal });
    },
  };
}

const plugin = {
  apiVersion: 5,
  name: "Proof of Work",
  activate(context) {
    return { peer: createProofOfWorkPeer(context) };
  },
};

export default plugin;
