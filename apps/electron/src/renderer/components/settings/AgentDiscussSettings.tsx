/**
 * 设置 · MOA → 圆桌偏好
 *
 * 落盘 ~/.tagent[-dev]/agent-discuss-prefs.json；主进程整单校验，非法 reject 中文错。
 *
 * variant:
 * - `page`：独立页（旧深链兜底；现已并入 MoaSettings）
 * - `module`：作为 MoaSettings 双子模块之一，无 intro / 无外层 SettingsSection
 *
 * 班底 `roundLimit` 可按预置覆盖；此处 `defaultRoundLimit` 仅作未指定时的默认。
 * 本期：`maxAgentMentionDepth` 运行时闸暂为 stub。
 */
import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, CheckCircle2 } from 'lucide-react'
import {
  SettingsCard,
  SettingsPageIntro,
  SettingsSection,
  SettingsSelect,
  SettingsToggle,
} from '@tagent/ui'
import {
  AGENT_DISCUSS_PREFS_DEFAULT,
  AGENT_DISCUSS_ROUND_LIMIT_MIN,
  AGENT_DISCUSS_ROUND_LIMIT_MAX,
  AGENT_DISCUSS_MENTION_DEPTH_MIN,
  AGENT_DISCUSS_MENTION_DEPTH_MAX,
  type AgentDiscussPrefs,
} from '@tagent/shared'

/** 研讨默认轮数选项（1–6） */
const ROUND_OPTIONS = Array.from(
  { length: AGENT_DISCUSS_ROUND_LIMIT_MAX - AGENT_DISCUSS_ROUND_LIMIT_MIN + 1 },
  (_, i) => i + AGENT_DISCUSS_ROUND_LIMIT_MIN,
).map((n) => ({ value: String(n), label: `${n} 轮` }))

/** @ 链式深度上限选项（1–10） */
const DEPTH_OPTIONS = Array.from(
  { length: AGENT_DISCUSS_MENTION_DEPTH_MAX - AGENT_DISCUSS_MENTION_DEPTH_MIN + 1 },
  (_, i) => i + AGENT_DISCUSS_MENTION_DEPTH_MIN,
).map((n) => ({ value: String(n), label: `${n} 层` }))

export function AgentDiscussSettings({
  variant = 'page',
  /** @deprecated 使用 variant="module"；保留兼容 MoaSettings 早期 hideIntro */
  hideIntro = false,
}: {
  variant?: 'page' | 'module'
  hideIntro?: boolean
}): JSX.Element {
  const mode: 'page' | 'module' = hideIntro ? 'module' : variant
  const [prefs, setPrefs] = useState<AgentDiscussPrefs | null>(null)
  const [error, setError] = useState('')
  const [ok, setOk] = useState('')
  const [saving, setSaving] = useState(false)

  const reload = useCallback(async (): Promise<void> => {
    setError('')
    try {
      const next = await window.electronAPI.getAgentDiscussPrefs()
      setPrefs(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : '无法读取圆桌设置')
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const save = useCallback(
    async (patch: Partial<AgentDiscussPrefs>): Promise<void> => {
      if (!prefs) return
      const next: AgentDiscussPrefs = { ...prefs, ...patch }
      setSaving(true)
      setOk('')
      setError('')
      setPrefs(next)
      try {
        const saved = await window.electronAPI.setAgentDiscussPrefs(next)
        setPrefs(saved)
        setOk('已保存')
      } catch (e) {
        setPrefs(prefs)
        setError(e instanceof Error ? e.message : '保存失败')
      } finally {
        setSaving(false)
      }
    },
    [prefs],
  )

  const ready = Boolean(prefs)
  const roundLimit = prefs?.defaultRoundLimit ?? AGENT_DISCUSS_PREFS_DEFAULT.defaultRoundLimit
  const mentionDepth = prefs?.maxAgentMentionDepth ?? AGENT_DISCUSS_PREFS_DEFAULT.maxAgentMentionDepth
  const routeComposer =
    prefs?.routeComposerWhileDiscussing ?? AGENT_DISCUSS_PREFS_DEFAULT.routeComposerWhileDiscussing

  const notices = (
    <>
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
    </>
  )

  const fields = (
    <SettingsCard divided className="moa-mode-card">
      <div className="moa-mode-panel moa-mode-panel--compact">
        <p className="moa-mode-panel__lead">互相讨论 · 多轮</p>
        <p className="moa-mode-panel__body">
          使用共用班底里的席位与模型；下列为圆桌全局默认，可被单个班底预置的研讨轮数覆盖。
        </p>
      </div>
      <SettingsSelect
        label="默认研讨轮数"
        description="1–6。班底预置若写了 roundLimit，以预置为准。"
        value={String(roundLimit)}
        onValueChange={(v) => void save({ defaultRoundLimit: Number(v) })}
        options={ROUND_OPTIONS}
        disabled={saving || !ready}
      />
      <SettingsSelect
        label="@ 链式深度上限"
        description="本期仅落盘 + UI，运行时闸暂未接。"
        value={String(mentionDepth)}
        onValueChange={(v) => void save({ maxAgentMentionDepth: Number(v) })}
        options={DEPTH_OPTIONS}
        disabled={saving || !ready}
      />
      <SettingsToggle
        label="讨论中把主会话输入路由到圆桌"
        description="默认关闭：讨论中主会话输入仍进讨论室（插话）。开启后改走圆桌编排。"
        checked={routeComposer}
        onCheckedChange={(v) => void save({ routeComposerWhileDiscussing: v })}
        disabled={saving || !ready}
      />
    </SettingsCard>
  )

  if (mode === 'module') {
    return (
      <div className="moa-mode-module">
        {notices}
        {fields}
      </div>
    )
  }

  return (
    <div className="settings-page agent-behavior-page">
      <SettingsPageIntro
        title="圆桌"
        description="多角色互相讨论出共识；与会诊对等，共用 MOA 班底。"
      />
      {notices}
      <SettingsSection title="圆桌" description="全局默认；班底预置可覆盖研讨轮数。">
        {fields}
      </SettingsSection>
    </div>
  )
}
