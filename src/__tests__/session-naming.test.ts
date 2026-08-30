import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeOrchestratorSessionName,
  computeSubagentSessionName,
  generateShortRunId,
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
