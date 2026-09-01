/**
 * Proof-of-work relocation helpers.
 *
 * Proof artifacts used to live inside the git worktree at `proof-of-work/`.
 * They are now written to an external directory (e.g. under XDG state) and
 * exposed in the worktree through a `proof-of-work` symlink. Keeping artifacts
 * out of the worktree means they never show up in git status, diffs, or
 * commit payloads.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  type Stats,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
 * Workspace-relative path of the file that records the absolute proof base.
 *
 * pi-web's browser file API cannot read server-side environment variables, so
 * this marker is the only channel through which the browser plugin learns
 * where proof artifacts actually live. It lives under `.belayd/`, which is
 * gitignored alongside the `proof-of-work` symlink.
 */
// SYNC WARNING: The marker path and file format below are a cross-component
// contract duplicated in `pi-web-plugins/proof-of-work/discovery.js`
// (`PROOF_DIR_MARKER_PATH`). The marker lives at ".belayd/proof-dir" and
// contains a single-line absolute proof base path followed by a trailing
// newline. Any change here must be mirrored in
// `pi-web-plugins/proof-of-work/discovery.js`, and vice versa.
export const PROOF_DIR_MARKER_RELATIVE_PATH = ".belayd/proof-dir";

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
 * Write the absolute proof base into the workspace marker file.
 *
 * The browser plugin reads this file through its absolute-path file API to
 * discover where proof artifacts live; it cannot read server environment
 * variables, so the marker is the only channel for that information.
 */
function writeProofDirMarker(
  workspaceRoot: string,
  absoluteProofBase: string,
): { ok: true } | { ok: false; error: string } {
  try {
    mkdirSync(join(workspaceRoot, ".belayd"), { recursive: true });
    writeFileSync(
      join(workspaceRoot, PROOF_DIR_MARKER_RELATIVE_PATH),
      `${absoluteProofBase}\n`,
      "utf-8",
    );
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `Failed to write proof dir marker: ${errorMessage(error)}` };
  }
}

/**
 * Create (or verify) the `proof-of-work` symlink at the workspace root and
 * write the proof-base marker that the browser plugin reads.
 *
 * The bridge contract has two parts:
 * - the `proof-of-work` symlink (terminal/agent use; resolves the external base)
 * - the `.belayd/proof-dir` marker (browser plugin use; carries the absolute base)
 *
 * A successful return guarantees both are in place; every error path leaves
 * the marker untouched.
 *
 * Side effect: creates the proof base directory, the symlink, and the marker.
 * Idempotent when the symlink already points at the expected proof base.
 *
 * - Symlink to the same target → rewrite marker, success.
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
        return writeProofDirMarker(workspaceRoot, absoluteProofBase);
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
      return writeProofDirMarker(workspaceRoot, absoluteProofBase);
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
