/**
 * Proof-of-work relocation helpers.
 *
 * Proof artifacts used to live inside the git worktree at `proof-of-work/`.
 * They are now written to an external directory (e.g. under XDG state) and
 * exposed in the worktree through a `proof-of-work` symlink. Keeping artifacts
 * out of the worktree means they never show up in git status, diffs, or
 * commit payloads.
 */

import { existsSync, lstatSync, mkdirSync, readlinkSync, type Stats, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Resolve the proof base directory.
 *
 * `BELAYD_PROOF_DIR` wins when set. Otherwise the base is
 * `${XDG_STATE_HOME:-~/.local/state}/belayd/proof`, matching the XDG Base
 * Directory specification for state data.
 */
export function resolveProofBase(env: Record<string, string | undefined>): string {
  const belaydProofDir = env.BELAYD_PROOF_DIR;
  if (belaydProofDir !== undefined && belaydProofDir !== "") {
    return belaydProofDir;
  }

  const xdgStateHome = env.XDG_STATE_HOME;
  const stateHome =
    xdgStateHome !== undefined && xdgStateHome !== ""
      ? xdgStateHome
      : join(homedir(), ".local", "state");

  return join(stateHome, "belayd", "proof");
}

/** Compute the per-task proof directory under a proof base. */
export function proofDirForTask(taskId: string, proofBase: string): string {
  return join(proofBase, taskId);
}

/**
 * Walk up from `cwd` to the nearest ancestor containing a `.git` entry.
 * Returns undefined when no git worktree root is found.
 */
function findWorkspaceRoot(cwd: string): string | undefined {
  let dir = resolve(cwd);
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** True when `error` is a NodeJS filesystem error with the given code. */
function isFsError(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Create (or verify) the `proof-of-work` symlink at the workspace root.
 *
 * Side effect: creates the proof base directory and the symlink when missing.
 * Idempotent when the symlink already points at the expected proof base.
 *
 * - Symlink to the same target → no-op success.
 * - Existing real directory → error (do not clobber real artifacts).
 * - Symlink to a different target → error (do not silently redirect).
 */
export function ensureProofBridge(
  cwd: string,
  proofBase: string,
): { ok: true } | { ok: false; error: string } {
  const workspaceRoot = findWorkspaceRoot(cwd);
  if (workspaceRoot === undefined) {
    return {
      ok: false,
      error: `No .git ancestor found from ${cwd}; cannot locate workspace root for proof-of-work symlink`,
    };
  }

  const absoluteProofBase = resolve(proofBase);
  const linkPath = join(workspaceRoot, "proof-of-work");

  // The external proof base must exist so the symlink resolves to a real dir.
  try {
    mkdirSync(absoluteProofBase, { recursive: true });
  } catch (error) {
    return {
      ok: false,
      error: `Failed to create proof base directory: ${errorMessage(error)}`,
    };
  }

  let linkStat: Stats;
  try {
    linkStat = lstatSync(linkPath);
  } catch (error) {
    if (isFsError(error, "ENOENT")) {
      try {
        symlinkSync(absoluteProofBase, linkPath);
        return { ok: true };
      } catch (symlinkError) {
        return {
          ok: false,
          error: `Failed to create proof-of-work symlink: ${errorMessage(symlinkError)}`,
        };
      }
    }
    return {
      ok: false,
      error: `Failed to inspect proof-of-work: ${errorMessage(error)}`,
    };
  }

  if (linkStat.isSymbolicLink()) {
    let target: string;
    try {
      target = readlinkSync(linkPath);
    } catch (error) {
      return {
        ok: false,
        error: `Failed to read proof-of-work symlink: ${errorMessage(error)}`,
      };
    }
    const resolvedTarget = resolve(workspaceRoot, target);
    if (resolvedTarget === absoluteProofBase) {
      return { ok: true };
    }
    return {
      ok: false,
      error: `proof-of-work already points to ${target}, expected ${absoluteProofBase}`,
    };
  }

  if (linkStat.isDirectory()) {
    return {
      ok: false,
      error: `proof-of-work already exists as a real directory at ${linkPath}`,
    };
  }

  return {
    ok: false,
    error: `proof-of-work already exists and is not a symlink at ${linkPath}`,
  };
}
