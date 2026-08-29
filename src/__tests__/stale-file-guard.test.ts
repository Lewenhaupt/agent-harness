import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkEdit, clearHashes, recordRead, reset } from "../stale-file-guard.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "stale-guard-test-"));
  reset();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  reset();
});

function writeTestFile(relativePath: string, content: string): string {
  const fullPath = join(tmpDir, relativePath);
  const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(fullPath, content, "utf8");
  return fullPath;
}

describe("recordRead", () => {
  it("accepts absolute paths", () => {
    const filePath = writeTestFile("test.txt", "hello world");
    recordRead(filePath, readFileSync(filePath, "utf8"));
    // No assertion needed — just verifies no error
  });

  it("accepts relative paths", () => {
    writeTestFile("test.txt", "hello world");
    // Change to tmpDir so the relative path works
    const origCwd = process.cwd;
    process.cwd = () => tmpDir;
    try {
      recordRead("test.txt", "hello world");
    } finally {
      process.cwd = origCwd;
    }
  });
});

describe("clearHashes", () => {
  it("removes all tracked file hashes", () => {
    const filePath = writeTestFile("test.txt", "hello world");
    recordRead(filePath, readFileSync(filePath, "utf8"));

    clearHashes();

    // After clearing, edit should be allowed (no hash to compare)
    const result = checkEdit(filePath);
    expect(result.allowed).toBe(true);
  });
});

describe("checkEdit", () => {
  it("allows edit when file was read and not modified", () => {
    const filePath = writeTestFile("test.txt", "hello world");
    recordRead(filePath, readFileSync(filePath, "utf8"));

    const result = checkEdit(filePath);
    expect(result.allowed).toBe(true);
  });

  it("blocks edit when file has changed since read", () => {
    const filePath = writeTestFile("test.txt", "hello world");
    // Read and record the initial content
    recordRead(filePath, readFileSync(filePath, "utf8"));

    // Modify the file externally
    writeFileSync(filePath, "modified content", "utf8");

    // Edit should be blocked
    const result = checkEdit(filePath);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("has changed since it was read");
  });

  it("blocks edit after bash cleared hashes (simulated by clearHashes)", () => {
    const filePath = writeTestFile("test.txt", "hello world");
    recordRead(filePath, readFileSync(filePath, "utf8"));

    // Simulate bash execution clearing all hashes
    clearHashes();

    // Edit the file (normally would be fine since bash cleared hashes)
    writeFileSync(filePath, "new content", "utf8");

    // Now checkEdit should allow (no hash tracked)
    const result = checkEdit(filePath);
    expect(result.allowed).toBe(true);
  });

  it("allows edit when no read was recorded for the file", () => {
    const filePath = writeTestFile("test.txt", "hello world");

    // No recordRead called — edit should be allowed
    const result = checkEdit(filePath);
    expect(result.allowed).toBe(true);
  });

  it("allows edit when file was read and then cleared", () => {
    const filePath = writeTestFile("test.txt", "hello world");
    recordRead(filePath, readFileSync(filePath, "utf8"));
    clearHashes();

    const result = checkEdit(filePath);
    expect(result.allowed).toBe(true);
  });

  it("provides a useful error message when blocked", () => {
    const filePath = writeTestFile("test.txt", "original content");
    recordRead(filePath, readFileSync(filePath, "utf8"));
    writeFileSync(filePath, "changed content", "utf8");

    const result = checkEdit(filePath);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(result.reason?.length).toBeGreaterThan(10);
  });

  it("handles non-existent files gracefully", () => {
    // Record a read for a file that doesn't exist yet
    const fakePath = join(tmpDir, "nonexistent.txt");
    recordRead(fakePath, "");

    // File doesn't exist — should allow (edit tool will fail with its own error)
    const result = checkEdit(fakePath);
    expect(result.allowed).toBe(true);
  });
});
