/**
 * REGRESS-A vitest — Chat 模式写工具硬拦（createCanUseTool 路径）
 *
 * 规格：docs/dev/core-loop/REGRESS-2026-08-07-SPEC.md §A
 * 根因：docs/dev/core-loop/REGRESS-A-FINDINGS.md
 *
 * 断言：
 * - executionMode=chat + Write → deny + interrupt:true + CHAT_MODE_BLOCK_REASON
 *   + 触发 chatModeBlockHandler，**不走 askRenderer**（不发 PERMISSION_REQUEST）。
 * - chat + EnterPlanMode（软拒绝）→ deny 无 interrupt、不触发 chatModeBlockHandler、不走 askRenderer。
 * - chat + Read → allow（只读不拦）。
 * - work + Write（反例）→ 走 askRenderer（发 PERMISSION_REQUEST），deny 无 interrupt。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { BrowserWindow } from 'electron'

vi.mock('electron', () => ({
  // PermissionService.create → registerIpc 只用 ipcMain.on；无需真实 IPC
  ipcMain: {
    on: vi.fn(),
    handle: vi.fn(),
    removeAllListeners: vi.fn(),
    removeHandler: vi.fn(),
  },
}))

import { PermissionService, setOnChatModeBlock } from './permission-service'
import { askUserService } from '../agent/agent-ask-user-service'
import {
  AGENT_IPC_CHANNELS,
  CHAT_MODE_BLOCK_REASON,
  type AskUserRequest,
  type ExecutionMode,
  type TAgentPermissionMode,
} from '@tagent/shared'

const AUTO: TAgentPermissionMode = 'auto'
const CHAT: ExecutionMode = 'chat'
const WORK: ExecutionMode = 'work'
const CWD = 'F:/TAgent_General'

describe('createCanUseTool — Chat 写工具硬拦（REGRESS-A）', () => {
  let sends: Array<{ channel: string; payload: unknown }>
  let win: { webContents: { send: (channel: string, payload: unknown) => void } }
  let svc: PermissionService
  let configDir: string
  const blockCalls: Array<{ sessionId: string; toolName: string }> = []

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'tagent-perm-svc-'))
    process.env.TAGENT_CONFIG_DIR = configDir
    sends = []
    win = {
      webContents: {
        send: (channel: string, payload: unknown) => {
          sends.push({ channel, payload })
        },
      },
    }
    blockCalls.length = 0
    svc = PermissionService.create(() => win as unknown as BrowserWindow)
    setOnChatModeBlock((sessionId, toolName) => {
      blockCalls.push({ sessionId, toolName })
    })
  })

  afterEach(() => {
    setOnChatModeBlock(undefined)
    delete process.env.TAGENT_CONFIG_DIR
    rmSync(configDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('executionMode=chat + Write → deny + interrupt:true + CHAT_MODE_BLOCK_REASON + 触发 chatModeBlockHandler，不走 askRenderer', async () => {
    const canUseTool = svc.createCanUseTool('sess-chat-write', () => AUTO, CWD, () => CHAT)
    const result = await canUseTool('Write', { file_path: 'a.ts', content: 'x' })

    expect(result.behavior).toBe('deny')
    if (result.behavior === 'deny') {
      expect(result.message).toBe(CHAT_MODE_BLOCK_REASON)
      expect(result.interrupt).toBe(true)
    }
    expect(blockCalls).toHaveLength(1)
    expect(blockCalls[0]!.toolName).toBe('Write')
    // 不走 askRenderer：未发 PERMISSION_REQUEST
    expect(sends.some((s) => s.channel === AGENT_IPC_CHANNELS.PERMISSION_REQUEST)).toBe(false)
  })

  it('executionMode=chat + EnterPlanMode（软拒绝）→ deny 无 interrupt、不触发 chatModeBlockHandler、不走 askRenderer', async () => {
    const canUseTool = svc.createCanUseTool('sess-chat-plan', () => AUTO, CWD, () => CHAT)
    const result = await canUseTool('EnterPlanMode', {})

    expect(result.behavior).toBe('deny')
    if (result.behavior === 'deny') {
      expect(result.message).toBe(CHAT_MODE_BLOCK_REASON)
      expect(result.interrupt).toBeUndefined()
    }
    expect(blockCalls).toHaveLength(0)
    expect(sends.some((s) => s.channel === AGENT_IPC_CHANNELS.PERMISSION_REQUEST)).toBe(false)
  })

  it('executionMode=chat + Read → allow（只读不拦）', async () => {
    const canUseTool = svc.createCanUseTool('sess-chat-read', () => AUTO, CWD, () => CHAT)
    const result = await canUseTool('Read', { file_path: 'a.ts' })

    expect(result.behavior).toBe('allow')
    expect(blockCalls).toHaveLength(0)
    expect(sends.some((s) => s.channel === AGENT_IPC_CHANNELS.PERMISSION_REQUEST)).toBe(false)
  })

  it('executionMode=work + Write → 走 askRenderer（发 PERMISSION_REQUEST），deny 无 interrupt（反例）', async () => {
    vi.useFakeTimers()
    try {
      const canUseTool = svc.createCanUseTool('sess-work-write', () => AUTO, CWD, () => WORK)
      const resultP = canUseTool('Write', { file_path: 'a.ts', content: 'x' })
      // askRenderer 在 checkPermission 的 await askRenderer 之前已同步发出 PERMISSION_REQUEST
      expect(sends.some((s) => s.channel === AGENT_IPC_CHANNELS.PERMISSION_REQUEST)).toBe(true)
      // 超时 deny（消费 setTimeout，避免泄漏到其他用例）
      await vi.advanceTimersByTimeAsync(120_000)
      const result = await resultP
      expect(result.behavior).toBe('deny')
      if (result.behavior === 'deny') {
        expect(result.interrupt).toBeUndefined()
      }
      // work 下不触发 Chat 硬拦
      expect(blockCalls).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('createCanUseTool — AskUserQuestion 拦截（REGRESS-H）', () => {
  let sends: Array<{ channel: string; payload: unknown }>
  let win: { webContents: { send: (channel: string, payload: unknown) => void } }
  let svc: PermissionService

  beforeEach(() => {
    sends = []
    win = {
      webContents: {
        send: (channel: string, payload: unknown) => {
          sends.push({ channel, payload })
        },
      },
    }
    svc = PermissionService.create(() => win as unknown as BrowserWindow)
  })

  afterEach(() => {
    // 清共享 ask-user 单例残留 pending（避免跨用例泄漏）
    askUserService.clearSessionPending('sess-ask')
    askUserService.clearSessionPending('sess-ask-abort')
  })

  it('AskUserQuestion 走拦截分支：发 ASK_USER_REQUEST，不进 askRenderer（不发 PERMISSION_REQUEST）；respond 注入 answers', async () => {
    const ac = new AbortController()
    const canUseTool = svc.createCanUseTool('sess-ask', () => AUTO, CWD, () => CHAT)
    const resultP = canUseTool(
      'AskUserQuestion',
      { questions: [{ question: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] }] },
      { signal: ac.signal }
    )

    // 同步发出 AskUser 请求（早于 checkPermission / askRenderer）
    expect(sends.some((s) => s.channel === AGENT_IPC_CHANNELS.ASK_USER_REQUEST)).toBe(true)
    // 不进通用权限横幅
    expect(sends.some((s) => s.channel === AGENT_IPC_CHANNELS.PERMISSION_REQUEST)).toBe(false)

    const req = sends.find((s) => s.channel === AGENT_IPC_CHANNELS.ASK_USER_REQUEST)!
      .payload as AskUserRequest
    expect(req.questions).toHaveLength(1)
    expect(req.questions[0]!.options).toHaveLength(2)
    expect(req.sessionId).toBe('sess-ask')

    // 用户作答 → 注入 answers + resolve allow（不卡、不当「未选」）
    const sid = askUserService.respondToAskUser(req.requestId, { '选哪个？': 'A' })
    expect(sid).toBe('sess-ask')
    const result = await resultP
    expect(result.behavior).toBe('allow')
    if (result.behavior === 'allow') {
      expect(result.updatedInput.answers).toEqual({ '选哪个？': 'A' })
      expect(Array.isArray(result.updatedInput.questions)).toBe(true)
    }
  })

  it('AskUserQuestion abort → deny「操作已中止」（不进 askRenderer）', async () => {
    const ac = new AbortController()
    const canUseTool = svc.createCanUseTool('sess-ask-abort', () => AUTO, CWD, () => CHAT)
    const resultP = canUseTool(
      'AskUserQuestion',
      { questions: [{ question: 'q', options: [{ label: 'x' }] }] },
      { signal: ac.signal }
    )
    expect(sends.some((s) => s.channel === AGENT_IPC_CHANNELS.ASK_USER_REQUEST)).toBe(true)
    expect(sends.some((s) => s.channel === AGENT_IPC_CHANNELS.PERMISSION_REQUEST)).toBe(false)
    ac.abort()
    const result = await resultP
    expect(result.behavior).toBe('deny')
    if (result.behavior === 'deny') {
      expect(result.message).toBe('操作已中止')
    }
  })
})
