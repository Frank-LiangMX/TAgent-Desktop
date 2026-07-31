/**
 * Shared utility functions for TAgent
 */

// Placeholder - will be expanded as needed
export function noop(): void {
  // no-op
}

export { normalizeLatexDelimiters } from './markdown-latex'
export { diffCapabilities } from './capabilities-diff'
export type { CapabilityChange } from './capabilities-diff'
export { calculateContextUsageRatio, sumContextUsedTokens } from './context-usage'
export type { UsageTokensLike } from './context-usage'
export {
  CONTEXT_USAGE_CATEGORY_COLORS,
  CONTEXT_USAGE_SWATCH,
  resolveContextUsageColor,
} from './context-usage-colors'
export { normalizeContextUsageSnapshot } from './context-usage-snapshot'
export {
  DEFAULT_CONTEXT_WINDOW,
  ONE_MILLION_CONTEXT_WINDOW,
  AUTO_COMPACT_THRESHOLD_RATIO,
  inferContextWindow,
  pickResultContextWindow,
  resolveDisplayContextWindow,
  supports1MContext,
} from './context-window'
export {
  COMPACTION_IN_PROGRESS_LABEL,
  getCompactBoundaryLabel,
  isSdkCompactBoundaryMessage,
  isSdkCompactingStatusMessage,
  isSdkStandaloneSystemMessage,
  readCompactBoundaryMetadata,
} from './sdk-compaction'
export type { SdkCompactBoundaryMetadata } from './sdk-compaction'
export { computeNextRunAt, formatScheduleLabel, isSameLocalDay } from './automation-schedule'
export type { AutomationScheduleInput } from './automation-schedule'
export {
  getFirstEnabledChannelModelId,
  normalizeChannelDefaultModelId,
  resolveAgentSessionModelId,
  resolveChannelDefaultModelId,
} from './channel-default-model'
export { estimateTokenCount, isCjkCodePoint } from './token-estimate'
export {
  THINKING_SIGNATURE_ERROR_CODE,
  THINKING_SIGNATURE_ERROR_TITLE,
  THINKING_SIGNATURE_ERROR_MESSAGE,
  isThinkingSignatureError,
  formatThinkingSignatureError,
  normalizeThinkingSignatureError,
} from './thinking-signature-error'
export {
  classifySessionError,
  isPromptTooLongMessage,
  isPromptTooLongResult,
  extractResultErrors,
  formatPromptTooLongError,
  PROMPT_TOO_LONG_ERROR_TITLE,
  PROMPT_TOO_LONG_ERROR_MESSAGE,
} from './session-error-classify'
export type {
  SessionErrorKind,
  ClassifySessionErrorInput,
} from './session-error-classify'

// kscc 核消息转译（SDKMessage → TAgentMessage IR，主进程 + renderer 共用）
export { sdkMessageToIR } from './kscc-message-adapter'
