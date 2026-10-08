import { describe, expect, it, vi } from 'vitest'
import { runSessionRecovery, SESSION_RECOVERY_PROMPT, type RecoveryTarget } from './session-recovery-flow'

const current: RecoveryTarget = { runtime: 'pi', channelId: 'a', modelId: 'one' }
describe('explicit session recovery', () => {
  it('continues with a short new instruction, without binding switch or original task replay', async () => {
    const send = vi.fn(), switchBinding = vi.fn()
    await runSessionRecovery({ current, target: current, isCurrent: () => true, send, switchBinding })
    expect(switchBinding).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(current, SESSION_RECOVERY_PROMPT)
  })
  it.each([
    { ...current, modelId: 'two' },
    { ...current, channelId: 'b' },
    { ...current, runtime: 'codex' as const },
    { ...current, runtime: 'claude-code' as const },
  ])('awaits successful transaction and sends the explicit new binding %j', async target => {
    const calls: string[] = []
    await runSessionRecovery({ current, target, isCurrent: () => true,
      switchBinding: async next => { expect(next).toEqual(target); calls.push('switch'); return true },
      send: async next => { expect(next).toEqual(target); calls.push('send') },
    })
    expect(calls).toEqual(['switch', 'send'])
  })
  it('never sends after a failed switch', async () => {
    const send = vi.fn()
    await expect(runSessionRecovery({ current, target: { ...current, modelId: 'two' }, isCurrent: () => true, switchBinding: async () => false, send })).rejects.toThrow('切换未完成')
    expect(send).not.toHaveBeenCalled()
  })
  it('does not continue a session navigated away from during a switch', async () => {
    let active = true
    const send = vi.fn()
    await expect(runSessionRecovery({ current, target: { ...current, channelId: 'b' }, isCurrent: () => active,
      switchBinding: async () => { active = false; return true }, send,
    })).rejects.toThrow('会话已切换')
    expect(send).not.toHaveBeenCalled()
  })
  it('propagates send rejection so the recovery error stays visible', async () => {
    await expect(runSessionRecovery({ current, target: current, isCurrent: () => true, switchBinding: vi.fn(), send: async () => { throw new Error('断联') } })).rejects.toThrow('断联')
  })
})
