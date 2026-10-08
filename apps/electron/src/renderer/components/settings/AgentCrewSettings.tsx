/**
 * 设置 · Agent 行为 → 子代理调度（沿用 agent-crew 偏好）
 *
 * 落盘 ~/.tagent[-dev]/agent-crew-prefs.json；主进程整单校验，非法 reject 中文错。
 * 视觉对齐 AgentBehaviorSettings / NoProgressGuardSettings（agent-behavior-* 样式）。
 *
 * 班组暂停；保留子代理并发与模型画像，隐藏班组专属配置但不清除存储。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2 } from 'lucide-react'
import {
  Button,
  SettingsCard,
  SettingsPageIntro,
  SettingsSection,
  SettingsSelect,
} from '@tagent/ui'
import {
  AGENT_CREW_PREFS_DEFAULT,
  AGENT_CREW_PARALLEL_MIN,
  AGENT_CREW_PARALLEL_MAX,
  type AgentCrewPrefs,
  type DelegationModelProfile,
  isLocalRuntimeProvider,
  isMoaModelId,
  CREW_ORCHESTRATION_ENABLED,
  CREW_PAUSED_MESSAGE,
} from '@tagent/shared'
import { useAtomValue } from 'jotai'
import { channelsAtom } from '../../atoms/channel-atoms'

type AgentCrewPrefsWithProfiles = AgentCrewPrefs & {
  modelProfiles?: DelegationModelProfile[]
}

const PROFILE_OPTIONS = {
  strength: [
    { value: 'unknown', label: '未知' },
    { value: 'standard', label: '标准' },
    { value: 'strong', label: '强' },
  ],
  speed: [
    { value: 'unknown', label: '未知' },
    { value: 'fast', label: '快' },
    { value: 'balanced', label: '均衡' },
    { value: 'slow', label: '慢' },
  ],
  cost: [
    { value: 'unknown', label: '未知' },
    { value: 'low', label: '低' },
    { value: 'medium', label: '中' },
    { value: 'high', label: '高' },
  ],
} as const

export function emptyModelProfile(channelId: string, modelId: string): DelegationModelProfile {
  return { channelId, modelId, enabled: true, strength: 'unknown', speed: 'unknown', cost: 'unknown', goodFor: [] }
}

function profileKey(profile: Pick<DelegationModelProfile, 'channelId' | 'modelId'>): string {
  return `${profile.channelId}\u0000${profile.modelId}`
}

export function getAvailableModelProfiles(
  channels: import('@tagent/shared').Channel[],
  existing: DelegationModelProfile[],
): DelegationModelProfile[] {
  const current = new Map(existing.map((profile) => [profileKey(profile), profile]))
  return channels
    .filter((channel) => channel.enabled && !isLocalRuntimeProvider(channel.provider))
    .flatMap((channel) => channel.models
      .filter((model) => model.enabled && !isMoaModelId(model.id))
      .map((model) => current.get(profileKey({ channelId: channel.id, modelId: model.id })) ?? emptyModelProfile(channel.id, model.id)))
}

export function mergeModelProfiles(
  visible: DelegationModelProfile[],
  existing: DelegationModelProfile[],
): DelegationModelProfile[] {
  const merged = new Map<string, DelegationModelProfile>()
  for (const profile of [...existing, ...visible]) merged.set(profileKey(profile), profile)
  return [...merged.values()]
}

/** 并行 worker 上限选项（1–8） */
const PARALLEL_OPTIONS = Array.from(
  { length: AGENT_CREW_PARALLEL_MAX - AGENT_CREW_PARALLEL_MIN + 1 },
  (_, i) => i + AGENT_CREW_PARALLEL_MIN,
).map((n) => ({ value: String(n), label: `${n} 路` }))

export function AgentCrewSettings(): JSX.Element {
  const channels = useAtomValue(channelsAtom)
  const [prefs, setPrefs] = useState<AgentCrewPrefsWithProfiles | null>(null)
  const [draftProfiles, setDraftProfiles] = useState<DelegationModelProfile[]>([])
  const [error, setError] = useState('')
  const [ok, setOk] = useState('')
  const [saving, setSaving] = useState(false)
  const saveLockRef = useRef<Promise<void> | null>(null)
  const prefsRef = useRef<AgentCrewPrefsWithProfiles | null>(null)
  prefsRef.current = prefs

  const reload = useCallback(async (): Promise<void> => {
    setError('')
    try {
      const next = await window.electronAPI.getAgentCrewPrefs()
      const withProfiles = next as AgentCrewPrefsWithProfiles
      setPrefs(withProfiles)
      setDraftProfiles(withProfiles.modelProfiles?.map((profile) => ({ ...profile, goodFor: [...profile.goodFor] })) ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : '无法读取子代理调度设置')
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const save = useCallback(
    async (patch: Partial<AgentCrewPrefsWithProfiles>): Promise<void> => {
      const run = async (): Promise<void> => {
      const base = prefsRef.current
      if (!base) return
      const next: AgentCrewPrefsWithProfiles = { ...base, ...patch }
      setSaving(true)
      setOk('')
      setError('')
      setPrefs(next)
      try {
        const saved = await window.electronAPI.setAgentCrewPrefs(next)
        const savedPrefs = saved as AgentCrewPrefsWithProfiles
        setPrefs(savedPrefs)
        prefsRef.current = savedPrefs
        setOk('已保存')
      } catch (e) {
        setPrefs(base)
        prefsRef.current = base
        setError(e instanceof Error ? e.message : '保存失败')
      } finally {
        setSaving(false)
      }
      }
      const queued = (saveLockRef.current ?? Promise.resolve()).then(run, run)
      const released = queued.finally(() => {
        if (saveLockRef.current === released) saveLockRef.current = null
      })
      saveLockRef.current = released
      await queued
    },
    [prefs],
  )

  const availableProfiles = useMemo(() => {
    return getAvailableModelProfiles(channels, draftProfiles)
  }, [channels, draftProfiles])

  const preservedProfiles = useMemo(() => {
    const available = new Set(availableProfiles.map(profileKey))
    return draftProfiles.filter((profile) => !available.has(profileKey(profile)))
  }, [availableProfiles, draftProfiles])

  const updateProfile = (profile: DelegationModelProfile, patch: Partial<DelegationModelProfile>): void => {
    const key = profileKey(profile)
    setDraftProfiles((current) => {
      const found = current.findIndex((item) => profileKey(item) === key)
      const next = { ...profile, ...patch }
      if (found < 0) return [...current, next]
      return current.map((item, index) => index === found ? next : item)
    })
  }

  const saveProfiles = async (): Promise<void> => {
    if (!prefs) return
    // Materialize visible defaults on explicit save, while retaining profiles
    // for channels/models that are currently disabled or gone.
    await save({ modelProfiles: mergeModelProfiles(availableProfiles, draftProfiles) })
  }

  const ready = Boolean(prefs)
  const maxParallel = prefs?.maxParallelWorkers ?? AGENT_CREW_PREFS_DEFAULT.maxParallelWorkers

  return (
    <div className="settings-page agent-behavior-page">
      <SettingsPageIntro
        title="子代理调度"
        description="配置子代理模型与并发能力。"
      />

      {!CREW_ORCHESTRATION_ENABLED ? (
        <div className="agent-behavior-notice" role="status">
          <AlertCircle size={15} />
          <span className="agent-behavior-notice-copy">{CREW_PAUSED_MESSAGE}</span>
        </div>
      ) : null}

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
        description="控制同一主会话下前台与后台子代理的并发。"
      >
        <SettingsCard divided>
          <SettingsSelect
            label="同时运行的子代理上限"
            description="同一主会话下前台与后台子代理共享此上限。"
            value={String(maxParallel)}
            onValueChange={(v) => void save({ maxParallelWorkers: Number(v) })}
            options={PARALLEL_OPTIONS}
            disabled={saving || !ready}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="子代理模型画像"
        description="只列出已启用的外部渠道模型。画像是你的校准，不是自动 benchmark；未知不会被当作强或快。"
      >
        <SettingsCard divided>
          {availableProfiles.length === 0 ? (
            <p className="agent-behavior-field-hint">暂无可派发的外部模型，请先在渠道设置中启用渠道和模型。</p>
          ) : availableProfiles.map((profile) => {
            const channel = channels.find((item) => item.id === profile.channelId)
            const model = channel?.models.find((item) => item.id === profile.modelId)
            return (
              <div key={profileKey(profile)} className="space-y-3 border-b border-border p-4 last:border-b-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-medium">{channel?.name ?? profile.channelId} / {model?.name ?? profile.modelId}</p>
                    <p className="text-xs text-muted-foreground">用户校准画像，仅影响默认主模型挑选与派发偏好。</p>
                  </div>
                  <label className="flex min-h-11 items-center gap-2 text-sm">
                    <input type="checkbox" checked={profile.enabled} onChange={(event) => updateProfile(profile, { enabled: event.target.checked })} />
                    可派发
                  </label>
                </div>
                <div className="grid gap-2 sm:grid-cols-3">
                  <SettingsSelect label="强度" value={profile.strength} onValueChange={(value) => updateProfile(profile, { strength: value as DelegationModelProfile['strength'] })} options={[...PROFILE_OPTIONS.strength]} disabled={saving} />
                  <SettingsSelect label="速度" value={profile.speed} onValueChange={(value) => updateProfile(profile, { speed: value as DelegationModelProfile['speed'] })} options={[...PROFILE_OPTIONS.speed]} disabled={saving} />
                  <SettingsSelect label="成本" value={profile.cost} onValueChange={(value) => updateProfile(profile, { cost: value as DelegationModelProfile['cost'] })} options={[...PROFILE_OPTIONS.cost]} disabled={saving} />
                </div>
                <label className="block text-sm">
                  <span className="mb-1 block font-medium">适合任务</span>
                  <input className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" value={profile.goodFor.join(', ')} onChange={(event) => updateProfile(profile, { goodFor: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) })} placeholder="例如：摘要、检索、代码审查" disabled={saving} />
                  <span className="mt-1 block text-xs text-muted-foreground">用逗号分隔；不会自动测试或推断能力。</span>
                </label>
              </div>
            )
          })}
          {preservedProfiles.length > 0 ? (
            <div className="space-y-1 p-4 text-xs text-muted-foreground" role="status">
              <p className="font-medium text-foreground">已保留的历史画像</p>
              <p>以下画像对应已禁用或已删除的渠道/模型，本次不会抹除：{preservedProfiles.map((profile) => `${profile.channelId} / ${profile.modelId}`).join('、')}</p>
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-3 border-t border-border p-4">
            <p className="text-xs text-muted-foreground">修改后点击保存画像，避免每次输入都触发 IPC。</p>
            <Button type="button" onClick={() => void saveProfiles()} disabled={!ready || saving}>保存画像</Button>
          </div>
        </SettingsCard>
      </SettingsSection>

      <p className="agent-behavior-field-hint">
        使用子代理完成委派。<code>maxParallelWorkers</code> 控制同一主会话下子代理的共享并发上限。
      </p>
    </div>
  )
}
