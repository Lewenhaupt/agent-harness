import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GateOptions, SpawnDetails } from "../agent-registry.js";
import {
  ensureProofBridge,
  PROOF_DIR_MARKER_RELATIVE_PATH,
  proofDirForTask,
  resolveProofBase,
} from "../proof-dir.js";
import {
  extractFailingLocations,
  gateLint,
  gateProofContent,
  gateTests,
  gateTypecheck,
  gateUserGuide,
  validateCastRecording,
} from "../quality-gates.js";

// `node:child_process` is mocked at the module boundary (repo convention) so
// the gate commands can fail with controlled stdout/stderr shapes without
// spawning a real pnpm process.
type GateExecCallback = (error: unknown, result: { stdout: string; stderr: string }) => void;

interface MockExecRejection extends Error {
  stdout?: string;
  stderr?: string;
  code?: number | string;
  killed?: boolean;
}

interface GateFailureProps {
  message?: string;
  stdout?: string;
  stderr?: string;
  code?: number | string;
  killed?: boolean;
}

const gateExec = vi.hoisted(() => {
  const state: {
    failure: MockExecRejection | null;
    rejectValue: { value: unknown } | null;
    stdout: string;
    stderr: string;
    calls: Array<{ command: string; options: unknown }>;
  } = { failure: null, rejectValue: null, stdout: "", stderr: "", calls: [] };

  const fn = vi.fn((_command: string, _options: unknown, _callback: GateExecCallback) => undefined);

  // Give the mock exec the same custom promisify hook Node's real exec has so
  // tests can control rejected values, including string/undefined/non-Error
  // rejections that a callback-style mock cannot express.
  Object.defineProperty(fn, Symbol.for("nodejs.util.promisify.custom"), {
    value: (command: string, options: unknown) =>
      new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        state.calls.push({ command, options });
        if (state.rejectValue !== null) {
          reject(state.rejectValue.value);
          return;
        }
        if (state.failure !== null) {
          reject(state.failure);
          return;
        }
        resolve({ stdout: state.stdout, stderr: state.stderr });
      }),
  });

  return { fn, state };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, exec: gateExec.fn };
});

const MOCK_DETAILS: SpawnDetails = {
  messages: [],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, toolCalls: 0 },
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

  it("passes for a valid recording with command, output, and exit code", async () => {
    const path = await writeCast({ version: 3, command: "node dist/cli.js --serve" }, [
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
    const path = await writeCast({ version: 3, command: "node dist/cli.js --serve" }, [
      [0.0, "o", "Running...\n"],
      [5.0, "o", "All tests pass\n"],
    ]);

    const result = await validateCastRecording(path);
    expect(result).toHaveProperty("passed", false);
    expect(result.feedback).toContain("missing exit code");
  });

  it("passes for a minimal-duration recording (elapsed time << 0.1s)", async () => {
    const path = await writeCast({ version: 3, command: "echo done" }, [
      [0.0, "o", "done\n"],
      [0.05, "x", "0"],
    ]);

    const result = await validateCastRecording(path);
    expect(result).toHaveProperty("passed", true);
  });

  it("passes when the last event timestamp is exactly 0.1s", async () => {
    const path = await writeCast({ version: 3, command: "echo done" }, [
      [0.0, "o", "done\n"],
      [0.1, "x", "0"],
    ]);

    const result = await validateCastRecording(path);
    expect(result).toHaveProperty("passed", true);
  });

  it("fails when no artifacts and no skip reason", async () => {
    const output = "Proof artifacts generated:\n- screenshot.png\n- recording.webm\n";

    const result = await gateProofContent(output, MOCK_DETAILS);

    expect(result).toHaveProperty("passed", false);
    expect(result.feedback).toContain("No proof artifacts produced or referenced");
  });

  it("resolves a .cast path from the provided proofDir", async () => {
    const proofDir = join(tmpDir, "external-proof", "bd-99");
    await mkdir(proofDir, { recursive: true });
    const castPath = join(proofDir, "valid.cast");
    await writeFile(
      castPath,
      [
        JSON.stringify({ version: 3, command: "node dist/cli.js --serve" }),
        JSON.stringify([0.0, "o", "Running tests...\n"]),
        JSON.stringify([1.5, "o", "PASS\n"]),
        JSON.stringify([2.0, "x", "0"]),
      ].join("\n"),
      "utf-8",
    );

    const output = "Proof recording: proof-of-work/bd-99/valid.cast\n";
    const result = await gateProofContent(output, MOCK_DETAILS, {
      proofDir,
    } satisfies GateOptions);

    expect(result).toHaveProperty("passed", true);
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

    const result = await gateProofContent(output, MOCK_DETAILS, {
      proofDir: join(tmpDir, "external-proof", "bd-99"),
    } satisfies GateOptions);

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
      proofDir: join(tmpDir, "external-proof", "bd-99"),
    } satisfies GateOptions);

    expect(result).toHaveProperty("passed", false);
    expect(result.feedback).toContain("Path traversal detected");
  });

  it("fails for path traversal in a non-.cast artifact ref", async () => {
    const output = "proof-of-work/../../../etc/passwd.png\n";

    const result = await gateProofContent(output, MOCK_DETAILS, {
      proofDir: join(tmpDir, "external-proof", "bd-99"),
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
      proofDir: join(tmpDir, "external-proof", "bd-99"),
    } satisfies GateOptions);

    expect(result).toHaveProperty("passed", false);
    expect(result.feedback).toContain("not found on disk");
  });

  it("passes when referenced non-.cast proof file exists on disk", async () => {
    const proofDir = join(tmpDir, "external-proof", "bd-99");
    const refPath = join(proofDir, "screenshot.png");
    const output = "Screenshot: proof-of-work/bd-99/screenshot.png\n";

    // Create directory and referenced file
    await mkdir(proofDir, { recursive: true });
    await writeFile(refPath, "fake-png-content", "utf-8");

    const result = await gateProofContent(output, MOCK_DETAILS, {
      proofDir,
    } satisfies GateOptions);

    expect(result).toHaveProperty("passed", true);
  });
});

describe("gateProofContent proof-optional and skip-reason flow", () => {
  it("passes with proofRequired false and no artifacts", async () => {
    const result = await gateProofContent("no artifacts here", MOCK_DETAILS, {
      proofRequired: false,
    } satisfies GateOptions);

    expect(result).toHaveProperty("passed", true);
    expect(result.feedback).toContain("Proof not required");
  });

  it.each([
    ["rename/refactor", "rename/refactor"],
    ["config-only", "config-only"],
    ["doc-only", "doc-only"],
    ["dependency bump", "dependency bump"],
    ["typo", "typo"],
  ])("passes with documented skip reason %s", async (_reason, label) => {
    const output = `**Proof skipped:** ${label}\n`;
    const result = await gateProofContent(output, MOCK_DETAILS);

    expect(result).toHaveProperty("passed", true);
    expect(result.feedback).toContain(`Proof skipped: ${label}`);
  });

  it("fails for an unknown skip reason", async () => {
    const output = "**Proof skipped:** because I felt like it\n";
    const result = await gateProofContent(output, MOCK_DETAILS);

    expect(result).toHaveProperty("passed", false);
    expect(result.feedback).toContain("No proof artifacts produced or referenced");
  });

  it("fails for a skip reason that only substring-matches a canonical label", async () => {
    const output = "**Proof skipped:** updating the readme\n";
    const result = await gateProofContent(output, MOCK_DETAILS);

    expect(result).toHaveProperty("passed", false);
    expect(result.feedback).toContain("No proof artifacts produced or referenced");
  });

  it("passes with a prefix-with-explanation skip reason", async () => {
    const output = "**Proof skipped:** config-only change — correctness validated by gates\n";
    const result = await gateProofContent(output, MOCK_DETAILS);

    expect(result).toHaveProperty("passed", true);
    expect(result.feedback).toContain("Proof skipped: config-only");
  });

  it("fails with no artifacts when proofRequired is undefined", async () => {
    const result = await gateProofContent("nothing to see\n", MOCK_DETAILS);

    expect(result).toHaveProperty("passed", false);
    expect(result.feedback).toContain("No proof artifacts produced or referenced");
  });
});

describe("validateCastRecording quality-gate command rejection", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "quality-gates-command-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function writeCast(header: Record<string, unknown>): Promise<string> {
    const path = join(tmpDir, "test.cast");
    const events: Array<[number, string, string]> = [
      [0.0, "o", "Running...\n"],
      [1.5, "o", "PASS\n"],
      [2.0, "x", "0"],
    ];
    const lines = [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))];
    await writeFile(path, lines.join("\n"), "utf-8");
    return path;
  }

  it.each([
    "pnpm test",
    "pnpm run typecheck",
    "npm run lint",
    "yarn build",
    "pnpm vitest run",
    "npx playwright test",
    "pnpm run test:unit",
  ])("rejects a .cast with header command %s", async (command) => {
    const path = await writeCast({ version: 3, command });
    const result = await validateCastRecording(path);

    expect(result).toHaveProperty("passed", false);
    expect(result.feedback).toContain("replicates a quality gate");
  });

  it("rejects a bash -c command wrapping a test-runner invocation", async () => {
    const path = await writeCast({
      version: 3,
      command: "bash -c 'cd /repo && pnpm vitest run src/foo.test.ts'",
    });
    const result = await validateCastRecording(path);

    expect(result).toHaveProperty("passed", false);
    expect(result.feedback).toContain("replicates a quality gate");
  });

  it("accepts a bash -c command wrapping a functional run", async () => {
    const path = await writeCast({
      version: 3,
      command: "bash -c 'curl http://localhost:3000/health'",
    });
    const result = await validateCastRecording(path);

    expect(result).toHaveProperty("passed", true);
  });
});

describe("gateProofContent accepted artifact existence", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "proof-artifact-existence-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function makeArtifact(filename: string): Promise<void> {
    const proofDir = join(tmpDir, "external-proof", "bd-99");
    await mkdir(proofDir, { recursive: true });
    await writeFile(join(proofDir, filename), "fake-content", "utf-8");
  }

  const proofDir = () => join(tmpDir, "external-proof", "bd-99");

  it.each(["x.trace.zip", "x.png", "x.jpg"])(
    "accepts existing proof-of-work/bd-99/%s via proofDir",
    async (filename) => {
      await makeArtifact(filename);
      const output = `Artifact: proof-of-work/bd-99/${filename}\n`;
      const result = await gateProofContent(output, MOCK_DETAILS, {
        proofDir: proofDir(),
      } satisfies GateOptions);

      expect(result).toHaveProperty("passed", true);
    },
  );

  it("rejects a missing referenced artifact", async () => {
    const output = "Artifact: proof-of-work/bd-99/missing.png\n";
    const result = await gateProofContent(output, MOCK_DETAILS, {
      proofDir: proofDir(),
    } satisfies GateOptions);

    expect(result).toHaveProperty("passed", false);
    expect(result.feedback).toContain("not found on disk");
  });

  it("rejects a .webm reference as no artifacts", async () => {
    const output = "Recording: proof-of-work/bd-99/recording.webm\n";
    const result = await gateProofContent(output, MOCK_DETAILS, {
      proofDir: proofDir(),
    } satisfies GateOptions);

    expect(result).toHaveProperty("passed", false);
    expect(result.feedback).toContain("No proof artifacts produced or referenced");
  });
});

describe("gateProofContent proof-dir artifact resolution", () => {
  let tmpDir: string;
  let proofDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "proof-dir-resolution-"));
    proofDir = join(tmpDir, "external-proof", "bd-99");
    await mkdir(proofDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function writeArtifact(relativePath: string): Promise<string> {
    const path = join(proofDir, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "fake-content", "utf-8");
    return path;
  }

  it("accepts an artifact listed only as an absolute proof-dir path", async () => {
    const absolutePath = await writeArtifact("shot.png");
    const output = `## Artifacts\n${absolutePath}\n`;

    const result = await gateProofContent(output, MOCK_DETAILS, { proofDir } satisfies GateOptions);

    expect(result).toHaveProperty("passed", true);
  });

  it("accepts mixed canonical and absolute refs", async () => {
    await writeArtifact("a.png");
    const absoluteTrace = await writeArtifact("b.trace.zip");
    const output = ["## Artifacts", "proof-of-work/bd-99/a.png", `${absoluteTrace}`].join("\n");

    const result = await gateProofContent(output, MOCK_DETAILS, { proofDir } satisfies GateOptions);

    expect(result).toHaveProperty("passed", true);
  });

  it("still fails when an absolute ref is missing on disk", async () => {
    const output = `## Artifacts\n${join(proofDir, "missing.png")}\n`;

    const result = await gateProofContent(output, MOCK_DETAILS, { proofDir } satisfies GateOptions);

    expect(result).toHaveProperty("passed", false);
    expect(result.feedback).toContain("not found on disk");
  });

  it("falls back to artifacts present under the proof dir when nothing is referenced", async () => {
    await writeArtifact("evidence.png");
    const output = "Captured the dashboard in a browser but listed no paths.\n";

    const result = await gateProofContent(output, MOCK_DETAILS, { proofDir } satisfies GateOptions);

    expect(result).toHaveProperty("passed", true);
    expect(result.feedback).not.toContain("No proof artifacts produced or referenced");
    expect(result.feedback).toContain("recovered from the task dir");
  });

  it("still applies .cast validation to fallback-derived artifacts", async () => {
    await writeArtifact("bad.cast");
    const output = "Captured the terminal but listed no paths.\n";

    const result = await gateProofContent(output, MOCK_DETAILS, { proofDir } satisfies GateOptions);

    expect(result).toHaveProperty("passed", false);
    expect(result.feedback).toContain(".cast");
  });

  it("still applies .cast validation to a fallback-enumerated uppercase .CAST artifact", async () => {
    // writeArtifact writes "fake-content", which is not parseable as a cast.
    // The uppercase extension must not let the fallback enumeration path skip
    // content validation.
    await writeArtifact("e.CAST");
    const output = "Captured the terminal but listed no paths.\n";

    const result = await gateProofContent(output, MOCK_DETAILS, { proofDir } satisfies GateOptions);

    expect(result).toHaveProperty("passed", false);
    expect(result.feedback).toContain(".CAST");
  });

  it("does not rescue a retry with a stale leftover artifact", async () => {
    await writeArtifact("leftover.png");
    const output = "Retry produced no new evidence.\n";
    const proofRunStartMs = Date.now() + 60_000;

    const result = await gateProofContent(output, MOCK_DETAILS, {
      proofDir,
      proofRunStartMs,
    } satisfies GateOptions);

    expect(result).toHaveProperty("passed", false);
    expect(result.feedback).toContain("No proof artifacts produced or referenced");
  });

  it("recovers an artifact written during the run", async () => {
    await writeArtifact("fresh.png");
    const output = "Captured the dashboard but listed no paths.\n";
    const proofRunStartMs = Date.now() - 60_000;

    const result = await gateProofContent(output, MOCK_DETAILS, {
      proofDir,
      proofRunStartMs,
    } satisfies GateOptions);

    expect(result).toHaveProperty("passed", true);
    expect(result.feedback).toContain("recovered from the task dir");
  });

  it("fails a fabricated trailing-dot ref beside a valid cast", async () => {
    const castPath = join(proofDir, "valid.cast");
    const validCast = [
      JSON.stringify({ version: 3, command: "curl http://localhost:3000/health" }),
      JSON.stringify([0.0, "o", "PASS health check\n"]),
      JSON.stringify([1.0, "x", "0"]),
    ].join("\n");
    await writeFile(castPath, validCast, "utf-8");
    const output = [
      "## Artifacts",
      "proof-of-work/bd-99/valid.cast",
      `${join(proofDir, "missing.png")}.`,
    ].join("\n");

    const result = await gateProofContent(output, MOCK_DETAILS, { proofDir } satisfies GateOptions);

    expect(result).toHaveProperty("passed", false);
    expect(result.feedback).toContain("not found on disk");
  });

  it("does not rescue an empty proof dir", async () => {
    const output = "Captured the dashboard in a browser but listed no paths.\n";
    const emptyProofDir = join(tmpDir, "external-proof", "bd-empty");

    const result = await gateProofContent(output, MOCK_DETAILS, {
      proofDir: emptyProofDir,
    } satisfies GateOptions);

    expect(result).toHaveProperty("passed", false);
    expect(result.feedback).toContain("No proof artifacts produced or referenced");
  });

  it("rejects an absolute path outside the proof dir", async () => {
    const outsidePath = join(tmpDir, "outside.png");
    await writeFile(outsidePath, "fake-content", "utf-8");
    const output = `## Artifacts\n${outsidePath}\n`;

    const result = await gateProofContent(output, MOCK_DETAILS, { proofDir } satisfies GateOptions);

    expect(result).toHaveProperty("passed", false);
    expect(result.feedback).toContain("No proof artifacts produced or referenced");
    expect(result.feedback).toContain("outside the proof task dir");
  });

  it("does not accept non-artifact extensions even when present on disk", async () => {
    const transcriptPath = await writeArtifact("transcript.txt");
    const output = `## Artifacts\n${transcriptPath}\n`;

    const result = await gateProofContent(output, MOCK_DETAILS, { proofDir } satisfies GateOptions);

    expect(result).toHaveProperty("passed", false);
    expect(result.feedback).toContain("No proof artifacts produced or referenced");
  });

  it("applies .cast validation to an uppercase .CAST ref", async () => {
    // writeArtifact writes "fake-content", which is not parseable as a cast.
    await writeArtifact("e.CAST");
    const output = "## Artifacts\nproof-of-work/bd-99/e.CAST\n";

    const result = await gateProofContent(output, MOCK_DETAILS, { proofDir } satisfies GateOptions);

    expect(result).toHaveProperty("passed", false);
    expect(result.feedback).toContain(".CAST");
  });

  it("accepts a valid uppercase .CAST ref", async () => {
    const validCast = [
      JSON.stringify({ version: 3, command: "curl http://localhost:3000/health" }),
      JSON.stringify([0.0, "o", "PASS health check\n"]),
      JSON.stringify([1.0, "x", "0"]),
    ].join("\n");
    await writeFile(join(proofDir, "valid.CAST"), validCast, "utf-8");
    const output = "## Artifacts\nproof-of-work/bd-99/valid.CAST\n";

    const result = await gateProofContent(output, MOCK_DETAILS, { proofDir } satisfies GateOptions);

    expect(result).toHaveProperty("passed", true);
  });

  it("accepts a referenced dotted filename", async () => {
    await writeArtifact("shot..png");

    const canonical = await gateProofContent(
      "## Artifacts\nproof-of-work/bd-99/shot..png\n",
      MOCK_DETAILS,
      { proofDir } satisfies GateOptions,
    );
    expect(canonical).toHaveProperty("passed", true);

    const absolute = await gateProofContent(
      `## Artifacts\n${join(proofDir, "shot..png")}\n`,
      MOCK_DETAILS,
      { proofDir } satisfies GateOptions,
    );
    expect(absolute).toHaveProperty("passed", true);
  });

  it("still rejects genuine parent-segment traversal", async () => {
    const output = "## Artifacts\nproof-of-work/bd-99/../../../etc/passwd.png\n";

    const result = await gateProofContent(output, MOCK_DETAILS, { proofDir } satisfies GateOptions);

    expect(result).toHaveProperty("passed", false);
    expect(result.feedback).toContain("Path traversal detected");
  });

  it("rejects a canonical task-relative parent-segment ref", async () => {
    const output = "## Artifacts\nproof-of-work/bd-99/../escape.png\n";

    const result = await gateProofContent(output, MOCK_DETAILS, { proofDir } satisfies GateOptions);

    expect(result).toHaveProperty("passed", false);
    expect(result.feedback).toContain("Path traversal detected");
  });

  it("rejects an absolute parent-segment ref instead of silently dropping it", async () => {
    // Build the ref textually: path.join would collapse the `..` segment.
    const output = `## Artifacts\n${proofDir}/../escape.png\n`;

    const result = await gateProofContent(output, MOCK_DETAILS, { proofDir } satisfies GateOptions);

    expect(result).toHaveProperty("passed", false);
    expect(result.feedback).toContain("Path traversal detected");
  });

  it("fails a traversal ref even when fresh artifacts exist", async () => {
    await writeArtifact("fresh.png");
    // Build the ref textually: path.join would collapse the `..` segment.
    const output = ["## Artifacts", `${proofDir}/../escape.png`].join("\n");
    const proofRunStartMs = Date.now() - 60_000;

    const result = await gateProofContent(output, MOCK_DETAILS, {
      proofDir,
      proofRunStartMs,
    } satisfies GateOptions);

    expect(result).toHaveProperty("passed", false);
    expect(result.feedback).toContain("Path traversal detected");
    expect(result.feedback).not.toContain("recovered from the task dir");
  });

  it("ignores a non-artifact prose path with a parent segment", async () => {
    await writeArtifact("shot.png");
    const output = [
      "## Artifacts",
      "proof-of-work/bd-99/shot.png",
      "Also fixed a path bug under /usr/local/../lib mention.",
    ].join("\n");

    const result = await gateProofContent(output, MOCK_DETAILS, { proofDir } satisfies GateOptions);

    expect(result).toHaveProperty("passed", true);
  });

  it("ignores a non-artifact canonical ref with a parent segment", async () => {
    await writeArtifact("shot.png");
    const output = [
      "## Artifacts",
      "proof-of-work/bd-99/shot.png",
      "Context: proof-of-work/../notes.md",
    ].join("\n");

    const result = await gateProofContent(output, MOCK_DETAILS, { proofDir } satisfies GateOptions);

    expect(result).toHaveProperty("passed", true);
  });

  it("accepts comma-separated absolute refs and checks every one", async () => {
    await writeArtifact("a.png");
    await writeArtifact("b.png");

    const listed = await gateProofContent(
      `## Artifacts\n${join(proofDir, "a.png")},${join(proofDir, "b.png")}\n`,
      MOCK_DETAILS,
      { proofDir } satisfies GateOptions,
    );
    expect(listed).toHaveProperty("passed", true);

    const fabricated = await gateProofContent(
      `## Artifacts\n${join(proofDir, "a.png")},${join(proofDir, "missing.png")}\n`,
      MOCK_DETAILS,
      { proofDir } satisfies GateOptions,
    );
    expect(fabricated).toHaveProperty("passed", false);
    expect(fabricated.feedback).toContain("not found on disk");
  });
});

describe("resolveProofBase", () => {
  it("returns BELAYD_PROOF_DIR when set", () => {
    expect(resolveProofBase({ BELAYD_PROOF_DIR: "/tmp/proofs" })).toBe("/tmp/proofs");
  });

  it("uses XDG_STATE_HOME when BELAYD_PROOF_DIR is absent", () => {
    expect(resolveProofBase({ XDG_STATE_HOME: "/tmp/state" })).toBe(
      join("/tmp/state", "belayd", "proof"),
    );
  });

  it("falls back to ~/.local/state/belayd/proof", () => {
    expect(resolveProofBase({})).toBe(join(homedir(), ".local", "state", "belayd", "proof"));
  });

  it("treats empty BELAYD_PROOF_DIR as unset", () => {
    expect(resolveProofBase({ BELAYD_PROOF_DIR: "", XDG_STATE_HOME: "/tmp/state" })).toBe(
      join("/tmp/state", "belayd", "proof"),
    );
  });
});

describe("proofDirForTask", () => {
  it("joins the proof base and task id", () => {
    expect(proofDirForTask("bd-42", "/base")).toBe(join("/base", "bd-42"));
  });
});

describe("ensureProofBridge", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "proof-bridge-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Create a git worktree root plus an external proof base under tmpDir. */
  function makeWorkspace(): { workspaceRoot: string; proofBase: string } {
    const workspaceRoot = join(tmpDir, "repo");
    mkdirSync(join(workspaceRoot, ".git"), { recursive: true });
    const proofBase = join(tmpDir, "external", "proof");
    return { workspaceRoot, proofBase };
  }

  it("creates the symlink and the proof base directory", () => {
    const { workspaceRoot, proofBase } = makeWorkspace();

    const result = ensureProofBridge(workspaceRoot, proofBase);

    expect(result).toHaveProperty("ok", true);
    expect(readlinkSync(join(workspaceRoot, "proof-of-work"))).toBe(resolve(proofBase));
    expect(existsSync(resolve(proofBase))).toBe(true);

    const marker = readFileSync(join(workspaceRoot, PROOF_DIR_MARKER_RELATIVE_PATH), "utf-8");
    expect(marker.trim()).toBe(resolve(proofBase));
    expect(marker.endsWith("\n")).toBe(true);
  });

  it("is idempotent when the symlink already points at the same target", () => {
    const { workspaceRoot, proofBase } = makeWorkspace();

    const first = ensureProofBridge(workspaceRoot, proofBase);
    const second = ensureProofBridge(workspaceRoot, proofBase);

    expect(first).toHaveProperty("ok", true);
    expect(second).toHaveProperty("ok", true);
    expect(readlinkSync(join(workspaceRoot, "proof-of-work"))).toBe(resolve(proofBase));
    expect(readFileSync(join(workspaceRoot, PROOF_DIR_MARKER_RELATIVE_PATH), "utf-8").trim()).toBe(
      resolve(proofBase),
    );
  });

  it("overwrites a stale proof-dir marker with the resolved base", () => {
    const { workspaceRoot, proofBase } = makeWorkspace();
    mkdirSync(join(workspaceRoot, ".belayd"), { recursive: true });
    writeFileSync(join(workspaceRoot, PROOF_DIR_MARKER_RELATIVE_PATH), "/stale/path\n", "utf-8");

    const result = ensureProofBridge(workspaceRoot, proofBase);

    expect(result).toHaveProperty("ok", true);
    expect(readFileSync(join(workspaceRoot, PROOF_DIR_MARKER_RELATIVE_PATH), "utf-8").trim()).toBe(
      resolve(proofBase),
    );
  });

  it("replaces an empty proof-of-work directory with the symlink", () => {
    const { workspaceRoot, proofBase } = makeWorkspace();
    mkdirSync(join(workspaceRoot, "proof-of-work"), { recursive: true });

    const result = ensureProofBridge(workspaceRoot, proofBase);

    expect(result).toHaveProperty("ok", true);
    expect(readlinkSync(join(workspaceRoot, "proof-of-work"))).toBe(resolve(proofBase));
    expect(existsSync(join(workspaceRoot, PROOF_DIR_MARKER_RELATIVE_PATH))).toBe(true);
  });

  it("errors when proof-of-work is a non-empty real directory", () => {
    const { workspaceRoot, proofBase } = makeWorkspace();
    mkdirSync(join(workspaceRoot, "proof-of-work"), { recursive: true });
    writeFileSync(join(workspaceRoot, "proof-of-work", "keep.cast"), "{}", "utf-8");

    const result = ensureProofBridge(workspaceRoot, proofBase);

    expect(result).toHaveProperty("ok", false);
    if (!result.ok) expect(result.error).toContain("real directory");
    expect(existsSync(join(workspaceRoot, "proof-of-work", "keep.cast"))).toBe(true);
    expect(existsSync(join(workspaceRoot, PROOF_DIR_MARKER_RELATIVE_PATH))).toBe(false);
  });

  it("errors when proof-of-work points at a different target", () => {
    const { workspaceRoot, proofBase } = makeWorkspace();
    const otherTarget = join(tmpDir, "external", "other");
    mkdirSync(otherTarget, { recursive: true });
    symlinkSync(otherTarget, join(workspaceRoot, "proof-of-work"));

    const result = ensureProofBridge(workspaceRoot, proofBase);

    expect(result).toHaveProperty("ok", false);
    if (!result.ok) expect(result.error).toContain("already points");
    expect(existsSync(join(workspaceRoot, PROOF_DIR_MARKER_RELATIVE_PATH))).toBe(false);
  });

  it("repoints a harness-owned symlink when the marker matches the stale target", () => {
    const { workspaceRoot, proofBase } = makeWorkspace();
    const oldBase = join(tmpDir, "external", "old-proof");
    mkdirSync(oldBase, { recursive: true });
    symlinkSync(oldBase, join(workspaceRoot, "proof-of-work"));
    mkdirSync(join(workspaceRoot, ".belayd"), { recursive: true });
    writeFileSync(
      join(workspaceRoot, PROOF_DIR_MARKER_RELATIVE_PATH),
      `${resolve(oldBase)}\n`,
      "utf-8",
    );

    const result = ensureProofBridge(workspaceRoot, proofBase);

    expect(result).toHaveProperty("ok", true);
    expect(readlinkSync(join(workspaceRoot, "proof-of-work"))).toBe(resolve(proofBase));
    expect(readFileSync(join(workspaceRoot, PROOF_DIR_MARKER_RELATIVE_PATH), "utf-8").trim()).toBe(
      resolve(proofBase),
    );
  });

  it("errors when the marker and the symlink target disagree", () => {
    const { workspaceRoot, proofBase } = makeWorkspace();
    const oldBase = join(tmpDir, "external", "old-proof");
    const otherBase = join(tmpDir, "external", "other-proof");
    mkdirSync(oldBase, { recursive: true });
    mkdirSync(otherBase, { recursive: true });
    symlinkSync(oldBase, join(workspaceRoot, "proof-of-work"));
    mkdirSync(join(workspaceRoot, ".belayd"), { recursive: true });
    writeFileSync(
      join(workspaceRoot, PROOF_DIR_MARKER_RELATIVE_PATH),
      `${resolve(otherBase)}\n`,
      "utf-8",
    );

    const result = ensureProofBridge(workspaceRoot, proofBase);

    expect(result).toHaveProperty("ok", false);
    if (!result.ok) expect(result.error).toContain("already points");
    expect(readlinkSync(join(workspaceRoot, "proof-of-work"))).toBe(resolve(oldBase));
  });

  it("errors when no .git ancestor exists", () => {
    const cwd = join(tmpDir, "no-git");
    mkdirSync(cwd, { recursive: true });

    const result = ensureProofBridge(cwd, join(tmpDir, "external", "proof"));

    expect(result).toHaveProperty("ok", false);
    if (!result.ok) expect(result.error).toContain("No .git ancestor");
    expect(existsSync(join(cwd, PROOF_DIR_MARKER_RELATIVE_PATH))).toBe(false);
  });

  it("errors when proof-of-work is a regular file, never silently replacing it", () => {
    const { workspaceRoot, proofBase } = makeWorkspace();
    writeFileSync(join(workspaceRoot, "proof-of-work"), "not a symlink", "utf-8");

    const result = ensureProofBridge(workspaceRoot, proofBase);

    expect(result).toHaveProperty("ok", false);
    if (!result.ok) expect(result.error).toContain("not a symlink");
    // The stray file is left in place; the harness never clobbers a non-symlink entry.
    expect(existsSync(join(workspaceRoot, "proof-of-work"))).toBe(true);
    expect(existsSync(join(workspaceRoot, PROOF_DIR_MARKER_RELATIVE_PATH))).toBe(false);
  });

  it("errors on a dangling symlink without repointing it", () => {
    const { workspaceRoot, proofBase } = makeWorkspace();
    symlinkSync("/does/not/exist", join(workspaceRoot, "proof-of-work"));

    const result = ensureProofBridge(workspaceRoot, proofBase);

    expect(result).toHaveProperty("ok", false);
    if (!result.ok) expect(result.error).toContain("already points");
    // The dangling link is left in place; the harness refuses to repoint a link it did not own.
    expect(readlinkSync(join(workspaceRoot, "proof-of-work"))).toBe("/does/not/exist");
    expect(existsSync(join(workspaceRoot, PROOF_DIR_MARKER_RELATIVE_PATH))).toBe(false);
  });

  it("repairs a CRLF-line-ending marker that matches the stale symlink target", () => {
    const { workspaceRoot, proofBase } = makeWorkspace();
    const oldBase = join(tmpDir, "external", "old-proof");
    mkdirSync(oldBase, { recursive: true });
    symlinkSync(oldBase, join(workspaceRoot, "proof-of-work"));
    mkdirSync(join(workspaceRoot, ".belayd"), { recursive: true });
    writeFileSync(
      join(workspaceRoot, PROOF_DIR_MARKER_RELATIVE_PATH),
      `${resolve(oldBase)}\r\n`,
      "utf-8",
    );

    const result = ensureProofBridge(workspaceRoot, proofBase);

    expect(result).toHaveProperty("ok", true);
    expect(readlinkSync(join(workspaceRoot, "proof-of-work"))).toBe(resolve(proofBase));
  });

  it("errors when an empty marker sits beside a foreign symlink", () => {
    const { workspaceRoot, proofBase } = makeWorkspace();
    const foreign = join(tmpDir, "external", "foreign");
    mkdirSync(foreign, { recursive: true });
    symlinkSync(foreign, join(workspaceRoot, "proof-of-work"));
    mkdirSync(join(workspaceRoot, ".belayd"), { recursive: true });
    writeFileSync(join(workspaceRoot, PROOF_DIR_MARKER_RELATIVE_PATH), "\n", "utf-8");

    const result = ensureProofBridge(workspaceRoot, proofBase);

    expect(result).toHaveProperty("ok", false);
    if (!result.ok) expect(result.error).toContain("already points");
    expect(readlinkSync(join(workspaceRoot, "proof-of-work"))).toBe(resolve(foreign));
  });

  it("errors when the marker is a relative path that cannot match the absolute symlink target", () => {
    const { workspaceRoot, proofBase } = makeWorkspace();
    const foreign = join(tmpDir, "external", "foreign");
    mkdirSync(foreign, { recursive: true });
    symlinkSync(foreign, join(workspaceRoot, "proof-of-work"));
    mkdirSync(join(workspaceRoot, ".belayd"), { recursive: true });
    writeFileSync(join(workspaceRoot, PROOF_DIR_MARKER_RELATIVE_PATH), "foreign\n", "utf-8");

    const result = ensureProofBridge(workspaceRoot, proofBase);

    expect(result).toHaveProperty("ok", false);
    if (!result.ok) expect(result.error).toContain("already points");
    expect(readlinkSync(join(workspaceRoot, "proof-of-work"))).toBe(resolve(foreign));
  });

  it("writes the exact marker byte contract: a single absolute path line plus trailing newline", () => {
    const { workspaceRoot, proofBase } = makeWorkspace();

    const result = ensureProofBridge(workspaceRoot, proofBase);

    expect(result).toHaveProperty("ok", true);
    const absoluteBase = resolve(proofBase);
    const marker = readFileSync(join(workspaceRoot, PROOF_DIR_MARKER_RELATIVE_PATH), "utf-8");
    // pi-web-plugins/proof-of-work/discovery.js reads exactly `${absoluteBase}\n`.
    expect(marker).toBe(`${absoluteBase}\n`);
    // And the symlink target matches the marker's absolute path.
    expect(readlinkSync(join(workspaceRoot, "proof-of-work"))).toBe(absoluteBase);
  });
});

describe("gateProofContent fallback", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "proof-gate-fallback-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const validCast = [
    JSON.stringify({ version: 3, command: "curl http://localhost:3000/health" }),
    JSON.stringify([0.0, "o", "Running tests...\n"]),
    JSON.stringify([1.5, "o", "PASS\n"]),
    JSON.stringify([2.0, "x", "0"]),
  ].join("\n");

  async function writeFileEnsuringParent(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf-8");
  }

  it("resolves a .cast path through the workspace proof-of-work symlink", async () => {
    const workspaceRoot = join(tmpDir, "repo");
    mkdirSync(join(workspaceRoot, ".git"), { recursive: true });
    const proofBase = join(tmpDir, "external", "proof");
    const castPath = join(proofBase, "bd-99", "valid.cast");
    await writeFileEnsuringParent(castPath, validCast);
    symlinkSync(resolve(proofBase), join(workspaceRoot, "proof-of-work"));

    const output = "Proof recording: proof-of-work/bd-99/valid.cast\n";
    const result = await gateProofContent(output, MOCK_DETAILS, { cwd: workspaceRoot });

    expect(result).toHaveProperty("passed", true);
  });

  it("still resolves a real proof-of-work directory when no proofDir is given", async () => {
    const workspaceRoot = join(tmpDir, "repo");
    mkdirSync(join(workspaceRoot, ".git"), { recursive: true });
    const castPath = join(workspaceRoot, "proof-of-work", "bd-99", "valid.cast");
    await writeFileEnsuringParent(castPath, validCast);

    const output = "Proof recording: proof-of-work/bd-99/valid.cast\n";
    const result = await gateProofContent(output, MOCK_DETAILS, { cwd: workspaceRoot });

    expect(result).toHaveProperty("passed", true);
  });

  it("resolves non-.cast refs through the workspace proof-of-work symlink", async () => {
    const workspaceRoot = join(tmpDir, "repo");
    mkdirSync(join(workspaceRoot, ".git"), { recursive: true });
    const proofBase = join(tmpDir, "external", "proof");
    await writeFileEnsuringParent(join(proofBase, "bd-99", "screenshot.png"), "fake-png-content");
    symlinkSync(resolve(proofBase), join(workspaceRoot, "proof-of-work"));

    const output = "Screenshot: proof-of-work/bd-99/screenshot.png\n";
    const result = await gateProofContent(output, MOCK_DETAILS, { cwd: workspaceRoot });

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

describe("quality gate command feedback", () => {
  const GATE_OPTIONS: GateOptions = { cwd: "/tmp/gate-cwd", timeoutInMs: 1_000 };

  /** Build an exec-style rejection carrying Node's extra diagnostic fields. */
  function gateFailure(props: GateFailureProps): MockExecRejection {
    return Object.assign(new Error(props.message ?? "Command failed"), props);
  }

  beforeEach(() => {
    gateExec.state.failure = null;
    gateExec.state.rejectValue = null;
    gateExec.state.stdout = "";
    gateExec.state.stderr = "";
    gateExec.state.calls.length = 0;
  });

  it("returns stdout diagnostics for a stdout-only lint failure", async () => {
    gateExec.state.failure = gateFailure({
      message: "Command failed: pnpm lint",
      stdout: "src/index.ts:174:3 lint/style/useImportType  FIXABLE  ━━━━━\n",
      code: 1,
    });

    const result = await gateLint("", MOCK_DETAILS, GATE_OPTIONS);

    expect(result).toHaveProperty("passed", false);
    expect(result.feedback).toContain("src/index.ts:174:3");
    expect(result.feedback).toContain("lint/style/useImportType");
    expect(result.feedback).toContain("--- stdout ---");
    expect(result.feedback).toContain("Failing files:");
    expect(result.feedback).toContain("src/index.ts:174");
  });

  it("returns stderr diagnostics for a stderr-only typecheck failure", async () => {
    gateExec.state.failure = gateFailure({
      message: "Command failed: pnpm typecheck",
      stderr: "src/agent-registry.ts(27,5): error TS2322: Type mismatch.\n",
      code: 2,
    });

    const result = await gateTypecheck("", MOCK_DETAILS, GATE_OPTIONS);

    expect(result).toHaveProperty("passed", false);
    expect(result.feedback).toContain("error TS2322");
    expect(result.feedback).toContain("--- stderr ---");
    expect(result.feedback).toContain("src/agent-registry.ts:27");
  });

  it("renders stdout before stderr when both streams carry diagnostics", async () => {
    gateExec.state.failure = gateFailure({
      message: "Command failed: pnpm test",
      stdout: "FAIL  src/__tests__/x.test.ts > suite > test\n",
      stderr: "stderr-diagnostic-marker\n",
      code: 1,
    });

    const result = await gateTests("", MOCK_DETAILS, GATE_OPTIONS);
    const feedback = result.feedback ?? "";

    expect(feedback).toContain("FAIL  src/__tests__/x.test.ts");
    expect(feedback).toContain("stderr-diagnostic-marker");
    expect(feedback.indexOf("--- stdout ---")).toBeLessThan(feedback.indexOf("--- stderr ---"));
    expect(feedback.indexOf("FAIL  src/__tests__/x.test.ts")).toBeLessThan(
      feedback.indexOf("stderr-diagnostic-marker"),
    );
  });

  it("includes the failed command and exit code in the header", async () => {
    gateExec.state.failure = gateFailure({
      message: "Command failed: pnpm lint",
      stdout: "src/foo.ts:12:3 lint/style/noNonNullAssertion\n",
      code: 1,
    });

    const result = await gateLint("", MOCK_DETAILS, GATE_OPTIONS);

    expect(result.feedback).toContain("Lint failed (pnpm lint, exit 1):");
    expect(gateExec.state.calls).toHaveLength(1);
    expect(gateExec.state.calls[0]?.command).toBe("pnpm lint");
    expect(gateExec.state.calls[0]?.options).toHaveProperty("maxBuffer", 10 * 1024 * 1024);
  });

  it("truncates huge stdout and keeps the feedback bounded", async () => {
    const hugeStdout = Array.from(
      { length: 200 },
      (_, index) => `src/foo.ts:${index + 1}:1 diagnostic line ${index + 1}`,
    ).join("\n");
    gateExec.state.failure = gateFailure({
      message: "Command failed: pnpm lint",
      stdout: hugeStdout,
      code: 1,
    });

    const result = await gateLint("", MOCK_DETAILS, GATE_OPTIONS);
    const feedback = result.feedback ?? "";

    expect(feedback).toContain("more lines truncated");
    expect(feedback).toContain("Run `pnpm lint` for the full output.");
    // 50 diagnostic lines + capped failing-file header + fixed scaffolding.
    expect(feedback.split("\n").length).toBeLessThan(100);
  });

  it("still returns non-empty feedback for a plain Error without streams", async () => {
    gateExec.state.failure = gateFailure({ message: "spawn pnpm ENOENT" });

    const result = await gateLint("", MOCK_DETAILS, GATE_OPTIONS);

    expect(result).toHaveProperty("passed", false);
    expect(result.feedback).toContain("spawn pnpm ENOENT");
    expect(result.feedback).toContain("Run `pnpm lint` for the full output.");
  });

  it("labels a killed command as timed out instead of reporting an exit code", async () => {
    gateExec.state.failure = gateFailure({
      message: "Command failed: pnpm test",
      killed: true,
    });

    const result = await gateTests("", MOCK_DETAILS, GATE_OPTIONS);

    expect(result.feedback).toContain("Tests failed (pnpm test, timed out after 1s):");
    expect(result.feedback).not.toContain("exit");
  });

  it("reports a maxBuffer overflow explicitly", async () => {
    gateExec.state.failure = gateFailure({
      message: "stdout maxBuffer length exceeded",
      code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
    });

    const result = await gateLint("", MOCK_DETAILS, GATE_OPTIONS);

    expect(result.feedback).toContain("capture limit");
    expect(result.feedback).not.toContain("undefined");
  });

  it("bounds feedback for a single pathological line", async () => {
    gateExec.state.failure = gateFailure({
      message: "Command failed: pnpm lint",
      stdout: "a".repeat(1_000_000),
      code: 1,
    });

    const result = await gateLint("", MOCK_DETAILS, GATE_OPTIONS);
    const feedback = result.feedback ?? "";

    expect(feedback).toContain("more chars truncated");
    expect(feedback).toContain("Run `pnpm lint` for the full output.");
    // 32 KiB stream cap plus header/markers/footer.
    expect(feedback.length).toBeLessThan(40_000);
  });

  it("turns a string rejection into feedback", async () => {
    gateExec.state.rejectValue = { value: "pnpm lint exploded" };

    const result = await gateLint("", MOCK_DETAILS, GATE_OPTIONS);

    expect(result).toHaveProperty("passed", false);
    expect(result.feedback).toContain("pnpm lint exploded");
  });

  it("handles an undefined rejection without throwing", async () => {
    gateExec.state.rejectValue = { value: undefined };

    const result = await gateLint("", MOCK_DETAILS, GATE_OPTIONS);

    expect(result).toHaveProperty("passed", false);
    expect(result.feedback).toContain("Command failed");
    expect(result.feedback).toContain("Run `pnpm lint` for the full output.");
  });

  it("handles a non-Error rejection object", async () => {
    gateExec.state.rejectValue = { value: { code: "ENOENT" } };

    const result = await gateLint("", MOCK_DETAILS, GATE_OPTIONS);

    expect(result.feedback).toContain("Lint failed (pnpm lint, spawn error ENOENT):");
  });

  it("renders a spawn-error phrase for a string exit code", async () => {
    gateExec.state.failure = gateFailure({
      message: "spawn pnpm ENOENT",
      code: "ENOENT",
    });

    const result = await gateLint("", MOCK_DETAILS, GATE_OPTIONS);

    expect(result.feedback).toContain("Lint failed (pnpm lint, spawn error ENOENT):");
  });

  it("reports only the char bound when both caps fire", async () => {
    const manyLines = Array.from(
      { length: 1_000 },
      (_, index) => `line ${index} ${"x".repeat(80)}`,
    ).join("\n");
    gateExec.state.failure = gateFailure({
      message: "Command failed: pnpm lint",
      stdout: manyLines,
      code: 1,
    });

    const result = await gateLint("", MOCK_DETAILS, GATE_OPTIONS);
    const feedback = result.feedback ?? "";

    expect(feedback).toContain("more chars truncated");
    // The line remainder from the char-capped slice would understate the real
    // total, so the line marker must not be emitted alongside the char marker.
    expect(feedback).not.toContain("more lines truncated");
  });

  it("falls back to a clear message for whitespace-only streams", async () => {
    gateExec.state.failure = gateFailure({
      message: "   ",
      stdout: " \n\t\n",
      stderr: "  ",
    });

    const result = await gateLint("", MOCK_DETAILS, GATE_OPTIONS);

    expect(result.feedback).toContain("No diagnostic output captured.");
  });

  it("falls back to a clear message for an empty Error message", async () => {
    gateExec.state.failure = gateFailure({ message: "" });

    const result = await gateLint("", MOCK_DETAILS, GATE_OPTIONS);

    expect(result.feedback).toContain("No diagnostic output captured.");
  });

  it("passes without feedback when the command succeeds", async () => {
    gateExec.state.stdout = "ok";

    const result = await gateLint("", MOCK_DETAILS, GATE_OPTIONS);

    expect(result).toHaveProperty("passed", true);
    expect(result).not.toHaveProperty("feedback");
  });
});

describe("extractFailingLocations", () => {
  it("extracts biome, tsc, and vitest locations in order without duplicates", () => {
    const output = [
      "src/foo.ts:12:34 lint/suspicious/noExplicitAny",
      "src/foo.ts(12,5): error TS2322: Type 'string' is not assignable to 'number'.",
      "FAIL  src/__tests__/x.test.ts > suite > test",
      " ❯ src/bar.ts:9:5",
      "src/foo.ts:12:90 lint/suspicious/noExplicitAny",
      "/repo/node_modules/pkg/index.js:1:1",
    ].join("\n");

    expect(extractFailingLocations(output)).toEqual([
      "src/foo.ts:12",
      "src/__tests__/x.test.ts",
      "src/bar.ts:9",
    ]);
  });

  it("caps the number of surfaced locations", () => {
    const output = Array.from(
      { length: 15 },
      (_, index) => `src/file-${index}.ts:${index + 1}:1 diagnostic`,
    ).join("\n");

    expect(extractFailingLocations(output)).toHaveLength(10);
  });

  it("returns no locations for output without file references", () => {
    expect(extractFailingLocations("Command failed: pnpm lint")).toEqual([]);
  });

  it("returns an empty result for empty input", () => {
    expect(extractFailingLocations("")).toEqual([]);
  });

  it("preserves absolute paths and dedupes by file path", () => {
    const output = [
      "/repo/src/a.ts:12:3 lint/style/noNonNullAssertion",
      "FAIL  /repo/src/b.ts > suite > test",
      " ❯ /repo/src/b.ts:9:5",
    ].join("\n");

    expect(extractFailingLocations(output)).toEqual(["/repo/src/a.ts:12", "/repo/src/b.ts"]);
  });

  it("skips node_modules locations", () => {
    const output = [
      "node_modules/pkg/index.js:1:1 lint/style/noNonNullAssertion",
      "src/a.ts:3:1 lint/style/noNonNullAssertion",
    ].join("\n");

    expect(extractFailingLocations(output)).toEqual(["src/a.ts:3"]);
  });

  it("extracts a diagnostic from the tail of a large stream", () => {
    const noise = Array.from(
      { length: 1_200 },
      (_, index) => `noise line ${index} ${"x".repeat(80)}`,
    ).join("\n");
    const output = `${noise}\n ❯ src/late.ts:9:5\n`;

    expect(output.length).toBeGreaterThan(64 * 1024);

    const startedAt = performance.now();
    const locations = extractFailingLocations(output);
    const elapsedInMs = performance.now() - startedAt;

    expect(locations).toContain("src/late.ts:9");
    expect(locations.length).toBeLessThanOrEqual(10);
    expect(elapsedInMs).toBeLessThan(1_000);
  });

  it("returns promptly for pathological long lines", () => {
    const wordRun = "a".repeat(200_000);
    const singleMegabyteLine = "b".repeat(1024 * 1024);
    const output = `${wordRun}\n${singleMegabyteLine}\n`;

    const startedAt = performance.now();
    const locations = extractFailingLocations(output);
    const elapsedInMs = performance.now() - startedAt;

    expect(locations).toEqual([]);
    expect(elapsedInMs).toBeLessThan(1_000);
  });
});
