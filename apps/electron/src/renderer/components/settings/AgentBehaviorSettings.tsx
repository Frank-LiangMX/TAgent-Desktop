/**
 * 设置 · Agent 行为 → 会诊（协作策略板）— V3 双档 + 扁平名册
 *
 * 重设计（去「汇」流程图）：会诊列表改为名册行（轻分隔 hairline，无左竖条 / 无卡片渐变），
 * 顶部仅两档 pill（kscc 内网 | 外部渠道；选中描边+字重+浅 fill，非整颗纯黑/紫块）；
 * 外部渠道档合并所有已启用非 kscc 渠模型（按 id 去重），channelId 落盘 = 'external' 哨兵。
 * 座位由「参考 chip → 汇圆 → 箭头 → 汇总 chip」改为单行 `名·模型 · … → 汇总 模型`。
 * 本页仅「会诊」班底 CRUD（各答各的再汇总，非圆桌讨论）；子代理 / 班组 / 圆桌在侧栏独立分页。
 * 逻辑 CRUD / IPC / 校验**不变**：list / add / edit / delete / toggle / 中文报错全部保留。
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  AlertCircle,
  CheckCircle2,
  CircleDot,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
} from 'lucide-react'
import {
  Button,
  DestructiveConfirmDialog,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SettingsCard,
  SettingsPageIntro,
  SettingsSection,
  SegmentedTabs,
  SegmentedTabsItem,
  Switch,
} from '@tagent/ui'
import {
  buildChannelBasedDraftPreset,
  buildExternalScopeDraftPreset,
  MOA_EXTERNAL_SCOPE_ID,
  type ChannelModel,
  type MoAPreset,
  type MoAReferenceSeat,
} from '@tagent/shared'
import {
  externalChannelsAtom,
  ksccChannelAtom,
  loadChannelsAtom,
} from '../../atoms/channel-atoms'

// ── helpers ──

/** 生成 custom-<短随机> presetId（仅小写/数字/短横线，≤32） */
function generatePresetId(existingIds: Set<string>): string {
  for (let attempt = 0; attempt < 20; attempt++) {
    const id = `custom-${Math.random().toString(36).slice(2, 8)}`
    if (!existingIds.has(id)) return id
  }
  // fallback：加时间戳后缀
  return `custom-${Date.now().toString(36)}`
}

type EditorMode = 'add' | 'edit'
type Notice = { kind: 'info' | 'error' | 'success'; message: string }

// ── 主组件 ──

export function AgentBehaviorSettings(): JSX.Element {
  const ksccChannel = useAtomValue(ksccChannelAtom)
  const externalChannels = useAtomValue(externalChannelsAtom)
  const loadChannels = useSetAtom(loadChannelsAtom)
  const [presets, setPresets] = useState<MoAPreset[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [editor, setEditor] = useState<{ mode: EditorMode; preset?: MoAPreset } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<MoAPreset | null>(null)
  /** 会诊档：仅两档（kscc 内网 | 外部渠道） */
  const [selectedScope, setSelectedScope] = useState<'kscc' | 'external'>('kscc')

  const reload = useCallback(async (): Promise<void> => {
    setLoadError('')
    try {
      const list = await window.electronAPI.listMoaPresets()
      setPresets(list)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : '无法读取会诊预置')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  // 确保渠道已加载（渠道 pill + 模型下拉需要）
  useEffect(() => {
    void loadChannels()
  }, [loadChannels])

  // 外部档合并模型：所有已启用非 kscc 渠的 enabled 模型按 id 去重合并（SPEC 05 V3 · 外部渠合并）
  const externalEnabledModels = useMemo(() => {
    const map = new Map<string, ChannelModel>()
    for (const c of externalChannels) {
      if (!c.enabled) continue
      for (const m of c.models) {
        if (m.enabled && !map.has(m.id)) map.set(m.id, m)
      }
    }
    return Array.from(map.values())
  }, [externalChannels])

  const hasKscc = Boolean(ksccChannel?.enabled)
  const hasAnyChannel = hasKscc || externalChannels.some((c) => c.enabled)

  // 当前档：kscc 不可用时回落 external（避免选中不可用档卡死）；用户显式选 external 时尊重
  const scope: 'kscc' | 'external' =
    selectedScope === 'kscc' && !hasKscc ? 'external' : selectedScope
  const isKscc = scope === 'kscc'
  const isExternal = scope === 'external'

  // 当前档已启用模型：kscc = 本渠 enabled；外部 = 合并模型列表
  const enabledModels = useMemo(
    () =>
      scope === 'kscc'
        ? (ksccChannel?.models.filter((m) => m.enabled) ?? [])
        : externalEnabledModels,
    [scope, ksccChannel, externalEnabledModels],
  )

  // 本档班底：kscc 取 channelId === kscc.id（及 v1 无字段兼容）；外部取 channelId === 'external' 哨兵
  const channelPresets = useMemo(() => {
    if (scope === 'kscc') {
      const ksccId = ksccChannel?.id
      if (!ksccId) return []
      return presets.filter((p) => !p.channelId || p.channelId === ksccId)
    }
    return presets.filter((p) => p.channelId === MOA_EXTERNAL_SCOPE_ID)
  }, [presets, scope, ksccChannel])
  const channelEnabledCount = channelPresets.filter((p) => p.enabled).length

  const canAddPreset = scope === 'kscc' ? hasKscc : externalEnabledModels.length > 0

  // 空态 CTA：kscc 基于本渠 enabled 合成 draft；外部基于合并模型列表合成（channelId=external）
  const handleGenerateDraft = useCallback((): void => {
    const id = generatePresetId(new Set(presets.map((p) => p.id)))
    const draftPreset =
      scope === 'kscc'
        ? ksccChannel
          ? buildChannelBasedDraftPreset(ksccChannel, id)
          : null
        : buildExternalScopeDraftPreset(externalEnabledModels, id)
    if (!draftPreset) return
    setEditor({ mode: 'add', preset: draftPreset })
  }, [scope, ksccChannel, externalEnabledModels, presets])

  const handleDelete = async (): Promise<void> => {
    if (!deleteTarget) return
    const target = deleteTarget
    try {
      // 整份保存：仅删本条，其余渠班底原样保留（不跨渠混删）
      const updated = presets.filter((p) => p.id !== target.id)
      const reloaded = await window.electronAPI.saveMoaPresets(updated)
      setPresets(reloaded)
    } catch (error) {
      // 删除整份写入不应失败（仅剩合法条目），但兜底
      console.error('[Agent 行为] 删除预置失败:', error)
    } finally {
      setDeleteTarget(null)
    }
  }

  const togglePreset = async (preset: MoAPreset): Promise<void> => {
    try {
      // 整份保存：仅切本条启用，其余渠班底原样保留
      const updated = presets.map((p) =>
        p.id === preset.id ? { ...p, enabled: !p.enabled } : p,
      )
      const reloaded = await window.electronAPI.saveMoaPresets(updated)
      setPresets(reloaded)
    } catch (error) {
      console.error('[Agent 行为] 切换启用失败:', error)
    }
  }

  return (
    <div className="settings-page agent-behavior-page">
      <SettingsPageIntro
        title="会诊"
        description={
          !hasAnyChannel
            ? '多模型并行交卷再汇总（各答各的，互不讨论）。请先在「渠道」中启用至少一个渠道。'
            : isKscc
              ? '配置 kscc 内网会诊班底。各席独立作答再汇总；席位无工具，查仓库请用普通发送。'
              : '配置外部渠道会诊班底（合并已启用外渠模型）。各席独立作答再汇总；席位无工具，查仓库请用普通发送。'
        }
      />

      {/* ── 会诊 CRUD（同页编辑；档 channelId 落盘；档切换 = SegmentedTabs）── */}
      <SettingsSection
        title="班底"
        description={
          isKscc
            ? '发送旁「会诊」会使用下列预置。'
            : '未自定义时发送旁可自动合成班底；有自定义则优先用下列预置。'
        }
        action={
          editor ? undefined : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditor({ mode: 'add' })}
              disabled={!canAddPreset}
            >
              <Plus size={14} />
              添加预置
            </Button>
          )
        }
      >
        {!hasAnyChannel ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            暂无已启用渠道；请先在渠道管理中启用。
          </p>
        ) : (
          <div className="agent-behavior-stack">
            {loadError && (
              <div className="agent-behavior-notice agent-behavior-notice--error" role="alert">
                <AlertCircle size={15} />
                <span className="agent-behavior-notice-copy">{loadError}</span>
                <Button variant="ghost" size="sm" onClick={() => void reload()}>重试</Button>
              </div>
            )}

            {/* 外部档仅 1 模：可建同模多角色，提示 */}
            {isExternal && enabledModels.length === 1 && (
              <div className="agent-behavior-notice" role="status">
                <CircleDot size={15} />
                <span className="agent-behavior-notice-copy">
                  外部渠道仅 1 个可用模型，只能配置同模多角色班底（两参考席同模型、不同 system）。
                </span>
              </div>
            )}

            {/* 档分段：与设置其它分段同族 SegmentedTabs；选中档 + 预置计数 */}
            <SettingsCard divided={false} className="agent-behavior-tier-card">
              <div className="agent-behavior-tier-row">
                <SegmentedTabs
                  value={scope}
                  onValueChange={(v) => {
                    if (!editor) setSelectedScope(v as 'kscc' | 'external')
                  }}
                  className="settings-segmented"
                >
                  <SegmentedTabsItem value="kscc" disabled={!!editor || !hasKscc}>
                    kscc 内网
                  </SegmentedTabsItem>
                  <SegmentedTabsItem value="external" disabled={!!editor}>
                    外部渠道
                  </SegmentedTabsItem>
                </SegmentedTabs>
                <div className="agent-behavior-summary" aria-live="polite">
                  <span>{channelPresets.length} 个预置</span>
                  <span aria-hidden>·</span>
                  <span>{channelEnabledCount} 个已启用</span>
                </div>
              </div>
            </SettingsCard>

            {editor ? (
              <PresetEditor
                mode={editor.mode}
                preset={editor.preset}
                channelModels={enabledModels}
                channelId={scope === 'kscc' ? (ksccChannel?.id ?? '') : MOA_EXTERNAL_SCOPE_ID}
                existingIds={new Set(presets.map((p) => p.id))}
                onCancel={() => setEditor(null)}
                onSaved={async (updatedList) => {
                  setPresets(updatedList)
                  setEditor(null)
                }}
              />
            ) : loading ? (
              <SettingsCard divided={false}>
                <div className="agent-behavior-loading">
                  <RefreshCw size={16} className="animate-spin" />
                  正在读取会诊预置…
                </div>
              </SettingsCard>
            ) : channelPresets.length === 0 ? (
              <SettingsCard divided={false}>
                <div className="agent-behavior-empty">
                  {isExternal ? (
                    enabledModels.length === 0 ? (
                      <span>外部渠道暂无可用模型，无法配置班底；请先在渠道管理中启用外部渠道及其模型。</span>
                    ) : (
                      <div className="agent-behavior-empty-cta">
                        <span>尚未自定义；发送旁会诊将使用自动合成班底。</span>
                        <Button variant="outline" size="sm" onClick={handleGenerateDraft}>
                          <Sparkles size={14} />
                          基于当前模型生成一版并编辑
                        </Button>
                      </div>
                    )
                  ) : (
                    <span>尚无会诊预置；添加后可在发送旁「会诊」中使用。</span>
                  )}
                </div>
              </SettingsCard>
            ) : (
              <SettingsCard divided>
                {channelPresets.map((preset) => (
                  <PresetRow
                    key={preset.id}
                    preset={preset}
                    onEdit={() => setEditor({ mode: 'edit', preset })}
                    onDelete={() => setDeleteTarget(preset)}
                    onToggle={() => void togglePreset(preset)}
                  />
                ))}
              </SettingsCard>
            )}
          </div>
        )}
      </SettingsSection>

      <DestructiveConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        icon={<Trash2 size={15} />}
        title={`删除预置「${deleteTarget?.name ?? ''}」？`}
        description="该预置将被永久移除。已使用此预置的会诊会话不受影响（运行中/历史的不变）。"
        confirmLabel="删除预置"
        onConfirm={handleDelete}
      />
    </div>
  )
}

// ── 名册行：座位单行（名·模型 · … → 汇总 模型）──

function PresetRow({
  preset,
  onEdit,
  onDelete,
  onToggle,
}: {
  preset: MoAPreset
  onEdit: () => void
  onDelete: () => void
  onToggle: () => void
}): JSX.Element {
  const isSeed = preset.id === 'default' || preset.id === 'cheap'
  const timeoutSec = preset.timeoutMsPerSeat ? preset.timeoutMsPerSeat / 1000 : 120
  return (
    <article
      className={`agent-behavior-row${preset.enabled ? '' : ' agent-behavior-row--off'}`}
    >
      {/* 左：名 + 内置标签 / 座位单行（参考席 名·模型 · … → 汇总 模型） */}
      <div className="agent-behavior-row-main min-w-0 flex-1">
        <div className="agent-behavior-row-title">
          <strong>{preset.name}</strong>
          {isSeed && <span className="agent-behavior-row-tag">内置</span>}
        </div>
        <div className="agent-behavior-seat-line">
          {preset.references.map((ref, index) => (
            <Fragment key={index}>
              {index > 0 && (
                <span className="agent-behavior-seat-sep" aria-hidden>
                  ·
                </span>
              )}
              <span className="agent-behavior-seat-token">
                <span className="agent-behavior-seat-name">{ref.name}</span>
                <span className="agent-behavior-seat-model">{ref.modelId}</span>
              </span>
            </Fragment>
          ))}
          <span className="agent-behavior-seat-arrow" aria-hidden>
            →
          </span>
          <span className="agent-behavior-seat-token agent-behavior-seat-token--agg">
            <span className="agent-behavior-seat-name">汇总</span>
            <span className="agent-behavior-seat-model">{preset.aggregatorModelId}</span>
          </span>
        </div>
      </div>

      {/* 右：超时 + 研讨轮数 + 启用开关 + 编辑/删 */}
      <div className="agent-behavior-row-control shrink-0">
        <span className="agent-behavior-row-meta">超时 {timeoutSec}s</span>
        {preset.roundLimit != null && preset.roundLimit !== 3 && (
          <span className="agent-behavior-row-meta">研讨 {preset.roundLimit} 轮</span>
        )}
        <Switch
          size="sm"
          checked={preset.enabled}
          aria-label={`${preset.enabled ? '停用' : '启用'} ${preset.name}`}
          onCheckedChange={onToggle}
        />
        <div className="agent-behavior-row-actions">
          <Button variant="ghost" size="sm" onClick={onEdit}>
            <Pencil size={13} />
            编辑
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground hover:text-destructive"
            aria-label={`删除 ${preset.name}`}
            onClick={onDelete}
          >
            <Trash2 size={13} />
          </Button>
        </div>
      </div>
    </article>
  )
}

// ── 预置编辑器（同页 inline 面板）──

interface PresetDraft {
  id: string
  name: string
  enabled: boolean
  references: MoAReferenceSeat[]
  aggregatorModelId: string
  timeoutMsPerSeat: number
  /**
   * 圆桌研讨全场轮数上限（仅「圆桌」生效；会诊固定单轮，忽略此值）。
   * `undefined` = 用默认 3（运行时兜底）；存在则须为 1..6 整数（validateDraft 校验）。
   */
  roundLimit?: number
  /** 所属渠道 id；保存时随 draft 落盘（SPEC 05 §3） */
  channelId: string
}

function createDraft(existingIds: Set<string>, channelId: string): PresetDraft {
  return {
    id: generatePresetId(existingIds),
    name: '',
    enabled: true,
    references: [
      { name: '参考·甲', modelId: '' },
      { name: '参考·乙', modelId: '' },
    ],
    aggregatorModelId: '',
    timeoutMsPerSeat: 120_000,
    roundLimit: 3,
    channelId,
  }
}

function presetToDraft(preset: MoAPreset): PresetDraft {
  return {
    id: preset.id,
    name: preset.name,
    enabled: preset.enabled,
    references: preset.references.map((r) => ({ ...r })),
    aggregatorModelId: preset.aggregatorModelId,
    timeoutMsPerSeat: preset.timeoutMsPerSeat ?? 120_000,
    roundLimit: preset.roundLimit,
    channelId: preset.channelId ?? '',
  }
}

function draftToMoAPreset(draft: PresetDraft): MoAPreset {
  return {
    id: draft.id,
    name: draft.name,
    enabled: draft.enabled,
    references: draft.references,
    aggregatorModelId: draft.aggregatorModelId,
    timeoutMsPerSeat: draft.timeoutMsPerSeat,
    ...(draft.roundLimit !== undefined ? { roundLimit: draft.roundLimit } : {}),
    channelId: draft.channelId,
  }
}

/** 客户端校验 draft：返回首个错误或 null */
function validateDraft(draft: PresetDraft): string | null {
  if (!draft.name.trim()) return '请填写预置名称'
  if (draft.references.length < 2) return '参考席至少需要 2 个'
  for (const ref of draft.references) {
    if (!ref.name.trim()) return '参考席名称不能为空'
    if (!ref.modelId.trim()) return '参考席模型不能为空'
  }
  if (!draft.aggregatorModelId.trim()) return '请选择汇总模型'
  if (draft.timeoutMsPerSeat <= 0) return '超时须为正数（毫秒）'
  if (
    draft.roundLimit != null &&
    (!Number.isInteger(draft.roundLimit) || draft.roundLimit < 1 || draft.roundLimit > 6)
  ) {
    return '研讨轮数须为 1–6 的整数'
  }
  return null
}

function PresetEditor({
  mode,
  preset,
  channelModels,
  channelId,
  existingIds,
  onCancel,
  onSaved,
}: {
  mode: EditorMode
  preset?: MoAPreset
  channelModels: Array<{ id: string; name: string }>
  channelId: string
  existingIds: Set<string>
  onCancel: () => void
  onSaved: (updatedList: MoAPreset[]) => void
}): JSX.Element {
  // edit / CTA-add 带 preset → 用 presetToDraft（保留其 channelId）；空 add → createDraft 绑当前渠
  const [draft, setDraft] = useState<PresetDraft>(() =>
    preset ? presetToDraft(preset) : createDraft(existingIds, channelId),
  )
  const [notice, setNotice] = useState<Notice | null>(null)
  const [saving, setSaving] = useState(false)
  const isSeed = draft.id === 'default' || draft.id === 'cheap'

  const update = (patch: Partial<PresetDraft>): void => {
    setDraft((current) => ({ ...current, ...patch }))
    setNotice(null)
  }

  const addReference = (): void => {
    update({ references: [...draft.references, { name: '', modelId: '' }] })
  }

  const removeReference = (index: number): void => {
    update({
      references: draft.references.filter((_, i) => i !== index),
    })
  }

  const updateReference = (index: number, patch: Partial<MoAReferenceSeat>): void => {
    update({
      references: draft.references.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    })
  }

  const submit = async (): Promise<void> => {
    const clientErr = validateDraft(draft)
    if (clientErr) {
      setNotice({ kind: 'error', message: clientErr })
      return
    }
    setSaving(true)
    setNotice(null)
    try {
      // 读最新列表、合并当前 draft、发整份保存
      const current = await window.electronAPI.listMoaPresets()
      const merged = mode === 'edit'
        ? current.map((p) => (p.id === draft.id ? draftToMoAPreset(draft) : p))
        : [...current, draftToMoAPreset(draft)]
      const reloaded = await window.electronAPI.saveMoaPresets(merged)
      await onSaved(reloaded)
    } catch (error) {
      setNotice({
        kind: 'error',
        message: error instanceof Error ? error.message : '保存失败',
      })
    } finally {
      setSaving(false)
    }
  }

  const hasChannelModels = channelModels.length > 0

  return (
    <SettingsCard divided={false}>
      <div
        className="agent-behavior-editor"
        role="form"
        aria-label={mode === 'add' ? '添加会诊预置' : `编辑预置 ${preset?.name ?? ''}`}
      >
        <div className="agent-behavior-editor-head">
          <div className="agent-behavior-editor-copy">
            <h3 className="agent-behavior-editor-title">
              {mode === 'add' ? '添加会诊预置' : preset?.name ?? '预置'}
            </h3>
          </div>
          <div className="agent-behavior-editor-enabled">
            <span>{draft.enabled ? '已启用' : '已停用'}</span>
            <Switch
              checked={draft.enabled}
              aria-label="启用预置"
              onCheckedChange={(enabled) => update({ enabled })}
            />
          </div>
        </div>

        {notice && (
          <div
            className={`agent-behavior-notice agent-behavior-notice--${notice.kind}`}
            role={notice.kind === 'error' ? 'alert' : 'status'}
          >
            {notice.kind === 'success' ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}
            <span className="agent-behavior-notice-copy">{notice.message}</span>
          </div>
        )}

        <div className="agent-behavior-editor-body">
          {/* 基本信息：轻量分组（非渠道 EditorSection 堆栈） */}
          <div className="agent-behavior-editor-group">
            <div className="agent-behavior-editor-group-label">基本信息</div>
            <div className="agent-behavior-form-grid">
              <Field label="预置名称">
                <input
                  className="agent-behavior-input"
                  value={draft.name}
                  placeholder="例如：架构审查"
                  onChange={(e) => update({ name: e.target.value })}
                />
              </Field>
              <Field
                label="预置 ID"
                hint={isSeed ? '内置预置 ID 不可更改' : '自动生成，无需手动编辑'}
              >
                <input
                  className="agent-behavior-input agent-behavior-input--mono"
                  value={draft.id}
                  disabled
                  readOnly
                />
              </Field>
            </div>
          </div>

          {/* 参考席位 */}
          <div className="agent-behavior-editor-group">
            <div className="agent-behavior-editor-group-head">
              <div>
                <div className="agent-behavior-editor-group-label">参考席位</div>
                <p className="agent-behavior-editor-group-desc">至少 2 个；席位无工具，仅做纯文本参考回答</p>
              </div>
              <Button variant="outline" size="sm" onClick={addReference}>
                <Plus size={14} />
                添加席位
              </Button>
            </div>
            <div className="agent-behavior-seat-list scrollbar-thin">
              {draft.references.length === 0 ? (
                <div className="agent-behavior-seat-empty">至少添加 2 个参考席位</div>
              ) : draft.references.map((ref, index) => (
                <div key={index} className="agent-behavior-seat-row">
                  <input
                    className="agent-behavior-input"
                    value={ref.name}
                    placeholder="席位名称"
                    onChange={(e) => updateReference(index, { name: e.target.value })}
                  />
                  <ModelSelect
                    value={ref.modelId}
                    channelModels={channelModels}
                    placeholder={hasChannelModels ? '选择模型' : '输入 modelId'}
                    onChange={(modelId) => updateReference(index, { modelId })}
                  />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`移除席位 ${ref.name || index + 1}`}
                    onClick={() => removeReference(index)}
                  >
                    <Trash2 size={13} />
                  </Button>
                </div>
              ))}
            </div>
          </div>

          {/* 汇总与超时 */}
          <div className="agent-behavior-editor-group">
            <div className="agent-behavior-editor-group-label">汇总与超时</div>
            <div className="agent-behavior-form-grid">
              <Field
                label="汇总模型"
                hint={!hasChannelModels ? '该渠道暂无已启用模型，可手动输入 modelId（须在会诊时所属渠道启用）' : undefined}
              >
                <ModelSelect
                  value={draft.aggregatorModelId}
                  channelModels={channelModels}
                  placeholder={hasChannelModels ? '选择汇总模型' : '输入汇总 modelId'}
                  onChange={(modelId) => update({ aggregatorModelId: modelId })}
                />
              </Field>
              <Field label="单席超时（ms）" hint="默认 120000（2 分钟）">
                <input
                  className="agent-behavior-input"
                  type="number"
                  min={1000}
                  step={1000}
                  value={draft.timeoutMsPerSeat}
                  placeholder="120000"
                  onChange={(e) => {
                    const val = Number(e.target.value)
                    if (!Number.isNaN(val) && val > 0) update({ timeoutMsPerSeat: val })
                  }}
                />
              </Field>
              <Field
                label="研讨轮数"
                hint="仅圆桌生效（1–6 整数）；会诊固定单轮，忽略此值。留空用默认 3。"
              >
                <input
                  className="agent-behavior-input"
                  type="number"
                  min={1}
                  max={6}
                  step={1}
                  value={draft.roundLimit ?? ''}
                  placeholder="3"
                  onChange={(e) => {
                    const raw = e.target.value
                    if (raw === '') {
                      update({ roundLimit: undefined })
                      return
                    }
                    const val = Number(raw)
                    if (Number.isNaN(val)) {
                      update({ roundLimit: undefined })
                      return
                    }
                    // 保留用户输入（含越界 / 非整数中间态），交 validateDraft 报错
                    update({ roundLimit: val })
                  }}
                />
              </Field>
            </div>
          </div>
        </div>

        <div className="agent-behavior-editor-actions">
          <Button variant="ghost" onClick={onCancel}>取消</Button>
          <Button disabled={saving} onClick={() => void submit()}>
            {saving ? '正在保存…' : mode === 'add' ? '添加预置' : '保存更改'}
          </Button>
        </div>
      </div>
    </SettingsCard>
  )
}

// ── 模型选择器（当前选中渠 enabled 下拉 / 手动输入兜底）──

function ModelSelect({
  value,
  channelModels,
  placeholder,
  onChange,
}: {
  value: string
  channelModels: Array<{ id: string; name: string }>
  placeholder: string
  onChange: (modelId: string) => void
}): JSX.Element {
  if (channelModels.length === 0) {
    // 该渠道无已启用模型：手动输入
    return (
      <input
        className="agent-behavior-input agent-behavior-input--mono"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    )
  }
  // 有已启用模型：下拉选择（含当前值兜底项）
  const items = [...channelModels]
  if (value && !items.some((m) => m.id === value)) {
    // 当前值不在列表中（手动输入遗留），作为兜底项显示
    items.push({ id: value, name: value })
  }
  return (
    <Select value={value || undefined} onValueChange={onChange}>
      <SelectTrigger className="agent-behavior-input agent-behavior-select">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className="scrollbar-thin !z-[130]">
        {items.map((m) => (
          <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

// ── 通用子组件 ──

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string
  hint?: string
  error?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <label className="agent-behavior-field">
      <span className="agent-behavior-field-label">{label}</span>
      {children}
      {error ? (
        <span className="agent-behavior-field-error" role="alert">{error}</span>
      ) : hint ? (
        <span className="agent-behavior-field-hint">{hint}</span>
      ) : null}
    </label>
  )
}
