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
  PLANNING_MODE_SYSTEM_PROMPT,
  PLANNING_MODE_TOOLS,
  PROOF_VERIFIER_AGENT,
  PROOF_VERIFIER_SYSTEM_PROMPT,
  PROOF_VERIFIER_TOOLS,
  RESEARCHER_SYSTEM_PROMPT,
  RESEARCHER_TOOLS,
} from "./agent-registry.js";
export type { BdCommandParse, BdCommandValidation } from "./bd-command.js";
export {
  BD_ALLOWED_SUBCOMMANDS,
  bdCommandReadsStdin,
  parseBdCommand,
  validateBdCommand,
} from "./bd-command.js";
export type { CastEvent, CastHeader, ParsedCast } from "./cast-utils.js";
export { castToText, cleanTerminalOutput, parseCast, readCastToText } from "./cast-utils.js";
export * from "./honcho-memory/index.js";
export type {
  GatewayModelEntry,
  LlmGatewayApiResponse,
  LlmGatewayModel,
  LlmGatewayPricing,
  ModelCompat,
  ModelCost,
  ModelsJsonDoc,
  ThinkingLevelMap,
} from "./llmgateway-models.js";
export {
  buildLlmGatewayModelsDoc,
  diffModelsDoc,
  isLlmGatewayApiResponse,
  mapLlmGatewayModels,
  parseLlmGatewayApiKeyFromAuthJson,
  serializeModelsJsonDoc,
} from "./llmgateway-models.js";
export type { AgentModelSpec, ModelClass } from "./model-classes.js";
// Model classes & quota-fallback routing
export {
  bareModelId,
  candidatesForModel,
  MODEL_CLASS_SPECS,
  MODEL_TO_CLASS,
  modelClassOf,
  PROVIDER_PREFERENCE,
  primaryModelOf,
  providerOf,
  resolveModelCandidates,
  resolveModelSpec,
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
export {
  ensureProofBridge,
  PROOF_DIR_MARKER_RELATIVE_PATH,
  proofDirForTask,
  resolveProjectProofBase,
  resolveProofBase,
} from "./proof-dir.js";
export type {
  ExtractedProofArtifact,
  ResolvedProofRef,
  VerifierInputs,
} from "./proof-verification.js";
export {
  buildVerifierPrompt,
  checkPathTraversal,
  checkProofArtifactsExist,
  checkProofDirTraversal,
  collectChangeContext,
  extractHowToVerify,
  extractProofArtifacts,
  findProofArtifactRefs,
  findWorkspaceRoot,
  isProofArtifactPath,
  PROOF_ARTIFACT_EXTENSIONS,
  resolveProofArtifactPath,
  resolveProofRefInDir,
} from "./proof-verification.js";
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
  computePlanningSubagentSessionName,
  computeSubagentSessionName,
  gateRetrySession,
  generateShortRunId,
  IN_SESSION_RETRY_LIMIT,
  isValidTaskId,
  resolveProjectSessionExists,
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
export type { RepoKeyExec, RepoKeyResult, WorktreeOptions } from "./worktree.js";
export {
  awaitWorktreeReady,
  isInsideWorktreeForBranch,
  projectKeyFromRepoRoot,
  resolveRepoKey,
  resolveWorktreePath,
  setupWorktree,
} from "./worktree.js";
