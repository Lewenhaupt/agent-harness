
export const PROOF_OF_WORK_ROOT = "proof-of-work";

// SYNC WARNING: The marker path and file format below are a cross-component
// contract duplicated in `src/proof-dir.ts` (`PROOF_DIR_MARKER_RELATIVE_PATH`).
// The marker lives at ".belayd/proof-dir" and contains a single-line absolute
// proof base path followed by a trailing newline. Any change here must be
// mirrored in `src/proof-dir.ts`, and vice versa.
export const PROOF_DIR_MARKER_PATH = ".belayd/proof-dir";

const missingListingErrorMessages = new Set(["Path does not exist", "Path is not a directory"]);
const deniedListingErrorMessages = new Set([
  "Absolute paths are not allowed",
  "Path is outside allowed paths",
  "Path escapes workspace",
  "Path traversal is not allowed",
]);

/**
 * Resolve where proof artifacts live, given pi-web's browser file API.
 *
 * The harness writes a marker file (`.belayd/proof-dir`) carrying the absolute
 * proof base, because the browser plugin cannot read server-side env. When the
 * marker is absent we fall back to the legacy workspace-relative
 * `proof-of-work` symlink location.
 *
 * Never rejects.
 */
export async function resolveProofRoot(files) {
  let file;
  try {
    file = await files.readFile(PROOF_DIR_MARKER_PATH);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "Path does not exist") {
      return { kind: "workspace", path: PROOF_OF_WORK_ROOT };
    }
    return { kind: "unavailable", detail: message };
  }

  if (file.binary) {
    return { kind: "unavailable", detail: "proof-dir marker is binary" };
  }

  if (typeof file.content !== "string") {
    return { kind: "unavailable", detail: "proof-dir marker has no text content" };
  }

  const base = file.content.trim();
  if (base === "") {
    return { kind: "unavailable", detail: "proof-dir marker is empty" };
  }
  if (base === "/") {
    return { kind: "unavailable", detail: "proof-dir marker must not point at the filesystem root" };
  }
  if (!base.startsWith("/")) {
    return { kind: "unavailable", detail: `proof-dir marker is not an absolute path: ${base}` };
  }
  return { kind: "external", path: base };
}

/** List task directories under proof-of-work/. Never rejects. */
export async function listTaskDirs(files, rootPath = PROOF_OF_WORK_ROOT) {
  let listing;
  try {
    listing = await files.listFiles(rootPath);
  } catch (error) {
    return fileAccessFailure(error);
  }
  const tasks = listing.entries
    .filter((entry) => entry.type === "directory")
    .map((entry) => ({ name: entry.name, path: entry.path }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return { kind: "loaded", tasks };
}

/** List files inside a single task directory. Never rejects. */
export async function listTaskFiles(files, taskPath) {
  let listing;
  try {
    listing = await files.listFiles(taskPath);
  } catch (error) {
    return fileAccessFailure(error);
  }
  const fileEntries = listing.entries
    .filter((entry) => entry.type === "file")
    .map((entry) => ({ name: entry.name, path: entry.path }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return { kind: "loaded", files: fileEntries };
}

/** Read a single proof-of-work file. Never rejects. */
export async function readProofFile(files, filePath) {
  try {
    const file = await files.readFile(filePath);
    return {
      kind: "loaded",
      content: file.content,
      binary: file.binary,
      truncated: file.truncated,
      modifiedAt: file.modifiedAt,
    };
  } catch (error) {
    return fileAccessFailure(error);
  }
}

/**
 * Resolve a panel file path to the absolute path `playwright show-trace`
 * should serve.
 *
 * External mode lists the proof base by absolute path, so an absolute panel
 * path passes through unchanged. Legacy or logical callers may hand us the
 * workspace-relative `proof-of-work/<rest>` view; map that onto the persistent
 * external base so a trace survives worktree removal. Workspace mode keeps the
 * workspace-relative path, which is the real location in that mode.
 */
export function resolveTracePath(proofRoot, workspacePath, filePath) {
  if (proofRoot !== undefined && proofRoot.kind === "external" && !filePath.startsWith("/")) {
    const rest = stripProofOfWorkPrefix(filePath);
    if (rest !== undefined) {
      return joinPath(proofRoot.path, rest);
    }
  }
  return joinPath(workspacePath, filePath);
}

/**
 * Confirm a resolved absolute proof file still exists by listing its parent
 * directory. Returns false when the directory or entry is gone, or when the
 * listing is denied. Never rejects.
 */
export async function traceFileAvailable(files, absolutePath) {
  const { dir, name } = splitAbsolutePath(absolutePath);
  // A trailing-slash/empty path (or the filesystem root) has no basename, so it
  // must never be allowed to match a listing entry by an empty name.
  if (name === "" || name === "." || name === "..") return false;
  try {
    const listing = await files.listFiles(dir);
    return listing.entries.some((entry) => entry.name === name && entry.type !== "directory");
  } catch {
    return false;
  }
}

function stripProofOfWorkPrefix(filePath) {
  if (filePath === PROOF_OF_WORK_ROOT) return "";
  const prefix = `${PROOF_OF_WORK_ROOT}/`;
  return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : undefined;
}

function joinPath(base, filePath) {
  if (filePath.startsWith("/")) return filePath;
  const trimmed = base.replace(/\/+$/, "");
  return filePath === "" ? `${trimmed}/` : `${trimmed}/${filePath}`;
}

function splitAbsolutePath(absolutePath) {
  // A file path with a trailing slash, or the empty string, has no basename.
  // Return an empty name so the caller's entry match can never succeed, and
  // point `dir` at the normalized path rather than an unintended parent.
  if (absolutePath === "" || /\/+$/.test(absolutePath)) {
    const dir = absolutePath.replace(/\/+$/, "") || "/";
    return { dir, name: "" };
  }
  if (!absolutePath.startsWith("/")) {
    const slash = absolutePath.lastIndexOf("/");
    if (slash === -1) return { dir: ".", name: absolutePath };
    return { dir: absolutePath.slice(0, slash) || ".", name: absolutePath.slice(slash + 1) };
  }
  const slash = absolutePath.lastIndexOf("/");
  if (slash <= 0) return { dir: "/", name: absolutePath.slice(1) };
  return { dir: absolutePath.slice(0, slash), name: absolutePath.slice(slash + 1) };
}

/** Return the lowercase file extension including the leading dot. */
export function getFileExtension(path) {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot).toLowerCase();
}

/** Build the pi-web preview URL for a binary media file (image or video).
 *  readFile() returns content:"" for these files; their bytes are served only
 *  by the streaming preview route, which local machines expose directly and
 *  remote machines expose through the /api/machines/:id proxy. An optional
 *  modifiedAt appends a cache-busting `v` param so a refreshed artifact is not
 *  served stale by the route's `max-age=3600` caching. */
export function mediaPreviewUrl({ machineId, machineKind, projectId, workspaceId, filePath, modifiedAt }) {
  const resource = `/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/file/preview`;
  const prefix = machineKind === "remote" ? `/api/machines/${encodeURIComponent(machineId)}` : "/api";
  const cacheBust = modifiedAt === undefined || modifiedAt === "" ? "" : `&v=${encodeURIComponent(modifiedAt)}`;
  return `${prefix}${resource}?path=${encodeURIComponent(filePath)}${cacheBust}`;
}

function fileAccessFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (deniedListingErrorMessages.has(message)) {
    return { kind: "denied", detail: message };
  }
  if (missingListingErrorMessages.has(message)) {
    return { kind: "missing" };
  }
  return { kind: "unavailable", detail: message };
}
