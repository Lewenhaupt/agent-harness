/**
 * Managed instruction groups for the pi system prompt.
 *
 * Some pi extensions ship a large prompt section (~35k chars for the browser
 * tools) and register an unconditionally-eager fallback that writes it on
 * every turn. pi exposes a `pi:instruction-groups` event channel so a host can
 * take ownership of those sections and only materialise a group's instructions
 * when at least one of its tools is in the session allowlist. pi 1.0.2 emits
 * nothing on that channel, so the harness emits it itself.
 *
 * The functions here are pure logic over plain group arrays and a mutable
 * sections record. The only effectful dependency (emitting the channel) is
 * passed in, so the whole contract — including the wiring that used to live in
 * `extensions/index.ts` — is testable without a pi runtime or mocks.
 */

/** Event channel pi extensions listen on to register managed prompt groups. */
export const INSTRUCTION_GROUPS_CHANNEL = "pi:instruction-groups";

export interface InstructionGroup {
  /** Section key the instructions are written under. */
  name: string;
  /** Tool names that, when any is in the session allowlist, activate the group. */
  tools: string[];
  description?: string;
  /** Built lazily, only when the group is active. */
  instructions: (ctx: unknown) => string;
}

/** Outcome of trying to register a group with the collector. */
export type RegisterInstructionGroupResult =
  | { registered: true }
  | { registered: false; reason: "invalid-name" | "reserved-name" | "invalid-tools" };

export interface InstructionGroupCollector {
  register: (group: InstructionGroup) => RegisterInstructionGroupResult;
  /** The foreign extension stores this and calls it as `collector.isManaged()`. */
  isManaged: () => boolean;
  groups: () => InstructionGroup[];
  isEmpty: () => boolean;
}

/**
 * pi-agent-browser's unmanaged fallback writes the browser prompt under the
 * literal section key `agent_browser`, while the managed group is named
 * `browser`. A managed collector must delete the legacy key so a load order
 * that lets the fallback run in the same turn cannot append a second ~35k-char
 * copy of the same instructions.
 */
export const LEGACY_SUPERSEDED_SECTION_KEYS: readonly string[] = ["agent_browser"];

/**
 * pi's `buildSystemPromptSections` throws at prompt-build time on any section
 * name failing this pattern, and that throw happens *after* all
 * `before_agent_start` handlers, outside any handler try/catch. A bad foreign
 * group must therefore degrade to "section missing", never "session broken".
 */
const GROUP_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;

/** pi renders `preamble` as untagged text; a group must not claim that key. */
const RESERVED_GROUP_NAMES: readonly string[] = ["preamble"];

function validateInstructionGroup(group: InstructionGroup): RegisterInstructionGroupResult {
  if (typeof group.name !== "string") {
    return { registered: false, reason: "invalid-name" };
  }
  if (RESERVED_GROUP_NAMES.includes(group.name)) {
    return { registered: false, reason: "reserved-name" };
  }
  if (!GROUP_NAME_PATTERN.test(group.name)) {
    return { registered: false, reason: "invalid-name" };
  }
  if (!Array.isArray(group.tools)) {
    return { registered: false, reason: "invalid-tools" };
  }
  return { registered: true };
}

/**
 * Collect groups from a single session's extensions.
 *
 * `register` dedupes by name (last registration wins) because extensions may
 * re-emit the channel on every turn; without dedup the groups array would grow
 * unbounded. It validates names/tools and returns a rejection instead of
 * throwing, so a malformed foreign group cannot break the session. State lives
 * in this closure rather than at module scope so concurrent sessions never
 * share a collector.
 */
export function createInstructionGroupCollector(): InstructionGroupCollector {
  const groups: InstructionGroup[] = [];
  return {
    register: (group) => {
      const validation = validateInstructionGroup(group);
      if (!validation.registered) return validation;
      const existing = groups.findIndex((candidate) => candidate.name === group.name);
      if (existing >= 0) {
        groups[existing] = group;
        return { registered: true };
      }
      groups.push(group);
      return { registered: true };
    },
    isManaged: () => true,
    groups: () => [...groups],
    isEmpty: () => groups.length === 0,
  };
}

/** A group is active when at least one of its tools is in the allowlist (exact match). */
function isGroupActive(group: InstructionGroup, selectedTools: readonly string[]): boolean {
  if (!Array.isArray(group.tools)) return false;
  return group.tools.some((tool) => selectedTools.includes(tool));
}

/** Filter to the groups whose tools overlap the session allowlist. */
export function selectActiveGroups(
  groups: readonly InstructionGroup[],
  selectedTools: readonly string[],
): InstructionGroup[] {
  return groups.filter((group) => isGroupActive(group, selectedTools));
}

export interface ApplyInstructionGroupSectionsInput {
  sections: Record<string, string>;
  groups: readonly InstructionGroup[];
  selectedTools: readonly string[];
  ctx: unknown;
  /** Failure channel for a malformed group; omit to stay silent. */
  warn?: (message: string) => void;
}

/**
 * Apply managed groups to a session's mutable prompt sections.
 *
 * Active groups get their section written under their group name; inactive
 * groups get any stale section of the same name deleted. The whole per-group
 * body (including the active check) runs inside the try because a malformed
 * foreign group must not be able to leave the legacy key deleted and the
 * managed section unwritten in the same turn.
 */
export function applyInstructionGroupSections(input: ApplyInstructionGroupSectionsInput): {
  applied: string[];
} {
  const { sections, groups, selectedTools, ctx, warn } = input;
  const applied: string[] = [];

  // Any group at all means the collector owns prompt sections this turn, so
  // the unmanaged fallback's legacy key must not survive alongside them.
  if (groups.length > 0) {
    for (const key of LEGACY_SUPERSEDED_SECTION_KEYS) {
      delete sections[key];
    }
  }

  for (const group of groups) {
    try {
      if (!isGroupActive(group, selectedTools)) {
        delete sections[group.name];
        continue;
      }
      sections[group.name] = group.instructions(ctx);
      applied.push(group.name);
    } catch (error) {
      delete sections[group.name];
      // Warn with the group name so a "browser instructions vanished"
      // diagnosis does not require bisecting the prompt sections.
      if (warn !== undefined) {
        warn(`instruction group "${group.name}" failed: ${String(error)}`);
      }
    }
  }

  return { applied };
}

export interface ManageInstructionGroupsInput {
  collector: InstructionGroupCollector;
  emitInstructionGroups: (collector: InstructionGroupCollector) => void;
  systemPromptOptions: unknown;
  ctx: unknown;
  /** Failure channel for the gate; omit to stay silent. */
  warn?: (message: string) => void;
}

export type ManageInstructionGroupsFailureReason =
  | "no-system-prompt-options"
  | "no-sections"
  | "no-selected-tools"
  | "no-groups";

export type ManageInstructionGroupsResult =
  | { managed: true; applied: string[] }
  | { managed: false; reason: ManageInstructionGroupsFailureReason };

/** Warning emitted when the channel was emitted but nothing registered a group. */
export const NO_GROUP_REGISTERED_WARNING =
  "instruction-group channel emitted but no group registered";

interface SystemPromptOptionsView {
  sections: Record<string, string>;
  selectedTools: string[];
}

/**
 * Narrow the runtime `systemPromptOptions` we get from pi.
 *
 * The guards come *before* any `emitInstructionGroups` call because the real
 * foreign listener permanently flips `isManaged` to `true` inside the emit. If
 * we emitted and then bailed on a missing allowlist, the fallback would be
 * disabled for the session with no section ever written and no chance to
 * self-heal (the collector is non-empty, so the emit never retries).
 */
function readSystemPromptOptions(
  value: unknown,
):
  | { ok: true; value: SystemPromptOptionsView }
  | { ok: false; reason: "no-system-prompt-options" | "no-sections" | "no-selected-tools" } {
  if (typeof value !== "object" || value === null) {
    return { ok: false, reason: "no-system-prompt-options" };
  }
  const record = value as { sections?: unknown; selectedTools?: unknown };
  const sections = record.sections;
  if (typeof sections !== "object" || sections === null || Array.isArray(sections)) {
    return { ok: false, reason: "no-sections" };
  }
  const selectedTools = record.selectedTools;
  if (
    !Array.isArray(selectedTools) ||
    selectedTools.length === 0 ||
    !selectedTools.every((tool): tool is string => typeof tool === "string")
  ) {
    return { ok: false, reason: "no-selected-tools" };
  }
  return {
    ok: true,
    value: { sections: sections as Record<string, string>, selectedTools },
  };
}

/**
 * Emit the instruction-groups channel (once, lazily) and apply the groups it
 * registers to the session's prompt sections.
 *
 * Bails before emitting when the session's allowlist is unknown or empty, and
 * leaves existing sections untouched when no extension registered a group, so
 * the unmanaged fallback keeps working in both cases.
 */
export function manageInstructionGroups(
  input: ManageInstructionGroupsInput,
): ManageInstructionGroupsResult {
  const options = readSystemPromptOptions(input.systemPromptOptions);
  if (!options.ok) return { managed: false, reason: options.reason };

  let emitted = false;
  if (input.collector.isEmpty()) {
    input.emitInstructionGroups(input.collector);
    emitted = true;
  }

  const groups = input.collector.groups();
  if (groups.length === 0) {
    // The foreign listener flips its managed flag the moment it receives the
    // collector, even when its own register call is rejected or absent, so a
    // silent no-groups outcome can disable the fallback permanently. Surface it.
    if (emitted && input.warn !== undefined) {
      input.warn(NO_GROUP_REGISTERED_WARNING);
    }
    return { managed: false, reason: "no-groups" };
  }

  const { applied } = applyInstructionGroupSections({
    sections: options.value.sections,
    groups,
    selectedTools: options.value.selectedTools,
    ctx: input.ctx,
    warn: input.warn,
  });

  return { managed: true, applied };
}

/**
 * Log line for a skipped gate, or `undefined` when nothing should be logged.
 *
 * `no-groups` is already warned inside `manageInstructionGroups` (only it knows
 * whether the emit path was taken), so the call site must not repeat it. The
 * remaining reasons mean the session's prompt options drifted from what the
 * harness expects — the C1 trigger — and must not disappear into the unmanaged
 * fallback silently.
 */
export function manageInstructionGroupsWarning(
  result: ManageInstructionGroupsResult,
): string | undefined {
  if (result.managed) return undefined;
  if (result.reason === "no-groups") return undefined;
  return `instruction-group gate skipped: ${result.reason}`;
}
