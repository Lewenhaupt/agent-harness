import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildArchifyArgs,
  buildArchifyCheckArgs,
  buildArchifyGuideArgs,
  buildArchifyInspectArgs,
  listArchifyExamples,
  parseArchifyReceipt,
  resolveArchifyHome,
  runArchify,
  runArchifyText,
} from "../src/archify.js";

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

// The wrapper's $out is the parent of bin/, so the packaged agent assets live
// at <out>/libexec/archify. Deriving it from the resolved binary tests the same
// layout the flake exports, without hard-coding a store hash.
function archifyHomeFromBinary(binary: string | null): string | null {
  if (binary === null) return null;
  if (!binary.endsWith("/bin/archify")) return null;
  return join(dirname(dirname(binary)), "libexec", "archify");
}

const ARCHIFY_HOME = archifyHomeFromBinary(ARCHIFY_PATH);

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
    const args = buildArchifyArgs({
      command: "render",
      type: "architecture",
      input: FIXTURE,
      output,
      quality: "showcase",
    });
    // render never takes --json; 3.x rejects it as an unknown option.
    expect(args).not.toContain("--json");

    const result = await runArchify(args, RUN_OPTIONS);

    expect(result).toHaveProperty("ok", true);
    if (!result.ok) throw new Error("expected a run result");
    expect(result.receipt).toHaveProperty("ok", true);
    expect(result.receipt).toHaveProperty("command", "render");
    expect(result.receipt).toHaveProperty("output", output);
    expect(existsSync(output)).toBe(true);
    expect(statSync(output).size).toBeGreaterThan(0);
  });

  it("rejects a render --json probe with a failure (3.x unknown-option exit 2)", async () => {
    if (ARCHIFY_PATH === null) {
      console.warn("Skipping integration test: archify not available");
      return;
    }

    // Pins the observed 3.0.1 behaviour: render has no --json flag, so the
    // harness must pass the path-synthesis branch, never relying on a receipt.
    const result = await runArchify(
      [
        "render",
        "architecture",
        FIXTURE,
        join(tmpRoot, "probe.html"),
        "--quality",
        "showcase",
        "--json",
      ],
      RUN_OPTIONS,
    );

    expect(result).toHaveProperty("ok", false);
    if (result.ok) throw new Error("expected a failure result");
    expect(result.error).toContain("--json");
    expect(existsSync(join(tmpRoot, "probe.html"))).toBe(false);
  });

  it("forwards --repo-root for architecture and workflow validation", async () => {
    if (ARCHIFY_PATH === null || ARCHIFY_HOME === null) {
      console.warn("Skipping integration test: archify not available");
      return;
    }

    const architected = await runArchify(
      buildArchifyArgs({
        command: "validate",
        type: "architecture",
        input: FIXTURE,
        repoRoot: REPO_ROOT,
      }),
      RUN_OPTIONS,
    );
    expect(architected).toHaveProperty("ok", true);
    if (!architected.ok) throw new Error("expected a run result");
    expect(architected.receipt).toHaveProperty("ok", true);

    // 3.x accepts --repo-root for every diagram type, not just architecture.
    const workflowExample = join(ARCHIFY_HOME, "examples", "agent-tool-call.workflow.json");
    if (!existsSync(workflowExample)) {
      console.warn("Skipping workflow repo-root probe: example not packaged");
      return;
    }
    const workflow = await runArchify(
      buildArchifyArgs({
        command: "validate",
        type: "workflow",
        input: workflowExample,
        repoRoot: REPO_ROOT,
      }),
      RUN_OPTIONS,
    );
    expect(workflow).toHaveProperty("ok", true);
    if (!workflow.ok) throw new Error("expected a run result");
    expect(workflow.receipt).toHaveProperty("ok", true);
  });

  it("reports unknown provenance when checking a sidecar-less copy", async () => {
    if (ARCHIFY_PATH === null) {
      console.warn("Skipping integration test: archify not available");
      return;
    }

    const deliveredPath = join(tmpRoot, "delivered.html");
    const delivered = await runArchify(
      buildArchifyArgs({
        command: "deliver",
        type: "architecture",
        input: FIXTURE,
        output: deliveredPath,
        quality: "showcase",
      }),
      RUN_OPTIONS,
    );
    expect(delivered).toHaveProperty("ok", true);
    if (!delivered.ok) throw new Error("expected a run result");

    const plainPath = join(tmpRoot, "plain.html");
    copyFileSync(deliveredPath, plainPath);
    const checked = await runArchifyText(buildArchifyCheckArgs(plainPath), RUN_OPTIONS);
    expect(checked).toHaveProperty("ok", true);
    if (!checked.ok) throw new Error("expected a text result");

    const parsed: unknown = JSON.parse(checked.text);
    if (parsed === null || typeof parsed !== "object") {
      throw new Error("expected a JSON object from check");
    }
    expect(parsed).toHaveProperty("ok", true);
    expect(parsed).toHaveProperty("provenance", "unknown");
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

  it("guide --json returns a list or a recommendation receipt", async () => {
    if (ARCHIFY_PATH === null) {
      console.warn("Skipping integration test: archify not available");
      return;
    }

    const result = await runArchifyText(buildArchifyGuideArgs({}), RUN_OPTIONS);
    expect(result).toHaveProperty("ok", true);
    if (!result.ok) throw new Error("expected a text result");

    const parsed: unknown = JSON.parse(result.text);
    expect(parsed).toBeTypeOf("object");
    if (parsed === null || typeof parsed !== "object") {
      throw new Error("expected a JSON object from guide");
    }
    expect(parsed).toHaveProperty("ok", true);
    expect(parsed).toHaveProperty("mode");
  });

  it("inspect architecture returns the compiled layout", async () => {
    if (ARCHIFY_PATH === null) {
      console.warn("Skipping integration test: archify not available");
      return;
    }

    const result = await runArchifyText(
      buildArchifyInspectArgs({ type: "architecture", input: FIXTURE }),
      RUN_OPTIONS,
    );
    expect(result).toHaveProperty("ok", true);
    if (!result.ok) throw new Error("expected a text result");

    const parsed: unknown = JSON.parse(result.text);
    if (parsed === null || typeof parsed !== "object") {
      throw new Error("expected a JSON object from inspect");
    }
    expect(parsed).toHaveProperty("ok", true);
    expect(parsed).toHaveProperty("diagram_type", "architecture");
    expect(parsed).toHaveProperty("layout");
  });

  it("check re-validates the delivered artifact", async () => {
    if (ARCHIFY_PATH === null) {
      console.warn("Skipping integration test: archify not available");
      return;
    }

    const output = join(tmpRoot, "delivered.html");
    const delivered = await runArchify(
      buildArchifyArgs({
        command: "deliver",
        type: "architecture",
        input: FIXTURE,
        output,
        quality: "showcase",
      }),
      RUN_OPTIONS,
    );
    expect(delivered).toHaveProperty("ok", true);
    if (!delivered.ok) throw new Error("expected a run result");

    const checked = await runArchifyText(buildArchifyCheckArgs(output), RUN_OPTIONS);
    expect(checked).toHaveProperty("ok", true);
    if (!checked.ok) throw new Error("expected a text result");

    const parsed: unknown = JSON.parse(checked.text);
    if (parsed === null || typeof parsed !== "object") {
      throw new Error("expected a JSON object from check");
    }
    expect(parsed).toHaveProperty("ok", true);
    expect(parsed).toHaveProperty("checks");
  });

  it("lists packaged example IRs from the resolved $ARCHIFY_HOME", () => {
    if (ARCHIFY_HOME === null || !existsSync(join(ARCHIFY_HOME, "examples"))) {
      console.warn("Skipping integration test: ARCHIFY_HOME not resolvable");
      return;
    }

    const home = resolveArchifyHome({ ARCHIFY_HOME });
    expect(home).toHaveProperty("ok", true);
    if (!home.ok) throw new Error("expected a home result");

    const listed = listArchifyExamples(home.home);
    expect(listed).toHaveProperty("ok", true);
    if (!listed.ok) throw new Error("expected an examples result");
    expect(listed.examples.length).toBe(15);
    expect(listed.examples.every((path) => path.endsWith(".json"))).toBe(true);
    expect(listed.examples).toContain(join(home.home, "examples", "web-app.architecture.json"));
  });
});
