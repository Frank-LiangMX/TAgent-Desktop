/**
 * 设置 · Agent 行为 → 子代理
 *
 * 范围：
 * - 委派积极性（全局默认；会话可单独覆盖）
 * - 默认后端：内置（进程内）| 本机 CLI
 * - 本机 CLI 时：启用池 + 优先级排序（列表顺序）；主会话 task 可指定 cli，省略则按序自动选
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAtom } from 'jotai'
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  RefreshCw,
} from 'lucide-react'
import {
  SettingsCard,
  SettingsSelect,
  SettingsSection,
} from '@tagent/ui'
import {
  moveWorkerPriority,
  syncDefaultCliId,
  type CliWorkerBackend,
  type CliWorkerEntry,
  type CliWorkersConfig,
  type CliWorkerProbeItem,
  type CliWorkersProbeResult,
  type SubagentEagerness,
} from '@tagent/shared'
import {
  readSubagentEagernessDefault,
  subagentEagernessDefaultAtom,
} from '../../atoms/subagent-prefs'
import {
  SUBAGENT_EAGERNESS_CONFIG,
  SUBAGENT_EAGERNESS_ORDER,
} from '../chat/subagent-ui-model'

type Notice = { kind: 'success' | 'error'; message: string } | null

function workerLabel(id: string): string {
  return id
}

const BACKEND_OPTIONS: Array<{ value: CliWorkerBackend; label: string }> = [
  { value: 'in-process', label: '内置子代理' },
  { value: 'cli', label: '本机 CLI' },
]

export function CliWorkersSettingsSection(): JSX.Element {
  const [cfg, setCfgState] = useState<CliWorkersConfig | null>(null)
  const [loadError, setLoadError] = useState('')
  const [notice, setNotice] = useState<Notice>(null)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [probeMap, setProbeMap] = useState<Record<string, CliWorkerProbeItem>>({})
  const [probing, setProbing] = useState(false)
  /** 高级：路径 / 模型 */
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [eagernessRaw, setEagernessRaw] = useAtom(subagentEagernessDefaultAtom)
  const eagerness = readSubagentEagernessDefault(eagernessRaw)

  const eagernessOptions = useMemo(
    () =>
      SUBAGENT_EAGERNESS_ORDER.map((level) => ({
        value: level,
        label: SUBAGENT_EAGERNESS_CONFIG[level].label,
      })),
    [],
  )

  const cfgRef = useRef<CliWorkersConfig | null>(null)
  const noticeTimerRef = useRef<number | null>(null)

  const setCfg = useCallback((next: CliWorkersConfig | null): void => {
    cfgRef.current = next
    setCfgState(next)
  }, [])

  const showNotice = useCallback((n: Notice): void => {
    if (noticeTimerRef.current != null) {
      window.clearTimeout(noticeTimerRef.current)
      noticeTimerRef.current = null
    }
    setNotice(n)
    if (n?.kind === 'success') {
      noticeTimerRef.current = window.setTimeout(() => {
        setNotice(null)
        noticeTimerRef.current = null
      }, 2500)
    }
  }, [])

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current != null) window.clearTimeout(noticeTimerRef.current)
    }
  }, [])

  /** 仅用户点击时探测——进页不扫 */
  const runProbe = useCallback(async (): Promise<void> => {
    setProbing(true)
    showNotice(null)
    try {
      const snap: CliWorkersProbeResult = await window.electronAPI.probeCliWorkers(
        cfgRef.current ?? undefined,
      )
      const map: Record<string, CliWorkerProbeItem> = {}
      for (const w of snap.workers) map[w.id] = w
      setProbeMap(map)
      const ok = snap.workers.filter((w) => w.available).length
      const total = snap.workers.length
      showNotice({
        kind: 'success',
        message: `检测完成：${ok}/${total} 个本机可用`,
      })
    } catch (error) {
      showNotice({
        kind: 'error',
        message: error instanceof Error ? error.message : '本机检测失败',
      })
    } finally {
      setProbing(false)
    }
  }, [showNotice])

  const reload = useCallback(async (): Promise<void> => {
    setLoadError('')
    try {
      const loaded = await window.electronAPI.listCliWorkersConfig()
      setCfg(loaded)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : '无法读取子代理配置')
    }
  }, [setCfg])

  useEffect(() => {
    void reload()
  }, [reload])

  const save = useCallback(
    async (next: CliWorkersConfig, successMsg?: string): Promise<void> => {
      const prev = cfgRef.current
      const synced = syncDefaultCliId(next)
      setCfg(synced)
      setSaving(true)
      showNotice(null)
      try {
        const saved = await window.electronAPI.saveCliWorkersConfig(synced)
        setCfg(saved)
        if (successMsg) showNotice({ kind: 'success', message: successMsg })
      } catch (error) {
        setCfg(prev)
        showNotice({
          kind: 'error',
          message: error instanceof Error ? error.message : '保存失败',
        })
      } finally {
        setSaving(false)
      }
    },
    [setCfg, showNotice],
  )

  /**
   * 默认后端：内置 ↔ 本机 CLI。
   * 内置：enabled=false + in-process。
   * 本机 CLI：enabled=true + cli（task 从启用池按优先级/指定 cli 挑选）。
   */
  const handleBackendChange = useCallback(
    (backend: string): void => {
      const cur = cfgRef.current
      if (!cur) return
      const nextBackend: CliWorkerBackend =
        backend === 'cli' ? 'cli' : 'in-process'
      const next: CliWorkersConfig = {
        ...cur,
        enabled: nextBackend === 'cli',
        defaultBackend: nextBackend,
      }
      void save(
        next,
        nextBackend === 'cli' ? '默认后端：本机 CLI' : '默认后端：内置子代理',
      )
    },
    [save],
  )

  const handleWorkerToggle = useCallback(
    (id: string, enabled: boolean): void => {
      const cur = cfgRef.current
      if (!cur) return
      const next: CliWorkersConfig = {
        ...cur,
        workers: cur.workers.map((x) => (x.id === id ? { ...x, enabled } : x)),
      }
      void save(syncDefaultCliId(next))
    },
    [save],
  )

  const handleMovePriority = useCallback(
    (id: string, direction: 'up' | 'down'): void => {
      const cur = cfgRef.current
      if (!cur) return
      const next = moveWorkerPriority(cur, id, direction)
      if (next === cur) return
      void save(next, direction === 'up' ? '已提高优先级' : '已降低优先级')
    },
    [save],
  )

  const updateWorkerField = useCallback(
    (id: string, patch: Partial<CliWorkerEntry>): void => {
      const cur = cfgRef.current
      if (!cur) return
      setCfg({
        ...cur,
        workers: cur.workers.map((x) => (x.id === id ? { ...x, ...patch } : x)),
      })
      setDirty(true)
    },
    [setCfg],
  )

  const handleWorkerBlur = useCallback((): void => {
    if (!dirty) return
    setDirty(false)
    const cur = cfgRef.current
    if (!cur) return
    void save(cur, '已保存')
  }, [dirty, save])

  if (!cfg) {
    return (
      <div className="cli-workers-block">
        {loadError ? (
          <div className="agent-behavior-notice agent-behavior-notice--error" role="alert">
            <AlertCircle size={15} />
            <span className="agent-behavior-notice-copy">{loadError}</span>
          </div>
        ) : (
          <div className="agent-behavior-loading">
            <RefreshCw size={16} className="animate-spin" />
            加载中…
          </div>
        )}
      </div>
    )
  }

  const backendValue: CliWorkerBackend =
    cfg.enabled && cfg.defaultBackend === 'cli' ? 'cli' : 'in-process'
  const useCli = backendValue === 'cli'
  const enabledOrder = cfg.workers.filter((w) => w.enabled).map((w) => w.id)

  const handleEagernessChange = (value: string): void => {
    const next = readSubagentEagernessDefault(value as SubagentEagerness)
    setEagernessRaw(next)
    showNotice({
      kind: 'success',
      message: `委派积极性默认：${SUBAGENT_EAGERNESS_CONFIG[next].label}`,
    })
  }

  return (
    <div className="cli-workers-block">
      {notice && (
        <div
          className={`agent-behavior-notice agent-behavior-notice--${notice.kind}`}
          role={notice.kind === 'error' ? 'alert' : 'status'}
        >
          {notice.kind === 'success' ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}
          <span className="agent-behavior-notice-copy">{notice.message}</span>
        </div>
      )}

      <SettingsCard divided>
        <SettingsSelect
          label="委派积极性"
          description={`${SUBAGENT_EAGERNESS_CONFIG[eagerness].description}。新会话与未单独设置的会话使用此默认；当前会话仍可在输入区临时改。`}
          value={eagerness}
          onValueChange={handleEagernessChange}
          options={eagernessOptions}
          placeholder="选择积极性"
        />
        <SettingsSelect
          label="默认后端"
          description={
            useCli
              ? '外渠 task 从启用的本机 CLI 池挑选（可指定或按优先级）；本机都不可用时回退内置。支持同会话并行多路。'
              : '使用内置子代理（与主会话同进程），不额外拉起 CLI。'
          }
          value={backendValue}
          onValueChange={handleBackendChange}
          options={BACKEND_OPTIONS}
          placeholder="选择后端"
          disabled={saving}
        />
      </SettingsCard>

      {useCli && (
        <SettingsSection
          title="本机 CLI 工人池"
          description={
            enabledOrder.length > 0
              ? `启用顺序即优先级：${enabledOrder.join(' > ')}。主会话可用 task.cli 指定；省略则按此序选第一个本机可用的。`
              : '至少启用一个 CLI。列表越靠上优先级越高；主会话也可在 task 里用 cli 参数指定。'
          }
        >
          <div className="cli-workers-toolbar">
            <button
              type="button"
              className="cli-workers-btn"
              disabled={probing || saving}
              onClick={() => void runProbe()}
            >
              <RefreshCw size={13} className={probing ? 'animate-spin' : undefined} />
              {probing ? '检测中…' : '检测本机'}
            </button>
            <span className="cli-workers-toolbar-hint">
              不自动扫，避免进设置卡顿；需要时再点。
            </span>
          </div>

          <div className="cli-workers-table" role="list">
            {cfg.workers.map((w, index) => {
              const probe = probeMap[w.id]
              const priorityRank = w.enabled
                ? enabledOrder.indexOf(w.id) + 1
                : 0
              let badge: { cls: string; text: string }
              if (probing) badge = { cls: 'is-pending', text: '…' }
              else if (!probe) badge = { cls: 'is-unknown', text: '未检测' }
              else if (probe.available) badge = { cls: 'is-ok', text: '可用' }
              else badge = { cls: 'is-miss', text: '未找到' }

              return (
                <div
                  key={w.id}
                  className={`cli-workers-row${w.enabled && priorityRank === 1 ? ' is-default' : ''}${!w.enabled ? ' is-off' : ''}`}
                  role="listitem"
                >
                  <div className="cli-workers-row-main">
                    <span className="cli-workers-prio" title="优先级（列表顺序）">
                      {w.enabled ? `#${priorityRank}` : '—'}
                    </span>
                    <span className="cli-workers-name">
                      {workerLabel(w.id)}
                      {w.enabled && priorityRank === 1 && (
                        <span className="cli-workers-tag">优先</span>
                      )}
                    </span>
                    <span className={`cli-workers-badge ${badge.cls}`}>{badge.text}</span>
                  </div>
                  <div className="cli-workers-row-actions">
                    <div className="cli-workers-move">
                      <button
                        type="button"
                        className="cli-workers-icon-btn"
                        disabled={saving || index === 0}
                        aria-label={`提高 ${w.id} 优先级`}
                        onClick={() => handleMovePriority(w.id, 'up')}
                      >
                        <ChevronUp size={14} />
                      </button>
                      <button
                        type="button"
                        className="cli-workers-icon-btn"
                        disabled={saving || index === cfg.workers.length - 1}
                        aria-label={`降低 ${w.id} 优先级`}
                        onClick={() => handleMovePriority(w.id, 'down')}
                      >
                        <ChevronDown size={14} />
                      </button>
                    </div>
                    <label className="cli-workers-check">
                      <input
                        type="checkbox"
                        checked={w.enabled}
                        disabled={saving}
                        onChange={(e) => handleWorkerToggle(w.id, e.target.checked)}
                      />
                      <span>启用</span>
                    </label>
                  </div>
                </div>
              )
            })}
          </div>

          <button
            type="button"
            className={`cli-workers-advanced-toggle${advancedOpen ? ' is-open' : ''}`}
            onClick={() => setAdvancedOpen((v) => !v)}
          >
            <ChevronDown size={14} />
            高级（路径 / 模型）
          </button>

          {advancedOpen && (
            <div className="cli-workers-advanced">
              {cfg.workers.map((w) => {
                const probe = probeMap[w.id]
                return (
                  <div key={w.id} className="cli-workers-adv-row">
                    <div className="cli-workers-adv-id">{workerLabel(w.id)}</div>
                    <label className="cli-workers-field">
                      <span className="cli-workers-field-lab">路径</span>
                      <input
                        className="cli-workers-field-inp"
                        value={w.bin}
                        onChange={(e) => updateWorkerField(w.id, { bin: e.target.value })}
                        onBlur={handleWorkerBlur}
                        placeholder={w.id}
                        disabled={saving}
                        spellCheck={false}
                      />
                    </label>
                    <label className="cli-workers-field">
                      <span className="cli-workers-field-lab">模型</span>
                      <input
                        className="cli-workers-field-inp"
                        value={w.defaultModel ?? ''}
                        onChange={(e) =>
                          updateWorkerField(w.id, {
                            defaultModel: e.target.value || undefined,
                          })
                        }
                        onBlur={handleWorkerBlur}
                        placeholder="CLI 默认"
                        disabled={saving}
                        spellCheck={false}
                      />
                    </label>
                    {probe?.resolvedPath && probe.resolvedPath !== w.bin && (
                      <div className="cli-workers-path" title={probe.resolvedPath}>
                        探测到 {probe.resolvedPath}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </SettingsSection>
      )}
    </div>
  )
}
