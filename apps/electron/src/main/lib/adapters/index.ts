/**
 * 适配器选择（双核可拔插入口）
 *
 * 按渠道选核：kscc 内网渠道 → ClaudeAgentAdapter，外部渠道 → PiAgentAdapter。
 * 见 docs/plans/2026-07-25-2.0-architecture-decision-dual-core.md §1.5 / ADR-0001。
 *
 * 可拔插（构建期，不删源码）：
 * - 默认 / 内网：静态引用 claude/，双核可用。
 * - 对外：TAGENT_EXTERNAL=1 → build-main.mjs 将本文件对 claude/* 的 import
 *   与 @anthropic-ai/claude-agent-sdk 解析到 scripts/stubs/kscc-external-stub.ts；
 *   electron-builder.external.yml 再排除 node_modules 里的 claude-agent-sdk*。
 * - 脚本：package:win（内网） / package:win:external（对外）
 *
 * 单例模式：每个 ChannelKind 缓存一个适配器实例。
 * PiAgentAdapter 内部用 Map<sessionId, Agent> 管理多 Agent 实例，
 * 外部仍是一致的 AgentProviderAdapter 接口。
 */
import type { AgentProviderAdapter } from '@tagent/shared'
import { ClaudeAgentAdapter } from './claude/claude-agent-adapter'
import { PiAgentAdapter } from './pi/pi-agent-adapter'

/** 渠道类型 */
export type ChannelKind = 'kscc' | 'external'

/** 按渠道选适配器（单例，按渠道缓存） */
const adapters = new Map<ChannelKind, AgentProviderAdapter>()

export function getAdapter(kind: ChannelKind): AgentProviderAdapter {
  let adapter = adapters.get(kind)
  if (!adapter) {
    adapter = kind === 'kscc' ? new ClaudeAgentAdapter() : new PiAgentAdapter()
    adapters.set(kind, adapter)
  }
  return adapter
}

/** 释放所有适配器资源（app quit 时调用） */
export function disposeAllAdapters(): void {
  for (const adapter of adapters.values()) {
    try {
      adapter.dispose()
    } catch {
      /* 忽略 */
    }
  }
  adapters.clear()
}

export { ClaudeAgentAdapter, PiAgentAdapter }
