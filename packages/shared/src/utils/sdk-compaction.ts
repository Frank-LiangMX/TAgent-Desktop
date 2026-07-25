/** SDK compact_boundary 元数据（Claude Agent SDK） */
export interface SdkCompactBoundaryMetadata {
  trigger?: 'manual' | 'auto'
  pre_tokens?: number
  post_tokens?: number
  duration_ms?: number
}

/** 压缩进行中 — 与 Codex / Claude Code 文案对齐 */
export const COMPACTION_IN_PROGRESS_LABEL = '压缩上下文'

/** 识别 SDK 压缩进行中的 status 消息 */
export function isSdkCompactingStatusMessage(message: {
  type?: string
  subtype?: string
  status?: unknown
}): boolean {
  return (
    message.type === 'system' &&
    (message.subtype === 'compacting' ||
      (message.subtype === 'status' && message.status === 'compacting'))
  )
}

/** 识别 SDK compact_boundary 完成标记 */
export function isSdkCompactBoundaryMessage(message: { type?: string; subtype?: string }): boolean {
  return message.type === 'system' && message.subtype === 'compact_boundary'
}

/** 需要在时间线独立占位的 system 消息（压缩 / 权限拒绝） */
export function isSdkStandaloneSystemMessage(message: {
  type?: string
  subtype?: string
  status?: unknown
}): boolean {
  if (message.type !== 'system') return false
  return (
    isSdkCompactBoundaryMessage(message) ||
    isSdkCompactingStatusMessage(message) ||
    message.subtype === 'permission_denied'
  )
}

/** 从 compact_boundary 读取元数据 */
export function readCompactBoundaryMetadata(
  message: unknown
): SdkCompactBoundaryMetadata | undefined {
  if (message == null || typeof message !== 'object') return undefined
  const meta = (message as { compact_metadata?: unknown }).compact_metadata
  if (meta == null || typeof meta !== 'object') return undefined
  return meta as SdkCompactBoundaryMetadata
}

/** 压缩完成分隔符文案（区分自动 / 手动） */
export function getCompactBoundaryLabel(metadata?: SdkCompactBoundaryMetadata): string {
  if (metadata?.trigger === 'auto') return '上下文已自动压缩'
  if (metadata?.trigger === 'manual') return '上下文已压缩'
  return '上下文已压缩'
}
