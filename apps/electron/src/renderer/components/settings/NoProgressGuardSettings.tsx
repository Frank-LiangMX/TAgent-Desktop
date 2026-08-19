/**
 * 设置 · 工具循环保护（No-Progress Guard）
 *
 * 落盘偏好；环境变量 TAGENT_NO_PROGRESS_GUARD_MODE 可覆盖。
 * 默认 enforce：重复无进展时提醒 → 复盘 → 暂停本轮（不杀进程）。
 */
import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, CheckCircle2 } from 'lucide-react'
import {
  SettingsCard,
  SettingsSection,
  SettingsSelect,
} from '@tagent/ui'
import {
  NO_PROGRESS_GUARD_DEFAULT_MODE,
  type NoProgressGuardMode,
} from '@tagent/shared'

type GuardModeState = {
  effective: NoProgressGuardMode
  stored: NoProgressGuardMode | null
  envOverride: NoProgressGuardMode | null
}

const MODE_OPTIONS = [
  {
    value: 'enforce',
    label: '强制（推荐）',
  },
  {
    value: 'shadow',
    label: '影子（只观察）',
  },
  {
    value: 'off',
    label: '关闭',
  },
] as const

export function NoProgressGuardSettings(): JSX.Element {
  const [state, setState] = useState<GuardModeState | null>(null)
  const [error, setError] = useState('')
  const [ok, setOk] = useState('')
  const [saving, setSaving] = useState(false)

  const reload = useCallback(async (): Promise<void> => {
    setError('')
    try {
      const next = await window.electronAPI.getNoProgressGuardMode()
      setState(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : '无法读取工具循环保护设置')
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const handleChange = useCallback(
    async (value: string): Promise<void> => {
      if (value !== 'off' && value !== 'shadow' && value !== 'enforce') return
      setSaving(true)
      setOk('')
      setError('')
      try {
        const next = await window.electronAPI.setNoProgressGuardMode(value)
        setState(next)
        setOk(
          next.envOverride
            ? `已保存偏好「${value}」，但当前被环境变量覆盖为「${next.envOverride}」`
            : `已设为「${MODE_OPTIONS.find((o) => o.value === value)?.label ?? value}」`,
        )
      } catch (e) {
        setError(e instanceof Error ? e.message : '保存失败')
      } finally {
        setSaving(false)
      }
    },
    [],
  )

  const selectValue = state?.stored ?? state?.effective ?? NO_PROGRESS_GUARD_DEFAULT_MODE

  return (
    <SettingsSection
      title="工具循环保护"
      description="防止 Agent 反复撞墙空转。强制模式会提醒、要求复盘，仍无进展则暂停本轮（会话可继续）。"
    >
      {error ? (
        <div className="agent-behavior-notice agent-behavior-notice--error" role="alert">
          <AlertCircle size={15} />
          <span className="agent-behavior-notice-copy">{error}</span>
        </div>
      ) : null}
      {ok ? (
        <div className="agent-behavior-notice agent-behavior-notice--success" role="status">
          <CheckCircle2 size={15} />
          <span className="agent-behavior-notice-copy">{ok}</span>
        </div>
      ) : null}
      <SettingsCard divided={false}>
        <SettingsSelect
          label="保护模式"
          value={selectValue}
          onValueChange={(v) => void handleChange(v)}
          options={MODE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          disabled={saving || !state}
        />
        <div className="settings-card-footnote">
          {state?.envOverride ? (
            <p className="agent-behavior-field-hint">
              环境变量 <code>TAGENT_NO_PROGRESS_GUARD_MODE={state.envOverride}</code>{' '}
              正在覆盖设置页偏好。当前实际生效：{state.effective}。
            </p>
          ) : (
            <p className="agent-behavior-field-hint">
              当前生效：{state?.effective ?? '…'}。紧急可用环境变量临时覆盖。
            </p>
          )}
        </div>
      </SettingsCard>
    </SettingsSection>
  )
}
