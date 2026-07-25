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
