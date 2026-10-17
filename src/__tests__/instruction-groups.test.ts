/**
 * Tests for the managed instruction-group contract.
 *
 * Everything here is plain data: the collector, the section applier, and the
 * wiring (`manageInstructionGroups`) take no pi runtime and need no mocks. The
 * effectful emit is passed in, which lets these tests simulate the real foreign
 * extension (register a group, flip a managed flag) exactly like pi-agent-browser.
 */

import { describe, expect, it } from "vitest";
import type {
  InstructionGroup,
  InstructionGroupCollector,
  ManageInstructionGroupsFailureReason,
} from "../../src/instruction-groups.js";
import {
  applyInstructionGroupSections,
  createInstructionGroupCollector,
  INSTRUCTION_GROUPS_CHANNEL,
  LEGACY_SUPERSEDED_SECTION_KEYS,
  manageInstructionGroups,
  manageInstructionGroupsWarning,
  NO_GROUP_REGISTERED_WARNING,
  selectActiveGroups,
} from "../../src/instruction-groups.js";
import { DEFAULT_AGENTS } from "../agent-registry.js";

/** Minimal browser-like group matching pi-agent-browser's registration. */
function browserGroup(overrides: { instructions?: (ctx: unknown) => string } = {}) {
  return {
    name: "browser",
    description: "Browse the web",
    tools: ["agent_browser", "agent_browser_code"],
    instructions: overrides.instructions ?? (() => "<browser>instructions</browser>"),
  };
}

/**
 * Emulates pi-agent-browser's `pi:instruction-groups` listener: it registers a
 * group and then permanently flips its `isManaged` flag to the collector's
 * value. Once flipped, the real extension never writes its fallback again.
 */
function fakeForeignExtension() {
  const state = { managed: false, emissions: 0 };
  return {
    state,
    emitInstructionGroups: (collector: InstructionGroupCollector): void => {
      state.emissions += 1;
      collector.register(browserGroup());
      state.managed = collector.isManaged();
    },
  };
}

describe("instruction groups", () => {
  it("exposes the channel name extensions listen on", () => {
    expect(INSTRUCTION_GROUPS_CHANNEL).toBe("pi:instruction-groups");
  });

  it("creates a managed collector that reports not-empty after register", () => {
    const collector = createInstructionGroupCollector();
    expect(collector.isEmpty()).toBe(true);
    expect(collector.isManaged()).toBe(true);
    const result = collector.register(browserGroup());
    expect(result).toEqual({ registered: true });
    expect(collector.isEmpty()).toBe(false);
    expect(collector.groups()).toHaveLength(1);
  });

  it("dedupes registrations by name with last registration winning", () => {
    const collector = createInstructionGroupCollector();
    collector.register({ ...browserGroup(), instructions: () => "first" });
    collector.register(browserGroup());
    collector.register({ ...browserGroup(), instructions: () => "last" });

    const groups = collector.groups();
    expect(groups).toHaveLength(1);
    expect(groups[0]?.instructions({})).toBe("last");
  });

  it("keeps repeated emits from accumulating duplicate groups", () => {
    const collector = createInstructionGroupCollector();
    collector.register(browserGroup());
    // emulate the foreign extension re-registering across turns
    collector.register(browserGroup());
    collector.register(browserGroup());
    expect(collector.groups()).toHaveLength(1);
  });

  it("rejects invalid group names without throwing (W2)", () => {
    const collector = createInstructionGroupCollector();
    expect(collector.register({ ...browserGroup(), name: "Bad Name" })).toEqual({
      registered: false,
      reason: "invalid-name",
    });
    expect(collector.register({ ...browserGroup(), name: "Uppercase" })).toEqual({
      registered: false,
      reason: "invalid-name",
    });
    expect(collector.register({ ...browserGroup(), name: "preamble" })).toEqual({
      registered: false,
      reason: "reserved-name",
    });
    expect(collector.register({ ...browserGroup(), name: "123" })).toEqual({
      registered: false,
      reason: "invalid-name",
    });
    expect(collector.isEmpty()).toBe(true);
  });

  it("rejects non-array tools without throwing (W1)", () => {
    const collector = createInstructionGroupCollector();
    const malformed = { ...browserGroup(), tools: "agent_browser" } as unknown as ReturnType<
      typeof browserGroup
    >;
    expect(collector.register(malformed)).toEqual({
      registered: false,
      reason: "invalid-tools",
    });
    expect(collector.isEmpty()).toBe(true);
  });

  it("selects groups active when any group tool is in the allowlist", () => {
    const group = browserGroup();
    expect(selectActiveGroups([group], ["read", "agent_browser_code"])).toEqual([group]);
    expect(selectActiveGroups([group], ["read", "bash"])).toEqual([]);
  });

  it("does not match tool names by substring", () => {
    const group = browserGroup();
    expect(selectActiveGroups([group], ["agent_browser_code_extra"])).toEqual([]);
  });

  it("writes an active group under its own name, not the legacy key", () => {
    const sections: Record<string, string> = {};
    const result = applyInstructionGroupSections({
      sections,
      groups: [browserGroup()],
      selectedTools: ["agent_browser"],
      ctx: {},
    });

    expect(result.applied).toEqual(["browser"]);
    expect(sections).toHaveProperty("browser", "<browser>instructions</browser>");
    expect(sections).not.toHaveProperty("agent_browser");
  });

  it("deletes a stale section for an inactive group", () => {
    const sections: Record<string, string> = { browser: "<browser>stale</browser>" };
    const result = applyInstructionGroupSections({
      sections,
      groups: [browserGroup()],
      selectedTools: ["read", "bash"],
      ctx: {},
    });

    expect(result.applied).toEqual([]);
    expect(sections).not.toHaveProperty("browser");
  });

  it("removes every legacy superseded key whenever any group is managed", () => {
    const sections: Record<string, string> = {
      agent_browser: "<agent_browser>legacy</agent_browser>",
    };
    applyInstructionGroupSections({
      sections,
      groups: [browserGroup()],
      selectedTools: ["read"],
      ctx: {},
    });

    for (const key of LEGACY_SUPERSEDED_SECTION_KEYS) {
      expect(sections).not.toHaveProperty(key);
    }
  });

  it("does not delete legacy keys when no group is managed", () => {
    const sections: Record<string, string> = { agent_browser: "legacy" };
    applyInstructionGroupSections({
      sections,
      groups: [],
      selectedTools: ["read"],
      ctx: {},
    });
    expect(sections).toHaveProperty("agent_browser", "legacy");
  });

  it("contains a throwing instructions builder, warns with the group name, and leaves no section", () => {
    const warnings: string[] = [];
    const sections: Record<string, string> = { browser: "stale" };
    const result = applyInstructionGroupSections({
      sections,
      groups: [
        browserGroup({
          instructions: () => {
            throw new Error("foreign prompt builder exploded");
          },
        }),
      ],
      selectedTools: ["agent_browser"],
      ctx: {},
      warn: (message) => warnings.push(message),
    });

    expect(result.applied).toEqual([]);
    expect(sections).not.toHaveProperty("browser");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"browser"');
  });

  it("pure contract: deletes every group section when the allowlist is empty", () => {
    // The wiring never reaches this because `manageInstructionGroups` bails
    // before mutating sections for an empty allowlist (see the wiring tests
    // below); this asserts the applier's standalone behaviour only.
    const sections: Record<string, string> = {
      browser: "stale-browser",
      other: "stale-other",
    };
    const result = applyInstructionGroupSections({
      sections,
      groups: [
        browserGroup(),
        {
          name: "other",
          tools: ["other_tool"],
          instructions: () => "other",
        },
      ],
      selectedTools: [],
      ctx: {},
    });

    expect(result.applied).toEqual([]);
    expect(sections).not.toHaveProperty("browser");
    expect(sections).not.toHaveProperty("other");
  });

  it("applies only the active groups and reports their names in order", () => {
    const sections: Record<string, string> = {};
    const result = applyInstructionGroupSections({
      sections,
      groups: [
        browserGroup(),
        { name: "other", tools: ["other_tool"], instructions: () => "other" },
      ],
      selectedTools: ["other_tool"],
      ctx: {},
    });

    expect(result.applied).toEqual(["other"]);
    expect(sections).toHaveProperty("other", "other");
    expect(sections).not.toHaveProperty("browser");
  });
});

describe("manageInstructionGroups wiring", () => {
  it("writes no browser section for a session without browser tools", () => {
    const collector = createInstructionGroupCollector();
    const foreign = fakeForeignExtension();
    const sections: Record<string, string> = { agent_browser: "legacy" };

    const result = manageInstructionGroups({
      collector,
      emitInstructionGroups: foreign.emitInstructionGroups,
      systemPromptOptions: { sections, selectedTools: ["read", "bash"] },
      ctx: {},
    });

    expect(result).toEqual({ managed: true, applied: [] });
    expect(foreign.state.managed).toBe(true);
    expect(sections).not.toHaveProperty("browser");
    expect(sections).not.toHaveProperty("agent_browser");
  });

  it("writes the browser section for a session with the tool", () => {
    const collector = createInstructionGroupCollector();
    const foreign = fakeForeignExtension();
    const sections: Record<string, string> = { agent_browser: "legacy" };

    const result = manageInstructionGroups({
      collector,
      emitInstructionGroups: foreign.emitInstructionGroups,
      systemPromptOptions: { sections, selectedTools: ["read", "agent_browser"] },
      ctx: {},
    });

    expect(result).toEqual({ managed: true, applied: ["browser"] });
    expect(sections).toHaveProperty("browser", "<browser>instructions</browser>");
    expect(sections).not.toHaveProperty("agent_browser");
  });

  it("leaves sections untouched when no extension registers a group", () => {
    const collector = createInstructionGroupCollector();
    const sections: Record<string, string> = { agent_browser: "legacy" };

    const result = manageInstructionGroups({
      collector,
      emitInstructionGroups: () => {},
      systemPromptOptions: { sections, selectedTools: ["read"] },
      ctx: {},
    });

    expect(result).toEqual({ managed: false, reason: "no-groups" });
    expect(sections).toHaveProperty("agent_browser", "legacy");
  });

  it("C1: does not emit for an empty allowlist, so isManaged cannot flip", () => {
    const collector = createInstructionGroupCollector();
    const foreign = fakeForeignExtension();
    const sections: Record<string, string> = { agent_browser: "legacy" };

    const result = manageInstructionGroups({
      collector,
      emitInstructionGroups: foreign.emitInstructionGroups,
      systemPromptOptions: { sections, selectedTools: [] },
      ctx: {},
    });

    expect(result).toEqual({ managed: false, reason: "no-selected-tools" });
    expect(foreign.state.emissions).toBe(0);
    expect(foreign.state.managed).toBe(false);
    expect(collector.isEmpty()).toBe(true);
    expect(sections).toHaveProperty("agent_browser", "legacy");
  });

  it("C1: does not emit when selectedTools is absent", () => {
    const collector = createInstructionGroupCollector();
    const foreign = fakeForeignExtension();
    const sections: Record<string, string> = { agent_browser: "legacy" };

    const result = manageInstructionGroups({
      collector,
      emitInstructionGroups: foreign.emitInstructionGroups,
      systemPromptOptions: { sections },
      ctx: {},
    });

    expect(result).toEqual({ managed: false, reason: "no-selected-tools" });
    expect(foreign.state.emissions).toBe(0);
    expect(sections).toHaveProperty("agent_browser", "legacy");
  });

  it("does not emit without system prompt options", () => {
    const collector = createInstructionGroupCollector();
    const foreign = fakeForeignExtension();

    const result = manageInstructionGroups({
      collector,
      emitInstructionGroups: foreign.emitInstructionGroups,
      systemPromptOptions: undefined,
      ctx: {},
    });

    expect(result).toEqual({ managed: false, reason: "no-system-prompt-options" });
    expect(foreign.state.emissions).toBe(0);
  });

  it("does not emit without a sections record", () => {
    const collector = createInstructionGroupCollector();
    const foreign = fakeForeignExtension();

    const result = manageInstructionGroups({
      collector,
      emitInstructionGroups: foreign.emitInstructionGroups,
      systemPromptOptions: { selectedTools: ["agent_browser"] },
      ctx: {},
    });

    expect(result).toEqual({ managed: false, reason: "no-sections" });
    expect(foreign.state.emissions).toBe(0);
  });

  it("emits once and still applies on later turns without re-emitting", () => {
    const collector = createInstructionGroupCollector();
    const foreign = fakeForeignExtension();

    const firstSections: Record<string, string> = { agent_browser: "legacy" };
    manageInstructionGroups({
      collector,
      emitInstructionGroups: foreign.emitInstructionGroups,
      systemPromptOptions: { sections: firstSections, selectedTools: ["agent_browser"] },
      ctx: {},
    });
    expect(foreign.state.emissions).toBe(1);

    const secondSections: Record<string, string> = { browser: "stale" };
    const result = manageInstructionGroups({
      collector,
      emitInstructionGroups: foreign.emitInstructionGroups,
      systemPromptOptions: { sections: secondSections, selectedTools: ["read"] },
      ctx: {},
    });

    expect(foreign.state.emissions).toBe(1);
    expect(result).toEqual({ managed: true, applied: [] });
    expect(secondSections).not.toHaveProperty("browser");
  });

  it("W6: warns when the channel was emitted but no group registered", () => {
    const collector = createInstructionGroupCollector();
    const warnings: string[] = [];
    const sections: Record<string, string> = { agent_browser: "legacy" };

    const result = manageInstructionGroups({
      collector,
      emitInstructionGroups: () => {},
      systemPromptOptions: { sections, selectedTools: ["read"] },
      ctx: {},
      warn: (message) => warnings.push(message),
    });

    expect(result).toEqual({ managed: false, reason: "no-groups" });
    expect(warnings).toEqual(["instruction-group channel emitted but no group registered"]);
    expect(sections).toHaveProperty("agent_browser", "legacy");
  });

  it("W6: does not warn when the emit path was not taken", () => {
    const collector = createInstructionGroupCollector();
    const warnings: string[] = [];

    // selectedTools is empty, so the manager bails before emitting.
    manageInstructionGroups({
      collector,
      emitInstructionGroups: () => {},
      systemPromptOptions: { sections: {}, selectedTools: [] },
      ctx: {},
      warn: (message) => warnings.push(message),
    });

    expect(warnings).toEqual([]);
  });

  it("W6: threads warn through to a malformed active group", () => {
    const collector = createInstructionGroupCollector();
    const warnings: string[] = [];

    const result = manageInstructionGroups({
      collector,
      emitInstructionGroups: (target) =>
        target.register(
          browserGroup({
            instructions: () => {
              throw new Error("boom");
            },
          }),
        ),
      systemPromptOptions: { sections: {}, selectedTools: ["agent_browser"] },
      ctx: {},
      warn: (message) => warnings.push(message),
    });

    expect(result).toEqual({ managed: true, applied: [] });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"browser"');
  });
});

describe("manageInstructionGroupsWarning", () => {
  it("maps each skipped reason to a call-site warning line", () => {
    expect(
      manageInstructionGroupsWarning({ managed: false, reason: "no-system-prompt-options" }),
    ).toBe("instruction-group gate skipped: no-system-prompt-options");
    expect(manageInstructionGroupsWarning({ managed: false, reason: "no-sections" })).toBe(
      "instruction-group gate skipped: no-sections",
    );
    expect(manageInstructionGroupsWarning({ managed: false, reason: "no-selected-tools" })).toBe(
      "instruction-group gate skipped: no-selected-tools",
    );
  });

  it("does not repeat the no-groups warning already emitted by the manager", () => {
    expect(manageInstructionGroupsWarning({ managed: false, reason: "no-groups" })).toBeUndefined();
  });

  it("returns undefined when the gate ran", () => {
    expect(manageInstructionGroupsWarning({ managed: true, applied: [] })).toBeUndefined();
  });
});

describe("instruction group edge cases", () => {
  it("returns no active groups when the allowlist has a browser tool but nothing registered", () => {
    expect(selectActiveGroups([], ["agent_browser", "agent_browser_code"])).toEqual([]);
  });

  it("preserves the legacy fallback when a browser tool is allowlisted but no group registered", () => {
    const collector = createInstructionGroupCollector();
    const sections: Record<string, string> = { agent_browser: "legacy" };
    const result = manageInstructionGroups({
      collector,
      emitInstructionGroups: () => {},
      systemPromptOptions: { sections, selectedTools: ["read", "agent_browser"] },
      ctx: {},
    });

    expect(result).toEqual({ managed: false, reason: "no-groups" });
    expect(sections).toHaveProperty("agent_browser", "legacy");
    expect(sections).not.toHaveProperty("browser");
  });

  it("treats a group with an empty tools array as inactive and deletes its stale section", () => {
    const group: InstructionGroup = { name: "empty", tools: [], instructions: () => "never" };
    expect(selectActiveGroups([group], ["read", "agent_browser"])).toEqual([]);

    const sections: Record<string, string> = { empty: "stale", keep: "keep" };
    const result = applyInstructionGroupSections({
      sections,
      groups: [group],
      selectedTools: ["read", "agent_browser"],
      ctx: {},
    });

    expect(result.applied).toEqual([]);
    expect(sections).not.toHaveProperty("empty");
    expect(sections).toHaveProperty("keep", "keep");
  });

  it("activates a group exactly once when its tools list repeats the selected tool", () => {
    const group: InstructionGroup = {
      name: "dupe",
      tools: ["agent_browser", "agent_browser"],
      instructions: () => "dupe-body",
    };
    expect(selectActiveGroups([group], ["agent_browser"])).toEqual([group]);

    const sections: Record<string, string> = {};
    const result = applyInstructionGroupSections({
      sections,
      groups: [group],
      selectedTools: ["agent_browser"],
      ctx: {},
    });

    expect(result.applied).toEqual(["dupe"]);
    expect(sections).toHaveProperty("dupe", "dupe-body");
  });

  it("writes the active group, deletes the inactive group's stale section, and leaves unrelated sections alone", () => {
    const sections: Record<string, string> = {
      browser: "stale-browser",
      other: "stale-other",
      unrelated: "keep-me",
    };
    const result = applyInstructionGroupSections({
      sections,
      groups: [
        { name: "browser", tools: ["agent_browser"], instructions: () => "fresh-browser" },
        { name: "other", tools: ["other_tool"], instructions: () => "fresh-other" },
      ],
      selectedTools: ["agent_browser"],
      ctx: {},
    });

    expect(result.applied).toEqual(["browser"]);
    expect(sections).toHaveProperty("browser", "fresh-browser");
    expect(sections).not.toHaveProperty("other");
    expect(sections).toHaveProperty("unrelated", "keep-me");
  });

  it("deletes the legacy agent_browser key even when a non-browser group is the only managed group (chosen behaviour)", () => {
    const sections: Record<string, string> = { agent_browser: "legacy", other: "stale" };
    const result = applyInstructionGroupSections({
      sections,
      groups: [{ name: "other", tools: ["other_tool"], instructions: () => "fresh-other" }],
      selectedTools: ["other_tool"],
      ctx: {},
    });

    expect(result.applied).toEqual(["other"]);
    expect(sections).toHaveProperty("other", "fresh-other");
    expect(sections).not.toHaveProperty("agent_browser");
  });
});

describe("validateInstructionGroup (reached through collector.register)", () => {
  it("accepts kebab/snake/digit-suffix names and has no length cap", () => {
    const collector = createInstructionGroupCollector();
    const names = ["browser-v2_test", "b", "a".repeat(500)];
    for (const name of names) {
      expect(collector.register({ name, tools: [], instructions: () => "" })).toEqual({
        registered: true,
      });
    }
    expect(collector.groups().map((group) => group.name)).toEqual(names);
  });

  it("rejects every invalid-name shape without throwing", () => {
    const collector = createInstructionGroupCollector();
    const invalidNames = [
      "1browser",
      "-browser",
      "_browser",
      "Browser",
      "browser.x",
      "browser x",
      "browser/x",
      "",
    ];
    for (const name of invalidNames) {
      expect(collector.register({ name, tools: [], instructions: () => "" })).toEqual({
        registered: false,
        reason: "invalid-name",
      });
    }
    expect(collector.isEmpty()).toBe(true);
  });

  it("rejects non-string names as invalid-name (checked before the pattern)", () => {
    const collector = createInstructionGroupCollector();
    for (const name of [undefined, null, 42, ["browser"]]) {
      expect(
        collector.register({ ...browserGroup(), name } as unknown as InstructionGroup),
      ).toEqual({ registered: false, reason: "invalid-name" });
    }
    expect(collector.isEmpty()).toBe(true);
  });

  it("reserves the exact preamble key only", () => {
    const collector = createInstructionGroupCollector();
    expect(collector.register({ name: "preamble", tools: [], instructions: () => "" })).toEqual({
      registered: false,
      reason: "reserved-name",
    });
    expect(
      collector.register({ name: "preamble_extra", tools: [], instructions: () => "" }),
    ).toEqual({ registered: true });
  });

  it("rejects a missing or non-array tools field but accepts an empty array", () => {
    const collector = createInstructionGroupCollector();
    expect(
      collector.register({
        name: "browser",
        instructions: () => "",
      } as unknown as InstructionGroup),
    ).toEqual({ registered: false, reason: "invalid-tools" });
    expect(
      collector.register({
        name: "browser",
        tools: "agent_browser",
      } as unknown as InstructionGroup),
    ).toEqual({ registered: false, reason: "invalid-tools" });
    expect(collector.register({ name: "browser", tools: [], instructions: () => "" })).toEqual({
      registered: true,
    });
  });
});

describe("manageInstructionGroups result union", () => {
  interface GateCase {
    label: string;
    systemPromptOptions: unknown;
    reason: ManageInstructionGroupsFailureReason;
    gateWarn: string | undefined;
    managerWarnings: string[];
  }

  const gateCases: GateCase[] = [
    {
      label: "no-system-prompt-options",
      systemPromptOptions: undefined,
      reason: "no-system-prompt-options",
      gateWarn: "instruction-group gate skipped: no-system-prompt-options",
      managerWarnings: [],
    },
    {
      label: "no-sections",
      systemPromptOptions: { selectedTools: ["read"] },
      reason: "no-sections",
      gateWarn: "instruction-group gate skipped: no-sections",
      managerWarnings: [],
    },
    {
      label: "no-selected-tools",
      systemPromptOptions: { sections: {}, selectedTools: [] },
      reason: "no-selected-tools",
      gateWarn: "instruction-group gate skipped: no-selected-tools",
      managerWarnings: [],
    },
    {
      label: "no-groups",
      systemPromptOptions: { sections: { agent_browser: "legacy" }, selectedTools: ["read"] },
      reason: "no-groups",
      gateWarn: undefined,
      managerWarnings: [NO_GROUP_REGISTERED_WARNING],
    },
  ];

  it("distinguishes every managed:false reason and keeps the two warning channels separate", () => {
    for (const gateCase of gateCases) {
      const collector = createInstructionGroupCollector();
      const warnings: string[] = [];
      const result = manageInstructionGroups({
        collector,
        emitInstructionGroups: () => {},
        systemPromptOptions: gateCase.systemPromptOptions,
        ctx: {},
        warn: (message) => warnings.push(message),
      });

      expect(result.managed, gateCase.label).toBe(false);
      if (!result.managed) {
        expect(result.reason, gateCase.label).toBe(gateCase.reason);
      }
      expect(warnings, gateCase.label).toEqual(gateCase.managerWarnings);
      expect(manageInstructionGroupsWarning(result), gateCase.label).toBe(gateCase.gateWarn);
    }
  });

  it("never pairs a gate-skip warning with a managed result (the only warn+managed path is a per-group failure)", () => {
    const collector = createInstructionGroupCollector();
    const warnings: string[] = [];
    const result = manageInstructionGroups({
      collector,
      emitInstructionGroups: (target) =>
        target.register(
          browserGroup({
            instructions: () => {
              throw new Error("builder exploded");
            },
          }),
        ),
      systemPromptOptions: { sections: {}, selectedTools: ["agent_browser"] },
      ctx: {},
      warn: (message) => warnings.push(message),
    });

    expect(result).toEqual({ managed: true, applied: [] });
    expect(warnings).toEqual([expect.stringContaining("failed")]);
    // The gate-skip channel stays silent; the warning came from the applier.
    expect(manageInstructionGroupsWarning(result)).toBeUndefined();
  });
});

describe("manageInstructionGroupsWarning exhaustiveness", () => {
  const allReasons: ManageInstructionGroupsFailureReason[] = [
    "no-system-prompt-options",
    "no-sections",
    "no-selected-tools",
    "no-groups",
  ];

  it("maps the full failure-reason union and never repeats a line", () => {
    const lines = allReasons.map((reason) =>
      manageInstructionGroupsWarning({ managed: false, reason }),
    );
    expect(lines).toEqual([
      "instruction-group gate skipped: no-system-prompt-options",
      "instruction-group gate skipped: no-sections",
      "instruction-group gate skipped: no-selected-tools",
      undefined,
    ]);
    const defined = lines.filter((line): line is string => line !== undefined);
    expect(new Set(defined).size).toBe(defined.length);
  });

  it("returns undefined for managed results with or without applied groups", () => {
    expect(manageInstructionGroupsWarning({ managed: true, applied: [] })).toBeUndefined();
    expect(manageInstructionGroupsWarning({ managed: true, applied: ["browser"] })).toBeUndefined();
  });
});

describe("DEFAULT_AGENTS browser-prompt regression guard", () => {
  it("gives the browser section only to agents whose allowlist has a browser tool", () => {
    const browserTools = browserGroup().tools;

    // The registry's browser tool name must stay in the foreign group's tool
    // list, or a rename would silently disable the section for real agents.
    expect(browserTools).toContain("agent_browser");

    const browserAgents: string[] = [];
    const nonBrowserAgents: string[] = [];
    for (const agent of DEFAULT_AGENTS) {
      const selectedTools = [...agent.tools];
      const expectsBrowser = selectedTools.some((tool) => browserTools.includes(tool));
      const sections: Record<string, string> = { agent_browser: "legacy" };
      const collector = createInstructionGroupCollector();
      const result = manageInstructionGroups({
        collector,
        emitInstructionGroups: (target) => target.register(browserGroup()),
        systemPromptOptions: { sections, selectedTools },
        ctx: {},
      });

      expect(result.managed, agent.name).toBe(true);
      if (expectsBrowser) {
        browserAgents.push(agent.name);
        expect(result, agent.name).toEqual({ managed: true, applied: ["browser"] });
        expect(sections, agent.name).toHaveProperty("browser", "<browser>instructions</browser>");
      } else {
        nonBrowserAgents.push(agent.name);
        expect(result, agent.name).toEqual({ managed: true, applied: [] });
        expect(sections, agent.name).not.toHaveProperty("browser");
      }
      // The legacy fallback key never survives a managed turn.
      expect(sections, agent.name).not.toHaveProperty("agent_browser");
    }

    // Snapshot: catches an allowlist edit (add or remove) that the loop above
    // would otherwise absorb because its expectation is derived from the same
    // tools. The set is derived from the real registry, then pinned.
    expect(browserAgents).toEqual(["belayd-implementer", "belayd-proof-generator"]);
    expect(nonBrowserAgents).toHaveLength(DEFAULT_AGENTS.length - browserAgents.length);
  });
});
