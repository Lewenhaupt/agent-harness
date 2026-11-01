
export const PROOF_OF_WORK_ROOT = "proof-of-work";

// SYNC WARNING: The receipt path, JSON shape and reference shape below are a
// cross-component contract duplicated in `src/proof-receipt.ts`
// (`PROOF_RECEIPT_RELATIVE_PATH`, `ProofReceiptSchema` (zod), `isProofReceiptId`
// and `isProofReceiptUrl`). The receipt lives at ".belayd/proof-receipt.json"
// and holds one JSON object:
// `{ version: 1, taskId: string, id?: string, url?: string, uploadedAt?: string,
// artifactCount?: number }` with at least one of `id`/`url`. An `id` is a UUID
// or >= 8 chars of `[A-Za-z0-9]` containing `-`/`_`; a `url` is an absolute
// `https:` URL (plain `http:` is rejected — there is no localhost exception)
// with a non-empty host and a non-root path. That id shape is a deliberate
// contract decision, not a formatting preference: accepting a short, unpadded
// platform id later is a `PROOF_RECEIPT_VERSION` bump in `src/proof-receipt.ts`
// (mirrored here), never a local tweak.
//
// This file cannot import zod or the TypeScript module, so `normalizeProofReceipt`
// below is the hand-rolled mirror of `ProofReceiptSchema`. It must be kept in
// sync with the zod schema in `src/proof-receipt.ts` — strict key set, the
// `version: 1` literal, the at-least-one-reference rule, the id shape, and the
// https-only url rule — and vice versa.
export const PROOF_RECEIPT_PATH = ".belayd/proof-receipt.json";

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

/** Accepted receipt keys; anything else is an unknown shape. */
const receiptKeys = new Set([
  "version",
  "taskId",
  "id",
  "url",
  "uploadedAt",
  "artifactCount",
]);

function receiptString(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

const MIN_RECEIPT_ID_LENGTH = 8;
const receiptIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const receiptUuidPattern =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Mirrors `isProofReceiptId`: UUIDs, or >= 8 id chars containing `-`/`_`. */
function isProofReceiptId(value) {
  if (receiptUuidPattern.test(value)) return true;
  if (!receiptIdPattern.test(value)) return false;
  if (value.length < MIN_RECEIPT_ID_LENGTH) return false;
  return value.includes("-") || value.includes("_");
}

/**
 * Mirrors `isProofReceiptUrl`: absolute `https:` only, non-empty host, non-root
 * path. Plain `http:` is rejected because the published contract (the proof
 * prompt and `docs/proof-verifier.md`) is https-only; see the SYNC WARNING.
 */
function isProofReceiptUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.hostname === "") return false;
  return parsed.pathname !== "" && parsed.pathname !== "/";
}

/**
 * Validate and normalize a parsed receipt object, mirroring
 * `ProofReceiptSchema` in `src/proof-receipt.ts` (see the SYNC WARNING above).
 * Returns undefined for any data that does not match the contract.
 */
function normalizeProofReceipt(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  if (Object.keys(raw).some((key) => !receiptKeys.has(key))) return undefined;
  if (raw.version !== 1) return undefined;

  const taskId = receiptString(raw.taskId);
  if (taskId === undefined) return undefined;

  const id = raw.id === undefined ? undefined : receiptString(raw.id);
  if (raw.id !== undefined && id === undefined) return undefined;

  const url = raw.url === undefined ? undefined : receiptString(raw.url);
  if (raw.url !== undefined && url === undefined) return undefined;

  if (id === undefined && url === undefined) return undefined;
  // The stored receipt is held to the same reference shape as an output line;
  // the two are compared by the gate, so the shapes must agree.
  if (id !== undefined && !isProofReceiptId(id)) return undefined;
  if (url !== undefined && !isProofReceiptUrl(url)) return undefined;

  const uploadedAt = raw.uploadedAt === undefined ? undefined : receiptString(raw.uploadedAt);
  if (raw.uploadedAt !== undefined && uploadedAt === undefined) return undefined;

  const artifactCount = raw.artifactCount;
  if (
    artifactCount !== undefined &&
    (!Number.isInteger(artifactCount) || artifactCount < 0)
  ) {
    return undefined;
  }

  return {
    version: 1,
    taskId,
    ...(id === undefined ? {} : { id }),
    ...(url === undefined ? {} : { url }),
    ...(uploadedAt === undefined ? {} : { uploadedAt }),
    ...(artifactCount === undefined ? {} : { artifactCount }),
  };
}

/**
 * Read the proof receipt from the (gitignored) workspace receipt file.
 *
 * A missing file is `{ kind: "none" }` — the platform does not exist for most
 * beads yet, so the panel falls back to the external proof root. Malformed,
 * denied or binary content is `{ kind: "invalid", detail }`. Never rejects.
 */
export async function resolveProofReceipt(files) {
  let file;
  try {
    file = await files.readFile(PROOF_RECEIPT_PATH);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "Path does not exist") return { kind: "none" };
    return { kind: "invalid", detail: message };
  }

  if (file.binary) return { kind: "invalid", detail: "proof receipt is binary" };
  if (typeof file.content !== "string") {
    return { kind: "invalid", detail: "proof receipt has no text content" };
  }

  let raw;
  try {
    raw = JSON.parse(file.content);
  } catch {
    return { kind: "invalid", detail: "proof receipt is not valid JSON" };
  }

  const receipt = normalizeProofReceipt(raw);
  if (receipt === undefined) {
    return { kind: "invalid", detail: "proof receipt does not match the receipt contract" };
  }
  return { kind: "receipt", receipt };
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
