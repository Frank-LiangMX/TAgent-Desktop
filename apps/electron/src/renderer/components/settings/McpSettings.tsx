/**
 * MCP 管理（工作区维度）
 *
 * 产品归属：插件页（与整合包同级），不再单独出现在设置里。
 * 行为：先选工作区 → 列表（名称/type/enabled/command|url 摘要/lastTestResult）
 *      → 增删改表单（stdio/http/sse）+ 启用开关即时 upsert + 真实测试连接。
 * 视觉：复用 ChannelsSettings 的 channel-* 样式与 @tagent/ui 组件。
 *
 * embedded + workspaceId：嵌入插件页时隐藏顶栏与工作区选择，共用父级工作区。
 */
import { useEffect, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  Wifi,
  Plug,
} from 'lucide-react'
import {
  AppTooltip,
  Button,
  DestructiveConfirmDialog,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@tagent/ui'
import type { McpServerEntry, McpTransportType, WorkspaceMcpConfig } from '@tagent/shared'
import { workspacesAtom, loadWorkspacesAtom } from '../../atoms/workspace-atoms'
import {
  MCP_DEFAULT_TIMEOUT,
  MCP_TRANSPORT_TYPES,
  buildMcpEntry,
  createMcpDraft,
  entryToDraft,
  listMcpServers,
  summarizeMcpEntry,
  validateMcpDraft,
  type McpDraft,
  type McpDraftValidation,
} from './mcp-settings-model'

type EditorMode = 'add' | 'edit'
type Operation = { kind: 'testing' | 'success' | 'error'; message: string }

export interface McpSettingsProps {
  /** 嵌入插件页：隐藏独立顶栏与工作区选择 */
  embedded?: boolean
  /** 受控工作区 id（embedded 时由插件页传入） */
  workspaceId?: string
}

export function McpSettings({ embedded = false, workspaceId }: McpSettingsProps = {}): JSX.Element {
  const workspaces = useAtomValue(workspacesAtom)
  const loadWorkspaces = useSetAtom(loadWorkspacesAtom)
  const [selectedId, setSelectedId] = useState('')
  const [config, setConfig] = useState<WorkspaceMcpConfig | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [editor, setEditor] = useState<{ mode: EditorMode; name?: string; entry?: McpServerEntry } | null>(null)
  const [operations, setOperations] = useState<Record<string, Operation>>({})
  const [deleteTarget, setDeleteTarget] = useState<{ name: string } | null>(null)

  // 打开时刷新工作区列表（可能在外部新建过项目）
  useEffect(() => {
    void loadWorkspaces()
  }, [loadWorkspaces])

  // 默认选中第一个工作区（非受控时）
  useEffect(() => {
    if (workspaceId) return
    if (!selectedId && workspaces.length > 0) {
      const first = workspaces[0]
      if (first) setSelectedId(first.id)
    }
  }, [workspaces, selectedId, workspaceId])

  const slug = workspaceId || selectedId

  const reload = async (): Promise<void> => {
    if (!slug) {
      setConfig({ servers: {} })
      return
    }
    setLoading(true)
    setLoadError('')
    try {
      const cfg = await window.electronAPI.getMcpConfig(slug)
      setConfig(cfg ?? { servers: {} })
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : '无法读取 MCP 配置')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!slug) {
      setConfig({ servers: {} })
      return
    }
    void reload()
    // reload 闭包随 slug 变化，故仅依赖 slug
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug])

  const setOp = (name: string, op: Operation): void => {
    setOperations((current) => ({ ...current, [name]: op }))
  }

  const testServer = async (name: string, entry: McpServerEntry): Promise<void> => {
    if (!slug) return
    setOp(name, { kind: 'testing', message: '正在测试连接…' })
    try {
      const result = await window.electronAPI.testMcpServer(slug, name, entry)
      setOp(name, { kind: result.success ? 'success' : 'error', message: result.message })
      await reload() // 反映持久化的 lastTestResult
    } catch (err) {
      setOp(name, { kind: 'error', message: err instanceof Error ? err.message : '连接测试失败' })
    }
  }

  const toggleServer = async (name: string, entry: McpServerEntry): Promise<void> => {
    if (!slug) return
    try {
      await window.electronAPI.upsertMcpServer(slug, name, { ...entry, enabled: !entry.enabled })
      await reload()
    } catch (err) {
      setOp(name, { kind: 'error', message: err instanceof Error ? err.message : '状态更新失败' })
    }
  }

  const deleteServer = async (): Promise<void> => {
    if (!deleteTarget || !slug) return
    const target = deleteTarget
    try {
      const result = await window.electronAPI.deleteMcpServer(slug, target.name)
      if (!result.ok) throw new Error(result.error ?? '删除失败')
      setOperations((current) => {
        const next = { ...current }
        delete next[target.name]
        return next
      })
      await reload()
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : '删除失败')
    }
  }

  if (editor) {
    return (
      <McpServerEditor
        mode={editor.mode}
        name={editor.name}
        entry={editor.entry}
        slug={slug}
        onCancel={() => setEditor(null)}
        onSaved={async () => {
          await reload()
          setEditor(null)
        }}
      />
    )
  }

  if (workspaces.length === 0) {
    return (
      <div className={embedded ? undefined : 'settings-page channel-settings-page'}>
        {!embedded && (
          <div className="channel-settings-heading">
            <div>
              <h2 className="settings-page-intro-title">MCP 服务器</h2>
              <p className="settings-page-intro-desc">按工作区管理 MCP 工具服务器，并测试真实连接</p>
            </div>
          </div>
        )}
        <div className="channel-empty">
          <Plug size={20} />
          <div>
            <strong>尚未打开项目目录</strong>
            <p>请先在主界面打开一个项目目录，再在此管理其 MCP 服务器。</p>
          </div>
        </div>
      </div>
    )
  }

  const servers = config ? listMcpServers(config) : []
  const enabledCount = servers.filter((s) => s.entry.enabled).length

  return (
    <div className={embedded ? undefined : 'settings-page channel-settings-page'}>
      {!embedded && (
        <>
          <div className="channel-settings-heading">
            <div>
              <h2 className="settings-page-intro-title">MCP 服务器</h2>
              <p className="settings-page-intro-desc">按工作区管理 MCP 工具服务器，并测试真实连接</p>
            </div>
            <Button size="sm" disabled={!slug} onClick={() => setEditor({ mode: 'add' })}>
              <Plus size={14} />
              添加服务器
            </Button>
          </div>

          <div className="flex items-center gap-2" style={{ marginTop: -6 }}>
            <span className="text-[11px] text-muted-foreground">工作区</span>
            <Select value={selectedId} onValueChange={setSelectedId}>
              <SelectTrigger className="channel-input channel-provider-select" style={{ width: 240 }}>
                <SelectValue placeholder="选择工作区" />
              </SelectTrigger>
              <SelectContent className="scrollbar-thin !z-[130]">
                {workspaces.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name ?? w.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </>
      )}

      {embedded && (
        <div className="channel-settings-heading" style={{ marginTop: 0 }}>
          <div className="channel-settings-summary" style={{ margin: 0 }}>
            <span>{servers.length} 个服务器</span>
            <span aria-hidden>·</span>
            <span>{enabledCount} 个已启用</span>
          </div>
          <Button size="sm" disabled={!slug} onClick={() => setEditor({ mode: 'add' })}>
            <Plus size={14} />
            添加服务器
          </Button>
        </div>
      )}

      {!embedded && (
        <div className="channel-settings-summary">
          <span>{servers.length} 个服务器</span>
          <span aria-hidden>·</span>
          <span>{enabledCount} 个已启用</span>
        </div>
      )}

      {loadError && (
        <div className="channel-notice channel-notice--error" role="alert">
          <AlertCircle size={15} />
          <span className="channel-notice-copy">{loadError}</span>
          <Button variant="ghost" size="sm" onClick={() => void reload()}>
            重试
          </Button>
        </div>
      )}

      {loading ? (
        <div className="channel-list-loading">
          <RefreshCw size={16} className="animate-spin" />
          正在读取 MCP 配置…
        </div>
      ) : servers.length === 0 ? (
        <div className="channel-empty">
          <Server size={20} />
          <div>
            <strong>还没有 MCP 服务器</strong>
            <p>添加一个 stdio / http / sse 服务器，即可在会话中调用其工具。</p>
          </div>
          <Button variant="outline" size="sm" disabled={!slug} onClick={() => setEditor({ mode: 'add' })}>
            添加第一个
          </Button>
        </div>
      ) : (
        <section className="channel-group">
          <div className="channel-list">
            {servers.map(({ name, entry }) => (
              <McpServerRow
                key={name}
                name={name}
                entry={entry}
                operation={operations[name]}
                onTest={() => void testServer(name, entry)}
                onEdit={() => setEditor({ mode: 'edit', name, entry })}
                onDelete={() => setDeleteTarget({ name })}
                onToggle={() => void toggleServer(name, entry)}
              />
            ))}
          </div>
        </section>
      )}

      <DestructiveConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        icon={<Trash2 size={15} />}
        title={`删除“${deleteTarget?.name ?? ''}”？`}
        description="该 MCP 服务器配置将从本工作区移除，相关会话将不再能调用其工具。"
        confirmLabel="删除服务器"
        onConfirm={deleteServer}
      />
    </div>
  )
}

function McpServerRow({
  name,
  entry,
  operation,
  onTest,
  onEdit,
  onDelete,
  onToggle,
}: {
  name: string
  entry: McpServerEntry
  operation?: Operation
  onTest: () => void
  onEdit: () => void
  onDelete: () => void
  onToggle: () => void
}): JSX.Element {
  const typeLabel = entry.type.toUpperCase()
  // 显示结果：live operation 优先，否则持久化 lastTestResult
  const live: Operation | undefined = operation
  const persisted: Operation | undefined = entry.lastTestResult
    ? { kind: entry.lastTestResult.success ? 'success' : 'error', message: entry.lastTestResult.message }
    : undefined
  const result = live ?? persisted

  return (
    <article className="channel-row">
      <div className="channel-row-topline">
        <div className={`channel-provider-mark ${entry.enabled ? '' : 'channel-provider-mark--muted'}`}>
          <Server size={15} />
        </div>
        <div className="channel-row-identity">
          <div className="channel-row-title">
            <strong>{name}</strong>
            <span className="channel-tag">{typeLabel}</span>
            <span className={`channel-status-text ${entry.enabled ? 'channel-status-text--on' : ''}`}>
              {entry.enabled ? '已启用' : '已停用'}
            </span>
          </div>
          <AppTooltip label={summarizeMcpEntry(entry)} multiline>
            <p>{summarizeMcpEntry(entry)}</p>
          </AppTooltip>
        </div>
        <Switch
          size="sm"
          checked={entry.enabled}
          aria-label={`${entry.enabled ? '停用' : '启用'} ${name}`}
          onCheckedChange={onToggle}
        />
      </div>
      <div className="channel-row-footer">
        <div
          className={`channel-test-result channel-test-result--${result?.kind ?? 'idle'}`}
          aria-live="polite"
        >
          {result?.kind === 'testing' && <RefreshCw size={12} className="animate-spin" />}
          {result?.kind === 'success' && <CheckCircle2 size={12} />}
          {result?.kind === 'error' && <AlertCircle size={12} />}
          <span>{result?.message ?? '尚未测试连接'}</span>
        </div>
        <div className="channel-row-actions">
          <Button variant="ghost" size="sm" disabled={result?.kind === 'testing'} onClick={onTest}>
            <Wifi size={13} />
            测试
          </Button>
          <Button variant="ghost" size="sm" onClick={onEdit}>
            <Pencil size={13} />
            编辑
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground hover:text-destructive"
            aria-label={`删除 ${name}`}
            onClick={onDelete}
          >
            <Trash2 size={13} />
          </Button>
        </div>
      </div>
    </article>
  )
}

function McpServerEditor({
  mode,
  name,
  entry,
  slug,
  onCancel,
  onSaved,
}: {
  mode: EditorMode
  name?: string
  entry?: McpServerEntry
  slug: string
  onCancel: () => void
  onSaved: () => Promise<void>
}): JSX.Element {
  const [draft, setDraft] = useState<McpDraft>(() =>
    entry && name ? entryToDraft(name, entry) : createMcpDraft()
  )
  const [errors, setErrors] = useState<McpDraftValidation['errors']>({})
  const [notice, setNotice] = useState<{ kind: 'info' | 'error' | 'success'; message: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const isStdio = draft.type === 'stdio'

  const update = (patch: Partial<McpDraft>): void => {
    setDraft((current) => ({ ...current, ...patch }))
    setErrors({})
  }

  const submit = async (): Promise<void> => {
    const validation = validateMcpDraft(draft)
    setErrors(validation.errors)
    if (!validation.valid) return
    setSaving(true)
    setNotice(null)
    try {
      await window.electronAPI.upsertMcpServer(slug, draft.name.trim(), buildMcpEntry(draft, entry))
      await onSaved()
    } catch (err) {
      setNotice({ kind: 'error', message: err instanceof Error ? err.message : '保存失败' })
    } finally {
      setSaving(false)
    }
  }

  const testDraft = async (): Promise<void> => {
    const validation = validateMcpDraft(draft)
    setErrors(validation.errors)
    if (!validation.valid) {
      setNotice({ kind: 'error', message: '请先补全必填项再测试' })
      return
    }
    setTesting(true)
    setNotice(null)
    try {
      const built = buildMcpEntry(draft, entry)
      const result = await window.electronAPI.testMcpServer(slug, draft.name.trim(), built)
      setNotice({
        kind: result.success ? 'success' : 'error',
        message: result.success ? result.message : `连接失败：${result.message}`,
      })
    } catch (err) {
      setNotice({ kind: 'error', message: err instanceof Error ? err.message : '连接测试失败' })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="settings-page channel-settings-page channel-editor">
      <button type="button" className="channel-editor-back" onClick={onCancel}>
        <ArrowLeft size={14} />
        返回服务器列表
      </button>
      <div className="channel-settings-heading">
        <div>
          <h2 className="settings-page-intro-title">
            {mode === 'add' ? '添加 MCP 服务器' : `编辑 ${name ?? ''}`}
          </h2>
          <p className="settings-page-intro-desc">配置 stdio / http / sse 传输，并可在保存前测试连接</p>
        </div>
        <div className="channel-editor-enabled">
          <span>{draft.enabled ? '已启用' : '已停用'}</span>
          <Switch checked={draft.enabled} onCheckedChange={(enabled) => update({ enabled })} />
        </div>
      </div>

      {notice && (
        <div
          className={`channel-notice channel-notice--${notice.kind}`}
          role={notice.kind === 'error' ? 'alert' : 'status'}
        >
          {notice.kind === 'success' ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}
          <span>{notice.message}</span>
        </div>
      )}

      <EditorSection title="基本信息" description="名称用于在会话中识别该 MCP 服务器">
        <div className="channel-form-grid">
          <Field label="名称" error={errors.name}>
            <input
              className="channel-input"
              value={draft.name}
              placeholder="例如：filesystem"
              disabled={mode === 'edit'}
              aria-invalid={Boolean(errors.name)}
              onChange={(e) => update({ name: e.target.value })}
            />
          </Field>
          <Field label="传输类型">
            <Select
              value={draft.type}
              onValueChange={(v) => update({ type: v as McpTransportType })}
            >
              <SelectTrigger className="channel-input channel-provider-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="scrollbar-thin !z-[130]">
                {MCP_TRANSPORT_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
      </EditorSection>

      <EditorSection
        title={isStdio ? 'stdio 配置' : 'http / sse 配置'}
        description={isStdio ? 'spawn 一个本地进程作为 MCP 服务器' : '连接远程 MCP 服务端'}
      >
        {isStdio ? (
          <>
            <Field label="command" error={errors.command}>
              <input
                className="channel-input channel-input--mono"
                value={draft.command}
                placeholder="npx"
                aria-invalid={Boolean(errors.command)}
                onChange={(e) => update({ command: e.target.value })}
              />
            </Field>
            <Field label="args" hint="空格分隔，或 JSON 数组，如 [&quot;-y&quot;,&quot;@modelcontextprotocol/server-filesystem&quot;]">
              <input
                className="channel-input channel-input--mono"
                value={draft.args}
                placeholder="-y @modelcontextprotocol/server-filesystem /tmp"
                onChange={(e) => update({ args: e.target.value })}
              />
            </Field>
            <Field label="env" hint="每行一个 KEY=VALUE">
              <textarea
                className="channel-input channel-input--mono"
                style={{ height: 'auto', minHeight: 64, padding: '8px 10px', resize: 'vertical' }}
                value={draft.env}
                placeholder={'NODE_ENV=development\nAPI_KEY=xxx'}
                rows={3}
                onChange={(e) => update({ env: e.target.value })}
              />
            </Field>
          </>
        ) : (
          <>
            <Field label="url" error={errors.url}>
              <input
                className="channel-input channel-input--mono"
                value={draft.url}
                placeholder="https://example.com/mcp"
                aria-invalid={Boolean(errors.url)}
                onChange={(e) => update({ url: e.target.value })}
              />
            </Field>
            <Field label="headers" hint="每行一个 KEY:VALUE">
              <textarea
                className="channel-input channel-input--mono"
                style={{ height: 'auto', minHeight: 64, padding: '8px 10px', resize: 'vertical' }}
                value={draft.headers}
                placeholder={'Authorization: Bearer xxx'}
                rows={3}
                onChange={(e) => update({ headers: e.target.value })}
              />
            </Field>
          </>
        )}
        <Field label={`timeout（秒）`} hint={`启动/连接超时，留空默认 ${MCP_DEFAULT_TIMEOUT}`} error={errors.timeout}>
          <input
            className="channel-input channel-input--mono"
            style={{ width: 120 }}
            value={draft.timeout}
            placeholder={String(MCP_DEFAULT_TIMEOUT)}
            aria-invalid={Boolean(errors.timeout)}
            inputMode="numeric"
            onChange={(e) => update({ timeout: e.target.value })}
          />
        </Field>
      </EditorSection>

      <div className="channel-editor-actions">
        <Button variant="outline" size="sm" disabled={testing} onClick={() => void testDraft()}>
          {testing ? <RefreshCw size={14} className="animate-spin" /> : <Wifi size={14} />}
          {testing ? '正在测试…' : '测试连接'}
        </Button>
        <div style={{ flex: 1 }} />
        <Button variant="ghost" onClick={onCancel}>
          取消
        </Button>
        <Button disabled={saving} onClick={() => void submit()}>
          {saving ? '正在保存…' : mode === 'add' ? '添加服务器' : '保存更改'}
        </Button>
      </div>
    </div>
  )
}

function EditorSection({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <section className="channel-editor-section">
      <div className="channel-editor-section-head">
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
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
      {error ? (
        <span className="channel-field-error" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="channel-field-hint">{hint}</span>
      ) : null}
    </label>
  )
}
