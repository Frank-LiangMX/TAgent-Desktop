/**
 * 设置 · Agent 行为 → 班组（agent-crew）
 *
 * 落盘 ~/.tagent[-dev]/agent-crew-prefs.json；主进程整单校验，非法 reject 中文错。
 * 视觉对齐 AgentBehaviorSettings / NoProgressGuardSettings（agent-behavior-* 样式）。
 *
 * 本期：仅落盘 + UI；`maxParallelWorkers` 调度未接、`showFlowAsGraph` 为阶段3预留
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
  AGENT_CREW_PREFS_DEFAULT,
  AGENT_CREW_PARALLEL_MIN,
  AGENT_CREW_PARALLEL_MAX,
  type AgentCrewPrefs,
} from '@tagent/shared'

/** 并行 worker 上限选项（1–8） */
const PARALLEL_OPTIONS = Array.from(
  { length: AGENT_CREW_PARALLEL_MAX - AGENT_CREW_PARALLEL_MIN + 1 },
  (_, i) => i + AGENT_CREW_PARALLEL_MIN,
).map((n) => ({ value: String(n), label: `${n} 路` }))

export function AgentCrewSettings(): JSX.Element {
  const [prefs, setPrefs] = useState<AgentCrewPrefs | null>(null)
  const [error, setError] = useState('')
  const [ok, setOk] = useState('')
  const [saving, setSaving] = useState(false)

  const reload = useCallback(async (): Promise<void> => {
    setError('')
    try {
      const next = await window.electronAPI.getAgentCrewPrefs()
      setPrefs(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : '无法读取班组设置')
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const save = useCallback(
    async (patch: Partial<AgentCrewPrefs>): Promise<void> => {
      if (!prefs) return
      const next: AgentCrewPrefs = { ...prefs, ...patch }
      setSaving(true)
      setOk('')
      setError('')
      setPrefs(next)
      try {
        const saved = await window.electronAPI.setAgentCrewPrefs(next)
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
  const autoOpen = prefs?.autoOpenPanelOnDispatch ?? AGENT_CREW_PREFS_DEFAULT.autoOpenPanelOnDispatch
  const maxParallel = prefs?.maxParallelWorkers ?? AGENT_CREW_PREFS_DEFAULT.maxParallelWorkers
  const showGraph = prefs?.showFlowAsGraph ?? AGENT_CREW_PREFS_DEFAULT.showFlowAsGraph

  return (
    <div className="settings-page agent-behavior-page">
      <SettingsPageIntro
        title="班组"
        description="长任务看板派工与工人编排。下列为班组派工偏好。"
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
        title="派工偏好"
        description="Work 模式派工后班组面板的行为与并行度。"
      >
        <SettingsCard divided>
          <SettingsToggle
            label="派工后自动打开班组面板"
            description="Work 模式向看板派工后，自动展开班组面板查看进度。关闭则保持当前视图。"
            checked={autoOpen}
            onCheckedChange={(v) => void save({ autoOpenPanelOnDispatch: v })}
            disabled={saving || !ready}
          />
          <SettingsSelect
            label="并行 worker 上限"
            description="本期仅落盘 + UI，调度器暂未接此上限（开关已生效但尚不据此限流）。"
            value={String(maxParallel)}
            onValueChange={(v) => void save({ maxParallelWorkers: Number(v) })}
            options={PARALLEL_OPTIONS}
            disabled={saving || !ready}
          />
          <SettingsToggle
            label="依赖用图展示"
            description="阶段3 预留偏好：开启后未来以依赖图展示任务关系；本期无图实现，仅作偏好落盘与文案提示。"
            checked={showGraph}
            onCheckedChange={(v) => void save({ showFlowAsGraph: v })}
            disabled={saving || !ready}
          />
        </SettingsCard>
      </SettingsSection>

      <p className="agent-behavior-field-hint">
        班组用于 Work 模式长任务派工：把任务拆到看板再派 headless 工人。
        <code>maxParallelWorkers</code> 与 <code>showFlowAsGraph</code> 本期为偏好落盘，运行时闸后续接入。
      </p>
    </div>
  )
}
