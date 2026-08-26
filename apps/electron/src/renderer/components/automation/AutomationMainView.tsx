import { useCallback, useEffect, useState } from 'react'
import { Clock3, Loader2, Pause, Pencil, Play, Plus, RefreshCw, Trash2 } from 'lucide-react'
import type { Automation } from '@tagent/shared'
import { formatScheduleLabel } from '@tagent/shared'
import { toast } from 'sonner'
import { AutomationSettings } from '../settings/AutomationSettings'

type AutomationApi = {
  listAutomations: () => Promise<Automation[]>
  toggleAutomation: (id: string) => Promise<Automation>
  deleteAutomation: (id: string) => Promise<boolean>
}
const getApi = (): AutomationApi => (window as unknown as { electronAPI: AutomationApi }).electronAPI
function nextRunLabel(timestamp: number): string {
  if (!timestamp) return '未安排'
  return new Date(timestamp).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
export function AutomationMainView(): JSX.Element {
  const [tasks, setTasks] = useState<Automation[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [editingTask, setEditingTask] = useState<Automation | null>(null)
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const selected = tasks.find((task) => task.id === selectedId) ?? null
  const reload = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const next = await getApi().listAutomations()
      setTasks(next)
      setSelectedId((current) => current && next.some((task) => task.id === current) ? current : next[0]?.id ?? null)
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '自动化任务加载失败')
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    void reload()
    const handleChanged = () => void reload()
    window.addEventListener('tagent:automations-changed', handleChanged)
    return () => window.removeEventListener('tagent:automations-changed', handleChanged)
  }, [reload])
  const toggleTask = async (id: string): Promise<void> => {
    setBusyId(id)
    try {
      const updated = await getApi().toggleAutomation(id)
      setTasks((current) => current.map((task) => task.id === id ? updated : task))
      window.dispatchEvent(new Event('tagent:automations-changed'))
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '切换任务状态失败')
    } finally {
      setBusyId(null)
    }
  }
  const deleteTask = async (task: Automation): Promise<void> => {
    if (!window.confirm(`确定删除「${task.name}」吗？运行历史也会一起删除。`)) return
    setBusyId(task.id)
    try {
      await getApi().deleteAutomation(task.id)
      const remaining = tasks.filter((item) => item.id !== task.id)
      setTasks(remaining)
      setSelectedId(remaining[0]?.id ?? null)
      window.dispatchEvent(new Event('tagent:automations-changed'))
      toast.success('自动化任务已删除')
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '删除失败')
    } finally {
      setBusyId(null)
    }
  }
  const openCreate = (): void => {
    setEditingTask(null)
    setCreating(true)
    setSelectedId(null)
  }
  const openEdit = (task: Automation): void => {
    setEditingTask(task)
    setCreating(true)
  }
  useEffect(() => {
    const handleSelected = (event: Event): void => {
      const id = (event as CustomEvent<{ id?: string }>).detail?.id
      if (!id) return
      setSelectedId(id)
      setEditingTask(null)
      setCreating(false)
    }
    const handleCreate = (): void => {
      setSelectedId(null)
      setEditingTask(null)
      setCreating(true)
    }
    window.addEventListener('tagent:automation-selected', handleSelected)
    window.addEventListener('tagent:automation-create', handleCreate)
    return () => {
      window.removeEventListener('tagent:automation-selected', handleSelected)
      window.removeEventListener('tagent:automation-create', handleCreate)
    }
  }, [])
  return (
    <div className="automation-workbench">
      <header className="automation-workbench-header">
        <div>
          <p className="automation-workbench-kicker">AUTOMATION</p>
          <h1 className="automation-workbench-title">自动化任务</h1>
          <p className="automation-workbench-subtitle">{tasks.length ? `${tasks.length} 个任务 · 后台持续运行` : '把重复工作交给 Agent'}</p>
        </div>
        <button type="button" onClick={() => void reload()} className="automation-toolbar-button" aria-label="刷新自动化任务"><RefreshCw size={15} className={loading ? 'animate-spin' : ''} /></button>
      </header>
      <div className="automation-workbench-body">
        <aside className="automation-task-sidebar" aria-label="自动化任务列表">
          <div className="automation-task-sidebar-header"><span>任务</span><button type="button" onClick={openCreate} className="automation-add-button" aria-label="新建自动化任务"><Plus size={15} /></button></div>
          <div className="automation-task-list">
            {loading ? <div className="automation-sidebar-empty"><Loader2 size={16} className="animate-spin" /></div> : tasks.length === 0 ? (
              <button type="button" onClick={openCreate} className="automation-sidebar-empty automation-sidebar-empty-action"><Plus size={17} /><span>新建第一条任务</span></button>
            ) : tasks.map((task) => (
              <button type="button" key={task.id} onClick={() => { setSelectedId(task.id); setCreating(false) }} data-active={selectedId === task.id && !creating ? 'true' : undefined} className="automation-task-item">
                <span className={`automation-task-status ${task.enabled ? 'is-enabled' : ''}`} aria-hidden="true" />
                <span className="min-w-0 flex-1 text-left"><span className="automation-task-item-name">{task.name || '未命名任务'}</span><span className="automation-task-item-meta">{formatScheduleLabel(task)}</span></span>
              </button>
            ))}
          </div>
        </aside>
        <main className={`automation-workbench-main ${creating ? 'is-creating' : ''}`}>
          {creating ? (
            <div className="automation-create-host">
              <AutomationSettings
                key={editingTask?.id ?? 'new'}
                editAutomation={editingTask}
                onSaved={(updated) => {
                  setTasks((current) => current.map((task) => task.id === updated.id ? updated : task))
                  setSelectedId(updated.id)
                  setEditingTask(null)
                  setCreating(false)
                }}
                onCancel={() => { setEditingTask(null); setCreating(false) }}
              />
            </div>
          ) : selected ? (
            <div className="automation-detail-scroll">
              <div className="automation-detail-heading">
                <div className="min-w-0"><p className="automation-detail-eyebrow">TASK</p><h2 className="truncate">{selected.name || '未命名任务'}</h2><p>{formatScheduleLabel(selected)}</p></div>
                <div className="automation-detail-actions">
                  <button type="button" onClick={() => openEdit(selected)} className="automation-secondary-button"><Pencil size={14} /> 编辑</button>
                  <button type="button" onClick={() => void toggleTask(selected.id)} disabled={busyId === selected.id} className="automation-secondary-button">{busyId === selected.id ? <Loader2 size={14} className="animate-spin" /> : selected.enabled ? <Pause size={14} /> : <Play size={14} />}{selected.enabled ? '暂停' : '启用'}</button>
                  <button type="button" onClick={() => void deleteTask(selected)} disabled={busyId === selected.id} className="automation-danger-button"><Trash2 size={14} /> 删除</button>
                </div>
              </div>
              <div className="automation-summary-grid">
                <SummaryCell label="状态" value={selected.enabled ? '运行中' : selected.completedAt ? '已完成' : '已暂停'} active={selected.enabled} />
                <SummaryCell label="下次执行" value={nextRunLabel(selected.nextRunAt)} />
                <SummaryCell label="已执行" value={`${selected.runCount ?? 0} 次`} />
                <SummaryCell label="连续失败" value={`${selected.consecutiveFailures ?? 0} 次`} />
              </div>
              <section className="automation-detail-card"><div className="automation-detail-card-heading"><span>任务指令</span><span>PROMPT</span></div><p className="automation-prompt">{selected.prompt}</p></section>
              <section className="automation-detail-card"><div className="automation-detail-card-heading"><span>执行环境</span><span>RUNTIME</span></div><dl className="automation-runtime-list"><div><dt>渠道</dt><dd>{selected.channelId}</dd></div><div><dt>模型</dt><dd>{selected.modelId || '渠道默认'}</dd></div><div><dt>权限</dt><dd>{selected.permissionMode === 'bypassPermissions' ? '自动执行' : '需审批'}</dd></div><div><dt>会话</dt><dd>{selected.sessionMode === 'reuse' ? '持续复用' : '按日复用'}</dd></div></dl></section>
            </div>
          ) : (
            <div className="automation-empty-main"><Clock3 size={28} /><h2>还没有自动化任务</h2><p>从左侧创建一条任务，让 Agent 接手重复工作。</p><button type="button" onClick={openCreate} className="automation-primary-button"><Plus size={15} /> 创建任务</button></div>
          )}
        </main>
      </div>
    </div>
  )
}
function SummaryCell({ label, value, active }: { label: string; value: string; active?: boolean }): JSX.Element {
  return <div className="automation-summary-cell"><span>{label}</span><strong data-tone={active ? 'active' : undefined}>{value}</strong></div>
}

