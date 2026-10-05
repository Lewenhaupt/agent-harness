import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildArchifyArgs, parseArchifyReceipt, runArchify } from "../src/archify.js";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const FIXTURE = resolve(REPO_ROOT, "test/fixtures/archify/minimal.architecture.json");

const RUN_OPTIONS = {
  cwd: REPO_ROOT,
  timeoutInMs: 60_000,
  maxBufferInBytes: 8 * 1024 * 1024,
};

function which(binary: string): string | null {
  try {
    const result = execFileSync("sh", ["-c", `command -v ${binary}`], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return result === "" ? null : result;
  } catch {
    return null;
  }
}

const ARCHIFY_PATH = which("archify");

describe("archify (integration, real binary)", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "belayd-archify-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("validates the fixture IR with exit 0 and a normalized check summary", () => {
    if (ARCHIFY_PATH === null) {
      console.warn("Skipping integration test: archify not available");
      return;
    }

    // execFileSync throws on a non-zero exit, so reaching the parse asserts exit 0.
    const stdout = execFileSync(ARCHIFY_PATH, ["validate", "architecture", FIXTURE, "--json"], {
      encoding: "utf-8",
      env: { ...process.env, ARCHIFY_UPDATE_CHECK_DISABLED: "1" },
    });

    const parsed = parseArchifyReceipt(stdout);
    expect(parsed).toHaveProperty("ok", true);
    if (!parsed.ok) throw new Error("expected a parsed receipt");
    expect(parsed.receipt).toHaveProperty("ok", true);
    expect(parsed.receipt.validation).toHaveProperty("checkCount");
    if (parsed.receipt.validation === undefined) throw new Error("expected a validation summary");
    expect(parsed.receipt.validation.checksPassed).toBe(parsed.receipt.validation.checkCount);
    expect(parsed.receipt.validation.checkCount).toBeGreaterThan(0);
  });

  it("delivers the fixture and reports artifact hash + validation summary", async () => {
    if (ARCHIFY_PATH === null) {
      console.warn("Skipping integration test: archify not available");
      return;
    }

    const output = join(tmpRoot, "delivered.html");
    const result = await runArchify(
      buildArchifyArgs({
        command: "deliver",
        type: "architecture",
        input: FIXTURE,
        output,
        quality: "showcase",
      }),
      RUN_OPTIONS,
    );

    expect(result).toHaveProperty("ok", true);
    if (!result.ok) throw new Error("expected a run result");
    expect(result.receipt).toHaveProperty("ok", true);
    expect(result.receipt.artifact).toHaveProperty("sha256");
    if (result.receipt.artifact === undefined) throw new Error("expected an artifact");
    expect(result.receipt.artifact.sha256.length).toBeGreaterThan(0);
    expect(result.receipt.validation).toHaveProperty("checksPassed");
    if (result.receipt.validation === undefined) throw new Error("expected a validation summary");
    expect(result.receipt.validation.checksPassed).toBe(result.receipt.validation.checkCount);
    expect(existsSync(output)).toBe(true);
    expect(statSync(output).size).toBeGreaterThan(0);

    const html = readFileSync(output);
    const hash = createHash("sha256").update(html).digest("hex");
    expect(result.receipt.artifact.sha256).toBe(hash);
    expect(result.receipt.artifact.bytes).toBe(html.byteLength);
  });

  it("renders the fixture, which prints a path and no JSON", async () => {
    if (ARCHIFY_PATH === null) {
      console.warn("Skipping integration test: archify not available");
      return;
    }

    const output = join(tmpRoot, "rendered.html");
    const result = await runArchify(
      buildArchifyArgs({
        command: "render",
        type: "architecture",
        input: FIXTURE,
        output,
        quality: "showcase",
      }),
      RUN_OPTIONS,
    );

    expect(result).toHaveProperty("ok", true);
    if (!result.ok) throw new Error("expected a run result");
    expect(result.receipt).toHaveProperty("ok", true);
    expect(result.receipt).toHaveProperty("command", "render");
    expect(result.receipt).toHaveProperty("output", output);
    expect(existsSync(output)).toBe(true);
    expect(statSync(output).size).toBeGreaterThan(0);
  });

  it("reports a real failure through runArchify when the IR does not exist", async () => {
    if (ARCHIFY_PATH === null) {
      console.warn("Skipping integration test: archify not available");
      return;
    }

    const missingInput = join(tmpRoot, "does-not-exist.architecture.json");
    // render (unlike deliver) has no --json, so a failure surfaces on stderr
    // and runArchify reports a transport-style {ok:false}.
    const result = await runArchify(
      buildArchifyArgs({
        command: "render",
        type: "architecture",
        input: missingInput,
        output: join(tmpRoot, "never.html"),
      }),
      RUN_OPTIONS,
    );

    expect(result).toHaveProperty("ok", false);
    if (result.ok) throw new Error("expected a failure result");
    expect(result.error).toContain("ENOENT");
    expect(existsSync(join(tmpRoot, "never.html"))).toBe(false);
  });
});
