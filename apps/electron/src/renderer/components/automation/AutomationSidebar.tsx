import { useCallback, useEffect, useState } from 'react'
import { Clock3, Loader2, Plus, RefreshCw } from 'lucide-react'
import type { Automation } from '@tagent/shared'
import { formatScheduleLabel } from '@tagent/shared'
import { toast } from 'sonner'

type AutomationApi = {
  listAutomations: () => Promise<Automation[]>
}

const getApi = (): AutomationApi =>
  (window as unknown as { electronAPI: AutomationApi }).electronAPI

export function AutomationSidebar(): JSX.Element {
  const [tasks, setTasks] = useState<Automation[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const next = await getApi().listAutomations()
      setTasks(next)
      setSelectedId((current) =>
        current && next.some((task) => task.id === current)
          ? current
          : next[0]?.id ?? null,
      )
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '自动化任务加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
    const handleChanged = (): void => void reload()
    window.addEventListener('tagent:automations-changed', handleChanged)
    return () => window.removeEventListener('tagent:automations-changed', handleChanged)
  }, [reload])

  const selectTask = (id: string): void => {
    setSelectedId(id)
    window.dispatchEvent(new CustomEvent('tagent:automation-selected', { detail: { id } }))
  }

  const openCreate = (): void => {
    setSelectedId(null)
    window.dispatchEvent(new Event('tagent:automation-create'))
  }

  return (
    <div className="automation-native-sidebar">
      <div className="automation-native-sidebar-header">
        <div>
          <p className="automation-native-sidebar-kicker">AUTOMATION</p>
          <h2>任务</h2>
        </div>
        <div className="automation-native-sidebar-actions">
          <button type="button" onClick={() => void reload()} aria-label="刷新自动化任务">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
          <button type="button" onClick={openCreate} aria-label="新建自动化任务">
            <Plus size={15} />
          </button>
        </div>
      </div>
      <div className="automation-native-task-list">
        {loading ? (
          <div className="automation-native-sidebar-empty"><Loader2 size={16} className="animate-spin" /></div>
        ) : tasks.length === 0 ? (
          <button type="button" onClick={openCreate} className="automation-native-sidebar-empty">
            <Clock3 size={18} />
            <span>新建第一条任务</span>
          </button>
        ) : (
          tasks.map((task) => (
            <button
              type="button"
              key={task.id}
              className="automation-native-task-item"
              data-active={selectedId === task.id || undefined}
              onClick={() => selectTask(task.id)}
            >
              <span className={task.enabled ? 'automation-native-task-dot is-enabled' : 'automation-native-task-dot'} aria-hidden />
              <span className="min-w-0 flex-1 text-left">
                <span className="automation-native-task-name">{task.name || '未命名任务'}</span>
                <span className="automation-native-task-meta">{formatScheduleLabel(task)}</span>
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  )
}
