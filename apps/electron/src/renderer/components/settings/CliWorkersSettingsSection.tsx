/**
 * 设置 · Agent 行为 → 子代理
 *
 * 范围：
 * - 委派积极性（全局默认；会话可单独覆盖）
 * - 默认后端：内置（进程内）| 本机 CLI
 * - 本机 CLI 时：启用池 + 优先级排序（列表顺序）；主会话 task 可指定 cli，省略则按序自动选
 * - 高级：按工人卡片编辑路径 / 模型 / 能力画像（控件对齐会诊页，不用原生 select/checkbox）
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
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SettingsCard,
  SettingsSelect,
  SettingsSection,
  Switch,
} from '@tagent/ui'
import {
  moveWorkerPriority,
  resolveWorkerCapability,
  syncDefaultCliId,
  SUPPORTED_CLI_WORKER_IDS,
  type CliReasoning,
  type CliWorkerBackend,
  type CliWorkerCapability,
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

type ProbeBadge = { cls: string; text: string }

function workerLabel(id: string): string {
  return id
}

function probeBadgeOf(
  probe: CliWorkerProbeItem | undefined,
  supported: boolean,
  probing: boolean,
): ProbeBadge {
  if (probing) return { cls: 'is-pending', text: '…' }
  if (!probe) return { cls: 'is-unknown', text: '未检测' }
  if (probe.available && supported) return { cls: 'is-ok', text: '可用' }
  if (probe.available && !supported) return { cls: 'is-miss', text: '已检测·暂不支持派工' }
  return { cls: 'is-miss', text: '未找到' }
}

const BACKEND_OPTIONS: Array<{ value: CliWorkerBackend; label: string }> = [
  { value: 'in-process', label: '内置子代理' },
  { value: 'cli', label: '本机 CLI' },
]

const COST_OPTIONS = [
  { value: '1', label: '最便宜' },
  { value: '2', label: '较便宜' },
  { value: '3', label: '适中' },
  { value: '4', label: '较贵' },
  { value: '5', label: '最贵' },
]

const REASONING_OPTIONS: Array<{ value: CliReasoning; label: string }> = [
  { value: 'low', label: '低 · 轻量任务' },
  { value: 'medium', label: '中 · 常规' },
  { value: 'high', label: '高 · 难推理' },
]

export function CliWorkersSettingsSection(): JSX.Element {
  const [cfg, setCfgState] = useState<CliWorkersConfig | null>(null)
  const [loadError, setLoadError] = useState('')
  const [notice, setNotice] = useState<Notice>(null)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [probeMap, setProbeMap] = useState<Record<string, CliWorkerProbeItem>>({})
  const [probing, setProbing] = useState(false)
  /** 高级：路径 / 模型 / 能力 */
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

  const reload = useCallback(async (): Promise<void> => {
    setLoadError('')
    try {
      const loaded = await window.electronAPI.listCliWorkersConfig()
      setCfg(loaded)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : '无法读取子代理配置')
    }
  }, [setCfg])

  /** 仅用户点击时探测——进页不扫；后端先对账落盘，再探测并拉回对账后的工人列表 */
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
      await reload()
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
  }, [showNotice, reload])

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

  const updateWorkerCapability = useCallback(
    (id: string, patch: Partial<CliWorkerCapability>): void => {
      const cur = cfgRef.current
      if (!cur) return
      setCfg({
        ...cur,
        workers: cur.workers.map((x) =>
          x.id === id
            ? { ...x, capability: { ...resolveWorkerCapability(x), ...patch } }
            : x,
        ),
      })
      setDirty(true)
    },
    [setCfg],
  )

  /** 能力字段即时落盘（Select / Switch 无可靠 blur） */
  const saveWorkerCapability = useCallback(
    (id: string, patch: Partial<CliWorkerCapability>): void => {
      const cur = cfgRef.current
      if (!cur) return
      const next: CliWorkersConfig = {
        ...cur,
        workers: cur.workers.map((x) =>
          x.id === id
            ? { ...x, capability: { ...resolveWorkerCapability(x), ...patch } }
            : x,
        ),
      }
      setDirty(false)
      void save(next, '已保存')
    },
    [save],
  )

  const handleWorkerVisionToggle = useCallback(
    (id: string, vision: boolean): void => {
      saveWorkerCapability(id, {
        modalities: vision ? ['text', 'vision'] : ['text'],
      })
    },
    [saveWorkerCapability],
  )

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
              ? `检测本机已安装的 coding CLI；启用顺序即优先级（当前 ${enabledOrder.join(' › ')}）。`
              : '检测本机已安装的 coding CLI；至少启用一个，列表越靠上优先级越高。'
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
              对账已安装项后检测可用性；高级里可改路径、模型与能力画像。
            </span>
          </div>

          <div className="cli-workers-table" role="list">
            {cfg.workers.map((w, index) => {
              const probe = probeMap[w.id]
              const priorityRank = w.enabled
                ? enabledOrder.indexOf(w.id) + 1
                : 0
              const supported = SUPPORTED_CLI_WORKER_IDS.includes(w.id)
              const badge = probeBadgeOf(probe, supported, probing)

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
                      {!supported && (
                        <span className="cli-workers-tag" title="已检测但暂无 runner，不参与 task 路由">
                          暂不支持
                        </span>
                      )}
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
                    <div className="cli-workers-enable">
                      <span className="cli-workers-enable-lab">启用</span>
                      <Switch
                        size="sm"
                        checked={w.enabled}
                        disabled={saving}
                        aria-label={`${w.enabled ? '停用' : '启用'} ${w.id}`}
                        onCheckedChange={(on) => handleWorkerToggle(w.id, on)}
                      />
                    </div>
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
            高级（路径 / 模型 / 能力）
          </button>

          {advancedOpen && (
            <div className="cli-workers-adv-cards">
              <p className="cli-workers-adv-hint">
                相对成本越大越贵；推理越高越吃重任务。主会话 task 会按这些档位挑选工人。
              </p>
              {cfg.workers.map((w) => {
                const probe = probeMap[w.id]
                const supported = SUPPORTED_CLI_WORKER_IDS.includes(w.id)
                const badge = probeBadgeOf(probe, supported, probing)
                const cap = resolveWorkerCapability(w)
                const hasVision = (cap.modalities ?? ['text']).includes('vision')

                return (
                  <div key={w.id} className="cli-workers-adv-card">
                    <div className="cli-workers-adv-card-head">
                      <span className="cli-workers-adv-card-title">{workerLabel(w.id)}</span>
                      <span className={`cli-workers-badge ${badge.cls}`}>{badge.text}</span>
                    </div>

                    {/* 扁平字段：不再叠「运行时 / 能力画像」中间标题 */}
                    <div className="cli-workers-adv-stack">
                      <label className="agent-behavior-field">
                        <span className="agent-behavior-field-label">可执行路径</span>
                        <Input
                          className="agent-behavior-input agent-behavior-input--mono"
                          value={w.bin}
                          onChange={(e) => updateWorkerField(w.id, { bin: e.target.value })}
                          onBlur={handleWorkerBlur}
                          placeholder={w.id}
                          disabled={saving}
                          spellCheck={false}
                        />
                        {probe?.resolvedPath && probe.resolvedPath !== w.bin && (
                          <span className="cli-workers-path" title={probe.resolvedPath}>
                            探测到 {probe.resolvedPath}
                          </span>
                        )}
                      </label>
                      <label className="agent-behavior-field">
                        <span className="agent-behavior-field-label">默认模型</span>
                        <Input
                          className="agent-behavior-input agent-behavior-input--mono"
                          value={w.defaultModel ?? ''}
                          onChange={(e) =>
                            updateWorkerField(w.id, {
                              defaultModel: e.target.value || undefined,
                            })
                          }
                          onBlur={handleWorkerBlur}
                          placeholder="留空则用 CLI 自带默认"
                          disabled={saving}
                          spellCheck={false}
                        />
                      </label>

                      <div className="cli-workers-adv-cap-grid">
                        <label className="agent-behavior-field">
                          <span className="agent-behavior-field-label">相对成本</span>
                          <Select
                            value={String(cap.cost)}
                            onValueChange={(v) =>
                              saveWorkerCapability(w.id, {
                                cost: Number(v) as CliWorkerCapability['cost'],
                              })
                            }
                            disabled={saving}
                          >
                            <SelectTrigger className="agent-behavior-input agent-behavior-select">
                              <SelectValue placeholder="选择成本档" />
                            </SelectTrigger>
                            <SelectContent className="scrollbar-thin !z-[130]">
                              {COST_OPTIONS.map((o) => (
                                <SelectItem key={o.value} value={o.value}>
                                  {o.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </label>
                        <label className="agent-behavior-field">
                          <span className="agent-behavior-field-label">推理强度</span>
                          <Select
                            value={cap.reasoning}
                            onValueChange={(v) =>
                              saveWorkerCapability(w.id, {
                                reasoning: v as CliReasoning,
                              })
                            }
                            disabled={saving}
                          >
                            <SelectTrigger className="agent-behavior-input agent-behavior-select">
                              <SelectValue placeholder="选择强度" />
                            </SelectTrigger>
                            <SelectContent className="scrollbar-thin !z-[130]">
                              {REASONING_OPTIONS.map((o) => (
                                <SelectItem key={o.value} value={o.value}>
                                  {o.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </label>
                      </div>

                      <div className="cli-workers-adv-switch-row">
                        <span className="agent-behavior-field-label">支持看图（视觉）</span>
                        <Switch
                          size="sm"
                          checked={hasVision}
                          disabled={saving}
                          aria-label={`${hasVision ? '关闭' : '开启'} ${w.id} 视觉`}
                          onCheckedChange={(on) => handleWorkerVisionToggle(w.id, on)}
                        />
                      </div>

                      <label className="agent-behavior-field">
                        <span className="agent-behavior-field-label">一句话适用场景</span>
                        <Input
                          className="agent-behavior-input"
                          value={cap.goodFor ?? ''}
                          onChange={(e) =>
                            updateWorkerCapability(w.id, {
                              goodFor: e.target.value || undefined,
                            })
                          }
                          onBlur={handleWorkerBlur}
                          placeholder="例如：改前端、跑命令、长上下文读代码"
                          disabled={saving}
                          spellCheck={false}
                        />
                      </label>
                    </div>
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
