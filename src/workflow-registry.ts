/**
 * Workflow sub-type registry — defines 7 workflow types with phase sequences,
 * agent overrides, quality gates, and proof requirements.
 *
 * Each workflow type has its own phase order, which is used by the process gate
 * to enforce the correct sequence for that type of work.
 */

import type { QualityGate } from "./agent-registry.js";
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
        tools?: string[];
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
}

/**
 * Registry of all workflow sub-types.
 */
export const WORKFLOW_REGISTRY: Record<WorkflowSubType, WorkflowSubTypeConfig> = {
  feature: {
    name: "feature",
    phases: ["scout", "plan", "implement", "review", "test", "userguide", "proof", "commit"],
    proofRequired: true,
  },

  bugfix: {
    name: "bugfix",
    phases: ["scout", "plan", "implement", "review", "test", "proof", "commit"],
    proofRequired: true,
    optionalPhases: ["scout"],
  },

  research: {
    name: "research",
    phases: ["scout", "plan", "proof", "commit"],
    proofRequired: true,
    agentOverrides: {
      plan: {
        model: "opencode-go/glm-5.3",
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
    phases: ["scout", "plan", "implement", "proof", "commit"],
    proofRequired: true,
    agentOverrides: {
      implement: {
        model: "opencode-go/deepseek-v4-flash",
      },
    },
  },

  refactor: {
    name: "refactor",
    phases: ["scout", "plan", "implement", "review", "test", "proof", "commit"],
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

/** Labels that map to workflow types when no exact match is found. */
const LABEL_TO_TYPE: Record<string, WorkflowSubType> = {
  bug: "bugfix",
  investigation: "research",
};

/** Title/description keyword patterns → workflow type. Checked in order. */
const TITLE_PATTERNS: Array<{ pattern: RegExp; type: WorkflowSubType }> = [
  { pattern: /\b(urgent|hotfix|critical|production|incident)\b/i, type: "hotfix" },
  { pattern: /\b(fix|bug|bugfix|broken|crash|regression)\b/i, type: "bugfix" },
  { pattern: /\b(refactor|cleanup|rename|restructure|reorgani[sz]e)\b/i, type: "refactor" },
  { pattern: /\b(docs?|documentation|readme|changelog)\b/i, type: "documentation" },
  {
    pattern: /\b(research|investigate|explore|spike|feasibility|prototype|poc)\b/i,
    type: "research",
  },
  {
    pattern:
      /\b(chore|tooling|config|ci|deps?|dependencies|upgrade|update|bump|maintenance|setup|provision)\b/i,
    type: "chore",
  },
];

/**
 * Resolve the workflow type from CLI argument, task labels, and title/description.
 * Priority: CLI arg > label > label mapping > title keywords > "feature".
 */
export function resolveWorkflowType(
  typeArg?: string,
  labels?: string[],
  title?: string,
): WorkflowSubType {
  if (typeArg && isValidWorkflowType(typeArg)) return typeArg;

  return resolveFromLabels(labels) ?? resolveFromTitle(title) ?? "feature";
}

/** Resolve the workflow type from a task's labels, if any match. */
function resolveFromLabels(labels?: string[]): WorkflowSubType | undefined {
  if (!labels) return undefined;
  for (const label of labels) {
    if (isValidWorkflowType(label)) return label;
    const mapped = LABEL_TO_TYPE[label];
    if (mapped) return mapped;
  }
  return undefined;
}

/** Resolve the workflow type from a task's title keywords, if any match. */
function resolveFromTitle(title?: string): WorkflowSubType | undefined {
  if (!title) return undefined;
  for (const { pattern, type: resolvedType } of TITLE_PATTERNS) {
    if (pattern.test(title)) return resolvedType;
  }
  return undefined;
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
