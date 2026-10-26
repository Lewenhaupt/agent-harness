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
export type { PhaseArtifact } from "./artifacts.js";
export {
  ARTIFACT_DIR,
  ARTIFACT_PHASES,
  artifactAbsPath,
  artifactPath,
  formatArtifactIndex,
  listPhaseArtifacts,
  MAX_ARTIFACT_CHARS,
  readPhaseArtifact,
  writePhaseArtifact,
} from "./artifacts.js";
export {
  BASH_DEFAULT_TIMEOUT_SECONDS,
  BASH_MAX_TIMEOUT_SECONDS,
  resolveBashTimeout,
} from "./bash-timeout.js";
export type { BdCommandParse, BdCommandValidation } from "./bd-command.js";
export {
  BD_ALLOWED_SUBCOMMANDS,
  BD_GATE_READ_SUBCOMMANDS,
  BD_READ_SUBCOMMANDS,
  bdCommandReadsStdin,
  buildBeadShowArgv,
  isBdReadArgv,
  isBdReadSubcommand,
  parseBdCommand,
  validateBdCommand,
} from "./bd-command.js";
export type {
  BeadComment,
  BeadCommentLookup,
  LookupBeadCommentsOptions,
  PhaseCommentAuthor,
} from "./bead-comments.js";
export {
  BEAD_READ_MAX_BUFFER_BYTES,
  BEAD_READ_TIMEOUT_MS,
  buildBeadCommentsArgv,
  COMMENT_EXCERPT_MAX_CHARS,
  commentTimeInMs,
  excerptComment,
  isHumanComment,
  lookupBeadComments,
  PHASE_COMMENT_PREFIX,
  parseBeadComments,
  phaseCommentBody,
  phaseCommentHeader,
  stripBdShowComments,
} from "./bead-comments.js";
export type {
  LookupOpenHumanGateOptions,
  OpenHumanGate,
  OpenHumanGateLookup,
} from "./bead-gates.js";
export {
  buildGateCreateArgv,
  buildGateListArgv,
  buildGateResolveArgv,
  lookupOpenHumanGate,
  parseCreatedGateId,
  parseOpenHumanGate,
} from "./bead-gates.js";
export {
  BELAYD_ACTOR_PREFIX,
  clearAssigneeArgv,
  isBelaydActor,
  orchestratorActor,
  parseAssignee,
  phaseActor,
  resolveBdActor,
  setAssigneeArgv,
  withActorArgv,
  withActorForSession,
} from "./beads-actor.js";
export type {
  BeadsAssigneeResult,
  BeadsAssigneeRunner,
  ClearAssigneeOptions,
  MirrorAssigneeOptions,
} from "./beads-assignee.js";
export { clearAssignee, isGuardMismatch, mirrorAssignee } from "./beads-assignee.js";
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
// Accepting a landed member (P5): close the bead, remove the worktree
export type {
  AcceptLandedMemberOptions,
  AcceptLandedMemberResult,
  FleetAcceptFailureReason,
  FleetAcceptRunner,
} from "./fleet-accept.js";
export { acceptLandedMember } from "./fleet-accept.js";
// Shared fleet state substrate (bd-126 P1–P4): paths, intent, audit, mailbox, queue
export type {
  BeadShowArgvBuilder,
  FleetBeadRunner,
  FleetBeadRunnerOptions,
  LookupFleetBeadsOptions,
  LookupFleetDependenciesOptions,
} from "./fleet-beads.js";
export {
  buildBeadDependencyArgv,
  FLEET_BEAD_LOOKUP_MAX_BUFFER_BYTES,
  FLEET_BEAD_LOOKUP_TIMEOUT_MS,
  lookupFleetBeads,
  lookupFleetDependencies,
} from "./fleet-beads.js";
// Supervisor heartbeat for a run-mode fleet (P5)
export type { SupervisorBeatVerdict, SupervisorHeartbeat } from "./fleet-heartbeat.js";
export {
  classifySupervisorBeat,
  FLEET_SUPERVISOR_HEARTBEAT_FILE,
  FLEET_SUPERVISOR_HEARTBEAT_SCHEMA_VERSION,
  FLEET_SUPERVISOR_HEARTBEAT_STALE_MS,
  parseSupervisorHeartbeat,
  readSupervisorHeartbeat,
  supervisorHeartbeatPath,
  writeSupervisorHeartbeat,
} from "./fleet-heartbeat.js";
export type {
  CollectFleetLaunchContextOptions,
  FleetAdvancePlan,
  FleetCommandArgs,
  FleetCommandParse,
  FleetConcurrencyResolution,
  FleetLaunchContext,
  FleetLaunchFleet,
  FleetLaunchRefusal,
  FleetLaunchRefusalReason,
  FleetLaunchValidation,
  FleetMemberLaunchOutcome,
  FleetMemberProbe,
  FleetTaskIdParse,
  FormatFleetLaunchReportInput,
  MergeFleetIntentInput,
  RunFleetLaunchOptions,
  RunFleetLaunchResult,
  ValidateFleetLaunchInput,
} from "./fleet-launch.js";
export {
  collectFleetLaunchContext,
  countActiveFleetOrchestrators,
  FLEET_MAX_CONCURRENT_ORCHESTRATORS,
  fleetUsageText,
  formatFleetLaunchRefusals,
  formatFleetLaunchReport,
  mergeFleetIntent,
  parseFleetCommandArgs,
  parseFleetTaskIds,
  planFleetAdvance,
  resolveFleetConcurrency,
  runFleetLaunch,
  validateFleetLaunch,
} from "./fleet-launch.js";
export type {
  BuildFleetNoteInput,
  FleetEventBatch,
  FleetNoteDirection,
  FleetNoteRecipientResolution,
  FormatFleetInboxInput,
} from "./fleet-mailbox.js";
export {
  buildFleetNote,
  FLEET_EVENT_INJECT_MAX_CHARS,
  FLEET_EVENT_INJECT_MAX_NOTES,
  FLEET_INBOX_RENDER_MAX_NOTES,
  FLEET_NOTE_BROADCAST,
  FLEET_NOTE_SUPERVISOR,
  formatFleetInbox,
  formatFleetNoteLine,
  resolveFleetNoteRecipients,
  selectFleetEvents,
} from "./fleet-mailbox.js";
export type {
  AcquireFleetMergeOptions,
  AcquireFleetMergeResult,
  DrainFleetMergeOptions,
  DrainFleetMergeResult,
  EnqueueFleetMergeOptions,
  EnqueueFleetMergeResult,
  FleetGateCommand,
  FleetGateCommandsResult,
  FleetMergeBroadcast,
  FleetMergeCommandResult,
  FleetMergeFailureReason,
  FleetMergeGateRunner,
  FleetMergeGateRunOptions,
  FleetMergeGitRunner,
  FleetMergeLockOptions,
  RecordedStashRestore,
  ReleaseFleetMergeOptions,
  ReleaseFleetMergeResult,
  RenderFleetMergeDrainOptions,
  RenewFleetMergeLeaseOptions,
  RenewFleetMergeLeaseResult,
  RestoreRecordedStashResult,
} from "./fleet-merge.js";
export {
  acquireFleetMerge,
  appendFleetMergeAudit,
  defaultFleetMergeGateRunner,
  defaultFleetMergeGitRunner,
  drainFleetMerge,
  enqueueFleetMerge,
  FLEET_MERGE_GATE_SCRIPTS,
  FLEET_MERGE_ORPHAN_LOCK_GRACE_MS,
  formatFleetMergeDrainReport,
  formatFleetMergeQueue,
  parseDroppedStashSha,
  readFleetGateCommands,
  releaseFleetMerge,
  renewFleetMergeLease,
  resolveFleetGateCommands,
  resolveFleetGateRunner,
  restoreRecordedStash,
} from "./fleet-merge.js";
export type {
  FleetLookupOptions,
  FleetMode,
  FleetSupervisorLiveness,
  FleetSupervisorMatchOptions,
  FleetSupervisorRecord,
  FleetSupervisorState,
  ResolveFleetModeOptions,
  ResolveMemberFleetOptions,
} from "./fleet-mode.js";
export {
  classifyFleetSupervisor,
  createFleetSupervisorRecord,
  FLEET_MIN_SUPERVISOR_PID,
  FLEET_REFUSED_TOOLS,
  formatFleetRefusal,
  isFleetRefusedTool,
  isProcessAlive,
  isSupervisorProcessAlive,
  listFleetIds,
  matchesFleetSupervisor,
  readProcessStartTime,
  resolveFleetMode,
  resolveMemberFleet,
} from "./fleet-mode.js";
export type {
  PauseFleetInput,
  PauseFleetResult,
  ResumeFleetInput,
  ResumeFleetResult,
} from "./fleet-pause.js";
export { pauseFleet, resumeFleet } from "./fleet-pause.js";
export type {
  DiagnoseMergeQueueInput,
  MemberLivenessReport,
  ParkRepairResult,
  RunFleetReconcileOptions,
  RunFleetReconcileResult,
} from "./fleet-reconcile.js";
export {
  diagnoseMergeQueue,
  FLEET_RECONCILE_ACTIVE_ENTRY_STATES,
  reportMemberLiveness,
  runFleetReconcile,
} from "./fleet-reconcile.js";
// Autonomous fleet run loop (P5)
export type {
  DeriveFleetMemberProgressOptions,
  FleetMemberClaim,
  FleetMemberObservation,
  FleetMemberProgress,
  FleetRun,
  FleetRunMember,
  FleetRunMode,
  FleetRunOutcome,
  FleetRunStop,
  FleetRunStopReason,
  FleetTickAction,
  FleetWorkflowProgressSnapshot,
  PlanFleetTickOptions,
} from "./fleet-run.js";
export {
  deriveFleetMemberProgress,
  FLEET_RUN_ACTION_TICK_INTERVAL_MS,
  FLEET_RUN_MAX_IDLE_TICKS,
  FLEET_RUN_MEMBERS_MAX,
  FLEET_RUN_MODES,
  FLEET_RUN_OUTCOMES,
  FLEET_RUN_SCHEMA_VERSION,
  FLEET_RUN_START_GRACE_MS,
  FLEET_RUN_STOP_REASONS,
  FLEET_RUN_TICK_INTERVAL_MS,
  FleetRunSchema,
  finishFleetRun,
  formatFleetRunLine,
  formatFleetRunStops,
  isFleetRunActive,
  planFleetTick,
  recordRunMemberLanded,
  recordRunMemberLaunched,
  recordRunMemberStopped,
  recordRunTick,
  startFleetRun,
} from "./fleet-run.js";
export type {
  FleetDependencyEdge,
  FleetDependencyGraph,
  FleetSchedule,
  FleetScheduleDeferral,
  FleetScheduleDeferralReason,
  FleetScheduleInput,
  FleetScheduleResult,
  FleetScheduleWave,
} from "./fleet-schedule.js";
export {
  FLEET_BLOCKING_DEPENDENCY_TYPES,
  FLEET_FINISHED_BEAD_STATUSES,
  FLEET_SCHEDULE_DEFERRAL_REASONS,
  parseFleetDependencyEdges,
  planFleetSchedule,
} from "./fleet-schedule.js";
export type {
  FleetMemberLeaseProbe,
  FleetMemberLiveness,
  FleetPidProbe,
  FleetProcessFs,
  FleetProcessScan,
  FleetProcessSnapshot,
  MemberPidIdentity,
  MemberPidOutcome,
  MemberPidSkipReason,
  ScanProcessesOptions,
  StopMemberSessionResult,
} from "./fleet-sessions.js";
export {
  classifyMemberLiveness,
  classifyMemberLivenessFromScan,
  defaultFleetPidProbe,
  FLEET_ORCHESTRATOR_SESSION_PREFIX,
  FLEET_PROC_CMDLINE_MAX_BYTES,
  FLEET_PROC_SCAN_MAX_ENTRIES,
  isMemberOrchestratorArgv,
  memberSessionToken,
  revalidateMemberPid,
  scanProcesses,
  stopMemberSession,
} from "./fleet-sessions.js";
export type {
  AckNotesOptions,
  AckNotesResult,
  AppendFleetAuditEntryOptions,
  CreateFleetIntentInput,
  DrainNotesOptions,
  DrainNotesResult,
  EnqueueNoteFanoutOptions,
  EnqueueNoteFanoutResult,
  EnqueueNoteOptions,
  EnqueueNoteResult,
  FleetAuditEntry,
  FleetIntentLoadResult,
  FleetIntentOptions,
  FleetIntentUpdateOutcome,
  FleetIntentUpdateRefusal,
  FleetMergeAcquireDecision,
  FleetMergeEntryState,
  FleetMergeLock,
  FleetMergeQueue,
  FleetMergeQueueEntry,
  FleetMergeQueueLoadResult,
  FleetNote,
  FleetNoteDelivery,
  FleetNoteKind,
  FleetStateFs,
  FleetStateWriteResult,
  UpdateFleetIntentOptions,
  UpdateFleetIntentResult,
  UpdateFleetMergeQueueOptions,
  UpdateFleetMergeQueueResult,
  WriteFleetIntentOptions,
  WriteFleetMergeQueueOptions,
} from "./fleet-state.js";
export {
  ackNotes,
  appendFleetAuditEntry,
  canAcquireFleetMerge,
  createFleetIntent,
  createFleetMergeLock,
  createFleetMergeQueue,
  drainNotes,
  enqueueNote,
  enqueueNoteFanout,
  FLEET_AUDIT_ACTION_MAX_LENGTH,
  FLEET_AUDIT_ACTOR_MAX_LENGTH,
  FLEET_AUDIT_DETAIL_MAX_LENGTH,
  FLEET_AUDIT_TASK_ID_MAX_LENGTH,
  FLEET_AUDIT_TASK_IDS_MAX,
  FLEET_MERGE_ENTRY_STATES,
  FLEET_MERGE_LEASE_MS,
  FLEET_MERGE_QUEUE_SCHEMA_VERSION,
  FLEET_NOTE_ADDRESS_MAX_LENGTH,
  FLEET_NOTE_BODY_MAX_LENGTH,
  FLEET_NOTE_FILE_MAX_BYTES,
  FLEET_NOTE_KINDS,
  FLEET_NOTE_SCHEMA_VERSION,
  fleetDir,
  fleetMemberTaskIds,
  fleetMergeLockDir,
  fleetNoteFileName,
  fleetRoot,
  formatAuditEntry,
  isFleetNoteKind,
  isLockExpired,
  parseFleetMergeQueue,
  parseFleetNote,
  pruneLandedFleetMember,
  readFleetIntent,
  readFleetMergeQueue,
  retireFleetDeferral,
  updateFleetIntent,
  updateFleetMergeQueue,
  writeFleetIntent,
  writeFleetMergeQueue,
} from "./fleet-state.js";
export type {
  BuildFleetStatusOptions,
  DeriveFleetMemberStateInput,
  FleetBead,
  FleetBeadLookup,
  FleetIntent,
  FleetLeaseSnapshot,
  FleetLeaseView,
  FleetMemberSnapshot,
  FleetMemberState,
  FleetMemberView,
  FleetPhaseRunView,
  FleetStateCounts,
  FleetStatus,
  FleetStatusFs,
  FleetSupervisor,
  FleetWarning,
  FleetWarningKind,
  FleetWorkflowFile,
  FleetWorkflowSnapshot,
  ReadFleetStatusOptions,
  ReadFleetStatusResult,
} from "./fleet-status.js";
export {
  applyFleetBeadLookup,
  buildFleetStatus,
  DEFAULT_FLEET_ID,
  deriveFleetMemberState,
  FLEET_INTENT_DEFERRED_MAX,
  FLEET_INTENT_MEMBERS_MAX,
  FLEET_INTENT_SUMMARY_MAX,
  FLEET_MEMBER_STATES,
  FLEET_SCHEMA_VERSION,
  FLEET_WARNING_KINDS,
  fleetAuditLogPath,
  fleetBeadTaskIds,
  fleetEventsDir,
  fleetInboxDir,
  fleetIntentFilePath,
  fleetLeaseView,
  fleetMergeQueueFilePath,
  fleetStateDir,
  formatFleetStatus,
  parseBeadView,
  parseBeadViews,
  parseFleetIntent,
  readFleetStatus,
  sanitizeFleetId,
} from "./fleet-status.js";
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
export type {
  GateResultEvent,
  GateResultInput,
  MetricsAppendResult,
  MetricsEnv,
  MetricsEvent,
  MetricsEventBase,
  PhaseAdvanceEvent,
  PhaseAdvanceInput,
  ReviewFindingsEvent,
  ReviewFindingsInput,
  RunEndEvent,
  RunEndInput,
  RunStartEvent,
  RunStartInput,
} from "./metrics.js";
export {
  appendMetricsEvent,
  buildGateResultEvent,
  buildPhaseAdvanceEvent,
  buildReviewFindingsEvent,
  buildRunEndEvent,
  buildRunStartEvent,
  METRICS_DIR_ENV,
  METRICS_ENABLED_ENV,
  metricsFilePath,
  metricsHostname,
  resolveMetricsDir,
} from "./metrics.js";
export type {
  MetricsQuery,
  MetricsQueryIo,
  MetricsQueryResult,
  MetricsReport,
  MetricsTable,
} from "./metrics-query.js";
export {
  buildDuckdbArgs,
  formatMetricsResults,
  formatMetricsTable,
  loadMetricsQueries,
  METRICS_EVENT_NAMES,
  METRICS_GLOB_TOKEN,
  parseCsv,
  parseMetricsQueryFile,
  parseMetricsTable,
  renderMetricsSql,
  runMetricsQueries,
} from "./metrics-query.js";
export type { AgentModelSpec, ModelClass } from "./model-classes.js";
// Model classes & quota-fallback routing
export {
  bareModelId,
  candidatesForModel,
  canonicalModelId,
  DEFAULT_PROVIDER_PREFERENCE,
  MODEL_CLASS_SPECS,
  MODEL_PROVIDER_PREFERENCE,
  MODEL_TO_CLASS,
  modelClassOf,
  PROVIDER_PREFERENCE,
  primaryModelOf,
  providerOf,
  providerPreferenceFor,
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
// One-orchestrator-per-worktree lease
export type {
  AcquireOrchestratorClaimOptions,
  AcquireOrchestratorClaimResult,
  AdoptOrchestratorClaimResult,
  OrchestratorClaim,
  OrchestratorClaimFs,
  OrchestratorClaimRead,
  OrchestratorClaimReadFs,
  OrchestratorClaimVerdict,
} from "./orchestrator-claim.js";
export {
  acquireOrchestratorClaim,
  adoptOrchestratorClaim,
  assignOrchestratorClaimSession,
  classifyOrchestratorClaim,
  describeOrchestratorClaim,
  heartbeatOrchestratorClaim,
  isPendingOrchestratorClaim,
  ORCHESTRATOR_CLAIM_ARCHIVE_PREFIX,
  ORCHESTRATOR_CLAIM_FILE_NAME,
  ORCHESTRATOR_CLAIM_HEARTBEAT_INTERVAL_MS,
  ORCHESTRATOR_CLAIM_PENDING_PREFIX,
  ORCHESTRATOR_CLAIM_SCHEMA_VERSION,
  ORCHESTRATOR_CLAIM_STALE_MS,
  orchestratorClaimFs,
  orchestratorClaimPath,
  parseOrchestratorClaim,
  readOrchestratorClaim,
  releaseOrchestratorClaim,
  replaceOrchestratorClaim,
} from "./orchestrator-claim.js";
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
  AdoptableTaskIdOptions,
  AssertOwnedWorktreeOptions,
  MatchOwnedWorktreeOptions,
  OwnedWorktreeResult,
  ReadWorkflowStateAtCwd,
  SessionOwnedWorktreeOptions,
  WorktreeBranch,
} from "./owned-worktree.js";
export {
  adoptableWorktreeTaskId,
  assertOwnedWorktree,
  formatWorktreePreamble,
  isSameOrDescendantTask,
  matchOwnedWorktree,
  matchSessionOwnedWorktree,
  readWorktreeBranch,
} from "./owned-worktree.js";
export type {
  PiBinaryCandidate,
  PiBinaryEnv,
  PiBinaryResolution,
  PiBinarySource,
} from "./pi-binary.js";
export {
  BELAYD_PI_BINARY_ENV,
  PI_BINARY_PATH_ENV,
  piBinaryCandidates,
  piBinaryNotice,
  resolvePiBinaryPath,
  SYSTEM_PI_BINARY,
} from "./pi-binary.js";
export type { AwaitingHuman, Phase } from "./process-gate.js";
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
  userGuideDocPath,
} from "./quality-gates.js";
export type { FailureClassification, FailureKind } from "./quota-failure.js";
export {
  classifySpawnFailure,
  DEFAULT_MODEL_UNAVAILABLE_COOLDOWN_SECONDS,
  DEFAULT_QUOTA_COOLDOWN_SECONDS,
  DEFAULT_TRANSIENT_COOLDOWN_SECONDS,
  isFallbackWorthy,
  parseQuotaResetSeconds,
} from "./quota-failure.js";
export type {
  CollectReviewDiffOptions,
  CollectReviewDiffResult,
  DiffScope,
  FormatReviewTaskOptions,
  ReviewDiff,
  ReviewFindingCounts,
  ReviewSeverity,
} from "./review-context.js";
export {
  boundReviewOutput,
  classifyDiffScope,
  collectReviewDiff,
  countReviewFindings,
  formatReviewTask,
  REVIEW_LINE_NUMBER_INSTRUCTION,
  REVIEW_OUTPUT_CONTRACT,
  REVIEW_PROCESS_INSTRUCTION,
  REVIEW_SCOPE_INSTRUCTION,
  REVIEW_SECTION_LIMITS,
} from "./review-context.js";
export type { WorkflowToolSetInput } from "./role-tools.js";
export {
  CONSULT_TOOLS,
  FLEET_TOOLS,
  MEMBER_FLEET_TOOLS,
  PLANNING_TOOL_SET,
  SUPERVISOR_FLEET_TOOLS,
  toolSetSize,
  WORKFLOW_CONTROL_TOOLS,
  workflowGateToolSet,
} from "./role-tools.js";
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
  runManifestFs,
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
export {
  hasConversation,
  lastAssistantText,
  narrowTranscriptEntries,
} from "./session-transcript.js";
export type { AgentProcessHandle, BuiltSpawnArgs, SpawnStream } from "./spawn.js";
export {
  buildSpawnArgs,
  collectSpawnResult,
  launchAgentProcess,
  resolvePiBinaryResolution,
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
export type {
  AgentToolSpec,
  DoctorInput,
  DoctorTool,
  ToolAuditRow,
  ToolSchemaLike,
  ToolTokenEstimate,
  ToolTokenReport,
} from "./tool-audit.js";
export {
  auditAgentTools,
  EXTERNAL_TOOL_NAMES,
  estimateSchemaTokens,
  estimateToolTokens,
  formatDoctorReport,
  HARNESS_TOOL_NAMES,
  unknownAllowlistTools,
} from "./tool-audit.js";
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
  CallerHandoffOptions,
  HandedOffMarker,
  SaveHandedOffMarkerOptions,
  SavePhaseSessionOptions,
  SaveReviewedShaOptions,
  SaveReviewedShaResult,
  WorkflowFs,
  WorkflowState,
  WriteCallerHandoffOptions,
} from "./workflow-state.js";
export {
  callerHandoffFilePath,
  clearCallerHandoff,
  clearHandedOffMarker,
  clearWorkflowState,
  parseHandedOffMarker,
  readCallerHandoff,
  readWorkflowState,
  saveCompletedPhases,
  saveHandedOffMarker,
  savePhaseSession,
  saveReviewedSha,
  workflowStateDir,
  workflowStateFilePath,
  writeCallerHandoff,
  writeWorkflowState,
} from "./workflow-state.js";
export type {
  GitCommonDirResult,
  ListWorktreesDeps,
  ParsedWorktreeList,
  RepoKeyExec,
  RepoKeyResult,
  WorktreeDeps,
  WorktreeListEntry,
  WorktreeListResult,
  WorktreeOptions,
} from "./worktree.js";
export {
  awaitWorktreeReady,
  isInsideWorktreeForBranch,
  listWorktrees,
  parseWorktreeListPorcelain,
  parseWorktreeListPorcelainZ,
  projectKeyFromRepoRoot,
  resolveGitCommonDir,
  resolveRepoKey,
  resolveWorktreePath,
  setupWorktree,
} from "./worktree.js";
