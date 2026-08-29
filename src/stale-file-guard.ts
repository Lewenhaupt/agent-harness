/**
 * Stale-file detection pi extension.
 *
 * Tracks which files have been read (by content hash) and blocks edit/write
 * operations when the file has changed since the last read. This prevents
 * the agent from silently editing files that were modified externally
 * (e.g., by a bash command).
 *
 * Behavior matrix:
 *   Read → edit (no changes)         → Passes
 *   Read → bash anything → edit      → Blocked (bash clears all hashes)
 *   Read → external change → edit    → Blocked (hash mismatch)
 *   Edit without reading first       → Allowed (no hash to compare)
 *   Write without reading            → Not blocked (write is intentional overwrite)
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Module-level state is reset per extension lifecycle
const fileHashes = new Map<string, string>();

/**
 * A simple content-addressable hash store for tracking file content.
 * Maps file paths to SHA-256 hex digests of their content at last read.
 */

/**
 * Hashes a string using SHA-256 and returns the hex digest.
 * Uses Node.js built-in crypto for performance.
 */
function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Records the current content hash of a file after a read operation.
 *
 * @param filePath - Absolute or relative path to the file that was read.
 * @param content - The full text content that was read from the file.
 */
export function recordRead(filePath: string, content: string): void {
  const normalizedPath = normalizePath(filePath);
  fileHashes.set(normalizedPath, sha256(content));
}

/**
 * Clears all tracked file hashes.
 * Called automatically after any bash execution (conservative invalidation).
 */
export function clearHashes(): void {
  fileHashes.clear();
}

/**
 * Checks whether an edit operation is safe to proceed.
 *
 * @param filePath - The file being edited.
 * @returns An object indicating whether the edit is allowed.
 *   If blocked, the `reason` field explains why.
 */
export function checkEdit(filePath: string): { allowed: boolean; reason?: string } {
  const normalizedPath = normalizePath(filePath);

  // No recorded hash → file was not read in this session. Allow the edit
  // (the agent may have created the file or is editing without a prior read).
  if (!fileHashes.has(normalizedPath)) {
    return { allowed: true };
  }

  const storedHash = fileHashes.get(normalizedPath);
  if (!storedHash) {
    return { allowed: true };
  }

  // Read the current file content
  let currentContent: string;
  try {
    currentContent = readFileSync(normalizedPath, "utf8");
  } catch {
    // File doesn't exist anymore, or can't be read. Allow the edit to proceed
    // (the tool will fail with a meaningful error anyway).
    return { allowed: true };
  }

  const currentHash = sha256(currentContent);

  if (currentHash !== storedHash) {
    return {
      allowed: false,
      reason: `"${normalizedPath}" has changed since it was read. Re-read it to get the latest content.`,
    };
  }

  return { allowed: true };
}

/**
 * Normalizes a file path to an absolute path for consistent hash lookups.
 */
function normalizePath(filePath: string): string {
  // If it's already absolute, use as-is
  if (filePath.startsWith("/")) {
    return filePath;
  }
  // Resolve relative paths against current working directory
  return resolve(process.cwd(), filePath);
}

/**
 * Returns the number of tracked file hashes (for testing/debugging).
 */
export function getTrackedFileCount(): number {
  return fileHashes.size;
}

/**
 * Clears all state (for testing).
 */
export function reset(): void {
  fileHashes.clear();
}
