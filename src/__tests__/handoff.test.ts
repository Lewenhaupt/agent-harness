import { describe, expect, it } from "vitest";
import {
  buildHandoff,
  buildOrchestratorPrompt,
  clearHandoff,
  collectHandoffDefault,
  formatHandoffBlock,
  HANDOFF_ARG_FILE_MAX_BYTES,
  HANDOFF_DIRTY_FILES_MAX,
  HANDOFF_FIELD_MAX_CHARS,
  HANDOFF_IDENTITY_FIELD_MAX_CHARS,
  HANDOFF_SCHEMA_VERSION,
  HANDOFF_TOTAL_MAX_CHARS,
  type HandoffPacket,
  handoffFilePath,
  parseHandoff,
  readHandoff,
  readHandoffFileArg,
  taskIdFromBranch,
  writeHandoff,
} from "../handoff.js";
import type { GitExec } from "../stack-rebase.js";
import { type WorkflowFs, writeWorkflowState } from "../workflow-state.js";

/** In-memory fs seam: no real files are touched. */
function createMemoryFs(initial: Record<string, string> = {}): {
  fs: WorkflowFs;
  files: Map<string, string>;
} {
  const files = new Map<string, string>(Object.entries(initial));
  return {
    files,
    fs: {
      existsSync: (path) => files.has(path),
      readFileSync: (path) => {
        const value = files.get(path);
        if (value === undefined) throw new Error(`ENOENT: ${path}`);
        return value;
      },
      writeFileSync: (path, data) => {
        files.set(path, data);
      },
      renameSync: (oldPath, newPath) => {
        const value = files.get(oldPath);
        if (value === undefined) throw new Error(`ENOENT: ${oldPath}`);
        files.delete(oldPath);
        files.set(newPath, value);
      },
      mkdirSync: () => {},
      unlinkSync: (path) => {
        files.delete(path);
      },
    },
  };
}

const CWD = "/repo/.feat-bd-121";

function populatedPacket(): HandoffPacket {
  return buildHandoff({
    taskId: "bd-121",
    workflowType: "feature",
    branch: "feat/bd-121",
    worktreePath: CWD,
    base: "feat/bd-119",
    forkPoint: "abc123",
    parentTaskId: "bd-119",
    parentBranch: "feat/bd-119",
    parentSessionId: "parent-session",
    parentWorktreePath: "/repo/.feat-bd-119",
    parentSummary: "Plan: add the handoff packet, fix originalCwd, record stack metadata.",
    parentTask: "Parent bead body",
    childTask: "Child bead body",
    completedPhases: ["scout", "plan"],
    lastCommitSubject: "feat(orchestration): pin runs to the session worktree (bd-119)",
    dirtyFiles: ["M src/handoff.ts", "?? .belayd/handoff.json"],
    now: 1_000,
  });
}

describe("buildHandoff", () => {
  it("keeps every fact when they are all present", () => {
    const packet = populatedPacket();

    expect(packet).toHaveProperty("schemaVersion", HANDOFF_SCHEMA_VERSION);
    expect(packet).toHaveProperty("taskId", "bd-121");
    expect(packet).toHaveProperty("workflowType", "feature");
    expect(packet).toHaveProperty("branch", "feat/bd-121");
    expect(packet).toHaveProperty("worktreePath", CWD);
    expect(packet).toHaveProperty("base", "feat/bd-119");
    expect(packet).toHaveProperty("forkPoint", "abc123");
    expect(packet).toHaveProperty("parentTaskId", "bd-119");
    expect(packet).toHaveProperty("parentBranch", "feat/bd-119");
    expect(packet).toHaveProperty("parentSessionId", "parent-session");
    expect(packet).toHaveProperty("parentWorktreePath", "/repo/.feat-bd-119");
    expect(packet).toHaveProperty("createdAt", 1_000);
    expect(packet).toHaveProperty("completedPhases", ["scout", "plan"]);
    expect(packet).toHaveProperty("dirtyFiles", ["M src/handoff.ts", "?? .belayd/handoff.json"]);
    expect(packet.parentSummary).toContain("handoff packet");
    expect(packet.parentTask).toBe("Parent bead body");
    expect(packet.childTask).toBe("Child bead body");
  });

  it("drops every missing or blank fact without throwing", () => {
    const packet = buildHandoff({
      taskId: "  bd-121  ",
      workflowType: "feature",
      branch: "feat/bd-121",
      worktreePath: CWD,
      base: "   ",
      forkPoint: "",
      parentTaskId: undefined,
      parentSummary: "   ",
      parentTask: "",
      completedPhases: ["", "  "],
      dirtyFiles: ["  "],
      now: 2_000,
    });

    expect(packet).toHaveProperty("taskId", "bd-121");
    expect(packet).not.toHaveProperty("base");
    expect(packet).not.toHaveProperty("forkPoint");
    expect(packet).not.toHaveProperty("parentTaskId");
    expect(packet).not.toHaveProperty("parentSummary");
    expect(packet).not.toHaveProperty("parentTask");
    expect(packet.completedPhases).toEqual([]);
    expect(packet.dirtyFiles).toEqual([]);
    expect(packet).toHaveProperty("createdAt", 2_000);
  });

  it("caps a single free-form field", () => {
    const packet = buildHandoff({
      taskId: "bd-121",
      workflowType: "feature",
      branch: "feat/bd-121",
      worktreePath: CWD,
      parentSummary: "x".repeat(HANDOFF_FIELD_MAX_CHARS * 2),
      now: 1,
    });

    expect(packet.parentSummary?.length).toBeLessThanOrEqual(HANDOFF_FIELD_MAX_CHARS + 20);
    expect(packet.parentSummary).toContain("(truncated)");
  });

  it("caps the total free-form budget across summary and task bodies", () => {
    const packet = buildHandoff({
      taskId: "bd-121",
      workflowType: "feature",
      branch: "feat/bd-121",
      worktreePath: CWD,
      parentSummary: "s".repeat(HANDOFF_FIELD_MAX_CHARS),
      parentTask: "p".repeat(HANDOFF_FIELD_MAX_CHARS),
      childTask: "c".repeat(HANDOFF_FIELD_MAX_CHARS),
      now: 1,
    });

    const total =
      (packet.parentSummary?.length ?? 0) +
      (packet.parentTask?.length ?? 0) +
      (packet.childTask?.length ?? 0);
    expect(total).toBeLessThanOrEqual(HANDOFF_TOTAL_MAX_CHARS + 60);
    // The summary is budgeted first, the last body absorbs the shortfall.
    expect(packet.parentSummary?.length).toBe(HANDOFF_FIELD_MAX_CHARS);
    expect(packet.childTask).toContain("(truncated)");
  });

  it("never splits a surrogate pair when truncating", () => {
    // Place an astral character exactly where the pre-marker cut lands, so a
    // naive slice would emit a lone high surrogate.
    const emoji = "😀";
    const markerLength = "…(truncated)".length;
    const contentAllowance = HANDOFF_FIELD_MAX_CHARS - markerLength;
    const summary = `${"a".repeat(contentAllowance - 1)}${emoji}${"b".repeat(50)}`;

    const packet = buildHandoff({
      taskId: "bd-121",
      workflowType: "feature",
      branch: "feat/bd-121",
      worktreePath: CWD,
      parentSummary: summary,
      now: 1,
    });

    const rendered = packet.parentSummary ?? "";
    expect(rendered.endsWith("(truncated)")).toBe(true);
    // No lone surrogate in either direction.
    expect(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(rendered),
    ).toBe(false);
    expect(rendered.length).toBeLessThanOrEqual(HANDOFF_FIELD_MAX_CHARS);
  });

  it("caps the dirty-file list", () => {
    const packet = buildHandoff({
      taskId: "bd-121",
      workflowType: "feature",
      branch: "feat/bd-121",
      worktreePath: CWD,
      dirtyFiles: Array.from({ length: HANDOFF_DIRTY_FILES_MAX + 10 }, (_, i) => `M file-${i}.ts`),
      now: 1,
    });

    expect(packet.dirtyFiles).toHaveLength(HANDOFF_DIRTY_FILES_MAX);
  });
});

describe("formatHandoffBlock", () => {
  it("renders identity, completed phases and the free-text sections", () => {
    const block = formatHandoffBlock(populatedPacket());

    expect(block.startsWith("## Handoff")).toBe(true);
    expect(block).toContain("- Task: bd-121 (feature)");
    expect(block).toContain(`- Worktree: ${CWD}`);
    expect(block).toContain("- Branch: feat/bd-121");
    expect(block).toContain("- Base: feat/bd-119 (fork point abc123)");
    expect(block).toContain("- Parent: bd-119, branch feat/bd-119");
    expect(block).toContain("- Completed phases: scout, plan");
    expect(block).toContain("- Last commit: feat(orchestration)");
    expect(block).toContain("- Uncommitted files: M src/handoff.ts");
    expect(block).toContain("### Parent summary");
    expect(block).toContain("### Parent task (bd-119)");
    expect(block).toContain("### Child task (bd-121)");
  });

  it("falls back to an explicit no-handoff line for an empty packet", () => {
    const block = formatHandoffBlock(
      buildHandoff({
        taskId: "bd-121",
        workflowType: "feature",
        branch: "feat/bd-121",
        worktreePath: CWD,
        now: 1,
      }),
    );

    expect(block).toBe("## Handoff\n\n(no handoff provided)");
  });

  it("is pure: formatting the same packet twice yields identical text", () => {
    const packet = populatedPacket();
    expect(formatHandoffBlock(packet)).toBe(formatHandoffBlock(packet));
  });
});

describe("handoff persistence", () => {
  it("round-trips a packet through the fs seam", () => {
    const { fs } = createMemoryFs();
    const packet = populatedPacket();

    const written = writeHandoff({ cwd: CWD, packet, fs });
    expect(written).toEqual({ ok: true });

    const read = readHandoff({ cwd: CWD, fs });
    expect(read).toEqual(packet);
    expect(handoffFilePath(CWD)).toBe(`${CWD}/.belayd/handoff.json`);
  });

  it("returns undefined for missing, corrupt or foreign-schema files", () => {
    const missing = createMemoryFs();
    expect(readHandoff({ cwd: CWD, fs: missing.fs })).toBeUndefined();

    const corrupt = createMemoryFs({ [handoffFilePath(CWD)]: "{not json" });
    expect(readHandoff({ cwd: CWD, fs: corrupt.fs })).toBeUndefined();

    const foreign = createMemoryFs({
      [handoffFilePath(CWD)]: JSON.stringify({ schemaVersion: 99, taskId: "bd-121" }),
    });
    expect(readHandoff({ cwd: CWD, fs: foreign.fs })).toBeUndefined();

    expect(parseHandoff({ schemaVersion: HANDOFF_SCHEMA_VERSION })).toBeUndefined();
  });

  it("reports a write failure as an error value", () => {
    const { fs } = createMemoryFs();
    const failing: WorkflowFs = {
      ...fs,
      renameSync: () => {
        throw new Error("disk full");
      },
    };

    expect(writeHandoff({ cwd: CWD, packet: populatedPacket(), fs: failing })).toEqual({
      ok: false,
      error: "disk full",
    });
  });

  it("clearHandoff removes the packet and tolerates a missing file", () => {
    const { fs, files } = createMemoryFs();
    writeHandoff({ cwd: CWD, packet: populatedPacket(), fs });
    expect(files.has(handoffFilePath(CWD))).toBe(true);

    expect(clearHandoff({ cwd: CWD, fs })).toEqual({ ok: true });
    expect(files.has(handoffFilePath(CWD))).toBe(false);

    // Teardown runs on worktrees that never received a packet.
    expect(clearHandoff({ cwd: CWD, fs })).toEqual({ ok: true });
  });

  it("rejects an oversize free-form field instead of injecting it", () => {
    const packet = populatedPacket();
    const oversize = { ...packet, parentSummary: "x".repeat(HANDOFF_FIELD_MAX_CHARS + 1) };

    expect(parseHandoff(oversize)).toBeUndefined();
  });

  it("rejects a packet whose bodies exceed the total budget", () => {
    const packet = populatedPacket();
    // Each field is inside the per-field cap; only the total check catches it.
    const oversizedTotal = {
      ...packet,
      parentSummary: "x".repeat(HANDOFF_FIELD_MAX_CHARS),
      parentTask: "x".repeat(HANDOFF_FIELD_MAX_CHARS),
      childTask: "x".repeat(HANDOFF_FIELD_MAX_CHARS),
    };

    expect(oversizedTotal.parentSummary.length).toBeLessThanOrEqual(HANDOFF_FIELD_MAX_CHARS);
    const total =
      oversizedTotal.parentSummary.length +
      oversizedTotal.parentTask.length +
      oversizedTotal.childTask.length;
    expect(total).toBeGreaterThan(HANDOFF_TOTAL_MAX_CHARS);
    expect(parseHandoff(oversizedTotal)).toBeUndefined();
  });

  it("rejects a partial packet written by an older packet shape", () => {
    const packet = populatedPacket();
    // An earlier writer that did not persist the list fields (or the clock)
    // must not be half-accepted: every consumer assumes the full shape.
    const { completedPhases: _completed, dirtyFiles: _dirty, ...withoutLists } = packet;
    const { createdAt: _createdAt, ...withoutClock } = packet;
    const { worktreePath: _worktree, ...withoutWorktree } = packet;

    expect(parseHandoff(withoutLists)).toBeUndefined();
    expect(parseHandoff(withoutClock)).toBeUndefined();
    expect(parseHandoff(withoutWorktree)).toBeUndefined();
  });

  it("rejects a schema version mismatch, including an absent one", () => {
    const packet = populatedPacket();

    expect(parseHandoff({ ...packet, schemaVersion: HANDOFF_SCHEMA_VERSION + 1 })).toBeUndefined();
    expect(parseHandoff({ ...packet, schemaVersion: 0 })).toBeUndefined();
    const { schemaVersion: _version, ...withoutVersion } = packet;
    expect(parseHandoff(withoutVersion)).toBeUndefined();
  });

  it("rejects non-object payloads instead of throwing", () => {
    expect(parseHandoff(null)).toBeUndefined();
    expect(parseHandoff(undefined)).toBeUndefined();
    expect(parseHandoff("bd-121")).toBeUndefined();
    expect(parseHandoff([])).toBeUndefined();
    expect(parseHandoff(42)).toBeUndefined();
  });

  it("always accepts what buildHandoff produced, including at the caps", () => {
    // Writer/reader invariant: buildHandoff must never emit a packet its own
    // parser rejects, or the child's persisted handoff silently disappears.
    const packet = buildHandoff({
      taskId: "bd-121",
      workflowType: "feature",
      branch: "feat/bd-121",
      worktreePath: CWD,
      base: "b".repeat(HANDOFF_FIELD_MAX_CHARS * 2),
      forkPoint: "f".repeat(HANDOFF_FIELD_MAX_CHARS * 2),
      parentTaskId: "p".repeat(HANDOFF_FIELD_MAX_CHARS * 2),
      parentSummary: "s".repeat(HANDOFF_FIELD_MAX_CHARS),
      parentTask: "t".repeat(HANDOFF_FIELD_MAX_CHARS),
      childTask: "c".repeat(HANDOFF_FIELD_MAX_CHARS),
      completedPhases: Array.from({ length: 250 }, (_, i) => `phase-${i}`),
      dirtyFiles: Array.from({ length: HANDOFF_DIRTY_FILES_MAX + 5 }, (_, i) => `M f-${i}.ts`),
      now: 7,
    });

    const bodyLength =
      (packet.parentSummary?.length ?? 0) +
      (packet.parentTask?.length ?? 0) +
      (packet.childTask?.length ?? 0);
    expect(bodyLength).toBeLessThanOrEqual(HANDOFF_TOTAL_MAX_CHARS);
    expect(packet.dirtyFiles).toHaveLength(HANDOFF_DIRTY_FILES_MAX);
    expect(packet.completedPhases).toHaveLength(100);
    for (const field of [packet.base, packet.forkPoint, packet.parentTaskId]) {
      expect(field?.length).toBe(HANDOFF_IDENTITY_FIELD_MAX_CHARS);
    }
    expect(parseHandoff(JSON.parse(JSON.stringify(packet)))).toEqual(packet);
  });

  it("keeps a body at the cap verbatim and truncates one char over", () => {
    const atCap = buildHandoff({
      taskId: "bd-121",
      workflowType: "feature",
      branch: "feat/bd-121",
      worktreePath: CWD,
      parentSummary: "x".repeat(HANDOFF_FIELD_MAX_CHARS),
      now: 1,
    });
    expect(atCap.parentSummary).toHaveLength(HANDOFF_FIELD_MAX_CHARS);
    expect(atCap.parentSummary).not.toContain("(truncated)");

    const overCap = buildHandoff({
      taskId: "bd-121",
      workflowType: "feature",
      branch: "feat/bd-121",
      worktreePath: CWD,
      parentSummary: "x".repeat(HANDOFF_FIELD_MAX_CHARS + 1),
      now: 1,
    });
    expect(overCap.parentSummary).toHaveLength(HANDOFF_FIELD_MAX_CHARS);
    expect(overCap.parentSummary?.endsWith("(truncated)")).toBe(true);
  });

  it("re-reads a capped packet byte-identically through the fs seam", () => {
    const { fs, files } = createMemoryFs();
    // The packet exercises both caps: identity fields truncated at 1024, bodies
    // truncated by the total budget. A writer/reader mismatch would surface as
    // a shorter or re-ordered file on the second read.
    const packet = buildHandoff({
      taskId: "bd-121",
      workflowType: "feature",
      branch: "feat/bd-121",
      worktreePath: CWD,
      parentSummary: "s".repeat(HANDOFF_FIELD_MAX_CHARS),
      parentTask: "t".repeat(HANDOFF_FIELD_MAX_CHARS),
      childTask: "c".repeat(HANDOFF_FIELD_MAX_CHARS),
      lastCommitSubject: "subject 😀".repeat(200),
      dirtyFiles: Array.from({ length: HANDOFF_DIRTY_FILES_MAX }, (_, i) => `M f-${i}.ts`),
      now: 5,
    });

    expect(writeHandoff({ cwd: CWD, packet, fs })).toEqual({ ok: true });
    const firstRaw = files.get(handoffFilePath(CWD));
    const firstRead = readHandoff({ cwd: CWD, fs });
    expect(firstRead).toEqual(packet);
    if (firstRead === undefined) throw new Error("expected the handoff packet to round-trip");

    // Writing the parsed packet back reproduces the same bytes.
    expect(writeHandoff({ cwd: CWD, packet: firstRead, fs })).toEqual({ ok: true });
    expect(files.get(handoffFilePath(CWD))).toBe(firstRaw);
    expect(readHandoff({ cwd: CWD, fs })).toEqual(firstRead);
  });
});

describe("readHandoffFileArg", () => {
  const stat = (info: { isFile: boolean; size: number }) => () => info;

  it("reads a small regular file", () => {
    expect(
      readHandoffFileArg({
        path: "/tmp/plan.md",
        stat: stat({ isFile: true, size: 10 }),
        read: () => "the plan",
      }),
    ).toEqual({ ok: true, text: "the plan" });
  });

  it("rejects a file above the byte cap without reading it", () => {
    const result = readHandoffFileArg({
      path: "/tmp/huge.log",
      stat: stat({ isFile: true, size: HANDOFF_ARG_FILE_MAX_BYTES + 1 }),
      read: () => {
        throw new Error("should not read");
      },
    });

    expect(result).toEqual({
      ok: false,
      error: `Handoff file /tmp/huge.log is ${HANDOFF_ARG_FILE_MAX_BYTES + 1} bytes; the limit is ${HANDOFF_ARG_FILE_MAX_BYTES}.`,
    });
  });

  it("rejects a directory", () => {
    const result = readHandoffFileArg({
      path: "/tmp/plan-dir",
      stat: stat({ isFile: false, size: 4096 }),
    });

    expect(result).toEqual({
      ok: false,
      error: "Handoff path /tmp/plan-dir is not a regular file.",
    });
  });

  it("rejects a FIFO/character device without opening it", () => {
    let readCalled = false;
    const result = readHandoffFileArg({
      path: "/dev/zero",
      stat: stat({ isFile: false, size: 0 }),
      read: () => {
        readCalled = true;
        return "";
      },
    });

    expect(result.ok).toBe(false);
    expect(readCalled).toBe(false);
  });

  it("reports a missing file as an error value", () => {
    const result = readHandoffFileArg({
      path: "/tmp/missing.md",
      stat: () => {
        throw new Error("ENOENT: no such file or directory");
      },
    });

    expect(result).toEqual({
      ok: false,
      error: "Cannot read handoff file /tmp/missing.md: ENOENT: no such file or directory",
    });
  });

  it("reports an unreadable file as an error value", () => {
    const result = readHandoffFileArg({
      path: "/tmp/secret.md",
      stat: stat({ isFile: true, size: 4 }),
      read: () => {
        throw new Error("EACCES: permission denied");
      },
    });

    expect(result).toEqual({
      ok: false,
      error: "Cannot read handoff file /tmp/secret.md: EACCES: permission denied",
    });
  });
});

describe("buildOrchestratorPrompt", () => {
  it("carries identity, the ownership rule and the handoff text", () => {
    const packet = populatedPacket();
    const prompt = buildOrchestratorPrompt({
      taskId: "bd-121",
      workflowType: "feature",
      worktreePath: CWD,
      branch: "feat/bd-121",
      phaseOrder: ["scout", "plan", "implement", "commit"],
      handoff: packet,
    });

    expect(prompt).toContain("Start the Belayd feature workflow for bd-121.");
    expect(prompt).toContain("## Identity");
    expect(prompt).toContain(`- Worktree (absolute): ${CWD}`);
    expect(prompt).toContain("- Branch: feat/bd-121");
    expect(prompt).toContain("- Parent: bd-119");
    expect(prompt).toContain("## Ownership");
    expect(prompt).toContain(`You own this worktree only (${CWD}).`);
    expect(prompt).toContain("Do not edit, reset or copy files in /repo/.feat-bd-119.");
    expect(prompt).toContain("you cannot drive another workflow");
    expect(prompt).toContain("## Handoff");
    expect(prompt).toContain(packet.parentSummary ?? "");
    expect(prompt).toContain("Follow the enforced phase order: scout → plan → implement → commit.");
    expect(prompt).toContain("Begin by calling `belayd_scout` to start.");
  });

  it("degrades to a no-handoff prompt when nothing is known", () => {
    const prompt = buildOrchestratorPrompt({
      taskId: "bd-121",
      workflowType: "chore",
      worktreePath: CWD,
      branch: "feat/bd-121",
      phaseOrder: [],
    });

    expect(prompt).toContain("- Task: bd-121 (chore workflow)");
    expect(prompt).not.toContain("Base branch");
    expect(prompt).not.toContain("Parent:");
    expect(prompt).toContain("Do not edit, reset or copy files in any other worktree.");
    expect(prompt).toContain("(no handoff provided)");
    // An empty phase order must still name a callable tool.
    expect(prompt).toContain("Begin by calling `belayd_commit` to start.");
  });
});

describe("collectHandoffDefault", () => {
  function exec(map: Record<string, string>): GitExec {
    return (args) => {
      const key = args.join(" ");
      const value = map[key];
      if (value === undefined) throw new Error(`unexpected git call: ${key}`);
      return value;
    };
  }

  it("gathers the mechanical default from the parent session", async () => {
    const { fs } = createMemoryFs();
    writeWorkflowState({
      cwd: CWD,
      fs,
      state: {
        schemaVersion: 1,
        taskId: "bd-119",
        workflowType: "feature",
        branch: "feat/bd-119",
        originalCwd: "/repo",
        phaseOrder: ["scout", "plan", "implement"],
        completedPhaseNames: ["scout", "plan"],
        startedAt: 1,
        updatedAt: 2,
      },
    });

    const packet = await collectHandoffDefault({
      cwd: CWD,
      taskId: "bd-121",
      workflowType: "feature",
      branch: "feat/bd-121",
      worktreePath: "/repo/.feat-bd-121",
      parentTaskId: "bd-119",
      parentBranch: "feat/bd-119",
      parentSessionId: "parent-session",
      parentWorktreePath: CWD,
      transcript: [{ type: "message", message: { role: "assistant", content: "parent answer" } }],
      deps: {
        fs,
        exec: exec({
          "log -1 --pretty=%s": "feat: parent commit\n",
          "status --porcelain": " M src/handoff.ts\n?? docs/diagrams/x.html\n",
        }),
        showTask: async (taskId) => `body of ${taskId}`,
        now: () => 42,
      },
    });

    expect(packet).toHaveProperty("taskId", "bd-121");
    expect(packet).toHaveProperty("parentTaskId", "bd-119");
    expect(packet).toHaveProperty("parentSummary", "parent answer");
    expect(packet).toHaveProperty("parentTask", "body of bd-119");
    expect(packet).toHaveProperty("childTask", "body of bd-121");
    expect(packet.completedPhases).toEqual(["scout", "plan"]);
    expect(packet).toHaveProperty("lastCommitSubject", "feat: parent commit");
    expect(packet.dirtyFiles).toEqual(["M src/handoff.ts", "?? docs/diagrams/x.html"]);
    expect(packet).toHaveProperty("createdAt", 42);
  });

  it("prefers explicit handoff text over the transcript summary", async () => {
    const { fs } = createMemoryFs();
    const packet = await collectHandoffDefault({
      cwd: CWD,
      taskId: "bd-121",
      workflowType: "feature",
      branch: "feat/bd-121",
      worktreePath: "/repo/.feat-bd-121",
      parentSummary: "explicit plan",
      transcript: [
        { type: "message", message: { role: "assistant", content: "last transcript text" } },
      ],
      deps: { fs, exec: exec({}), showTask: async () => undefined, now: () => 1 },
    });

    expect(packet).toHaveProperty("parentSummary", "explicit plan");
  });

  it("degrades to empty fields when every probe fails", async () => {
    const packet = await collectHandoffDefault({
      cwd: CWD,
      taskId: "bd-121",
      workflowType: "feature",
      branch: "feat/bd-121",
      worktreePath: "/repo/.feat-bd-121",
      deps: {
        exec: () => {
          throw new Error("not a git repository");
        },
        showTask: async () => {
          throw new Error("bd not installed");
        },
      },
    });

    expect(packet.completedPhases).toEqual([]);
    expect(packet.dirtyFiles).toEqual([]);
    expect(packet).not.toHaveProperty("lastCommitSubject");
    expect(packet).not.toHaveProperty("parentTask");
    expect(packet).not.toHaveProperty("parentSummary");
  });

  it("still produces a usable identity-only packet when every probe fails", async () => {
    // The launch must not depend on git/bd/workflow.json being reachable: the
    // degraded packet still has to name the task, branch and owned worktree,
    // and must survive its own parser (it is persisted to disk verbatim).
    const packet = await collectHandoffDefault({
      cwd: CWD,
      taskId: "bd-121",
      workflowType: "feature",
      branch: "feat/bd-121",
      worktreePath: "/repo/.feat-bd-121",
      deps: {
        exec: () => {
          throw new Error("not a git repository");
        },
        showTask: async () => undefined,
        fs: {
          existsSync: () => true,
          readFileSync: () => {
            throw new Error("EACCES: permission denied");
          },
          writeFileSync: () => {},
          renameSync: () => {},
          mkdirSync: () => {},
          unlinkSync: () => {},
        },
        now: () => 9,
      },
    });

    expect(parseHandoff(JSON.parse(JSON.stringify(packet)))).toEqual(packet);
    expect(packet).toHaveProperty("taskId", "bd-121");
    expect(packet).toHaveProperty("branch", "feat/bd-121");
    expect(packet).toHaveProperty("worktreePath", "/repo/.feat-bd-121");
    // With no parent facts the handoff section is explicitly empty rather than
    // a half-rendered list; the identity block above it carries task/branch.
    expect(formatHandoffBlock(packet)).toBe("## Handoff\n\n(no handoff provided)");

    const prompt = buildOrchestratorPrompt({
      taskId: "bd-121",
      workflowType: "feature",
      worktreePath: "/repo/.feat-bd-121",
      branch: "feat/bd-121",
      phaseOrder: ["scout"],
      handoff: packet,
    });
    expect(prompt).toContain(`- Worktree (absolute): /repo/.feat-bd-121`);
    expect(prompt).toContain("- Branch: feat/bd-121");
    expect(prompt).toContain("## Handoff");
  });
});

describe("taskIdFromBranch", () => {
  it("recovers the bead id from a workflow branch and ignores plain branches", () => {
    expect(taskIdFromBranch("feat/bd-121")).toBe("bd-121");
    expect(taskIdFromBranch("fix/bd-42.1")).toBe("bd-42.1");
    expect(taskIdFromBranch("main")).toBeUndefined();
  });
});
