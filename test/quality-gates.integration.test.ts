import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { validateCastRecording } from "../src/quality-gates.js";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");

describe("validateCastRecording (integration)", () => {
  const task63Cast = resolve(REPO_ROOT, "proof-of-work/TASK-63/03a-agent-harness-tests.cast");
  const task67Cast = resolve(REPO_ROOT, "proof-of-work/TASK-67/rename-fix.cast");

  it("passes for TASK-63 recording (valid proof)", async () => {
    if (!existsSync(task63Cast)) {
      console.warn("Skipping integration test: proof-of-work/TASK-63 not found (clean checkout)");
      return;
    }

    const result = await validateCastRecording(task63Cast);

    expect(result).toHaveProperty("passed", true);
  });

  it("fails for TASK-67 recording (no command executed)", async () => {
    if (!existsSync(task67Cast)) {
      console.warn("Skipping integration test: proof-of-work/TASK-67 not found (clean checkout)");
      return;
    }

    const result = await validateCastRecording(task67Cast);

    expect(result).toHaveProperty("passed", false);
    expect(result.feedback).toContain("no command executed");
  });
});
