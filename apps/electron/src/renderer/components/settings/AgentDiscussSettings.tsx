/**
 * 设置 · Agent 行为 → 圆桌（agent-discuss）
 *
 * 落盘 ~/.tagent[-dev]/agent-discuss-prefs.json；主进程整单校验，非法 reject 中文错。
 * 视觉对齐 AgentBehaviorSettings / NoProgressGuardSettings（agent-behavior-* 样式）。
 *
 * 与「会诊」班底的关系：会诊班底 `roundLimit` 仍可在班底里单独覆盖；
 * 此处 `defaultRoundLimit` 仅作「未显式指定轮数时」的研讨默认。
 *
 * 本期：仅落盘 + UI；`maxAgentMentionDepth` 运行时闸暂为 stub
 * （见 docs/dev/moa-roundtable/IMPLEMENT-AGENT-DISCUSS-CREW-SETTINGS-FINDINGS.md）。
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

export function AgentDiscussSettings(): JSX.Element {
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
      // 首次尚未读到 prefs 时不应触发（控件 disabled 兜底）
      if (!prefs) return
      const next: AgentDiscussPrefs = { ...prefs, ...patch }
      setSaving(true)
      setOk('')
      setError('')
      // 乐观更新：先把 UI 切到新值，失败再回滚并回显
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
  const routeComposer = prefs?.routeComposerWhileDiscussing ?? AGENT_DISCUSS_PREFS_DEFAULT.routeComposerWhileDiscussing

  return (
    <div className="settings-page agent-behavior-page">
      <SettingsPageIntro
        title="圆桌"
        description="多角色互相讨论、出共识；支持插话与喊停。下列为研讨默认偏好，会诊班底仍可单独覆盖轮数。"
      />

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

      <SettingsSection
        title="研讨默认"
        description="未在班底里显式指定轮数时，圆桌研讨采用下列默认。"
      >
        <SettingsCard divided>
          <SettingsSelect
            label="默认研讨轮数"
            description="1–6 整数。会诊班底的 roundLimit 仍可覆盖此默认值。"
            value={String(roundLimit)}
            onValueChange={(v) => void save({ defaultRoundLimit: Number(v) })}
            options={ROUND_OPTIONS}
            disabled={saving || !ready}
          />
          <SettingsSelect
            label="@ 链式深度上限"
            description="本期仅落盘 + UI，运行时闸暂未接（开关已生效但尚不拦截越深 @ 链）。"
            value={String(mentionDepth)}
            onValueChange={(v) => void save({ maxAgentMentionDepth: Number(v) })}
            options={DEPTH_OPTIONS}
            disabled={saving || !ready}
          />
          <SettingsToggle
            label="讨论中把主会话输入路由到圆桌"
            description="默认关闭：讨论进行中主会话输入仍进讨论室（插话），不抢路由到圆桌编排。开启后主会话输入改走圆桌。"
            checked={routeComposer}
            onCheckedChange={(v) => void save({ routeComposerWhileDiscussing: v })}
            disabled={saving || !ready}
          />
        </SettingsCard>
      </SettingsSection>

      <p className="agent-behavior-field-hint">
        与「会诊」班底的关系：会诊是各答各的再汇总（单轮），圆桌是多角色互相讨论出共识（多轮）。
        研讨轮数可在会诊班底里按班底单独覆盖；此处仅作未指定时的默认。
      </p>
    </div>
  )
}
