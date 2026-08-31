import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Check, Clock3, Loader2, Pause, Play, Plus, Trash2 } from 'lucide-react'
import type { Automation, Channel, CreateAutomationInput, UpdateAutomationInput } from '@tagent/shared'
import { formatScheduleLabel } from '@tagent/shared'
import { toast } from 'sonner'
import {
  DestructiveConfirmDialog,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SettingsPageIntro,
} from '@tagent/ui'

type AutomationApi = {
  listAutomations: () => Promise<Automation[]>
  createAutomation: (input: CreateAutomationInput) => Promise<Automation>
  updateAutomation: (input: UpdateAutomationInput) => Promise<Automation>
  toggleAutomation: (id: string) => Promise<Automation>
  deleteAutomation: (id: string) => Promise<boolean>
  listChannels: () => Promise<Channel[]>
}

type Draft = {
  name: string
  prompt: string
  scheduleType: CreateAutomationInput['scheduleType']
  intervalMinutes: number
  timeOfDay: string
  dayOfWeek: number
  dayOfMonth: number
  scheduledAt: string
  channelId: string
  modelId: string
}

const getApi = (): AutomationApi =>
  (window as unknown as { electronAPI: AutomationApi }).electronAPI

const newDraft = (channel?: Channel): Draft => ({
  name: '',
  prompt: '',
  scheduleType: 'daily',
  intervalMinutes: 60,
  timeOfDay: '09:00',
  dayOfWeek: 1,
  dayOfMonth: 1,
  scheduledAt: '',
  channelId: channel?.id ?? '',
  modelId: channel?.defaultModelId ?? channel?.models.find((item) => item.enabled)?.id ?? '',
})

function channelModels(channel: Channel | undefined): Channel['models'] {
  return channel?.models.filter((item) => item.enabled) ?? []
}

function toDateTimeLocal(timestamp?: number): string {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function draftFromAutomation(automation: Automation): Draft {
  return {
    name: automation.name,
    prompt: automation.prompt,
    scheduleType: automation.scheduleType,
    intervalMinutes: automation.intervalMinutes || 60,
    timeOfDay: automation.timeOfDay || '09:00',
    dayOfWeek: automation.dayOfWeek ?? 1,
    dayOfMonth: automation.dayOfMonth ?? 1,
    scheduledAt: toDateTimeLocal(automation.scheduledAt),
    channelId: automation.channelId,
    modelId: automation.modelId || '',
  }
}

type AutomationSettingsProps = {
  editAutomation?: Automation | null
  onSaved?: (automation: Automation) => void
  onCancel?: () => void
}

export function AutomationSettings({ editAutomation = null, onSaved, onCancel }: AutomationSettingsProps = {}): JSX.Element {
  const [automations, setAutomations] = useState<Automation[]>([])
  const [channels, setChannels] = useState<Channel[]>([])
  const [editingId, setEditingId] = useState<string | null>(editAutomation?.id ?? null)
  const [draft, setDraft] = useState<Draft>(() => editAutomation ? draftFromAutomation(editAutomation) : newDraft())
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Automation | null>(null)
  const [error, setError] = useState<string | null>(null)

  const selectedChannel = useMemo(
    () => channels.find((item) => item.id === draft.channelId),
    [channels, draft.channelId],
  )

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const [nextAutomations, nextChannels] = await Promise.all([
        getApi().listAutomations(),
        getApi().listChannels(),
      ])
      setAutomations(nextAutomations)
      setChannels(nextChannels.filter((item) => item.enabled))
      setDraft((current) => {
        if (editingId) return current
        if (current.channelId && nextChannels.some((item) => item.id === current.channelId)) {
          return current
        }
        return newDraft(nextChannels.find((item) => item.enabled))
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '自动化任务加载失败')
    } finally {
      setLoading(false)
    }
  }, [editingId])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    if (!editAutomation) return
    setEditingId(editAutomation.id)
    setDraft(draftFromAutomation(editAutomation))
  }, [editAutomation?.id, editAutomation?.updatedAt])

  const updateDraft = <K extends keyof Draft>(key: K, value: Draft[K]): void => {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  const handleChannelChange = (channelId: string): void => {
    const channel = channels.find((item) => item.id === channelId)
    setDraft((current) => ({
      ...current,
      channelId,
      modelId: channel?.defaultModelId ?? channel?.models.find((item) => item.enabled)?.id ?? '',
    }))
  }

  const handleCreate = async (): Promise<void> => {
    if (!draft.name.trim()) {
      toast.error('请填写任务名称')
      return
    }
    if (!draft.prompt.trim()) {
      toast.error('请填写任务指令')
      return
    }
    if (!draft.channelId) {
      toast.error('请先配置并选择一个 AI 渠道')
      return
    }
    if (draft.scheduleType === 'once' && !draft.scheduledAt) {
      toast.error('请选择一次性任务的执行时间')
      return
    }

    setSaving(true)
    try {
      const input: CreateAutomationInput = {
        name: draft.name.trim(),
        prompt: draft.prompt.trim(),
        scheduleType: draft.scheduleType,
        intervalMinutes: Math.max(1, draft.intervalMinutes),
        timeOfDay: draft.timeOfDay,
        dayOfWeek: draft.dayOfWeek,
        dayOfMonth: draft.dayOfMonth,
        scheduledAt: draft.scheduledAt ? new Date(draft.scheduledAt).getTime() : undefined,
        channelId: draft.channelId,
        modelId: draft.modelId || undefined,
        active: true,
        permissionMode: 'bypassPermissions',
      }
      const created = await getApi().createAutomation(input)
      setAutomations((current) => [created, ...current])
      setDraft(newDraft(selectedChannel))
      window.dispatchEvent(new Event('tagent:automations-changed'))
      toast.success('自动化任务已创建')
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '创建失败')
    } finally {
      setSaving(false)
    }
  }

  const handleUpdate = async (): Promise<void> => {
    if (!editingId) return
    if (!draft.name.trim()) {
      toast.error('请填写任务名称')
      return
    }
    if (!draft.prompt.trim()) {
      toast.error('请填写任务指令')
      return
    }
    if (!draft.channelId) {
      toast.error('请先配置并选择一个 AI 渠道')
      return
    }
    if (draft.scheduleType === 'once' && !draft.scheduledAt) {
      toast.error('请选择一次性任务的执行时间')
      return
    }
    setSaving(true)
    try {
      const input: UpdateAutomationInput = {
        id: editingId,
        name: draft.name.trim(),
        prompt: draft.prompt.trim(),
        scheduleType: draft.scheduleType,
        intervalMinutes: Math.max(1, draft.intervalMinutes),
        timeOfDay: draft.timeOfDay,
        dayOfWeek: draft.dayOfWeek,
        dayOfMonth: draft.dayOfMonth,
        scheduledAt: draft.scheduledAt ? new Date(draft.scheduledAt).getTime() : undefined,
        channelId: draft.channelId,
        modelId: draft.modelId || undefined,
        enabled: editAutomation?.enabled ?? automations.find((item) => item.id === editingId)?.enabled ?? true,
      }
      const updated = await getApi().updateAutomation(input)
      setAutomations((current) => current.map((item) => (item.id === updated.id ? updated : item)))
      window.dispatchEvent(new Event('tagent:automations-changed'))
      toast.success('自动化任务已更新')
      onSaved?.(updated)
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleToggle = async (id: string): Promise<void> => {
    setBusyId(id)
    try {
      const updated = await getApi().toggleAutomation(id)
      setAutomations((current) => current.map((item) => (item.id === id ? updated : item)))
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '切换任务状态失败')
    } finally {
      setBusyId(null)
    }
  }

  const requestDelete = (automation: Automation): void => {
    setDeleteTarget(automation)
  }
  const confirmDelete = async (): Promise<void> => {
    const automation = deleteTarget
    if (!automation) return
    setBusyId(automation.id)
    try {
      await getApi().deleteAutomation(automation.id)
      setAutomations((current) => current.filter((item) => item.id !== automation.id))
      setDeleteTarget(null)
      toast.success('自动化任务已删除')
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '删除失败')
    } finally {
      setBusyId(null)
    }
  }

  const models = channelModels(selectedChannel)

  return (
    <div className="settings-page settings-automation-page">
      <SettingsPageIntro
        title="自动化"
        description="让 Agent 按固定节奏执行重复工作。任务会在后台运行，并使用独立的自动会话。"
      />

      <section className="settings-section-card">
        <div className="settings-section-card-header">
          <div>
            <h2 className="settings-section-card-title">{editingId ? '编辑任务' : '新建任务'}</h2>
            <p className="settings-section-card-description">{editingId ? '修改任务内容和执行频率，保存后立即生效。' : '只需要填写任务指令和执行频率，保存后立即启用。'}</p>
          </div>
          <Clock3 size={17} className="text-foreground/35" aria-hidden="true" />
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <label className="settings-field">
            <span className="settings-field-label">任务名称</span>
            <input value={draft.name} onChange={(event) => updateDraft('name', event.target.value)} placeholder="例如：整理今日项目进展" className="settings-input" />
          </label>
          <label className="settings-field">
            <span className="settings-field-label">执行频率</span>
            <Select value={draft.scheduleType} onValueChange={(value) => updateDraft('scheduleType', value as Draft['scheduleType'])}>
              <SelectTrigger className="settings-input settings-select-trigger">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="scrollbar-thin !z-[130]">
                <SelectItem value="interval">每隔一段时间</SelectItem>
                <SelectItem value="daily">每天</SelectItem>
                <SelectItem value="weekly">每周</SelectItem>
                <SelectItem value="monthly">每月</SelectItem>
                <SelectItem value="once">执行一次</SelectItem>
              </SelectContent>
            </Select>
          </label>

          {draft.scheduleType === 'interval' ? (
            <label className="settings-field">
              <span className="settings-field-label">间隔分钟</span>
              <input type="number" min={1} value={draft.intervalMinutes} onChange={(event) => updateDraft('intervalMinutes', Number(event.target.value))} className="settings-input" />
            </label>
          ) : null}

          {draft.scheduleType === 'weekly' ? (
            <label className="settings-field">
              <span className="settings-field-label">星期</span>
              <Select value={String(draft.dayOfWeek)} onValueChange={(value) => updateDraft('dayOfWeek', Number(value))}>
                <SelectTrigger className="settings-input settings-select-trigger">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="scrollbar-thin !z-[130]">
                  <SelectItem value="1">周一</SelectItem><SelectItem value="2">周二</SelectItem><SelectItem value="3">周三</SelectItem><SelectItem value="4">周四</SelectItem><SelectItem value="5">周五</SelectItem><SelectItem value="6">周六</SelectItem><SelectItem value="0">周日</SelectItem>
                </SelectContent>
              </Select>
            </label>
          ) : null}

          {draft.scheduleType === 'monthly' ? (
            <label className="settings-field">
              <span className="settings-field-label">每月几号</span>
              <input type="number" min={1} max={31} value={draft.dayOfMonth} onChange={(event) => updateDraft('dayOfMonth', Number(event.target.value))} className="settings-input" />
            </label>
          ) : null}

          {draft.scheduleType === 'once' ? (
            <label className="settings-field">
              <span className="settings-field-label">执行时间</span>
              <input type="datetime-local" value={draft.scheduledAt} onChange={(event) => updateDraft('scheduledAt', event.target.value)} className="settings-input" />
            </label>
          ) : null}

          {draft.scheduleType !== 'once' ? (
            <label className="settings-field">
              <span className="settings-field-label">执行时刻</span>
              <input type="time" value={draft.timeOfDay} onChange={(event) => updateDraft('timeOfDay', event.target.value)} className="settings-input" />
            </label>
          ) : null}

          <label className="settings-field">
            <span className="settings-field-label">AI 渠道</span>
            <Select value={draft.channelId || '__none__'} onValueChange={(value) => handleChannelChange(value === '__none__' ? '' : value)} disabled={channels.length === 0}>
              <SelectTrigger className="settings-input settings-select-trigger">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="scrollbar-thin !z-[130]">
                {channels.length === 0 ? <SelectItem value="__none__" disabled>暂无可用渠道</SelectItem> : null}
                {channels.map((channel) => <SelectItem key={channel.id} value={channel.id}>{channel.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </label>

          <label className="settings-field">
            <span className="settings-field-label">模型（可选）</span>
            <Select value={draft.modelId || '__default__'} onValueChange={(value) => updateDraft('modelId', value === '__default__' ? '' : value)} disabled={models.length === 0}>
              <SelectTrigger className="settings-input settings-select-trigger">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="scrollbar-thin !z-[130]">
                <SelectItem value="__default__">使用渠道默认模型</SelectItem>
                {models.map((model) => <SelectItem key={model.id} value={model.id}>{model.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </label>

          <label className="settings-field md:col-span-2">
            <span className="settings-field-label">任务指令</span>
            <textarea value={draft.prompt} onChange={(event) => updateDraft('prompt', event.target.value)} placeholder="例如：检查仓库最近一天的变更，整理成三点摘要，并指出需要我关注的风险。" rows={4} className="settings-input min-h-[104px] resize-y" />
            <span className="settings-field-hint">自动执行时会直接把这段指令交给 Agent。</span>
          </label>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          {editingId && onCancel ? (
            <button type="button" onClick={onCancel} disabled={saving} className="settings-secondary-button">取消编辑</button>
          ) : null}
          <button type="button" onClick={() => void (editingId ? handleUpdate() : handleCreate())} disabled={saving || channels.length === 0} className="settings-primary-button">
            {saving ? <Loader2 size={14} className="animate-spin" /> : editingId ? <Check size={14} /> : <Plus size={14} />}
            {editingId ? '保存修改' : '创建并启用'}
          </button>
        </div>
      </section>

      <section className="settings-section-card">
        <div className="settings-section-card-header">
          <div>
            <h2 className="settings-section-card-title">任务列表</h2>
            <p className="settings-section-card-description">{automations.length ? `${automations.length} 个任务` : '还没有自动化任务'}</p>
          </div>
          <button type="button" onClick={() => void reload()} className="settings-secondary-button" aria-label="刷新任务列表">刷新</button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-10 text-foreground/40"><Loader2 size={18} className="animate-spin" aria-label="正在加载" /></div>
        ) : error ? (
          <div className="settings-empty-state" role="alert"><p>{error}</p><button type="button" onClick={() => void reload()} className="settings-secondary-button">重试</button></div>
        ) : automations.length === 0 ? (
          <div className="settings-empty-state"><Check size={18} className="text-foreground/30" aria-hidden="true" /><p>创建第一条任务后，它会显示在这里。</p></div>
        ) : (
          <div className="space-y-2">
            {automations.map((automation) => (
              <div key={automation.id} className="settings-list-row">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className={`size-2 rounded-full ${automation.enabled ? 'bg-emerald-500' : 'bg-foreground/25'}`} aria-hidden="true" />
                    <span className="truncate text-[13px] font-medium">{automation.name}</span>
                    <span className="shrink-0 text-[10px] text-foreground/45">{automation.enabled ? '运行中' : '已暂停'}</span>
                  </div>
                  <p className="mt-1 truncate text-[11px] text-foreground/45">{formatScheduleLabel(automation)} · 已执行 {automation.runCount ?? 0} 次</p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button type="button" onClick={() => void handleToggle(automation.id)} disabled={busyId === automation.id} className="settings-icon-button" aria-label={automation.enabled ? `暂停 ${automation.name}` : `启用 ${automation.name}`} title={automation.enabled ? '暂停' : '启用'}>
                    {busyId === automation.id ? <Loader2 size={14} className="animate-spin" /> : automation.enabled ? <Pause size={14} /> : <Play size={14} />}
                  </button>
                  <button type="button" onClick={() => requestDelete(automation)} disabled={busyId === automation.id} className="settings-icon-button settings-icon-button--danger" aria-label={`删除 ${automation.name}`} title="删除">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
      <DestructiveConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => { if (!open && !busyId) setDeleteTarget(null) }}
        title="删除自动化任务？"
        description={deleteTarget ? <>确定删除「{deleteTarget.name}」吗？运行历史也会一起删除。</> : null}
        confirmLabel="删除任务"
        onConfirm={confirmDelete}
        icon={<AlertTriangle size={16} aria-hidden="true" />}
      />
    </div>
  )
}

