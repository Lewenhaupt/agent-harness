export const PROOF_OF_WORK_ROOT = "proof-of-work";

const missingListingErrorMessages = new Set(["Path does not exist", "Path is not a directory"]);

/** List task directories under proof-of-work/. Never rejects. */
export async function listTaskDirs(files) {
  let listing;
  try {
    listing = await files.listFiles(PROOF_OF_WORK_ROOT);
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
  if (error instanceof Error && missingListingErrorMessages.has(error.message)) {
    return { kind: "missing" };
  }
  return { kind: "unavailable", detail: error instanceof Error ? error.message : String(error) };
}