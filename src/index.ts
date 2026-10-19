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
export type {
  ArchifyArtifact,
  ArchifyCommand,
  ArchifyDiagnostic,
  ArchifyDiagramType,
  ArchifyExamplesResult,
  ArchifyGuidanceCommand,
  ArchifyHomeResult,
  ArchifyParamName,
  ArchifyParamSupply,
  ArchifyQuality,
  ArchifyReceipt,
  ArchifyReceiptParse,
  ArchifyRunResult,
  ArchifySpecification,
  ArchifyTextResult,
  ArchifyToolCommand,
  ArchifyValidation,
  BuildArchifyArgsOptions,
  BuildArchifyGuideArgsOptions,
  BuildArchifyInspectArgsOptions,
  RunArchifyOptions,
} from "./archify.js";
export {
  ARCHIFY_COMMANDS,
  ARCHIFY_DIAGRAM_TYPES,
  ARCHIFY_GUIDANCE_COMMANDS,
  ARCHIFY_QUALITY_PROFILES,
  ARCHIFY_TOOL_COMMANDS,
  buildArchifyArgs,
  buildArchifyCheckArgs,
  buildArchifyGuideArgs,
  buildArchifyInspectArgs,
  formatArchifyIgnoredParamsNote,
  formatArchifyResult,
  ignoredArchifyParams,
  isArchifyCommand,
  isArchifyDiagramType,
  isArchifyQuality,
  isArchifyToolCommand,
  listArchifyExamples,
  parseArchifyReceipt,
  resolveArchifyHome,
  runArchify,
  runArchifyText,
} from "./archify.js";
export type { ArgvParse } from "./argv.js";
export { parseArgv } from "./argv.js";
export {
  BASH_DEFAULT_TIMEOUT_SECONDS,
  BASH_MAX_TIMEOUT_SECONDS,
  resolveBashTimeout,
} from "./bash-timeout.js";
export type { BdCommandParse, BdCommandValidation } from "./bd-command.js";
export {
  BD_ALLOWED_SUBCOMMANDS,
  bdCommandReadsStdin,
  parseBdCommand,
  validateBdCommand,
} from "./bd-command.js";
export type { BelaydCommandArgs, BelaydCommandArgsParse } from "./belayd-command-args.js";
export { parseBelaydCommandArgs } from "./belayd-command-args.js";
export type {
  CapacityCache,
  CapacityCacheOptions,
  CapacityProbe,
  CapacityProbeResult,
  CapacityWindow,
  EndpointCapacityProbeOptions,
} from "./capacity-cache.js";
export {
  CAPACITY_PROBE_URL_ENV,
  createCapacityCache,
  createEndpointCapacityProbe,
  createFallbackCapacityProbe,
  DEFAULT_CAPACITY_BODY_LIMIT_BYTES,
  DEFAULT_CAPACITY_PROBE_TIMEOUT_MS,
  DEFAULT_CAPACITY_TTL_MS,
  MAX_CAPACITY_WINDOWS,
  orderCandidatesByCapacity,
  parseCapacityWindows,
  probeFromCooldownStore,
} from "./capacity-cache.js";
export type { CastEvent, CastHeader, ParsedCast } from "./cast-utils.js";
export { castToText, cleanTerminalOutput, parseCast, readCastToText } from "./cast-utils.js";
export type { ChdirTargetInput, ChdirTargetResult } from "./chdir-guard.js";
export { isSafeChdirTarget } from "./chdir-guard.js";
// Handoff packets carried into a spawned orchestrator
export type {
  BuildHandoffInput,
  CollectHandoffDefaultInput,
  HandoffDefaultDeps,
  HandoffPacket,
  OrchestratorPromptInput,
} from "./handoff.js";
export {
  buildHandoff,
  buildOrchestratorPrompt,
  clearHandoff,
  collectHandoffDefault,
  formatHandoffBlock,
  HANDOFF_ARG_FILE_MAX_BYTES,
  HANDOFF_DIRTY_FILES_MAX,
  HANDOFF_FIELD_MAX_CHARS,
  HANDOFF_FILE_NAME,
  HANDOFF_IDENTITY_FIELD_MAX_CHARS,
  HANDOFF_SCHEMA_VERSION,
  HANDOFF_TOTAL_MAX_CHARS,
  handoffFilePath,
  parseHandoff,
  readHandoff,
  readHandoffFileArg,
  taskIdFromBranch,
  writeHandoff,
} from "./handoff.js";
export * from "./honcho-memory/index.js";
export type {
  ApplyInstructionGroupSectionsInput,
  InstructionGroup,
  InstructionGroupCollector,
  ManageInstructionGroupsFailureReason,
  ManageInstructionGroupsInput,
  ManageInstructionGroupsResult,
  RegisterInstructionGroupResult,
} from "./instruction-groups.js";
export {
  applyInstructionGroupSections,
  createInstructionGroupCollector,
  INSTRUCTION_GROUPS_CHANNEL,
  LEGACY_SUPERSEDED_SECTION_KEYS,
  manageInstructionGroups,
  manageInstructionGroupsWarning,
  NO_GROUP_REGISTERED_WARNING,
  selectActiveGroups,
} from "./instruction-groups.js";
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
  canonicalModelId,
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
export type {
  CreateModelSessionStateOptions,
  FlushAndResetModelTelemetryOptions,
  FlushModelTelemetryOptions,
  FlushModelTelemetryResult,
  ModelSessionState,
  ModelTelemetryAppendFn,
} from "./model-session-state.js";
export {
  createModelSessionState,
  flushAndResetModelTelemetry,
  flushModelTelemetry,
  resetModelSessionState,
} from "./model-session-state.js";
export type {
  AppendModelTelemetryOptions,
  AppendModelTelemetryResult,
  ModelPhaseEvent,
  ModelPhaseStats,
  ModelTelemetrySnapshot,
  ModelTelemetryStore,
  ModelTelemetryTotals,
} from "./model-telemetry.js";
export {
  appendModelTelemetry,
  combineModelTelemetryStores,
  createModelTelemetryStore,
  diffModelTelemetryStats,
  formatModelTelemetrySummary,
  ModelTelemetryTotalsSchema,
  mergeModelTelemetry,
  modelTelemetryPath,
  readModelTelemetry,
  sumModelTelemetryStats,
  writeModelTelemetry,
} from "./model-telemetry.js";
export type {
  OutlineAppliedFilters,
  OutlineFile,
  OutlineFileSymbols,
  OutlineFilesOptions,
  OutlineKind,
  OutlineLanguage,
  OutlineResult,
  OutlineSymbol,
  OutlineSymbolGroup,
  OutlineTargetResolution,
  OutlineTruncationCause,
  ResolveOutlineTargetsOptions,
} from "./outline.js";
export {
  formatOutline,
  isOutlineKind,
  isOutlineSupportedFile,
  mergeOutlineSymbols,
  OUTLINE_FILE_EXTENSIONS,
  OUTLINE_KINDS,
  OUTLINE_LANGUAGES,
  OUTLINE_MAX_FILES,
  OUTLINE_MAX_OUTPUT_BYTES,
  OUTLINE_MAX_WALK_ENTRIES,
  OUTLINE_TS_EXTENSIONS,
  outlineAstGrepLanguage,
  outlineFiles,
  resolveOutlineTargets,
} from "./outline.js";
export {
  buildAstGrepArgs,
  buildAstGrepRule,
  OUTLINE_AST_GREP_DEFAULT,
  OUTLINE_AST_GREP_ENV,
  parseAstGrepJson,
  runAstGrep,
} from "./outline-ast-grep.js";
export type {
  OutlineBinaryResolution,
  OutlineBinarySpec,
  OutlineSpawnOptions,
  OutlineSpawnOutcome,
} from "./outline-binary.js";
export {
  findExecutableOnPath,
  formatSpawnFailure,
  resolveOutlineBinary,
  spawnOutlineBinary,
} from "./outline-binary.js";
export {
  buildCtagsArgs,
  mapCtagsKind,
  OUTLINE_CTAGS_DEFAULT,
  OUTLINE_CTAGS_ENV,
  OUTLINE_CTAGS_MAP_OVERRIDES,
  parseCtagsJson,
  runCtags,
} from "./outline-ctags.js";
export type {
  OutlineExtractionOptions,
  OutlineExtractionResult,
} from "./outline-extract.js";
export { extractOutlineSymbols } from "./outline-extract.js";
export type {
  AssertOwnedWorktreeOptions,
  MatchOwnedWorktreeOptions,
  OwnedWorktreeResult,
  ReadWorkflowStateAtCwd,
  SessionOwnedWorktreeOptions,
  WorktreeBranch,
} from "./owned-worktree.js";
export {
  assertOwnedWorktree,
  formatWorktreePreamble,
  isSameOrDescendantTask,
  matchOwnedWorktree,
  matchSessionOwnedWorktree,
  readWorktreeBranch,
} from "./owned-worktree.js";
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
  EnumerateProofDirOptions,
  ExtractedProofArtifact,
  ProofRefScan,
  ResolvedProofRef,
  VerifierInputs,
} from "./proof-verification.js";
export {
  acceptedProofRefsFromScan,
  buildVerifierPrompt,
  checkPathTraversal,
  checkProofArtifactsExist,
  checkProofDirTraversal,
  collectChangeContext,
  enumerateProofDirArtifacts,
  extractHowToVerify,
  extractProofArtifacts,
  findOutsideProofDirRefs,
  findProofArtifactRefs,
  findTraversalProofRefs,
  findWorkspaceRoot,
  hasExtensionIgnoreCase,
  isProofArtifactPath,
  PROOF_ARTIFACT_EXTENSIONS,
  resolveProofArtifactPath,
  resolveProofRefInDir,
  scanProofRefs,
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
  CollectReviewDiffOptions,
  CollectReviewDiffResult,
  DiffScope,
  FormatReviewTaskOptions,
  ReviewDiff,
  ReviewSeverity,
} from "./review-context.js";
export {
  boundReviewOutput,
  classifyDiffScope,
  collectReviewDiff,
  formatReviewTask,
  REVIEW_OUTPUT_CONTRACT,
  REVIEW_SCOPE_INSTRUCTION,
  REVIEW_SECTION_LIMITS,
} from "./review-context.js";
export type {
  DetachedRunOptions,
  RunDelivery,
  RunHandle,
  RunOutcome,
  WatchRunDeps,
} from "./run-detached.js";
export { classifyRunOutcome, spawnDetachedRun, watchRunCompletion } from "./run-detached.js";
export type { RunManifest, RunTelemetryTotals } from "./run-manifest.js";
export {
  completeRunByUser,
  listPendingUserCompletions,
  listRuns,
  markRunDelivered,
  RunStatus,
  readRunManifest,
  runManifestPath,
  runsDir,
  scanForInterruptedRuns,
  setRunStatus,
  setRunTelemetry,
  writeRunManifest,
} from "./run-manifest.js";
export type { PhaseSessionRecord, SubagentSessionRef } from "./session-naming.js";
export {
  computeOrchestratorSessionName,
  computePlanningSubagentSessionName,
  computeSubagentSessionName,
  gateRetrySession,
  generateShortRunId,
  IN_SESSION_RETRY_LIMIT,
  isValidTaskId,
  parseSubagentSessionName,
  resolvePhaseInvocation,
  resolveProjectSessionExists,
} from "./session-naming.js";
export type { TranscriptEntry } from "./session-transcript.js";
export { lastAssistantText, narrowTranscriptEntries } from "./session-transcript.js";
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
export type {
  GitExec,
  StackNode,
  StackRebaseResult,
  StackRebaseSkip,
  StackRebaseStep,
} from "./stack-rebase.js";
export {
  AUTO_REBASE_CONFIG_KEY,
  AUTO_REBASE_ENV_KEY,
  branchExists,
  currentBranch,
  DEFAULT_BASE_BRANCH,
  defaultGitExec,
  planStackRebase,
  readStackNode,
  resolveAutoRebaseEnabled,
  resolveStackChain,
  runStackRebase,
  writeStackBase,
} from "./stack-rebase.js";
export {
  checkEdit,
  clearHashes,
  getTrackedFileCount,
  recordRead,
  reset,
} from "./stale-file-guard.js";
// Workflow registry
export type {
  WorkflowResolution,
  WorkflowResolutionSource,
  WorkflowSubType,
  WorkflowSubTypeConfig,
} from "./workflow-registry.js";
export {
  getPhasesForType,
  isValidWorkflowType,
  parseWorkflowLabel,
  resolveQualityGate,
  resolveWorkflowSelection,
  resolveWorkflowType,
  WF_LABEL_PREFIX,
  WORKFLOW_REGISTRY,
  WORKFLOW_SUB_TYPES,
} from "./workflow-registry.js";
export type {
  SavePhaseSessionOptions,
  SaveReviewedShaOptions,
  SaveReviewedShaResult,
  WorkflowFs,
  WorkflowState,
} from "./workflow-state.js";
export {
  clearWorkflowState,
  readWorkflowState,
  saveCompletedPhases,
  savePhaseSession,
  saveReviewedSha,
  workflowStateDir,
  workflowStateFilePath,
  writeWorkflowState,
} from "./workflow-state.js";
export type { RepoKeyExec, RepoKeyResult, WorktreeDeps, WorktreeOptions } from "./worktree.js";
export {
  awaitWorktreeReady,
  isInsideWorktreeForBranch,
  projectKeyFromRepoRoot,
  resolveRepoKey,
  resolveWorktreePath,
  setupWorktree,
} from "./worktree.js";
