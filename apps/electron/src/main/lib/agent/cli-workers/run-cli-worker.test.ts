/**
 * runCliWorker 单测：mock 四个 runner，验证按 worker.id 路由 + 未知 id 兜底。
 *
 * - kscc → runKsccWorker（bin/model 从 worker 取）
 * - grok / codex / mimo → 对应 runner（直接透传 input）
 * - 未知 id → ok:false 中文 summary，不调任何 runner
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  runKsccWorker: vi.fn(),
  runGrokWorker: vi.fn(),
  runCodexWorker: vi.fn(),
  runMimoWorker: vi.fn(),
  runOpencodeWorker: vi.fn(),
  runClaudeWorker: vi.fn(),
}))

vi.mock('./run-kscc-worker', () => ({ runKsccWorker: mocks.runKsccWorker }))
vi.mock('./run-grok-worker', () => ({ runGrokWorker: mocks.runGrokWorker }))
vi.mock('./run-codex-worker', () => ({ runCodexWorker: mocks.runCodexWorker }))
vi.mock('./run-mimo-worker', () => ({ runMimoWorker: mocks.runMimoWorker }))
vi.mock('./run-opencode-worker', () => ({ runOpencodeWorker: mocks.runOpencodeWorker }))
vi.mock('./run-claude-worker', () => ({ runClaudeWorker: mocks.runClaudeWorker }))

import { runCliWorker } from './run-cli-worker'
import { SUPPORTED_CLI_WORKER_IDS } from '@tagent/shared'

const OK = { ok: true, summary: 'OK', toolCalls: 0, durationMs: 10, exitCode: 0 }

beforeEach(() => {
  mocks.runKsccWorker.mockClear()
  mocks.runGrokWorker.mockClear()
  mocks.runCodexWorker.mockClear()
  mocks.runMimoWorker.mockClear()
  mocks.runOpencodeWorker.mockClear()
  mocks.runClaudeWorker.mockClear()
  mocks.runKsccWorker.mockResolvedValue(OK)
  mocks.runGrokWorker.mockResolvedValue(OK)
  mocks.runCodexWorker.mockResolvedValue(OK)
  mocks.runMimoWorker.mockResolvedValue(OK)
  mocks.runOpencodeWorker.mockResolvedValue(OK)
  mocks.runClaudeWorker.mockResolvedValue(OK)
})

describe('runCliWorker · 路由', () => {
  it('kscc → runKsccWorker（bin/model 从 worker 取，透传 prompt/cwd/signal/回调）', async () => {
    const onProgress = vi.fn()
    const ac = new AbortController()
    await runCliWorker({
      worker: { id: 'kscc', enabled: true, bin: 'kscc', defaultModel: 'glm-5.2' },
      prompt: 'do',
      cwd: 'C:\\p',
      signal: ac.signal,
      onProgress,
    })
    expect(mocks.runKsccWorker).toHaveBeenCalledWith({
      bin: 'kscc',
      model: 'glm-5.2',
      prompt: 'do',
      cwd: 'C:\\p',
      signal: ac.signal,
      onProgress,
      onToolUse: undefined,
      onToolResult: undefined,
      onTextChunk: undefined,
    })
    expect(mocks.runGrokWorker).not.toHaveBeenCalled()
  })

  it('grok → runGrokWorker（透传 input）', async () => {
    const input = {
      worker: { id: 'grok', enabled: true, bin: 'grok' },
      prompt: 'do',
      cwd: 'C:\\p',
    }
    await runCliWorker(input)
    expect(mocks.runGrokWorker).toHaveBeenCalledWith(input)
    expect(mocks.runKsccWorker).not.toHaveBeenCalled()
  })

  it('codex → runCodexWorker', async () => {
    const input = { worker: { id: 'codex', enabled: true, bin: 'codex' }, prompt: 'do', cwd: 'C:\\p' }
    await runCliWorker(input)
    expect(mocks.runCodexWorker).toHaveBeenCalledWith(input)
  })

  it('mimo → runMimoWorker', async () => {
    const input = { worker: { id: 'mimo', enabled: true, bin: 'mimo' }, prompt: 'do', cwd: 'C:\\p' }
    await runCliWorker(input)
    expect(mocks.runMimoWorker).toHaveBeenCalledWith(input)
  })

  it('opencode → runOpencodeWorker', async () => {
    const input = { worker: { id: 'opencode', enabled: true, bin: 'opencode' }, prompt: 'do', cwd: 'C:\\p' }
    await runCliWorker(input)
    expect(mocks.runOpencodeWorker).toHaveBeenCalledWith(input)
  })

  it('claude → runClaudeWorker', async () => {
    const input = { worker: { id: 'claude', enabled: true, bin: 'claude' }, prompt: 'do', cwd: 'C:\\p' }
    await runCliWorker(input)
    expect(mocks.runClaudeWorker).toHaveBeenCalledWith(input)
  })

  it('未知 id → ok:false 中文 summary，不调任何 runner', async () => {
    const r = await runCliWorker({
      worker: { id: 'mycustom', enabled: true, bin: 'mycustom' },
      prompt: 'do',
      cwd: 'C:\\p',
    })
    expect(r.ok).toBe(false)
    expect(r.summary).toContain('未知 CLI 工人')
    expect(r.summary).toContain('mycustom')
    expect(mocks.runKsccWorker).not.toHaveBeenCalled()
    expect(mocks.runGrokWorker).not.toHaveBeenCalled()
    expect(mocks.runCodexWorker).not.toHaveBeenCalled()
    expect(mocks.runMimoWorker).not.toHaveBeenCalled()
    expect(mocks.runOpencodeWorker).not.toHaveBeenCalled()
    expect(mocks.runClaudeWorker).not.toHaveBeenCalled()
  })

  it('SUPPORTED_CLI_WORKER_IDS 含 6 个 id', () => {
    expect([...SUPPORTED_CLI_WORKER_IDS]).toEqual(['kscc', 'grok', 'codex', 'mimo', 'opencode', 'claude'])
  })
})
