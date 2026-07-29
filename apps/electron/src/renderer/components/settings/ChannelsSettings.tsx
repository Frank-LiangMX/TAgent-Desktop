import { useEffect, useRef, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  CloudDownload,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  Wifi,
} from 'lucide-react'
import {
  Button,
  DestructiveConfirmDialog,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@tagent/ui'
import {
  PROVIDER_DEFAULT_URLS,
  PROVIDER_LABELS,
  type Channel,
  type ChannelModel,
  type ProviderType,
} from '@tagent/shared'
import {
  channelsAtom,
  externalChannelsAtom,
  ksccChannelAtom,
  loadChannelsAtom,
} from '../../atoms/channel-atoms'
import {
  KSCC_PROVIDER,
  buildCreateInput,
  buildUpdateInput,
  channelToDraft,
  createChannelDraft,
  mergeFetchedModels,
  normalizeModels,
  validateChannelDraft,
  type ChannelDraft,
  type ChannelDraftValidation,
} from './channel-settings-model'

type EditorMode = 'add' | 'edit'
type Operation = { kind: 'testing' | 'success' | 'error'; message: string }

const PROVIDERS = Object.entries(PROVIDER_LABELS)
  .filter(([provider]) => provider !== KSCC_PROVIDER) as Array<[ProviderType, string]>

export function ChannelsSettings(): JSX.Element {
  const channels = useAtomValue(channelsAtom)
  const builtin = useAtomValue(ksccChannelAtom)
  const externals = useAtomValue(externalChannelsAtom)
  const loadChannels = useSetAtom(loadChannelsAtom)
  const [loading, setLoading] = useState(channels.length === 0)
  const [loadError, setLoadError] = useState('')
  const [editor, setEditor] = useState<{ mode: EditorMode; channel?: Channel } | null>(null)
  const [operations, setOperations] = useState<Record<string, Operation>>({})
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set())
  const [deleteTarget, setDeleteTarget] = useState<Channel | null>(null)

  const reload = async (): Promise<void> => {
    setLoadError('')
    try {
      await loadChannels()
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : '无法读取渠道配置')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void reload()
  }, [loadChannels])

  const setBusy = (id: string, busy: boolean): void => {
    setBusyIds((current) => {
      const next = new Set(current)
      if (busy) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const testChannel = async (channel: Channel): Promise<void> => {
    setOperations((current) => ({
      ...current,
      [channel.id]: { kind: 'testing', message: '正在验证连接…' },
    }))
    try {
      const result = await window.electronAPI.testChannel(channel.id)
      setOperations((current) => ({
        ...current,
        [channel.id]: {
          kind: result.success ? 'success' : 'error',
          message: result.message,
        },
      }))
    } catch (error) {
      setOperations((current) => ({
        ...current,
        [channel.id]: {
          kind: 'error',
          message: error instanceof Error ? error.message : '连接测试失败',
        },
      }))
    }
  }

  const toggleChannel = async (channel: Channel): Promise<void> => {
    setBusy(channel.id, true)
    try {
      await window.electronAPI.updateChannel(channel.id, { enabled: !channel.enabled })
      await reload()
    } catch (error) {
      setOperations((current) => ({
        ...current,
        [channel.id]: {
          kind: 'error',
          message: error instanceof Error ? error.message : '状态更新失败',
        },
      }))
    } finally {
      setBusy(channel.id, false)
    }
  }

  const deleteChannel = async (): Promise<void> => {
    if (!deleteTarget) return
    const target = deleteTarget
    setBusy(target.id, true)
    try {
      const result = await window.electronAPI.deleteChannel(target.id)
      if (!result.ok) throw new Error(result.error ?? '删除失败')
      await reload()
    } catch (error) {
      const message = error instanceof Error ? error.message : '删除失败'
      setOperations((current) => ({
        ...current,
        [target.id]: {
          kind: 'error',
          message,
        },
      }))
      throw new Error(message)
    } finally {
      setBusy(target.id, false)
    }
  }

  if (editor) {
    return (
      <ChannelEditor
        mode={editor.mode}
        channel={editor.channel}
        onCancel={() => setEditor(null)}
        onSaved={async () => {
          await reload()
          setEditor(null)
        }}
      />
    )
  }

  const enabledCount = channels.filter((channel) => channel.enabled).length
  return (
    <div className="settings-page channel-settings-page">
      <div className="channel-settings-heading">
        <div>
          <h2 className="settings-page-intro-title">渠道</h2>
          <p className="settings-page-intro-desc">
            管理 AI 供应商、访问凭据和会话可用的模型
          </p>
        </div>
        <Button size="sm" onClick={() => setEditor({ mode: 'add' })}>
          <Plus size={14} />
          添加渠道
        </Button>
      </div>

      <div className="channel-settings-summary" aria-live="polite">
        <span>{channels.length} 个渠道</span>
        <span aria-hidden>·</span>
        <span>{enabledCount} 个已启用</span>
      </div>

      {loadError && (
        <div className="channel-notice channel-notice--error" role="alert">
          <AlertCircle size={15} />
          <span className="channel-notice-copy">{loadError}</span>
          <Button variant="ghost" size="sm" onClick={() => void reload()}>重试</Button>
        </div>
      )}

      {loading ? (
        <div className="channel-list-loading">
          <RefreshCw size={16} className="animate-spin" />
          正在读取渠道配置…
        </div>
      ) : (
        <>
          {builtin && (
            <ChannelGroup title="内置服务" description="由 TAgent 提供，无需配置 API Key">
              <ChannelRow
                channel={builtin}
                builtin
                operation={operations[builtin.id]}
                busy={busyIds.has(builtin.id)}
                onEdit={() => setEditor({ mode: 'edit', channel: builtin })}
                onTest={() => void testChannel(builtin)}
                onToggle={() => void toggleChannel(builtin)}
              />
            </ChannelGroup>
          )}

          <ChannelGroup title="外部服务" description="使用你自己的供应商凭据直连">
            {externals.length > 0 ? externals.map((channel) => (
              <ChannelRow
                key={channel.id}
                channel={channel}
                operation={operations[channel.id]}
                busy={busyIds.has(channel.id)}
                onEdit={() => setEditor({ mode: 'edit', channel })}
                onDelete={() => setDeleteTarget(channel)}
                onTest={() => void testChannel(channel)}
                onToggle={() => void toggleChannel(channel)}
              />
            )) : (
              <div className="channel-empty">
                <Server size={20} />
                <div>
                  <strong>还没有外部渠道</strong>
                  <p>添加供应商与 API Key，即可在新会话中选择对应模型。</p>
                </div>
                <Button variant="outline" size="sm" onClick={() => setEditor({ mode: 'add' })}>
                  添加第一个渠道
                </Button>
              </div>
            )}
          </ChannelGroup>
        </>
      )}

      <DestructiveConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        icon={<Trash2 size={15} />}
        title={`删除“${deleteTarget?.name ?? ''}”？`}
        description="渠道配置和访问凭据将从本机移除，绑定该渠道的历史会话将无法继续发送消息。"
        confirmLabel="删除渠道"
        onConfirm={deleteChannel}
      />
    </div>
  )
}

function ChannelGroup({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <section className="channel-group">
      <div className="channel-group-heading">
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      <div className="channel-list">{children}</div>
    </section>
  )
}

function ChannelRow({
  channel,
  builtin = false,
  operation,
  busy,
  onEdit,
  onDelete,
  onTest,
  onToggle,
}: {
  channel: Channel
  builtin?: boolean
  operation?: Operation
  busy: boolean
  onEdit: () => void
  onDelete?: () => void
  onTest: () => void
  onToggle: () => void
}): JSX.Element {
  const enabledModels = channel.models.filter((model) => model.enabled)
  return (
    <article className="channel-row">
      <div className="channel-row-topline">
        <div className={`channel-provider-mark ${channel.enabled ? '' : 'channel-provider-mark--muted'}`}>
          <Server size={15} />
        </div>
        <div className="channel-row-identity">
          <div className="channel-row-title">
            <strong>{channel.name}</strong>
            {builtin && <span className="channel-tag">内置</span>}
            <span className={`channel-status-text ${channel.enabled ? 'channel-status-text--on' : ''}`}>
              {channel.enabled ? '已启用' : '已停用'}
            </span>
          </div>
          <p title={channel.baseUrl || 'TAgent 内置网关'}>
            {PROVIDER_LABELS[channel.provider]} · {channel.baseUrl || 'TAgent 内置网关'}
          </p>
        </div>
        <Switch
          size="sm"
          checked={channel.enabled}
          disabled={busy}
          aria-label={`${channel.enabled ? '停用' : '启用'} ${channel.name}`}
          onCheckedChange={onToggle}
        />
      </div>
      <div className="channel-row-details">
        <span>{enabledModels.length} 个可用模型</span>
        <span aria-hidden>·</span>
        <span className="truncate">默认：{channel.defaultModelId || '未设置'}</span>
        {!builtin && (
          <>
            <span aria-hidden>·</span>
            <span className="channel-credential"><KeyRound size={12} />{channel.apiKey ? '凭据已保存' : '缺少凭据'}</span>
          </>
        )}
      </div>
      <div className="channel-row-footer">
        <div className={`channel-test-result channel-test-result--${operation?.kind ?? 'idle'}`} aria-live="polite">
          {operation?.kind === 'testing' && <RefreshCw size={12} className="animate-spin" />}
          {operation?.kind === 'success' && <CheckCircle2 size={12} />}
          {operation?.kind === 'error' && <AlertCircle size={12} />}
          <span>{operation?.message ?? '尚未测试连接'}</span>
        </div>
        <div className="channel-row-actions">
          <Button
            variant="ghost"
            size="sm"
            disabled={operation?.kind === 'testing'}
            onClick={onTest}
          >
            <Wifi size={13} />
            测试
          </Button>
          <Button variant="ghost" size="sm" onClick={onEdit}>
            <Pencil size={13} />
            编辑
          </Button>
          {onDelete && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-destructive"
              aria-label={`删除 ${channel.name}`}
              disabled={busy}
              onClick={onDelete}
            >
              <Trash2 size={13} />
            </Button>
          )}
        </div>
      </div>
    </article>
  )
}

function ChannelEditor({
  mode,
  channel,
  onCancel,
  onSaved,
}: {
  mode: EditorMode
  channel?: Channel
  onCancel: () => void
  onSaved: () => Promise<void>
}): JSX.Element {
  const [draft, setDraft] = useState<ChannelDraft>(() => channel ? channelToDraft(channel) : createChannelDraft())
  const [errors, setErrors] = useState<ChannelDraftValidation['errors']>({})
  const [notice, setNotice] = useState<{ kind: 'info' | 'error' | 'success'; message: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [newModelId, setNewModelId] = useState('')
  const syncRequest = useRef(0)
  const builtin = draft.provider === KSCC_PROVIDER

  const update = (patch: Partial<ChannelDraft>): void => {
    setDraft((current) => ({ ...current, ...patch }))
    setErrors({})
  }

  const updateModels = (models: ChannelModel[], requestedDefault = draft.defaultModelId): void => {
    const normalized = normalizeModels(models, requestedDefault)
    update({ models: normalized.models, defaultModelId: normalized.defaultModelId })
  }

  const changeProvider = (provider: ProviderType): void => {
    syncRequest.current += 1
    update({
      provider,
      baseUrl: PROVIDER_DEFAULT_URLS[provider],
      models: [],
      defaultModelId: '',
    })
    setNotice(null)
  }

  const syncModels = async (): Promise<void> => {
    if (!draft.baseUrl.trim()) {
      setErrors({ baseUrl: '请先填写服务地址' })
      return
    }
    const connectionChanged = Boolean(
      channel
      && (draft.provider !== channel.provider || draft.baseUrl.trim() !== channel.baseUrl.trim()),
    )
    if (!draft.apiKey.trim() && mode === 'add') {
      setErrors({ apiKey: '请先填写 API Key' })
      return
    }
    if (!draft.apiKey.trim() && connectionChanged) {
      setErrors({ apiKey: '供应商或服务地址已更改，请输入对应的 API Key' })
      return
    }
    const requestId = ++syncRequest.current
    setSyncing(true)
    setNotice(null)
    try {
      const result = mode === 'edit' && channel && !draft.apiKey.trim()
        ? await window.electronAPI.fetchModelsForChannel({ channelId: channel.id })
        : await window.electronAPI.fetchModels({
            provider: draft.provider,
            baseUrl: draft.baseUrl.trim(),
            apiKey: draft.apiKey.trim(),
          })
      if (requestId !== syncRequest.current) return
      setDraft((current) => {
        const merged = mergeFetchedModels(current.models, result.models, current.defaultModelId)
        return { ...current, models: merged.models, defaultModelId: merged.defaultModelId }
      })
      setErrors({})
      setNotice({
        kind: result.success ? 'success' : 'info',
        message: result.success
          ? `已从供应商同步 ${result.models.length} 个模型`
          : result.models.length > 0
            ? `${result.message}；已合并本地预设，请确认后再保存`
            : result.message,
      })
    } catch (error) {
      if (requestId !== syncRequest.current) return
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : '模型同步失败' })
    } finally {
      if (requestId === syncRequest.current) setSyncing(false)
    }
  }

  const addModel = (): void => {
    const id = newModelId.trim()
    if (!id) return
    if (draft.models.some((model) => model.id === id)) {
      setNotice({ kind: 'info', message: `模型 ${id} 已在列表中` })
      return
    }
    updateModels([...draft.models, { id, name: id, enabled: true }])
    setNewModelId('')
  }

  const submit = async (): Promise<void> => {
    const validation = validateChannelDraft(draft, mode)
    setErrors(validation.errors)
    if (!validation.valid) return
    setSaving(true)
    setNotice(null)
    try {
      if (mode === 'add') {
        await window.electronAPI.createChannel(buildCreateInput(draft))
      } else if (channel) {
        await window.electronAPI.updateChannel(channel.id, buildUpdateInput(draft))
      }
      await onSaved()
    } catch (error) {
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : '保存失败' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="settings-page channel-settings-page channel-editor">
      <button type="button" className="channel-editor-back" onClick={onCancel}>
        <ArrowLeft size={14} />
        返回渠道列表
      </button>
      <div className="channel-settings-heading">
        <div>
          <h2 className="settings-page-intro-title">{mode === 'add' ? '添加渠道' : `编辑 ${channel?.name ?? '渠道'}`}</h2>
          <p className="settings-page-intro-desc">
            {builtin ? '管理内置服务的可用模型与启用状态' : '配置供应商连接、访问凭据与模型'}
          </p>
        </div>
        <div className="channel-editor-enabled">
          <span>{draft.enabled ? '渠道已启用' : '渠道已停用'}</span>
          <Switch checked={draft.enabled} onCheckedChange={(enabled) => update({ enabled })} />
        </div>
      </div>

      {notice && (
        <div className={`channel-notice channel-notice--${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
          {notice.kind === 'success' ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}
          <span>{notice.message}</span>
        </div>
      )}

      <EditorSection title="基本信息" description="用于在会话模型选择器中识别该连接">
        <div className="channel-form-grid">
          <Field label="渠道名称" error={errors.name}>
            <input
              className="channel-input"
              value={draft.name}
              placeholder="例如：团队 OpenAI"
              aria-invalid={Boolean(errors.name)}
              onChange={(event) => update({ name: event.target.value })}
            />
          </Field>
          <Field label="供应商">
            <Select
              value={draft.provider}
              disabled={builtin}
              onValueChange={(provider) => changeProvider(provider as ProviderType)}
            >
              <SelectTrigger className="channel-input channel-provider-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="scrollbar-thin !z-[130]">
              {builtin && <SelectItem value={KSCC_PROVIDER}>{PROVIDER_LABELS[KSCC_PROVIDER]}</SelectItem>}
              {!builtin && PROVIDERS.map(([provider, label]) => (
                <SelectItem key={provider} value={provider}>{label}</SelectItem>
              ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
      </EditorSection>

      {!builtin && (
        <EditorSection title="连接配置" description="凭据仅加密保存在本机">
          <Field label="服务地址" error={errors.baseUrl}>
            <input
              className="channel-input channel-input--mono"
              value={draft.baseUrl}
              placeholder="https://api.example.com/v1"
              aria-invalid={Boolean(errors.baseUrl)}
              onChange={(event) => update({ baseUrl: event.target.value })}
            />
          </Field>
          <Field
            label={mode === 'edit' ? '替换 API Key' : 'API Key'}
            hint={mode === 'edit' && channel?.apiKey
              ? '密钥已加密保存，可直接同步模型；输入新值将替换现有密钥。'
              : mode === 'edit'
                ? '当前没有可用凭据，请输入 API Key。'
                : '不会显示在渠道列表或日志中。'}
            error={errors.apiKey}
          >
            <input
              type="password"
              className="channel-input channel-input--mono"
              value={draft.apiKey}
              placeholder={mode === 'edit' && channel?.apiKey ? '••••••••••••（已保存）' : '输入供应商 API Key'}
              autoComplete="new-password"
              aria-invalid={Boolean(errors.apiKey)}
              onChange={(event) => update({ apiKey: event.target.value })}
            />
          </Field>
        </EditorSection>
      )}

      <EditorSection
        title="可用模型"
        description="仅启用的模型会出现在新会话中；默认模型必须处于启用状态"
        action={!builtin ? (
          <Button variant="outline" size="sm" disabled={syncing} onClick={() => void syncModels()}>
            <CloudDownload size={14} className={syncing ? 'animate-pulse' : ''} />
            {syncing ? '正在同步…' : '从供应商同步'}
          </Button>
        ) : undefined}
      >
        <div className="channel-model-add">
          <input
            className="channel-input channel-input--mono"
            value={newModelId}
            placeholder="手动输入模型 ID"
            onChange={(event) => setNewModelId(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                addModel()
              }
            }}
          />
          <Button variant="outline" size="sm" onClick={addModel} disabled={!newModelId.trim()}>
            <Plus size={14} />
            添加
          </Button>
        </div>
        {errors.models && <p className="channel-field-error" role="alert">{errors.models}</p>}
        <div className="channel-model-list channel-model-scroll scrollbar-thin">
          {draft.models.length === 0 ? (
            <div className="channel-model-empty">同步供应商模型，或手动添加模型 ID</div>
          ) : draft.models.map((model) => (
            <div key={model.id} className="channel-model-row">
              <button
                type="button"
                className={`channel-default-radio ${draft.defaultModelId === model.id ? 'channel-default-radio--active' : ''}`}
                disabled={!model.enabled}
                aria-label={`将 ${model.name} 设为默认模型`}
                title={model.enabled ? '设为默认模型' : '启用后可设为默认'}
                onClick={() => update({ defaultModelId: model.id })}
              >
                <span />
              </button>
              <div className="channel-model-copy">
                <strong>{model.name}</strong>
                <span>{model.id}</span>
              </div>
              {draft.defaultModelId === model.id && <span className="channel-tag">默认</span>}
              <Switch
                size="sm"
                checked={model.enabled}
                aria-label={`${model.enabled ? '停用' : '启用'} ${model.name}`}
                onCheckedChange={(enabled) => updateModels(
                  draft.models.map((item) => item.id === model.id ? { ...item, enabled } : item),
                  draft.defaultModelId,
                )}
              />
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`移除 ${model.name}`}
                onClick={() => updateModels(draft.models.filter((item) => item.id !== model.id), draft.defaultModelId)}
              >
                <Trash2 size={13} />
              </Button>
            </div>
          ))}
        </div>
      </EditorSection>

      <div className="channel-editor-actions">
        <Button variant="ghost" onClick={onCancel}>取消</Button>
        <Button disabled={saving} onClick={() => void submit()}>
          {saving ? '正在保存…' : mode === 'add' ? '添加渠道' : '保存更改'}
        </Button>
      </div>
    </div>
  )
}

function EditorSection({
  title,
  description,
  action,
  children,
}: {
  title: string
  description: string
  action?: React.ReactNode
  children: React.ReactNode
}): JSX.Element {
  return (
    <section className="channel-editor-section">
      <div className="channel-editor-section-head">
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
        {action}
      </div>
      <div className="channel-editor-section-body">{children}</div>
    </section>
  )
}

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
    <label className="channel-field">
      <span className="channel-field-label">{label}</span>
      {children}
      {error ? <span className="channel-field-error" role="alert">{error}</span> : hint ? <span className="channel-field-hint">{hint}</span> : null}
    </label>
  )
}
