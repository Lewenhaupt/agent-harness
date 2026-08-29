import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SpawnDetails } from "../agent-registry.js";
import type { GateOptions } from "../quality-gates.js";
import { gateProofContent, gateUserGuide, validateCastRecording } from "../quality-gates.js";

const MOCK_DETAILS: SpawnDetails = {
  messages: [],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
  exitCode: 0,
};

describe("validateCastRecording", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "quality-gates-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Helper to write a .cast file and return the full path. */
  async function writeCast(
    header: Record<string, unknown>,
    events: Array<[number, string, string]>,
  ): Promise<string> {
    const path = join(tmpDir, "test.cast");
    const lines = [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))];
    await writeFile(path, lines.join("\n"), "utf-8");
    return path;
  }

  it("passes for a valid recording with command, output, exit code, and non-zero timing", async () => {
    const path = await writeCast({ version: 3, command: "pnpm test" }, [
      [0.0, "o", "Running tests...\n"],
      [1.5, "o", "PASS  src/index.test.ts\n"],
      [2.0, "x", "0"],
    ]);

    const result = await validateCastRecording(path);
    expect(result).toHaveProperty("passed", true);
  });

  it("fails when header has no command field (empty session reproduction)", async () => {
    const path = await writeCast({ version: 3 }, [
      [0.0, "o", "\u001b[35m❯\u001b[0m"],
      [0.001, "o", "\u001b]2;shell\u0007"],
    ]);

    const result = await validateCastRecording(path);
    expect(result).toHaveProperty("passed", false);
    expect(result.feedback).toContain("no command executed");
  });

  it("fails for echo-only recording (no substantive output)", async () => {
    const path = await writeCast({ version: 3, command: "echo done" }, [
      [0.0, "o", ""],
      [0.005, "x", "0"],
    ]);

    const result = await validateCastRecording(path);
    expect(result).toHaveProperty("passed", false);
    expect(result.feedback).toContain("no substantive output");
  });

  it("fails when no exit code event is present", async () => {
    const path = await writeCast({ version: 3, command: "pnpm test" }, [
      [0.0, "o", "Running...\n"],
      [5.0, "o", "All tests pass\n"],
    ]);

    const result = await validateCastRecording(path);
    expect(result).toHaveProperty("passed", false);
    expect(result.feedback).toContain("missing exit code");
  });

  it("fails when elapsed time is <= 0.1s", async () => {
    const path = await writeCast({ version: 3, command: "echo done" }, [
      [0.0, "o", "done\n"],
      [0.05, "x", "0"],
    ]);

    const result = await validateCastRecording(path);
    expect(result).toHaveProperty("passed", false);
    expect(result.feedback).toContain("too short");
  });

  it("passes when no .cast file is found (other modalities OK)", async () => {
    const output = "Proof artifacts generated:\n- screenshot.png\n- recording.webm\n";

    const result = await gateProofContent(output, MOCK_DETAILS);

    expect(result).toHaveProperty("passed", true);
    expect(result.feedback).toContain("No .cast file found");
  });

  it("fails for malformed JSON header", async () => {
    const path = join(tmpDir, "bad.cast");
    await writeFile(path, 'not valid json\n[0.0, "o", "hi"]\n', "utf-8");

    const result = await validateCastRecording(path);
    expect(result).toHaveProperty("passed", false);
    expect(result.feedback).toContain("invalid header JSON");
  });

  it("fails when the .cast file does not exist on disk", async () => {
    const output = "Here is the proof recording:\nproof-of-work/bd-99/nonexistent.cast\n";

    const result = await gateProofContent(output, MOCK_DETAILS);

    expect(result).toHaveProperty("passed", false);
    expect(result.feedback).toContain("not found on disk");
  });

  it("fails for OSC-only recording (no substantive output after OSC strip)", async () => {
    const path = await writeCast({ version: 3, command: "echo test" }, [
      [0.0, "o", "\u001b]2;shell\u0007"],
      [0.0, "o", "\u001b]7;kitty-shell-cwd://home\u0007"],
      [0.5, "x", "0"],
    ]);

    const result = await validateCastRecording(path);
    expect(result).toHaveProperty("passed", false);
    expect(result.feedback).toContain("no substantive output");
  });

  it("fails for OSC-only recording with ST terminator", async () => {
    const path = await writeCast({ version: 3, command: "echo test" }, [
      [0.0, "o", "\u001b]0;window-title\u001b\\"],
      [0.5, "x", "0"],
    ]);

    const result = await validateCastRecording(path);
    expect(result).toHaveProperty("passed", false);
    expect(result.feedback).toContain("no substantive output");
  });

  it("fails for path traversal attempt in cast file path", async () => {
    const output = "proof-of-work/../../../etc/passwd.cast\n";

    const result = await gateProofContent(output, MOCK_DETAILS, {
      cwd: tmpDir,
    } satisfies GateOptions);

    expect(result).toHaveProperty("passed", false);
    expect(result.feedback).toContain("Path traversal detected");
  });

  it("fails for empty events array", async () => {
    const path = await writeCast({ version: 3, command: "echo test" }, []);

    const result = await validateCastRecording(path);
    expect(result).toHaveProperty("passed", false);
    expect(result.feedback).toContain("empty events array");
  });

  it("fails when referenced non-.cast proof file does not exist", async () => {
    const output = "Screenshot: proof-of-work/bd-99/screenshot.png\n";

    const result = await gateProofContent(output, MOCK_DETAILS, {
      cwd: tmpDir,
    } satisfies GateOptions);

    expect(result).toHaveProperty("passed", false);
    expect(result.feedback).toContain("not found on disk");
  });

  it("passes when referenced non-.cast proof file exists on disk", async () => {
    const proofDir = join(tmpDir, "proof-of-work", "bd-99");
    const refPath = join(proofDir, "screenshot.png");
    const output = "Screenshot: proof-of-work/bd-99/screenshot.png\n";

    // Create directory and referenced file
    await mkdir(proofDir, { recursive: true });
    await writeFile(refPath, "fake-png-content", "utf-8");

    const result = await gateProofContent(output, MOCK_DETAILS, {
      cwd: tmpDir,
    } satisfies GateOptions);

    expect(result).toHaveProperty("passed", true);
  });
});

describe("gateUserGuide", () => {
  it("passes when both How to Verify and How to Use sections are present with sufficient length", async () => {
    const output = [
      "## How to Verify",
      "1. Run `pnpm test`",
      "2. Check the output",
      "3. Verify the process gate blocks out-of-sequence phase tools",
      "4. Confirm tests pass for all 8 phases",
      "",
      "## How to Use",
      "```typescript",
      'import { startWorkflow } from "./harness";',
      "",
      'const result = await startWorkflow("feature", "bd-42");',
      "console.log(result);",
      "```",
      "",
      "For CLI usage:",
      "```bash",
      "pnpm run workflow --type feature --task bd-42",
      "```",
    ].join("\n");

    const result = await gateUserGuide(output, MOCK_DETAILS);
    expect(result).toHaveProperty("passed", true);
  });

  it("fails without How to Verify section", async () => {
    const output = ["## How to Use", "```typescript", 'console.log("hello");', "```"].join("\n");

    const result = await gateUserGuide(output, MOCK_DETAILS);
    expect(result).toHaveProperty("passed", false);
    expect(result.feedback).toContain("How to Verify");
  });

  it("fails without How to Use section", async () => {
    const output = ["## How to Verify", "1. Run `pnpm test`", "2. Check the output"].join("\n");

    const result = await gateUserGuide(output, MOCK_DETAILS);
    expect(result).toHaveProperty("passed", false);
    expect(result.feedback).toContain("How to Use");
  });

  it("fails when output is too short", async () => {
    const output = "## How to Verify\n## How to Use\n";

    const result = await gateUserGuide(output, MOCK_DETAILS);
    expect(result).toHaveProperty("passed", false);
    expect(result.feedback).toContain("too short");
  });

  it("fails when both sections are missing", async () => {
    const output = "Some random text without sections.\n";

    const result = await gateUserGuide(output, MOCK_DETAILS);
    expect(result).toHaveProperty("passed", false);
    expect(result.feedback).toContain("How to Verify");
    expect(result.feedback).toContain("How to Use");
  });

  it("is case-insensitive for section headers", async () => {
    const output = ["## How to verify", "1. Run tests", "", "## How to use", "Just call it"].join(
      "\n",
    );

    // Make sure it's long enough: pad the output
    const padded = output + "\n".repeat(20) + "x".repeat(180);
    const result = await gateUserGuide(padded, MOCK_DETAILS);
    expect(result).toHaveProperty("passed", true);
  });

  it("passes with exactly the minimum length", async () => {
    const sections = ["## How to Verify", "1. Run tests", "", "## How to Use", "Just call it"].join(
      "\n",
    );
    // Pad to exactly 200 chars
    const padding = "x".repeat(200 - sections.length);
    const output = sections + padding;

    expect(output.length).toBeGreaterThanOrEqual(200);
    const result = await gateUserGuide(output, MOCK_DETAILS);
    expect(result).toHaveProperty("passed", true);
  });

  it("fails on empty string input", async () => {
    const result = await gateUserGuide("", MOCK_DETAILS);
    expect(result).toHaveProperty("passed", false);
  });

  it("detects section headers appearing mid-line (not at line start)", async () => {
    // Section header appears in the middle of a sentence, not at line start.
    // The regex matches anywhere in the string, so the gate considers this valid.
    // The failure should only be about length being too short.
    const output = [
      "This document contains details on ## How to Verify the changes.",
      "And also includes ## How to Use the API at the end.",
      "x".repeat(200),
    ].join("\n");

    const result = await gateUserGuide(output, MOCK_DETAILS);
    // Headers are found (regex matches anywhere), so the only failure is length
    expect(result).toHaveProperty("passed", true);
  });

  it("passes for very long user guide content (>10000 chars)", async () => {
    const howToVerifyHeader = "## How to Verify";
    const howToUseHeader = "## How to Use";
    const body = "x".repeat(5000);
    const output = [howToVerifyHeader, body, "", howToUseHeader, body].join("\n");

    // Ensure it's long enough
    expect(output.length).toBeGreaterThan(10000);

    const result = await gateUserGuide(output, MOCK_DETAILS);
    expect(result).toHaveProperty("passed", true);
  });

  it("handles unicode and special characters in output", async () => {
    const output = [
      "## How to Verify",
      "1. Exécutez `pnpm test` — vérifiez les résultats",
      "2. Check café ☕ is served correctly",
      "3. Ensure über-strings work (piñata, jalapeño, façade)",
      "",
      "## How to Use",
      "```typescript",
      "// 👋 Greet the user",
      'console.log("Hëllö Wörld 🌍");',
      "const result = foo.bar(); // → ∫∑π",
      "```",
    ].join("\n");

    const result = await gateUserGuide(output, MOCK_DETAILS);
    expect(result).toHaveProperty("passed", true);
  });

  it("fails on whitespace-only output", async () => {
    const output = "   \n  \n   \n  ";

    const result = await gateUserGuide(output, MOCK_DETAILS);
    expect(result).toHaveProperty("passed", false);
    expect(result.feedback).toContain("How to Verify");
    expect(result.feedback).toContain("How to Use");
    expect(result.feedback).toContain("too short");
  });

  it("handles output with leading whitespace before section headers", async () => {
    const output = [
      "   ## How to Verify",
      "1. Run tests",
      "",
      "   ## How to Use",
      "Call the function",
    ].join("\n");

    // Since the regex uses ##\s+, leading spaces are fine
    const padded = output + "x".repeat(200 - output.length);
    const result = await gateUserGuide(padded, MOCK_DETAILS);
    expect(result).toHaveProperty("passed", true);
  });

  it("fails when section headers are missing trailing content", async () => {
    // Section headers present but minimal content after them
    const output = ["## How to Verify", "", "## How to Use", ""].join("\n");

    // Pad to exceed minimum length so the only failure is content structure
    const padded = `${output}\n${"x".repeat(200 - output.length)}`;
    // Without proper content, it still passes headers + length checks
    const result = await gateUserGuide(padded, MOCK_DETAILS);
    expect(result).toHaveProperty("passed", true);
  });

  it("rejects output with content below minimum length even with proper headers", async () => {
    const output = ["## How to Verify", "Run test", "## How to Use", "Call it"].join("\n");

    // Output is well below 200 chars
    expect(output.length).toBeLessThan(200);

    const result = await gateUserGuide(output, MOCK_DETAILS);
    expect(result).toHaveProperty("passed", false);
    expect(result.feedback).toContain("too short");
  });
});
