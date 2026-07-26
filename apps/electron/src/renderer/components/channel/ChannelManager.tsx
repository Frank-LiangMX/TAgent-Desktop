/**
 * 渠道管理（最小自写，跟随现有骨架内联样式）
 *
 * kscc 内置渠道：特殊卡（OAuth 无需 apiKey，不可删，provider/baseUrl 锁定）
 * 外部渠道：增删改 + 测试连接（占位）+ 启用切换
 *
 * 状态：渠道列表来自 Jotai channel-atoms；增删改后 reload。
 */
import { useEffect, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  PROVIDER_LABELS,
  PROVIDER_DEFAULT_URLS,
  type Channel,
  type ChannelModel,
  type ProviderType,
} from '@tagent/shared'
import {
  ksccChannelAtom,
  externalChannelsAtom,
  loadChannelsAtom,
} from '../../atoms/channel-atoms'

/** kscc 内置渠道 ID */
const KSCC_BUILTIN_ID = 'kscc-internal'

/** models textarea ↔ ChannelModel[] 互转（一行一个 id，name 默认等于 id） */
function modelsToText(models: ChannelModel[]): string {
  return models.map((m) => m.id).join('\n')
}
function parseModels(text: string): ChannelModel[] {
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((id) => ({ id, name: id, enabled: true }))
}

interface FormState {
  name: string
  provider: ProviderType
  baseUrl: string
  apiKey: string
  modelsText: string
  defaultModelId: string
  enabled: boolean
}

const EMPTY_FORM: FormState = {
  name: '',
  provider: 'anthropic',
  baseUrl: PROVIDER_DEFAULT_URLS.anthropic,
  apiKey: '',
  modelsText: '',
  defaultModelId: '',
  enabled: true,
}

export function ChannelManager({ onClose }: { onClose: () => void }): JSX.Element {
  const loadChannels = useSetAtom(loadChannelsAtom)
  const kscc = useAtomValue(ksccChannelAtom)
  const externals = useAtomValue(externalChannelsAtom)

  const [mode, setMode] = useState<'add' | 'edit' | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    void loadChannels()
  }, [loadChannels])

  const notify = (m: string): void => {
    setMsg(m)
    setTimeout(() => setMsg(null), 3000)
  }

  const onProviderChange = async (provider: ProviderType): Promise<void> => {
    const baseUrl = PROVIDER_DEFAULT_URLS[provider] ?? ''
    setForm((f) => ({ ...f, provider, baseUrl, modelsText: '', defaultModelId: '' }))
    // 拉默认模型（占位：返回内置默认列表）
    try {
      const res = await window.electronAPI.fetchModels({ provider, baseUrl, apiKey: form.apiKey })
      if (res.models.length > 0) {
        setForm((f) => ({
          ...f,
          modelsText: modelsToText(res.models),
          defaultModelId: res.models[0]?.id ?? '',
        }))
      }
    } catch {
      /* 忽略，用户手动填 */
    }
  }

  const startAdd = (): void => {
    setMode('add')
    setEditingId(null)
    setForm(EMPTY_FORM)
  }

  const startEdit = async (ch: Channel): Promise<void> => {
    setMode('edit')
    setEditingId(ch.id)
    setForm({
      name: ch.name,
      provider: ch.provider,
      baseUrl: ch.baseUrl,
      apiKey: '', // 编辑时留空 = 不修改
      modelsText: modelsToText(ch.models),
      defaultModelId: ch.defaultModelId ?? '',
      enabled: ch.enabled,
    })
  }

  const cancelForm = (): void => {
    setMode(null)
    setEditingId(null)
    setForm(EMPTY_FORM)
  }

  const submit = async (): Promise<void> => {
    if (!form.name.trim()) {
      notify('请填渠道名称')
      return
    }
    setBusy(true)
    try {
      const models = parseModels(form.modelsText)
      if (mode === 'add') {
        if (form.provider !== KSCC_BUILTIN_ID && !form.apiKey.trim()) {
          notify('外部渠道需填 apiKey')
          setBusy(false)
          return
        }
        await window.electronAPI.createChannel({
          name: form.name.trim(),
          provider: form.provider,
          baseUrl: form.baseUrl.trim(),
          apiKey: form.apiKey.trim(),
          models,
          defaultModelId: form.defaultModelId || undefined,
          enabled: form.enabled,
        })
        notify('已添加')
      } else if (mode === 'edit' && editingId) {
        await window.electronAPI.updateChannel(editingId, {
          name: form.name.trim(),
          // kscc 编辑不下发 provider/baseUrl/apiKey（内置锁定）
          provider: form.provider === KSCC_BUILTIN_ID ? undefined : form.provider,
          baseUrl: form.provider === KSCC_BUILTIN_ID ? undefined : form.baseUrl.trim(),
          apiKey: form.provider === KSCC_BUILTIN_ID ? undefined : form.apiKey.trim(),
          models,
          defaultModelId: form.defaultModelId || undefined,
          enabled: form.enabled,
        })
        notify('已保存')
      }
      await loadChannels()
      cancelForm()
    } catch (e) {
      notify('操作失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }

  const onDelete = async (ch: Channel): Promise<void> => {
    if (!confirm(`删除渠道「${ch.name}」？`)) return
    const res = await window.electronAPI.deleteChannel(ch.id)
    if (res.ok) {
      notify('已删除')
      await loadChannels()
    } else {
      notify(res.error ?? '删除失败')
    }
  }

  const onTest = async (ch: Channel): Promise<void> => {
    notify('测试中…')
    const res = await window.electronAPI.testChannel(ch.id)
    notify(res.success ? `✓ ${res.message}` : `✗ ${res.message}`)
  }

  const toggleEnabled = async (ch: Channel): Promise<void> => {
    await window.electronAPI.updateChannel(ch.id, { enabled: !ch.enabled })
    await loadChannels()
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.3)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: 640,
          maxWidth: '90vw',
          maxHeight: '85vh',
          background: '#fff',
          borderRadius: 12,
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
        }}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div
          style={{
            padding: '12px 16px',
            borderBottom: '1px solid #eee',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <strong>渠道管理</strong>
          <button onClick={onClose} style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 18 }}>
            ×
          </button>
        </div>

        {/* 内容 */}
        <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
          {msg && (
            <div style={{ padding: '8px 12px', marginBottom: 12, background: '#f0f7ff', borderRadius: 8, fontSize: 13 }}>
              {msg}
            </div>
          )}

          {/* kscc 内置渠道 */}
          {kscc && (
            <ChannelCard
              ch={kscc}
              builtin
              onEdit={() => void startEdit(kscc)}
              onTest={() => void onTest(kscc)}
              onToggle={() => void toggleEnabled(kscc)}
            />
          )}

          {/* 外部渠道 */}
          <div style={{ marginTop: 16, fontSize: 13, color: '#666', marginBottom: 8 }}>
            外部渠道（apiKey 直连）
          </div>
          {externals.length === 0 && (
            <div style={{ padding: 12, color: '#999', fontSize: 12 }}>暂无外部渠道，点下方添加</div>
          )}
          {externals.map((ch) => (
            <ChannelCard
              key={ch.id}
              ch={ch}
              onEdit={() => void startEdit(ch)}
              onDelete={() => void onDelete(ch)}
              onTest={() => void onTest(ch)}
              onToggle={() => void toggleEnabled(ch)}
            />
          ))}

          {/* 添加按钮 / 表单 */}
          {mode === null ? (
            <button
              onClick={startAdd}
              style={{ marginTop: 16, padding: '8px 16px', width: '100%' }}
            >
              + 添加外部渠道
            </button>
          ) : (
            <ChannelForm
              mode={mode}
              form={form}
              busy={busy}
              onForm={setForm}
              onProviderChange={(p) => void onProviderChange(p)}
              onSubmit={() => void submit()}
              onCancel={cancelForm}
            />
          )}
        </div>
      </div>
    </div>
  )
}

/** 渠道卡片（只读 + 操作按钮） */
function ChannelCard({
  ch,
  builtin = false,
  onEdit,
  onDelete,
  onTest,
  onToggle,
}: {
  ch: Channel
  builtin?: boolean
  onEdit: () => void
  onDelete?: () => void
  onTest: () => void
  onToggle: () => void
}): JSX.Element {
  return (
    <div
      style={{
        border: `1px solid ${builtin ? '#d4e5ff' : '#eee'}`,
        background: builtin ? '#f7fbff' : '#fafafa',
        borderRadius: 8,
        padding: 12,
        marginBottom: 8,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <strong>{ch.name}</strong>
          {builtin && (
            <span style={{ marginLeft: 8, fontSize: 11, color: '#1a73e8', background: '#e8f0fe', padding: '2px 6px', borderRadius: 4 }}>
              内置 / OAuth
            </span>
          )}
          {!ch.enabled && (
            <span style={{ marginLeft: 8, fontSize: 11, color: '#999', background: '#f0f0f0', padding: '2px 6px', borderRadius: 4 }}>
              已禁用
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={onToggle} style={btnStyle}>
            {ch.enabled ? '禁用' : '启用'}
          </button>
          <button onClick={onTest} style={btnStyle}>
            测试
          </button>
          <button onClick={onEdit} style={btnStyle}>
            编辑
          </button>
          {!builtin && onDelete && (
            <button onClick={onDelete} style={{ ...btnStyle, color: '#c00' }}>
              删除
            </button>
          )}
        </div>
      </div>
      <div style={{ marginTop: 6, fontSize: 12, color: '#666' }}>
        Provider: {PROVIDER_LABELS[ch.provider]}
        {ch.baseUrl ? ` · ${ch.baseUrl}` : ' · 内置网关'}
        {' · apiKey: '}
        {builtin ? 'OAuth（无需）' : ch.apiKey ? '已保存' : '未设置'}
      </div>
      <div style={{ marginTop: 4, fontSize: 12, color: '#999' }}>
        模型: {ch.models.map((m) => m.id).join(', ') || '无'} · 默认: {ch.defaultModelId ?? '无'}
      </div>
    </div>
  )
}

/** 添加/编辑表单 */
function ChannelForm({
  mode,
  form,
  busy,
  onForm,
  onProviderChange,
  onSubmit,
  onCancel,
}: {
  mode: 'add' | 'edit'
  form: FormState
  busy: boolean
  onForm: (f: FormState) => void
  onProviderChange: (p: ProviderType) => void
  onSubmit: () => void
  onCancel: () => void
}): JSX.Element {
  const isKscc = form.provider === KSCC_BUILTIN_ID
  const models = parseModels(form.modelsText)
  const set = (patch: Partial<FormState>): void => onForm({ ...form, ...patch })

  return (
    <div style={{ marginTop: 16, border: '1px solid #ddd', borderRadius: 8, padding: 12, background: '#fff' }}>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>{mode === 'add' ? '添加渠道' : '编辑渠道'}</div>

      <Field label="名称">
        <input style={inputStyle} value={form.name} onChange={(e) => set({ name: e.target.value })} />
      </Field>

      <Field label="Provider">
        <select
          style={inputStyle}
          value={form.provider}
          disabled={mode === 'edit' && isKscc}
          onChange={(e) => onProviderChange(e.target.value as ProviderType)}
        >
          {Object.entries(PROVIDER_LABELS)
            .filter(([p]) => mode === 'edit' || p !== KSCC_BUILTIN_ID) // 添加时不选 kscc（内置已存在）
            .map(([p, label]) => (
              <option key={p} value={p}>
                {label}
              </option>
            ))}
        </select>
      </Field>

      <Field label="Base URL">
        <input
          style={inputStyle}
          value={form.baseUrl}
          disabled={isKscc}
          placeholder={isKscc ? '内置网关，无需填写' : 'https://...'}
          onChange={(e) => set({ baseUrl: e.target.value })}
        />
      </Field>

      {!isKscc && (
        <Field label={mode === 'edit' ? 'API Key（留空不修改）' : 'API Key'}>
          <input
            type="password"
            style={inputStyle}
            value={form.apiKey}
            placeholder={mode === 'edit' ? '留空不修改；若提示解密失败请重新输入' : 'sk-...'}
            onChange={(e) => set({ apiKey: e.target.value })}
          />
        </Field>
      )}

      <Field label="模型列表（一行一个 model id）">
        <textarea
          style={{ ...inputStyle, minHeight: 60, fontFamily: 'monospace' }}
          value={form.modelsText}
          onChange={(e) => set({ modelsText: e.target.value, defaultModelId: '' })}
        />
      </Field>

      <Field label="默认模型">
        <select
          style={inputStyle}
          value={form.defaultModelId}
          onChange={(e) => set({ defaultModelId: e.target.value })}
        >
          <option value="">（自动取第一个）</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.id}
            </option>
          ))}
        </select>
      </Field>

      <Field label="启用">
        <input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
      </Field>

      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button onClick={onSubmit} disabled={busy} style={{ padding: '8px 16px' }}>
          {busy ? '处理中…' : mode === 'add' ? '添加' : '保存'}
        </button>
        <button onClick={onCancel} style={{ padding: '8px 16px' }}>
          取消
        </button>
      </div>
    </div>
  )
}

const btnStyle: React.CSSProperties = {
  padding: '4px 10px',
  fontSize: 12,
  border: '1px solid #ddd',
  background: '#fff',
  borderRadius: 6,
  cursor: 'pointer',
}
const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 8px',
  border: '1px solid #ccc',
  borderRadius: 6,
  fontSize: 13,
  boxSizing: 'border-box',
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ marginBottom: 10 }}>
      <label style={{ display: 'block', fontSize: 12, color: '#555', marginBottom: 4 }}>{label}</label>
      {children}
    </div>
  )
}
