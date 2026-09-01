/**
 * @belayd/agent-harness — Multi-agent harness for Belayd.
 *
 * Agents defined as TypeScript objects in a registry, exposed as pi tools,
 * and spawned as isolated pi --mode json --no-session processes.
 */

export type {
  AgentDefinition,
  GateOptions,
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
  RESEARCHER_SYSTEM_PROMPT,
  RESEARCHER_TOOLS,
} from "./agent-registry.js";
export type { BdCommandValidation } from "./bd-command.js";
export { BD_ALLOWED_SUBCOMMANDS, validateBdCommand } from "./bd-command.js";
export type { ModelClass } from "./model-classes.js";
// Model classes & quota-fallback routing
export {
  bareModelId,
  candidatesForModel,
  MODEL_CLASS_SPECS,
  MODEL_TO_CLASS,
  modelClassOf,
  PROVIDER_PREFERENCE,
  providerOf,
  resolveModelCandidates,
} from "./model-classes.js";
export type {
  CooldownEntry,
  CooldownFs,
  CooldownScope,
  ModelCooldownStore,
  ModelCooldownStoreOptions,
} from "./model-cooldown.js";
export { createModelCooldownStore, defaultModelCooldownPath } from "./model-cooldown.js";
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
export * from "./proof-dir.js";
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
export type {
  DetachedRunOptions,
  RunDelivery,
  RunHandle,
  WatchRunDeps,
} from "./run-detached.js";
export { spawnDetachedRun, watchRunCompletion } from "./run-detached.js";
export type { RunManifest } from "./run-manifest.js";
export {
  listRuns,
  RunStatus,
  readRunManifest,
  runManifestPath,
  runsDir,
  scanForInterruptedRuns,
  setRunStatus,
  writeRunManifest,
} from "./run-manifest.js";
export {
  computeOrchestratorSessionName,
  computeSubagentSessionName,
  generateShortRunId,
  isValidTaskId,
} from "./session-naming.js";
export type { AgentProcessHandle, BuiltSpawnArgs, SpawnStream } from "./spawn.js";
export {
  buildSpawnArgs,
  collectSpawnResult,
  launchAgentProcess,
  spawnAgentProcess,
} from "./spawn.js";
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
export type { WorkflowFs, WorkflowState } from "./workflow-state.js";
export {
  clearWorkflowState,
  readWorkflowState,
  saveCompletedPhases,
  workflowStateDir,
  workflowStateFilePath,
  writeWorkflowState,
} from "./workflow-state.js";
export type { WorktreeOptions } from "./worktree.js";
export {
  awaitWorktreeReady,
  isInsideWorktreeForBranch,
  resolveWorktreePath,
  setupWorktree,
} from "./worktree.js";
