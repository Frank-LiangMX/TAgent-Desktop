/**
 * Pi 核适配器（外部渠道：DeepSeek/OpenAI/Google 等，pi-ai 直连）
 *
 * 2.0 双核之一。见 docs/plans/2026-07-25-2.0-architecture-decision-dual-core.md §7.1。
 *
 * 跟 kscc 核的区别：
 * - 不 spawn 子进程（Pi Agent 在主进程内存，自带循环）
 * - 无长驻问题（Agent 对象天然常驻）
 * - 上下文 Pi 自管（state.messages），无 SDK resume cache
 * - Xfast/MoA 全活（Pi 管工具循环，可并行）
 *
 * 当前阶段：占位骨架，核心 agent 功能先用 kscc 核跑通。
 * 后续填充：pi-ai provider streamFn（直连外部 API）+ 工具循环 + 持久化。
 *
 * 可拔插：内网版可排除本文件（只用 kscc 核）。
 */
import type {
  AgentProviderAdapter,
  AgentQueryInput,
  SDKUserMessageInput,
  SDKMessage,
} from '@tagent/shared'

export class PiAgentAdapter implements AgentProviderAdapter {
  async *query(_input: AgentQueryInput): AsyncIterable<SDKMessage> {
    // TODO: Pi 核实现
    // - new Agent({ streamFn: createPiStreamFn(外部渠道配置), tools, systemPrompt })
    // - agent.prompt(用户消息) → 流式事件 → 转成 SDKMessage 格式（或 TAgentMessage IR）
    // - Pi 自带循环，无 spawn，无长驻问题
    throw new Error('[pi adapter] 尚未实现：Pi 核适配器待填充（pi-ai provider streamFn + 工具循环）')
  }

  hasActiveChannel(_sessionId: string): boolean {
    // Pi Agent 对象天然常驻，只要会话不 dispose 就一直在
    // TODO: 跟踪 Pi Agent 实例
    return false
  }

  async sendQueuedMessage(_sessionId: string, _message: SDKUserMessageInput): Promise<void> {
    throw new Error('[pi adapter] 尚未实现')
  }

  async interruptQuery(_sessionId: string): Promise<void> {
    // TODO: agent.abort()
  }

  abort(_sessionId: string): void {
    // TODO: dispose Pi Agent
  }

  dispose(): void {
    // TODO: 释放所有 Pi Agent
  }
}
