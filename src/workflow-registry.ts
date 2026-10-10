/**
 * Workflow sub-type registry — defines 7 workflow types with phase sequences,
 * agent overrides, quality gates, and proof requirements.
 *
 * Each workflow type has its own phase order, which is used by the process gate
 * to enforce the correct sequence for that type of work.
 */

import type { QualityGate } from "./agent-registry.js";
import { RESEARCHER_SYSTEM_PROMPT, RESEARCHER_TOOLS } from "./agent-registry.js";
import type { ModelClass } from "./model-classes.js";
import type { Phase } from "./process-gate.js";
import { gateFullValidation } from "./quality-gates.js";

/**
 * Workflow sub-type names.
 */
export type WorkflowSubType =
  | "feature"
  | "bugfix"
  | "research"
  | "chore"
  | "documentation"
  | "refactor"
  | "hotfix";

/**
 * Configuration for a single workflow sub-type.
 */
export interface WorkflowSubTypeConfig {
  /** Canonical name. */
  name: WorkflowSubType;

  /** Ordered list of phases for this workflow type. Subset of PHASE_ORDER, in order. */
  phases: Phase[];

  /**
   * Agent overrides: override the default agent model, tools, or quality gate
   * for specific phases.
   */
  agentOverrides?: Partial<
    Record<
      Phase,
      {
        model?: string;
        modelClass?: ModelClass;
        tools?: string[];
        systemPrompt?: string;
        qualityGate?: QualityGate;
      }
    >
  >;

  /**
   * Gate overrides: override the quality gate for specific phases.
   * Higher priority than agentOverrides.qualityGate.
   */
  gateOverrides?: Partial<Record<Phase, QualityGate>>;

  /** Whether proof artifacts are required for this workflow type. */
  proofRequired: boolean;

  /**
   * Phases that are optionally included — they may be skipped
   * without blocking subsequent phases.
   */
  optionalPhases?: Phase[];

  /**
   * Phases whose tools stay callable during the workflow but are not required
   * steps. They are not part of `phases`, so they do not gate progress or
   * advance completion — they are consultation-only.
   */
  consultPhases?: Phase[];
}

/**
 * Registry of all workflow sub-types.
 */
export const WORKFLOW_REGISTRY: Record<WorkflowSubType, WorkflowSubTypeConfig> = {
  feature: {
    name: "feature",
    phases: ["implement", "review", "test", "userguide", "proof", "commit"],
    consultPhases: ["scout", "plan"],
    proofRequired: true,
  },

  bugfix: {
    name: "bugfix",
    phases: ["implement", "review", "test", "proof", "commit"],
    consultPhases: ["scout", "plan"],
    proofRequired: true,
  },

  research: {
    name: "research",
    // Research is investigation only — no implementation, no proof artifacts.
    phases: ["scout", "plan", "commit"],
    proofRequired: false,
    agentOverrides: {
      plan: {
        model: "opencode-go/glm-5.3",
        tools: RESEARCHER_TOOLS,
        systemPrompt: RESEARCHER_SYSTEM_PROMPT,
      },
    },
  },

  chore: {
    name: "chore",
    phases: ["plan", "implement", "test", "commit"],
    proofRequired: false,
    agentOverrides: {
      implement: {
        qualityGate: gateFullValidation,
      },
    },
  },

  documentation: {
    name: "documentation",
    phases: ["implement", "proof", "commit"],
    consultPhases: ["scout", "plan"],
    proofRequired: true,
    agentOverrides: {
      implement: {
        model: "opencode-go/deepseek-v4-flash",
      },
    },
  },

  refactor: {
    name: "refactor",
    phases: ["implement", "review", "test", "proof", "commit"],
    consultPhases: ["scout", "plan"],
    proofRequired: true,
  },

  hotfix: {
    name: "hotfix",
    phases: ["implement", "review", "test", "proof", "commit"],
    proofRequired: true,
    agentOverrides: {
      implement: {
        model: "opencode-go/deepseek-v4-flash",
      },
    },
  },
};

/**
 * All valid workflow sub-type names.
 */
export const WORKFLOW_SUB_TYPES: WorkflowSubType[] = Object.keys(
  WORKFLOW_REGISTRY,
) as WorkflowSubType[];

/**
 * Check if a string is a valid workflow sub-type.
 */
export function isValidWorkflowType(type: string): type is WorkflowSubType {
  return type in WORKFLOW_REGISTRY;
}

/**
 * Get the phases for a workflow type. Falls back to feature.
 */
export function getPhasesForType(type?: WorkflowSubType): Phase[] {
  if (type && isValidWorkflowType(type)) {
    return [...WORKFLOW_REGISTRY[type].phases];
  }
  return [...WORKFLOW_REGISTRY.feature.phases];
}

/** Namespace prefix for machine-readable workflow-type labels. */
export const WF_LABEL_PREFIX = "wf:";

/**
 * How a workflow type was chosen. Recorded for provenance so a run can be
 * audited: `arg` is an explicit CLI/tool argument, `label` is a namespaced
 * `wf:<type>` bead label (which needs user confirmation), and `default` is the
 * feature fallback when no explicit signal exists.
 */
export type WorkflowResolutionSource = "arg" | "label" | "default";

/** Structured workflow-type resolution with provenance. */
export interface WorkflowResolution {
  type: WorkflowSubType;
  source: WorkflowResolutionSource;
  matchedLabel?: string;
  requiresConfirmation: boolean;
}

/**
 * Parse the first valid `wf:<type>` label. The prefix is lowercase and the
 * suffix must be an exact workflow type; invalid suffixes are ignored rather
 * than treated as an error so an unrelated `wf:` label cannot hijack the choice.
 */
export function parseWorkflowLabel(
  labels?: string[],
): { type: WorkflowSubType; label: string } | undefined {
  if (!labels) return undefined;
  for (const label of labels) {
    if (!label.startsWith(WF_LABEL_PREFIX)) continue;
    const candidate = label.slice(WF_LABEL_PREFIX.length);
    if (isValidWorkflowType(candidate)) return { type: candidate, label };
  }
  return undefined;
}

/**
 * Resolve the workflow type from an explicit argument or a namespaced
 * `wf:<type>` label. Precedence: valid arg > `wf:` label > feature. Title
 * heuristics and plain type labels are intentionally ignored — a single
 * keyword or legacy label must never silently demote a task below feature.
 */
export function resolveWorkflowSelection(typeArg?: string, labels?: string[]): WorkflowResolution {
  if (typeArg && isValidWorkflowType(typeArg)) {
    return { type: typeArg, source: "arg", requiresConfirmation: false };
  }

  const fromLabel = parseWorkflowLabel(labels);
  if (fromLabel) {
    return {
      type: fromLabel.type,
      source: "label",
      matchedLabel: fromLabel.label,
      requiresConfirmation: true,
    };
  }

  return { type: "feature", source: "default", requiresConfirmation: false };
}

/** Thin wrapper over resolveWorkflowSelection for callers that only need the type. */
export function resolveWorkflowType(typeArg?: string, labels?: string[]): WorkflowSubType {
  return resolveWorkflowSelection(typeArg, labels).type;
}

/**
 * Resolve the quality gate for a phase, merging agent default
 * with workflow config overrides.
 */
export function resolveQualityGate(
  phase: Phase,
  workflowType: WorkflowSubType,
  agentGate?: QualityGate,
): QualityGate | undefined {
  const config = WORKFLOW_REGISTRY[workflowType];
  // Gate overrides have highest priority
  if (config.gateOverrides?.[phase]) return config.gateOverrides[phase];
  // Then agent overrides
  if (config.agentOverrides?.[phase]?.qualityGate) {
    return config.agentOverrides[phase].qualityGate;
  }
  // Then default agent gate
  return agentGate;
}
