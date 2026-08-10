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

  const reload = useCallback(async (): Promise<void> => {
    setLoadError('')
    try {
      const loaded = await window.electronAPI.listCliWorkersConfig()
      setCfg(loaded)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : '无法读取子代理配置')
    }
  }, [setCfg])

  /** 仅用户点击时探测——进页不扫；后端先对账落盘（新增已安装 / 移除未安装占位 / 保留自定义），再探测并拉回对账后的工人列表 */
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
      // 后端对账可能新增/移除工人行：拉回对账后的配置，保证 probe 徽标与列表行对齐
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

  /**
   * 能力画像编辑（成本 / 推理 / 视觉 / 适用场景）。
   * 基础 = resolveWorkerCapability(w)：旧配置无 capability 时给中性默认
   * （cost 3 / medium / text），编辑即落显式 capability 字段，保证对象完整。
   * cost / reasoning / goodFor 走 onChange + onBlur 保存（复用 updateWorkerField 模式）；
   * vision 开关无 blur，单独 handleWorkerVisionToggle 直接 save。
   */
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

  /** 视觉开关：checkbox 无 blur，onChange 直接落盘（镜像 handleWorkerToggle 模式）。 */
  const handleWorkerVisionToggle = useCallback(
    (id: string, vision: boolean): void => {
      const cur = cfgRef.current
      if (!cur) return
      const next: CliWorkersConfig = {
        ...cur,
        workers: cur.workers.map((x) =>
          x.id === id
            ? {
                ...x,
                capability: {
                  ...resolveWorkerCapability(x),
                  modalities: vision ? ['text', 'vision'] : ['text'],
                },
              }
            : x,
        ),
      }
      void save(next, '已保存')
    },
    [save],
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
            '工人池 = 启动时自动探测本机已安装的 coding CLI + 手动添加的自定义工人；未找到的目录项不再占位。' +
            (enabledOrder.length > 0
              ? ` 启用顺序即优先级：${enabledOrder.join(' > ')}；主会话可用 task.cli 指定，省略则按此序选第一个本机可用的。`
              : ' 至少启用一个 CLI；列表越靠上优先级越高。') +
            ' 高级里可编辑各工人能力画像（成本 / 推理 / 视觉 / 适用场景），主会话 task 按 require / prefer 挑选。'
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
              先对账本机已安装（新增 / 移除占位）再检测可用性。
            </span>
          </div>

          <div className="cli-workers-table" role="list">
            {cfg.workers.map((w, index) => {
              const probe = probeMap[w.id]
              const priorityRank = w.enabled
                ? enabledOrder.indexOf(w.id) + 1
                : 0
              const supported = SUPPORTED_CLI_WORKER_IDS.includes(w.id)
              let badge: { cls: string; text: string }
              if (probing) badge = { cls: 'is-pending', text: '…' }
              else if (!probe) badge = { cls: 'is-unknown', text: '未检测' }
              else if (probe.available && supported) badge = { cls: 'is-ok', text: '可用' }
              else if (probe.available && !supported)
                badge = { cls: 'is-miss', text: '已检测·暂不支持派工' }
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
            高级（路径 / 模型 / 能力）
          </button>

          {advancedOpen && (
            <div className="cli-workers-advanced">
              {cfg.workers.map((w) => {
                const probe = probeMap[w.id]
                const cap = resolveWorkerCapability(w)
                const hasVision = (cap.modalities ?? ['text']).includes('vision')
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
                    <div className="cli-workers-cap-row">
                      <span
                        className="cli-workers-cap-label"
                        title="成本：1 最便宜 ~ 5 最贵（相对档，task prefer.costMax 过滤、prefer 打分越低越优）；推理：require.reasoningMin 过滤；视觉：require.vision 过滤；适用场景：注入能力卡供主 Agent 自选"
                      >
                        能力
                      </span>
                      <label className="cli-workers-field">
                        <span className="cli-workers-field-lab">成本</span>
                        <select
                          className="cli-workers-field-inp cli-workers-cap-select"
                          value={String(cap.cost)}
                          onChange={(e) =>
                            updateWorkerCapability(w.id, {
                              cost: Number(e.target.value) as CliWorkerCapability['cost'],
                            })
                          }
                          onBlur={handleWorkerBlur}
                          disabled={saving}
                        >
                          {[1, 2, 3, 4, 5].map((n) => (
                            <option key={n} value={String(n)}>
                              {n}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="cli-workers-field">
                        <span className="cli-workers-field-lab">推理</span>
                        <select
                          className="cli-workers-field-inp cli-workers-cap-select"
                          value={cap.reasoning}
                          onChange={(e) =>
                            updateWorkerCapability(w.id, {
                              reasoning: e.target.value as CliReasoning,
                            })
                          }
                          onBlur={handleWorkerBlur}
                          disabled={saving}
                        >
                          <option value="low">低</option>
                          <option value="medium">中</option>
                          <option value="high">高</option>
                        </select>
                      </label>
                      <label className="cli-workers-check">
                        <input
                          type="checkbox"
                          checked={hasVision}
                          onChange={(e) => handleWorkerVisionToggle(w.id, e.target.checked)}
                          disabled={saving}
                        />
                        <span>视觉</span>
                      </label>
                      <label className="cli-workers-field cli-workers-field--grow">
                        <span className="cli-workers-field-lab">适用场景</span>
                        <input
                          className="cli-workers-field-inp"
                          value={cap.goodFor ?? ''}
                          onChange={(e) =>
                            updateWorkerCapability(w.id, {
                              goodFor: e.target.value || undefined,
                            })
                          }
                          onBlur={handleWorkerBlur}
                          placeholder="一句话适用场景"
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
