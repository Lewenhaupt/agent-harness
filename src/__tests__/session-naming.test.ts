import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeOrchestratorSessionName,
  computePlanningSubagentSessionName,
  computeSubagentSessionName,
  gateRetrySession,
  generateShortRunId,
  isValidTaskId,
  resolveProjectSessionExists,
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

describe("gateRetrySession", () => {
  const base = "belayd-bd-42-sub-implement-run1";

  it("resumes the base session for attempts 1 and 2", () => {
    expect(gateRetrySession(base, 1)).toEqual({ sessionName: base, resumeSession: true });
    expect(gateRetrySession(base, 2)).toEqual({ sessionName: base, resumeSession: true });
  });

  it("starts a fresh epoch at attempt 3 and resumes it at attempt 4", () => {
    expect(gateRetrySession(base, 3)).toEqual({
      sessionName: `${base}-retry-3`,
      resumeSession: false,
    });
    expect(gateRetrySession(base, 4)).toEqual({
      sessionName: `${base}-retry-3`,
      resumeSession: true,
    });
  });

  it("repeats fresh/resume epochs to MAX_GATE_ATTEMPTS depth", () => {
    const expected = [
      { attempt: 5, sessionName: `${base}-retry-5`, resumeSession: false },
      { attempt: 6, sessionName: `${base}-retry-5`, resumeSession: true },
      { attempt: 7, sessionName: `${base}-retry-7`, resumeSession: false },
      { attempt: 8, sessionName: `${base}-retry-7`, resumeSession: true },
      { attempt: 9, sessionName: `${base}-retry-9`, resumeSession: false },
      // Locked mapping: attempt 10 never actually spawns (runQualityGate
      // short-circuits at MAX_GATE_ATTEMPTS), but it still resolves like an
      // even (resume) attempt of the retry-9 epoch.
      { attempt: 10, sessionName: `${base}-retry-9`, resumeSession: true },
    ];
    for (const { attempt, sessionName, resumeSession } of expected) {
      expect(gateRetrySession(base, attempt)).toEqual({ sessionName, resumeSession });
    }
  });

  it("throws on an empty base, a non-string base, or invalid attempt", () => {
    expect(() => gateRetrySession("", 1)).toThrow("base must be a non-empty string");
    expect(() => gateRetrySession(42 as unknown as string, 1)).toThrow(
      "base must be a non-empty string",
    );
    expect(() => gateRetrySession(base, 0)).toThrow("attempt must be a positive integer");
    expect(() => gateRetrySession(base, 1.5)).toThrow("attempt must be a positive integer");
  });
});

describe("resolveProjectSessionExists", () => {
  let sessionDir: string;
  const originalEnv = { ...process.env };
  const headerFor = (id: string): string =>
    `${JSON.stringify({ type: "session", version: 3, id })}\n`;
  const writeSession = (dir: string, id: string): void => {
    writeFileSync(join(dir, `2024-01-15T10-00-00-000Z_${id}.jsonl`), headerFor(id));
  };

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), "belayd-session-exists-"));
    process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
  });

  afterEach(() => {
    rmSync(sessionDir, { recursive: true, force: true });
    for (const key of ["PI_CODING_AGENT_SESSION_DIR", "PI_CODING_AGENT_DIR"]) {
      const prior = originalEnv[key];
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
  });

  it("returns false when the session id is missing", () => {
    expect(resolveProjectSessionExists("belayd-absent")).toBe(false);
  });

  it("returns true when a matching session file exists", () => {
    writeSession(sessionDir, "belayd-existing");
    expect(resolveProjectSessionExists("belayd-existing")).toBe(true);
  });

  it("does not match a session whose header id merely contains the id", () => {
    writeSession(sessionDir, "belayd-existing-x");
    expect(resolveProjectSessionExists("belayd-existing")).toBe(false);
  });

  it("returns false when the file header cannot be parsed", () => {
    writeFileSync(join(sessionDir, "2024-01-15T10-00-00-000Z_belayd-bad.jsonl"), "{}");
    expect(resolveProjectSessionExists("belayd-bad")).toBe(false);
  });

  it("returns false for a non-existent directory", () => {
    process.env.PI_CODING_AGENT_SESSION_DIR = join(sessionDir, "does-not-exist");
    expect(resolveProjectSessionExists("belayd-existing")).toBe(false);
  });

  it("resolves the default agentDir/sessions/<slug>/ path", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "belayd-agent-dir-"));
    const cwd = mkdtempSync(join(tmpdir(), "belayd-cwd-"));
    try {
      const slug = `--${resolve(cwd)
        .replace(/^[/\\]/, "")
        .replace(/[/\\:]/g, "-")}--`;
      const dir = join(agentDir, "sessions", slug);
      mkdirSync(dir, { recursive: true });
      writeSession(dir, "belayd-default-path");
      expect(
        resolveProjectSessionExists("belayd-default-path", {
          cwd,
          env: { PI_CODING_AGENT_DIR: agentDir },
        }),
      ).toBe(true);
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("uses settings.json sessionDir when set", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "belayd-agent-settings-"));
    const settingsSessionDir = mkdtempSync(join(tmpdir(), "belayd-settings-sessions-"));
    try {
      writeFileSync(
        join(agentDir, "settings.json"),
        JSON.stringify({ sessionDir: settingsSessionDir }),
      );
      writeSession(settingsSessionDir, "belayd-settings");
      expect(
        resolveProjectSessionExists("belayd-settings", {
          env: { PI_CODING_AGENT_DIR: agentDir },
        }),
      ).toBe(true);
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
      rmSync(settingsSessionDir, { recursive: true, force: true });
    }
  });
});
