/**
 * 对外版（TAGENT_EXTERNAL=1）构建期 stub。
 *
 * build-main.mjs 在对外构建时把 adapters/claude/* 与
 * @anthropic-ai/claude-agent-sdk 解析到本文件，避免：
 * 1) main.cjs 内留下 require('@anthropic-ai/claude-agent-sdk')
 * 2) 把 kscc 核实现打进对外 bundle
 *
 * 源码 adapters/claude/ 仍保留，内网 / dev 默认路径不受影响。
 */
const EXTERNAL_MSG =
  '此为对外发行版：kscc 内网核与 Claude Agent SDK 未打包。请使用外部 API 渠道（Pi 核）。'

/** 与真实 ClaudeAgentAdapter 同名，供 getAdapter('kscc') 实例化后在首用时报错 */
export class ClaudeAgentAdapter {
  hasActiveChannel(_sessionId: string): boolean {
    return false
  }

  async *query(_input: unknown): AsyncGenerator<never, void, unknown> {
    throw new Error(EXTERNAL_MSG)
  }

  abort(_sessionId: string): void {}

  dispose(): void {}

  async interruptQuery(_sessionId: string): Promise<void> {}

  async sendQueuedMessage(_sessionId: string, _message: unknown): Promise<void> {
    throw new Error(EXTERNAL_MSG)
  }

  async setPermissionMode(_sessionId: string, _mode: string): Promise<void> {
    throw new Error(EXTERNAL_MSG)
  }

  async setModel(_sessionId: string, _model: string): Promise<void> {
    throw new Error(EXTERNAL_MSG)
  }
}

/** channel-tester / session-service 等调用：对外版恒为未安装 */
export function resolveKsccPath(): string | undefined {
  return undefined
}

export function spawnKscc(..._args: unknown[]): never {
  throw new Error(EXTERNAL_MSG)
}

// ── @anthropic-ai/claude-agent-sdk 表面（kanban inject 等动态 import）──

export function query(..._args: unknown[]): never {
  throw new Error(EXTERNAL_MSG)
}

export function tool(..._args: unknown[]): never {
  throw new Error(EXTERNAL_MSG)
}

export function createSdkMcpServer(..._args: unknown[]): never {
  throw new Error(EXTERNAL_MSG)
}

export default {
  query,
  tool,
  createSdkMcpServer,
  ClaudeAgentAdapter,
  resolveKsccPath,
  spawnKscc,
}
