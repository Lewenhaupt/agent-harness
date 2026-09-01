
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
    };
  } catch (error) {
    return fileAccessFailure(error);
  }
}

/** Return the lowercase file extension including the leading dot. */
export function getFileExtension(path) {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot).toLowerCase();
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
