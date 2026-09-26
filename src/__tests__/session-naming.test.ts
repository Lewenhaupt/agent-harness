import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeOrchestratorSessionName,
  computePlanningSubagentSessionName,
  computeSubagentSessionName,
  generateShortRunId,
  isValidTaskId,
} from "../session-naming.js";

describe("computeSubagentSessionName", () => {
  it("returns belayd-bd-42-scout-abc123 with correct inputs", () => {
    const name = computeSubagentSessionName("bd-42", "scout", "abc123");
    expect(name).toBe("belayd-bd-42-sub-scout-abc123");
  });

  it("works with all 8 phases", () => {
    const phases = ["scout", "plan", "implement", "review", "test", "userguide", "proof", "commit"];
    for (const phase of phases) {
      const name = computeSubagentSessionName("bd-99", phase, "run1");
      expect(name).toBe(`belayd-bd-99-sub-${phase}-run1`);
    }
  });

  it("works with different task IDs", () => {
    const names = [
      computeSubagentSessionName("bd-1", "scout", "a"),
      computeSubagentSessionName("bd-100", "scout", "a"),
      computeSubagentSessionName("bd-9999", "scout", "a"),
    ];
    expect(names).toEqual([
      "belayd-bd-1-sub-scout-a",
      "belayd-bd-100-sub-scout-a",
      "belayd-bd-9999-sub-scout-a",
    ]);
  });

  it("works with subtask notation", () => {
    const name = computeSubagentSessionName("bd-16.2", "scout", "abc");
    expect(name).toBe("belayd-bd-16.2-sub-scout-abc");
  });
});

describe("computePlanningSubagentSessionName", () => {
  it("returns belayd-planning-sub-scout-abc", () => {
    expect(computePlanningSubagentSessionName("scout", "abc")).toBe(
      "belayd-planning-sub-scout-abc",
    );
  });

  it("works with the research phase", () => {
    expect(computePlanningSubagentSessionName("research", "r1")).toBe(
      "belayd-planning-sub-research-r1",
    );
  });

  it("throws on empty phaseName", () => {
    expect(() => computePlanningSubagentSessionName("", "abc")).toThrow(
      "phaseName must be a non-empty string",
    );
  });

  it("throws on empty runId", () => {
    expect(() => computePlanningSubagentSessionName("scout", "")).toThrow(
      "shortRunId must be a non-empty string",
    );
  });
});

describe("computeOrchestratorSessionName", () => {
  it("returns belayd-bd-42", () => {
    const name = computeOrchestratorSessionName("bd-42");
    expect(name).toBe("belayd-bd-42");
  });

  it("works with bd-N variants", () => {
    expect(computeOrchestratorSessionName("bd-1")).toBe("belayd-bd-1");
    expect(computeOrchestratorSessionName("bd-100")).toBe("belayd-bd-100");
    expect(computeOrchestratorSessionName("bd-9999")).toBe("belayd-bd-9999");
  });

  it("works with subtask notation", () => {
    expect(computeOrchestratorSessionName("bd-16.2")).toBe("belayd-bd-16.2");
  });

  it("throws on empty taskId", () => {
    expect(() => computeOrchestratorSessionName("")).toThrow("taskId must be a non-empty string");
  });

  it("throws on taskId not matching bd-N pattern", () => {
    expect(() => computeOrchestratorSessionName("bad-id")).toThrow(
      "taskId must follow the beads ID pattern (e.g. bd-42, bd-42.1)",
    );
    expect(() => computeOrchestratorSessionName("my-task-123")).toThrow();
  });

  it("throws on non-string taskId", () => {
    expect(() => computeOrchestratorSessionName(null as unknown as string)).toThrow(
      "taskId must be a non-empty string",
    );
    expect(() => computeOrchestratorSessionName(undefined as unknown as string)).toThrow(
      "taskId must be a non-empty string",
    );
  });
});

describe("input validation", () => {
  it("throws on empty taskId", () => {
    expect(() => computeSubagentSessionName("", "scout", "abc")).toThrow(
      "taskId must be a non-empty string",
    );
  });
  it("throws on empty phaseName", () => {
    expect(() => computeSubagentSessionName("bd-42", "", "abc")).toThrow(
      "phaseName must be a non-empty string",
    );
  });
  it("throws on empty shortRunId", () => {
    expect(() => computeSubagentSessionName("bd-42", "scout", "")).toThrow(
      "shortRunId must be a non-empty string",
    );
  });
  it("throws on taskId not matching bd-N pattern", () => {
    expect(() => computeSubagentSessionName("bad-id", "scout", "abc")).toThrow(
      "taskId must follow the beads ID pattern (e.g. bd-42, bd-42.1)",
    );
  });

  it("throws on non-string taskId for subagent", () => {
    expect(() => computeSubagentSessionName(null as unknown as string, "scout", "abc")).toThrow(
      "taskId must be a non-empty string",
    );
    expect(() =>
      computeSubagentSessionName(undefined as unknown as string, "scout", "abc"),
    ).toThrow("taskId must be a non-empty string");
  });

  it("throws on non-string phaseName", () => {
    expect(() => computeSubagentSessionName("bd-42", null as unknown as string, "abc")).toThrow(
      "phaseName must be a non-empty string",
    );
    expect(() =>
      computeSubagentSessionName("bd-42", undefined as unknown as string, "abc"),
    ).toThrow("phaseName must be a non-empty string");
  });

  it("throws on non-string shortRunId", () => {
    expect(() => computeSubagentSessionName("bd-42", "scout", null as unknown as string)).toThrow(
      "shortRunId must be a non-empty string",
    );
    expect(() =>
      computeSubagentSessionName("bd-42", "scout", undefined as unknown as string),
    ).toThrow("shortRunId must be a non-empty string");
  });
});

describe("isValidTaskId (shell-injection gate, bd-71)", () => {
  // readTaskMetadata/readTaskPlan route the taskId through execFile argv
  // (no shell), but the disk-resume and start-task paths rely on this gate
  // to keep a crafted id out of argv at all. A weakened regex that accepted
  // a metacharacter would let attacker-controlled bytes reach a positional
  // argv element — and any future regression back to the `bd show ${taskId}`
  // shell-string form would be exploitable. These cases pin the contract.
  it("accepts beads ids and subtask notation", () => {
    expect(isValidTaskId("bd-42")).toBe(true);
    expect(isValidTaskId("bd-1")).toBe(true);
    expect(isValidTaskId("bd-9999")).toBe(true);
    expect(isValidTaskId("bd-42.1")).toBe(true);
    expect(isValidTaskId("bd-42.1.7")).toBe(true);
  });

  it("rejects empty and non-string inputs", () => {
    expect(isValidTaskId("")).toBe(false);
    expect(isValidTaskId("  ")).toBe(false);
    expect(isValidTaskId(null as unknown as string)).toBe(false);
    expect(isValidTaskId(undefined as unknown as string)).toBe(false);
    expect(isValidTaskId(42 as unknown as string)).toBe(false);
  });

  it("rejects shell command chaining", () => {
    expect(isValidTaskId("bd-42;rm -rf /")).toBe(false);
    expect(isValidTaskId("bd-42; rm -rf /")).toBe(false);
    expect(isValidTaskId("bd-42 && echo pwned")).toBe(false);
    expect(isValidTaskId("bd-42 | cat")).toBe(false);
    expect(isValidTaskId("bd-42||echo pwned")).toBe(false);
  });

  it("rejects command substitution", () => {
    expect(isValidTaskId("bd-42$(whoami)")).toBe(false);
    expect(isValidTaskId("bd-42`whoami`")).toBe(false);
    expect(isValidTaskId("$(id)bd-42")).toBe(false);
  });

  it("rejects quotes that could break out of surrounding strings", () => {
    expect(isValidTaskId('bd-42"')).toBe(false);
    expect(isValidTaskId("bd-42'")).toBe(false);
    expect(isValidTaskId('bd-42";rm -rf /;"')).toBe(false);
  });

  it("rejects whitespace and shell-special bytes", () => {
    expect(isValidTaskId("bd-42 ")).toBe(false);
    expect(isValidTaskId(" bd-42")).toBe(false);
    expect(isValidTaskId("bd-42\t")).toBe(false);
    expect(isValidTaskId("bd-42\n")).toBe(false);
    expect(isValidTaskId("bd-4>2")).toBe(false);
    expect(isValidTaskId("bd-4<2")).toBe(false);
    expect(isValidTaskId("bd-4&2")).toBe(false);
  });

  it("rejects ids that do not start with the bd- prefix", () => {
    expect(isValidTaskId("bad-id")).toBe(false);
    expect(isValidTaskId("my-task-123")).toBe(false);
    expect(isValidTaskId("42")).toBe(false);
    expect(isValidTaskId("bd-")).toBe(false);
  });
});

describe("generateShortRunId", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a non-empty string", () => {
    vi.setSystemTime(new Date("2024-01-15T10:00:00Z"));
    const id = generateShortRunId();
    expect(id).toBeTruthy();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("returns different values on successive calls with different timestamps", () => {
    vi.setSystemTime(new Date("2024-01-15T10:00:00Z"));
    const id1 = generateShortRunId();

    // Advance time by 1ms to ensure a different timestamp
    vi.setSystemTime(new Date("2024-01-15T10:00:00.001Z"));
    const id2 = generateShortRunId();

    expect(id1).not.toBe(id2);
  });

  it("returns the same value for the same timestamp (deterministic)", () => {
    vi.setSystemTime(new Date("2024-01-15T10:00:00Z"));
    const id1 = generateShortRunId();
    const id2 = generateShortRunId();
    expect(id1).toBe(id2);
  });

  it("returns a base-36 string (lowercase alphanumeric)", () => {
    vi.setSystemTime(new Date("2024-01-15T10:00:00Z"));
    const id = generateShortRunId();
    expect(id).toMatch(/^[0-9a-z]+$/);
  });

  it("returns a known value for a known timestamp", () => {
    // 2024-01-15T10:00:00Z = 1705312800000 ms, base-36 = "lrer7ls0"
    vi.setSystemTime(new Date("2024-01-15T10:00:00Z"));
    const id = generateShortRunId();
    expect(id).toBe("lrer7ls0");
  });
});
