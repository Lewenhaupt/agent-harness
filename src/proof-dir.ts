/**
 * Proof-of-work relocation helpers.
 *
 * Proof artifacts used to live inside the git worktree at `proof-of-work/`.
 * They are now written to an external directory (e.g. under XDG state) and
 * exposed in the worktree through a `proof-of-work` symlink. Keeping artifacts
 * out of the worktree means they never show up in git status, diffs, or
 * commit payloads.
 *
 * Namespacing: {@link resolveProofBase} returns the global proof root and
 * {@link resolveProjectProofBase} returns `root/<projectKey>`, so identical
 * task IDs in different git repositories never share a proof directory.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmdirSync,
  type Stats,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveRepoKey } from "./worktree.js";

/**
 * Resolve the global proof root.
 *
 * `BELAYD_PROOF_DIR` wins when set. Otherwise the root is
 * `${XDG_STATE_HOME:-~/.local/state}/belayd/proof`, matching the XDG Base
 * Directory specification for state data. The per-project base is
 * `root/<projectKey>` (see {@link resolveProjectProofBase}); this function
 * intentionally stays project-agnostic so legacy callers keep the old path.
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

/**
 * Resolve the project-scoped proof base: `resolveProofBase(env)/<projectKey>`.
 *
 * The key is derived from the git common dir of `cwd`, so every linked
 * worktree of one repository maps to the same base. A custom
 * `BELAYD_PROOF_DIR` is namespaced the same way.
 *
 * Side effect: derives the key via git (see `resolveRepoKey`).
 */
export function resolveProjectProofBase(
  env: Record<string, string | undefined>,
  cwd: string,
): { ok: true; base: string } | { ok: false; error: string } {
  const repoKey = resolveRepoKey(cwd);
  if (!repoKey.ok) {
    return { ok: false, error: repoKey.error };
  }
  return { ok: true, base: join(resolveProofBase(env), repoKey.key) };
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
// newline. bd-58 namespaces the proof base by project key but leaves this
// marker format unchanged (still one absolute path line), so discovery.js
// needs no edit. Any change here must be mirrored in
// `pi-web-plugins/proof-of-work/discovery.js`, and vice versa.
export const PROOF_DIR_MARKER_RELATIVE_PATH = ".belayd/proof-dir";

/**
 * Read the proof-base marker, returning undefined when it is missing or empty.
 * The marker is the harness-owned signal that a bridge symlink is safe to
 * repoint (production of the marker proves the harness created the bridge).
 */
function readProofDirMarker(workspaceRoot: string): string | undefined {
  try {
    const content = readFileSync(join(workspaceRoot, PROOF_DIR_MARKER_RELATIVE_PATH), "utf-8");
    const trimmed = content.trim();
    return trimmed === "" ? undefined : trimmed;
  } catch {
    // Any read failure means there is no usable marker, and a missing marker
    // means the bridge is not harness-owned, so failing closed is the safe
    // direction (never repoint a link we cannot prove we created).
    return undefined;
  }
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

function createSymlinkAndMarker(
  workspaceRoot: string,
  absoluteProofBase: string,
  linkPath: string,
): { ok: true } | { ok: false; error: string } {
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

/** True when the directory exists and contains no entries. */
function isEmptyDirectory(
  path: string,
): { ok: true; empty: boolean } | { ok: false; error: string } {
  try {
    return { ok: true, empty: readdirSync(path).length === 0 };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/**
 * Replace an empty real directory with the bridge symlink. Non-empty
 * directories are left untouched so real artifacts are never clobbered.
 */
function replaceEmptyDirectoryWithSymlink(
  workspaceRoot: string,
  absoluteProofBase: string,
  linkPath: string,
): { ok: true } | { ok: false; error: string } {
  const isEmpty = isEmptyDirectory(linkPath);
  if (!isEmpty.ok) {
    return {
      ok: false,
      error: `proof-of-work already exists as a real directory at ${linkPath} and could not be inspected: ${isEmpty.error}`,
    };
  }
  if (!isEmpty.empty) {
    return {
      ok: false,
      error: `proof-of-work already exists as a real directory with content at ${linkPath}`,
    };
  }
  try {
    rmdirSync(linkPath);
  } catch (error) {
    return {
      ok: false,
      error: `Failed to remove empty proof-of-work directory: ${errorMessage(error)}`,
    };
  }
  return createSymlinkAndMarker(workspaceRoot, absoluteProofBase, linkPath);
}

/**
 * Repoint a harness-owned bridge symlink at the expected proof base.
 *
 * Only called after the marker has been verified to match the current symlink
 * target, so the stale link is known to be harness-owned and safe to replace.
 */
function repointSymlink(
  workspaceRoot: string,
  absoluteProofBase: string,
  linkPath: string,
): { ok: true } | { ok: false; error: string } {
  // The unlink→symlink window is subject to a race; a lost race surfaces as a
  // caught symlinkSync error returned as { ok: false } (non-fatal, and never a
  // silent mis-point).
  try {
    unlinkSync(linkPath);
  } catch (error) {
    return {
      ok: false,
      error: `Failed to remove stale proof-of-work symlink: ${errorMessage(error)}`,
    };
  }
  try {
    symlinkSync(absoluteProofBase, linkPath);
  } catch (error) {
    return {
      ok: false,
      error: `Failed to repoint proof-of-work symlink: ${errorMessage(error)}`,
    };
  }
  return writeProofDirMarker(workspaceRoot, absoluteProofBase);
}

/**
 * Inspect the existing `proof-of-work` entry and create, verify, repoint, or
 * reject it. Split from {@link ensureProofBridge} to keep both functions'
 * branching readable.
 */
function ensureSymlinkBridge(
  workspaceRoot: string,
  absoluteProofBase: string,
  linkPath: string,
): { ok: true } | { ok: false; error: string } {
  let linkStat: Stats;
  try {
    linkStat = lstatSync(linkPath);
  } catch (error) {
    if (isFsError(error, "ENOENT")) {
      return createSymlinkAndMarker(workspaceRoot, absoluteProofBase, linkPath);
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
    // The bridge target and the marker both store absolute paths, so a
    // relative symlink target can never match the marker and is therefore
    // never repointed (fails closed).
    const resolvedTarget = resolve(workspaceRoot, target);
    if (resolvedTarget === absoluteProofBase) {
      return writeProofDirMarker(workspaceRoot, absoluteProofBase);
    }
    const marker = readProofDirMarker(workspaceRoot);
    if (marker !== undefined && resolve(workspaceRoot, marker) === resolvedTarget) {
      return repointSymlink(workspaceRoot, absoluteProofBase, linkPath);
    }
    return {
      ok: false,
      error: `proof-of-work already points to ${target}, expected ${absoluteProofBase}`,
    };
  }

  if (linkStat.isDirectory()) {
    return replaceEmptyDirectoryWithSymlink(workspaceRoot, absoluteProofBase, linkPath);
  }

  return {
    ok: false,
    error: `proof-of-work already exists and is not a symlink at ${linkPath}`,
  };
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
 * - Symlink to a different target whose marker matches that target → repoint
 *   (harness-owned bridge being migrated to a new namespaced base).
 * - Symlink to a different target with no/mismatched marker → error (do not
 *   silently redirect a link we did not create).
 * - Existing empty real directory → removed and replaced with the symlink
 *   (a stray empty directory is a setup artifact, not real proof content).
 * - Existing non-empty real directory → error (do not clobber real artifacts).
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

  return ensureSymlinkBridge(workspaceRoot, absoluteProofBase, linkPath);
}
