import { useEffect, useRef, useState } from 'react'
import type { AgentRuntimeKind, Channel } from '@tagent/shared'
import { isMoaModelId } from '@tagent/shared'
import { AGENT_RUNTIME_LABELS, AGENT_RUNTIME_ORDER, channelAcceptsRuntime } from '../../atoms/agent-runtime'
import type { RecoveryTarget } from './session-recovery-flow'

interface Props {
  current: RecoveryTarget
  channels: Channel[]
  disabled: boolean
  retryable: boolean
  codexAvailable?: boolean
  onRecover: (target: RecoveryTarget) => Promise<void>
}

/** Draft choices do not mutate session binding until the user confirms. */
export function SessionRecoveryActions({ current, channels, disabled, retryable, codexAvailable, onRecover }: Props): JSX.Element {
  const [mode, setMode] = useState<'model' | 'runtime' | null>(null)
  const [runtime, setRuntime] = useState<AgentRuntimeKind>(current.runtime)
  const [choice, setChoice] = useState('')
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState('')
  const lock = useRef(false)
  useEffect(() => {
    // An external selector or a completed transaction changed the real binding.
    // Drop stale draft choices, but preserve any pending operation/failure feedback.
    setMode(null)
    setChoice('')
    setRuntime(current.runtime)
  }, [current.runtime, current.channelId, current.modelId])
  const locked = disabled || pending
  const targets = channels.filter(c => channelAcceptsRuntime(c, runtime)).flatMap(c =>
    c.models.filter(m => m.enabled && !isMoaModelId(m.id)).map(m => ({
      key: JSON.stringify([c.id, m.id]), label: `${c.name} / ${m.name}`,
      target: { runtime, channelId: c.id, modelId: m.id },
    })),
  ).filter(({ target }) => mode !== 'model' || target.channelId !== current.channelId || target.modelId !== current.modelId)
  const selected = targets.find(t => t.key === choice)?.target
  const buttonClass = 'rounded-lg px-2.5 py-1.5 text-xs font-medium hover:bg-foreground/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-45'

  const recover = async (target: RecoveryTarget): Promise<void> => {
    if (locked || lock.current) return
    lock.current = true
    setPending(true)
    setFailure('')
    try { await onRecover(target) }
    catch (error) { setFailure(error instanceof Error ? error.message : String(error)) }
    finally { lock.current = false; setPending(false) }
  }
  const open = (next: 'model' | 'runtime'): void => {
    setMode(next); setChoice(''); setFailure('')
    setRuntime(next === 'model' ? current.runtime : AGENT_RUNTIME_ORDER.find(r => r !== current.runtime) ?? 'pi')
  }
  return <div className="mt-2 flex flex-col gap-2 text-foreground">
    <div className="flex flex-wrap items-center gap-1">
      {retryable && <button type="button" className={`${buttonClass} bg-primary/10 text-primary`} disabled={locked} onClick={() => void recover(current)}>{pending ? '正在恢复…' : '继续当前模型'}</button>}
      <button type="button" className={buttonClass} disabled={locked} onClick={() => open('model')}>换模型继续</button>
      <button type="button" className={buttonClass} disabled={locked} onClick={() => open('runtime')}>换内核接力</button>
    </div>
    {mode && <div className="flex flex-col gap-2 rounded-lg border border-border bg-background/80 p-2">
      {mode === 'runtime' && <label className="flex flex-wrap items-center gap-2 text-xs">目标内核
        <select aria-label="目标内核" className="min-w-0 rounded border border-border bg-background p-1.5" disabled={locked} value={runtime} onChange={e => { setRuntime(e.target.value as AgentRuntimeKind); setChoice('') }}>
          {AGENT_RUNTIME_ORDER.filter(r => r !== current.runtime).map(r => <option key={r} value={r} disabled={r === 'codex' && codexAvailable === false}>{AGENT_RUNTIME_LABELS[r]}{r === 'codex' && codexAvailable === false ? '（未安装）' : ''}</option>)}
        </select>
      </label>}
      <label className="flex min-w-0 flex-wrap items-center gap-2 text-xs">渠道 / 模型
        <select aria-label="恢复渠道和模型" className="min-w-0 max-w-full flex-1 rounded border border-border bg-background p-1.5" disabled={locked} value={choice} onChange={e => setChoice(e.target.value)}>
          <option value="">请选择</option>
          {targets.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
      </label>
      {!targets.length && <p className="text-xs text-muted-foreground">没有可选模型，请在「设置 → 渠道」配置兼容的 API 渠道。</p>}
      <p className="text-xs text-muted-foreground">{mode === 'runtime' ? '切换内核' : '切换渠道或模型'}将带上最近可见对话节选，不是完整上下文迁移。结果不明的操作需先核实。</p>
      <div className="flex gap-1">
        <button type="button" className={`${buttonClass} bg-primary/10 text-primary`} disabled={locked || !selected || (runtime === 'codex' && codexAvailable === false)} onClick={() => selected && void recover(selected)}>{pending ? '正在恢复…' : '确认并继续'}</button>
        <button type="button" className={buttonClass} disabled={pending} onClick={() => setMode(null)}>取消</button>
      </div>
    </div>}
    {failure && <p role="status" aria-live="polite" className="text-xs text-destructive">{failure}</p>}
  </div>
}
