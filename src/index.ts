/**
 * @belayd/agent-harness — Multi-agent harness for Belayd.
 *
 * Agents defined as TypeScript objects in a registry, exposed as pi tools,
 * and spawned as isolated pi --mode json --no-session processes.
 */

export type {
  AgentDefinition,
  GateResult,
  QualityGate,
  SpawnDetails,
  SpawnOptions,
  SpawnResult,
  SpawnUsage,
} from "./agent-registry.js";
export {
  DEFAULT_AGENTS,
  getAgent,
  getAgentByShortName,
  getPhaseToolName,
} from "./agent-registry.js";
export type { ModelClass } from "./model-classes.js";
// Model classes & quota-fallback routing
export {
  bareModelId,
  candidatesForModel,
  MODEL_CLASS_SPECS,
  MODEL_TO_CLASS,
  modelClassOf,
  PROVIDER_PREFERENCE,
  resolveModelCandidates,
} from "./model-classes.js";
export type { CooldownEntry, ModelCooldownStore } from "./model-cooldown.js";
export { createModelCooldownStore } from "./model-cooldown.js";
export type { Phase } from "./process-gate.js";
export {
  ALL_PHASE_NAMES,
  ALL_PHASE_TOOLS,
  checkToolAllowed,
  formatProcessState,
  getNextPhase,
  isWorkflowComplete,
  markPhaseCompleted,
  PHASE_INDEX,
  PHASE_ORDER,
  PHASE_TOOLS,
} from "./process-gate.js";
export type { GateOptions } from "./quality-gates.js";
export {
  gateFullValidation,
  gateLint,
  gateTests,
  gateTypecheck,
  gateUserGuide,
} from "./quality-gates.js";
export type { FailureClassification, FailureKind } from "./quota-failure.js";
export {
  classifySpawnFailure,
  DEFAULT_QUOTA_COOLDOWN_SECONDS,
  DEFAULT_TRANSIENT_COOLDOWN_SECONDS,
  parseQuotaResetSeconds,
} from "./quota-failure.js";
export {
  computeOrchestratorSessionName,
  computeSubagentSessionName,
  generateShortRunId,
} from "./session-naming.js";
export { spawnAgentProcess } from "./spawn.js";
export type {
  SpawnAttempt,
  SpawnWithFallbackOptions,
  SpawnWithFallbackResult,
} from "./spawn-with-fallback.js";
export { spawnAgentWithFallback } from "./spawn-with-fallback.js";
export {
  checkEdit,
  clearHashes,
  getTrackedFileCount,
  recordRead,
  reset,
} from "./stale-file-guard.js";
// Workflow registry
export type { WorkflowSubType, WorkflowSubTypeConfig } from "./workflow-registry.js";
export {
  getPhasesForType,
  isValidWorkflowType,
  resolveQualityGate,
  resolveWorkflowType,
  WORKFLOW_REGISTRY,
  WORKFLOW_SUB_TYPES,
} from "./workflow-registry.js";
export type { WorktreeOptions } from "./worktree.js";
export { isInsideWorktreeForBranch, resolveWorktreePath, setupWorktree } from "./worktree.js";
