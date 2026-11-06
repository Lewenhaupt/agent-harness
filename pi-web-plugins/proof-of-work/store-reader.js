// SYNC WARNING: this is the plain-JS mirror of the proof-receipt read half of
// the per-repository execution store in `src/repo-state-store.ts` (bd-281,
// bd-303). The proof-of-work server module runs inside the pi-web session
// daemon and cannot import TypeScript, but the panel must still show a receipt
// the harness wrote, so it reads the same SQLite file directly. Both sides must
// agree on:
//
//   - the store file name `state.sqlite`, inside the `belayd` directory of the
//     git common dir (`<git-common-dir>/belayd/state.sqlite`);
//   - the relocation override `BELAYD_REPO_STATE_FILE` (`REPO_STATE_FILE_ENV`);
//   - table `workflow_binding` and its columns (worktree_path, task_id,
//     bound_at): the worktree -> task id locator. A row whose `task_id` is the
//     empty string is a cleared binding, not a task id;
//   - table `proof_receipt` and its columns (task_id, payload, updated_at): the
//     receipt document is `payload` as JSON text, keyed by the task id.
//
// Failure modes are mirrored as well: a store file that does not exist is
// `absent` ("no receipt", because the harness creates it on the first write),
// while an existing file that cannot be read — corrupt, not SQLite, a schema
// without `proof_receipt`, a permission problem — is a failure the caller
// renders as unreadable.
//
// What crosses is only the row's `payload` text; the receipt JSON shape and its
// validation rules are mirrored separately in `discovery.js` (see the SYNC
// WARNING there), which stays the single browser-side shape check.
//
// This reader has **no write path at all**: the connection is opened with
// `{ readOnly: true }` and the returned handle exposes reads only. The server
// module renders an unavailable receipt rather than opening the store writable,
// and it never creates, migrates or repairs the file — that belongs to the
// harness, which owns the schema.

import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";

/** Environment override for the store path (mirrors `REPO_STATE_FILE_ENV`). */
export const REPO_STATE_FILE_ENV = "BELAYD_REPO_STATE_FILE";

/** Store file name inside the `belayd` dir (mirrors `REPO_STATE_FILE_NAME`). */
export const REPO_STATE_FILE_NAME = "state.sqlite";

/** Directory the store lives in, below the git common dir. */
export const REPO_STATE_DIR_NAME = "belayd";

export const WORKFLOW_BINDING_TABLE = "workflow_binding";
export const PROOF_RECEIPT_TABLE = "proof_receipt";

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function readInteger(row, key) {
  const value = row[key];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return 0;
}

/**
 * Open the per-repository store read-only.
 *
 * A store file that does not exist is `absent`, not a failure: the harness
 * creates the file (and its directory) on the first write, so a workspace where
 * no phase tool has run yet — or whose store was deleted — is the ordinary "no
 * receipt" case, exactly what the harness's own read reports. The check is the
 * filesystem, not the engine's error text.
 *
 * Every other open failure is a real failure (`absent: false`): a corrupt file,
 * a file that is not SQLite, a permission problem, or a store whose schema
 * predates `proof_receipt`. The caller renders those as unreadable rather than
 * as "no receipt".
 *
 * Opening still probes both mirrored tables once. A writable store would migrate
 * here; this reader cannot and must not, because schema apply is the harness's
 * job and a write path would give the panel a second authority.
 *
 * @param {{ path: string }} options
 * @returns {({ ok: true, store: object } | { ok: false, absent: boolean, error: string })}
 */
export function openProofReceiptReader(options) {
  if (!existsSync(options.path)) {
    return { ok: false, absent: true, error: `${options.path} does not exist` };
  }

  let database;
  try {
    database = new DatabaseSync(options.path, { readOnly: true, timeout: 5000 });
    database.prepare(`SELECT 1 FROM ${WORKFLOW_BINDING_TABLE} LIMIT 1`).get();
    database.prepare(`SELECT 1 FROM ${PROOF_RECEIPT_TABLE} LIMIT 1`).get();
  } catch (error) {
    if (database !== undefined) {
      try {
        database.close();
      } catch {
        // A handle that failed its schema probe may already be unusable.
      }
    }
    return {
      ok: false,
      absent: false,
      error: `could not open ${options.path}: ${errorMessage(error)}`,
    };
  }

  let closed = false;
  const assertOpen = () => {
    if (closed) throw new Error(`repository store ${options.path} is closed`);
  };

  const store = {
    readOnly: true,
    path: options.path,
    /** Task id bound to a worktree, or null when the worktree has no binding. */
    readBoundTaskId(worktreePath) {
      assertOpen();
      const row = database
        .prepare(`SELECT task_id FROM ${WORKFLOW_BINDING_TABLE} WHERE worktree_path = ?`)
        .get(worktreePath);
      if (row === undefined) return null;
      const taskId = row.task_id;
      if (typeof taskId !== "string" || taskId === "") return null;
      return taskId;
    },
    /** The stored receipt payload text and write time, or null when no row exists. */
    readReceipt(taskId) {
      assertOpen();
      const row = database
        .prepare(`SELECT payload, updated_at FROM ${PROOF_RECEIPT_TABLE} WHERE task_id = ?`)
        .get(taskId);
      if (row === undefined) return null;
      const payload = row.payload;
      if (typeof payload !== "string") {
        throw new Error(`proof receipt for ${taskId} has no payload text`);
      }
      return { payload, updatedAt: readInteger(row, "updated_at") };
    },
    close() {
      if (closed) return;
      closed = true;
      database.close();
    },
  };

  return { ok: true, store };
}
