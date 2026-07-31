/**
 * Agent prompt builder — MEMORY 相关精简版（Phase 2.1）
 *
 * 只导出记忆相关两个构建函数，供双核 systemPrompt 拼接：
 * - buildMemoryPromptSections: 管理规则 + 记忆快照段
 * - 复用 memory-management-rules.ts 的 MEMORY_MANAGEMENT_RULES（不复制字符串）
 *
 * 记忆快照段格式参考 TAgent_General agent-prompt-builder.ts L912-930（Frozen snapshot 模式）：
 * 会话启动时一次性注入 L0/L1/L2，会话进行中记忆写入不改本节（保 Prompt Cache）。
 */

import { MEMORY_MANAGEMENT_RULES } from './memory-management-rules'

/** 记忆模式：通用 / TA */
export type PromptMemoryMode = 'general' | 'ta'

/**
 * 记忆快照输入：支持结构化对象（l0/l1/l2 三段）或原始字符串（整段注入）。
 * 与 General 的 readMemorySnapshot() 返回结构对齐。
 */
export type MemorySnapshotInput = { l0?: string; l1?: string; l2?: string } | string | null | undefined

/**
 * 构建记忆相关 system prompt 段。
 *
 * @param opts.mode 记忆模式
 * @param opts.memorySnapshot L0/L1/L2 快照（Frozen snapshot）
 * @returns managementRules（管理规则段）+ memorySnapshotSection（记忆快照段，无内容时为空串）
 */
export function buildMemoryPromptSections(opts: {
  mode: PromptMemoryMode
  memorySnapshot: MemorySnapshotInput
}): { managementRules: string; memorySnapshotSection: string } {
  const snapshotSection = buildMemorySnapshotSection(opts.memorySnapshot)
  return {
    managementRules: MEMORY_MANAGEMENT_RULES,
    memorySnapshotSection: snapshotSection,
  }
}

/**
 * 拼 `## 记忆快照` 段（Frozen snapshot 模式）
 *
 * 无任何记忆内容时返回空串，调用方跳过该段。
 */
function buildMemorySnapshotSection(snapshot: MemorySnapshotInput): string {
  const memoryLines: string[] = []

  if (typeof snapshot === 'string') {
    if (snapshot.trim()) {
      memoryLines.push(snapshot.trim())
    }
  } else if (snapshot) {
    if (snapshot.l0?.trim()) {
      memoryLines.push(`### 用户画像（L0）\n${snapshot.l0.trim()}`)
    }
    if (snapshot.l1?.trim()) {
      memoryLines.push(`### 项目画像与索引（L1）\n${snapshot.l1.trim()}`)
    }
    if (snapshot.l2?.trim()) {
      memoryLines.push(`### 稳定事实（L2）\n${snapshot.l2.trim()}`)
    }
  }

  if (memoryLines.length === 0) {
    return ''
  }

  return `## 记忆快照

以下是系统从长期记忆中为你加载的画像与事实（本会话内固定，不随写入刷新；新写入的记忆下一会话才会生效）：

${memoryLines.join('\n\n')}`
}
