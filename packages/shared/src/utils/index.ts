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
  resolveUiContextWindow,
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
  classifyUserFacingError,
  isChatModeBlockMessage,
  buildChatModeBlockUserError,
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
  UserFacingError,
  UserFacingErrorCode,
} from './session-error-classify'

// kscc 核消息转译（SDKMessage → TAgentMessage IR，主进程 + renderer 共用）
export { sdkMessageToIR } from './kscc-message-adapter'

// 模型侧富内容输出校验（渲染层围栏检测的单一事实源）
export {
  RICH_FENCE_LANGUAGES,
  isRichFenceLanguage,
  unclosedFenceLanguage,
  validateRichOutput,
  buildRichOutputFixPrompt,
  buildRichContentSystemPrompt,
} from './rich-output-validate'
export type { RichOutputIssue } from './rich-output-validate'

// 主会话输出风格（kscc / Pi 双核共用沟通红线）
export { buildOutputStylePrompt } from './output-style-prompt'

// idle / 断流看门狗纯函数（超时判定）
export {
  IDLE_WATCHDOG_TIMEOUT_MS,
  shouldForceIdle,
} from './idle-watchdog'

// 流式 delta 协议（E）：累计快照 → 增量 suffix delta + resync + 落盘快照校准
export {
  computeDelta,
  extractBlockSnapshot,
  DeltaTracker,
  stripPartialAssistantBody,
  shouldDeltaTrackAssistant,
  type BlockDelta,
  type BlockSnapshot,
  type DeltaContentBlock,
  type StreamDeltaEmission,
} from './streaming-delta-protocol'
