/**
 * 全局记忆 L5 模块入口（Phase 2）
 *
 * Phase 2.1 七服务移植完成，在此统一 re-export 全部公开服务与函数。
 * 2.2/2.3 再接 renderer / IPC / main index wiring。
 */
export { getDiscardedMemoryDir } from './discarded-memory'
export { MEMORY_MANAGEMENT_RULES } from './memory-management-rules'

// memory-layer-service
export {
  MemoryLayerService,
  memoryLayerService,
  getMemoryDir,
  type MemoryMode,
  type SessionMemoryRecord,
  type RecordSessionParams,
  type MemoryLayerStats,
} from './memory-layer-service'

// nudge-service
export {
  NudgeService,
  nudgeService,
  type NudgeType,
  type NudgeCandidate,
  type NudgeResult,
} from './nudge-service'

// memory-evidence-sink
export {
  MemoryEvidenceSink,
  memoryEvidenceSink,
  type MemoryEvidenceEntry,
} from './memory-evidence-sink'

// stage-queue-service
export {
  readStageQueue,
  enqueueStage,
  removeFromStage,
  acceptAll,
  rejectAll,
  getStageStats,
  type StageEntry,
} from './stage-queue-service'

// memory-candidate-quality
export {
  isLowQualityMemoryContent,
  isLowQualityInsight,
  memoryContentDedupeKey,
  MIN_INSIGHT_CONFIDENCE,
} from './memory-candidate-quality'

// memory-consolidation-service
export {
  ConsolidationService,
  ConsolidationError,
  defaultExecutor,
  defaultApplier,
  buildDefaultDeps,
  computeBatchId,
  sanitizeBatchOutput,
  todayStr,
  filterAfterCursor,
  type ConsolidationOutcome,
  type Insight,
  type Contradiction,
  type BatchOutput,
  type ConsolidationRequest,
  type RunOptions,
  type RunResult,
  type ConsolidationState,
  type GlobalLeaseState,
  type PendingApplication,
  type ConsolidationDeps,
} from './memory-consolidation-service'

// idle-memory-consolidation-scheduler
export {
  IdleConsolidationScheduler,
  startIdleConsolidationScheduler,
  stopIdleConsolidationScheduler,
  isSchedulerRunning,
  setMemoryForegroundActivityProbe,
  resolveIdleConsolidationFlag,
  TICK_MS,
  type ConsolidationServiceLike,
  type IdleSchedulerDeps,
} from './idle-memory-consolidation-scheduler'

// reflect-service
export {
  reflectService,
  type ReflectionOutcome,
  type ReflectResult,
} from './reflect-service'

// scheduled-cleanup-service
export {
  scheduledCleanupService,
  type CleanupResult,
} from './scheduled-cleanup-service'

// self-repair-service
export {
  selfRepairService,
  type SelfRepairResult,
} from './self-repair-service'

// agent-context-utils
export {
  MAX_TOOL_SUMMARY_LENGTH,
  CHARS_PER_TOKEN,
  AVG_TOKENS_PER_MESSAGE,
  setSessionContextWindow,
  getSessionContextWindow,
  clearSessionContextWindow,
  clearAllSessionContextWindows,
  computeMaxContextMessages,
  summarizeToolResult,
  formatImagePlaceholder,
} from './agent-context-utils'

// agent-session-compactor
export {
  PROTECT_FIRST_N,
  PROTECT_LAST_N,
  planDropOldToolResults,
  planKeepLastN,
  compactSession,
  type SDKMessageRow,
} from './agent-session-compactor'

// agent-prompt-builder（精简版）
export {
  buildMemoryPromptSections,
  type PromptMemoryMode,
  type MemorySnapshotInput,
} from './agent-prompt-builder'

// Phase 5
export {
  normalizeToTextMessages,
  contentToText,
  estimateTextTokens,
  estimateMessagesTokens,
  type TextMessage,
} from './history-normalizer'
export {
  COMPACTION_SPLIT_SYSTEM,
  buildCompactionSplitUserPrompt,
  parseCompactionSplitResult,
  type CompactionSplitResult,
} from './compaction-prompt'
export {
  getLearnedSafeContextLimit,
  recordBurstAndLearn,
  type LearnedLimitEntry,
} from './context-limits-store'
export { completeMemoryLlm, embedTexts, resolveMemoryLlmChannel, MemoryLlmError } from './memory-llm-client'
export { indexSessionChunks, searchSessionVectors } from './session-vector-store'
export { buildMemoryRecallContext } from './memory-retrieval'
export { buildGraphPayload } from './learning-graph-service'
