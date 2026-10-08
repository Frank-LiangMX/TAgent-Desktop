import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, Pencil, RefreshCw, Save } from 'lucide-react'
import { Button, SettingsCard, SettingsPageIntro, SettingsSection, Switch } from '@tagent/ui'
import { isChannelCompatibleWithRuntime, isMoaModelId, type Channel } from '@tagent/shared'
import { AgentConnectionsOverview } from './AgentConnectionsOverview'

type AgentRuntime = 'pi' | 'codex' | 'claude-code' | 'kscc' | 'custom-cli'
type PermissionProfile = 'read-only' | 'workspace-write' | 'full'
type WorkspacePolicy = 'inherit' | 'fixed' | 'temporary'

type AgentProfile = {
  [key: string]: unknown
  id: string
  name: string
  description?: string
  runtime: AgentRuntime
  enabled: boolean
  builtIn: boolean
  channelId?: string
  modelId?: string
  systemPrompt?: string
  skills?: string[]
  mcpServers?: string[]
  permissionProfile: PermissionProfile
  workspacePolicy: WorkspacePolicy
  workspacePath?: string
  allowPiTask: boolean
  allowBackground: boolean
  approvalRequired: boolean
  tools?: string[]
  capabilities?: {
    tags: string[]
    vision?: boolean
    reasoning?: 'low' | 'medium' | 'high'
  }
}

type Notice = { kind: 'success' | 'error'; message: string } | null

const RUNTIME_LABELS: Record<AgentRuntime, string> = {
  pi: 'Pi',
  codex: 'Codex',
  'claude-code': 'Claude Code',
  kscc: 'Claude Code（KSCC 内核）',
  'custom-cli': '自定义 CLI',
}

const PERMISSION_LABELS: Record<PermissionProfile, string> = {
  'read-only': '只读',
  'workspace-write': '工作区可写',
  full: '完全权限',
}

const WORKSPACE_LABELS: Record<WorkspacePolicy, string> = {
  inherit: '继承当前工作区',
  fixed: '固定工作区',
  temporary: '临时工作区（暂不支持）',
}

function optionalText(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function commaSeparated(values: string[] | undefined): string {
  return values?.join(', ') ?? ''
}

function parseCommaSeparated(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function updateProfile(
  profiles: AgentProfile[] | null,
  id: string,
  patch: Partial<AgentProfile>,
): AgentProfile[] | null {
  return profiles?.map((profile) =>
    profile.id === id ? { ...profile, ...patch } : profile,
  ) ?? null
}

/** UI eligibility follows the shared protocol compatibility contract. */
export function compatibleProfileChannels(channels: Channel[], runtime: AgentRuntime): Channel[] {
  if (runtime !== 'pi' && runtime !== 'codex' && runtime !== 'claude-code') return []
  return channels.filter((channel) => isChannelCompatibleWithRuntime(channel, runtime))
}

/** A profile binding is authoritative; never silently substitute another channel/model. */
export function profileBindingError(profile: Pick<AgentProfile, 'runtime' | 'channelId' | 'modelId'>, channels: Channel[]): string | null {
  if (profile.runtime !== 'pi' && profile.runtime !== 'codex' && profile.runtime !== 'claude-code') return null
  if (!profile.channelId && profile.modelId) return '已设置模型绑定但未设置渠道；请同时选择渠道，避免静默回退。'
  if (!profile.channelId) return null
  if (!profile.modelId) return '已绑定渠道但未绑定模型；请同时选择渠道和模型，避免跨渠道任务失败。'
  const channel = channels.find((item) => item.id === profile.channelId)
  if (!channel || !isChannelCompatibleWithRuntime(channel, profile.runtime)) {
    return `${RUNTIME_LABELS[profile.runtime]} 绑定的渠道与运行时协议不兼容，请重新选择。`
  }
  if (!profile.modelId) return null
  const model = channel.models.find((item) => item.id === profile.modelId)
  if (!model || !model.enabled || isMoaModelId(model.id)) {
    return '绑定的模型不存在、已停用或为虚拟 MoA 模型；不会静默改用其它模型。'
  }
  return null
}

export function profileConfigurationError(
  profile: Pick<AgentProfile, 'runtime' | 'channelId' | 'modelId' | 'workspacePolicy' | 'workspacePath'> & Pick<AgentProfile, 'skills' | 'mcpServers' | 'tools'>,
  channels: Channel[],
): string | null {
  const bindingError = profileBindingError(profile, channels)
  if (bindingError) return bindingError
  if (profile.workspacePolicy === 'temporary') return '临时工作区暂不支持；请选择继承当前工作区。'
  if (profile.workspacePolicy === 'fixed' && !profile.workspacePath?.trim()) return '固定工作区需要路径；不同于父会话工作区的路径将在派发时拒绝。'
  if (profile.skills?.length || profile.mcpServers?.length) return 'skills / MCP 尚未接入此预设；请清空这些高级绑定后再保存。'
  if (profile.runtime !== 'pi' && profile.tools?.length) return `${RUNTIME_LABELS[profile.runtime]} 的 tools 白名单尚未接入；请清空 tools 后再保存。`
  return null
}

export function AgentCatalogSettings({
  onNavigate,
}: {
  onNavigate: (tab: 'channels' | 'agent-cli') => void
}): JSX.Element {
  const [profiles, setProfiles] = useState<AgentProfile[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loadingError, setLoadingError] = useState('')
  const [channels, setChannels] = useState<Channel[]>([])
  const [channelsError, setChannelsError] = useState('')
  const [notice, setNotice] = useState<Notice>(null)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const requestId = useRef(0)
  const channelRequestId = useRef(0)
  const editRevision = useRef(0)
  const dirtyRef = useRef(false)

  useEffect(() => {
    dirtyRef.current = dirty
  }, [dirty])

  const load = useCallback(async (): Promise<void> => {
    const currentRequest = ++requestId.current
    setLoadingError('')
    try {
      const next = (await window.electronAPI.listAgentProfiles()) as AgentProfile[]
      if (currentRequest !== requestId.current || dirtyRef.current) return
      setProfiles(next)
      setSelectedId(null)
      setDirty(false)
    } catch {
      if (currentRequest === requestId.current) setLoadingError('暂时无法读取 Agent 预设，请重试。')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const loadChannels = useCallback(async (): Promise<void> => {
    const currentRequest = ++channelRequestId.current
    setChannelsError('')
    try {
      const next = await window.electronAPI.listChannels()
      if (currentRequest === channelRequestId.current) setChannels(next as Channel[])
    } catch {
      if (currentRequest === channelRequestId.current) setChannelsError('渠道列表暂时不可用。')
    }
  }, [])

  useEffect(() => {
    void loadChannels()
    return () => {
      requestId.current++
      channelRequestId.current++
    }
  }, [loadChannels])

  const navigateFromOverview = useCallback((tab: 'channels' | 'agent-cli'): void => {
    if (dirty && !window.confirm('Agent 预设有未保存的更改。仍要离开并放弃这些更改吗？')) return
    onNavigate(tab)
  }, [dirty, onNavigate])

  const changeProfile = useCallback((id: string, patch: Partial<AgentProfile>): void => {
    setProfiles((current) => updateProfile(current, id, patch))
    setDirty(true)
    dirtyRef.current = true
    editRevision.current += 1
    setNotice(null)
  }, [])

  const toggle = useCallback((id: string, enabled: boolean): void => {
    changeProfile(id, { enabled })
  }, [changeProfile])

  const save = useCallback(async (): Promise<void> => {
    if (!profiles) return
    const invalid = profiles
      .map((profile) => profileConfigurationError(profile, channels))
      .find(Boolean)
    if (invalid) {
      setNotice({ kind: 'error', message: invalid })
      return
    }
    const revisionAtStart = editRevision.current
    setSaving(true)
    setNotice(null)
    try {
      const saved = await window.electronAPI.saveAgentProfiles(profiles)
      if (revisionAtStart === editRevision.current) {
        setProfiles(saved as AgentProfile[])
        setDirty(false)
        dirtyRef.current = false
        setNotice({ kind: 'success', message: 'Agent 预设已保存' })
      }
    } catch {
      setNotice({ kind: 'error', message: '保存失败，请稍后重试。' })
    } finally {
      setSaving(false)
    }
  }, [profiles])

  if (!profiles) {
    return (
      <div className="settings-page agent-catalog-settings-page">
        <SettingsPageIntro title="Agent 接入" description="接入 Pi、Codex 或 Claude Code / KSCC，在聊天中选择使用。" />
        <AgentConnectionsOverview onNavigate={navigateFromOverview} />
        <div className="agent-behavior-loading" role={loadingError ? 'alert' : 'status'}>
          {loadingError ? <AlertCircle size={16} /> : <RefreshCw size={16} className="animate-spin" />}
        <span>{loadingError || 'Agent 预设加载中…'}</span>
          {loadingError && <Button variant="outline" size="sm" onClick={() => void load()}>重试</Button>}
        </div>
      </div>
    )
  }

  return (
    <div className="settings-page agent-catalog-settings-page">
      <SettingsPageIntro title="Agent 接入" description="接入 Pi、Codex 或 Claude Code / KSCC，在聊天中选择使用。" />
      <AgentConnectionsOverview onNavigate={navigateFromOverview} />

      <details className="mt-5">
        <summary className="cursor-pointer text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          高级：Agent 预设
        </summary>
        <p className="mt-2 text-sm text-muted-foreground">
          可选配置，按预设运行时执行子任务；不会改变主会话的运行内核或角色配置。
        </p>
        {channelsError && <div className="mt-2 flex items-center gap-2 text-sm text-destructive" role="alert"><span>{channelsError}已保存的渠道或模型仍会保留显示。</span><Button variant="outline" size="sm" onClick={() => void loadChannels()}>重试渠道读取</Button></div>}
        <SettingsSection
          title="子任务预设"
          description="Pi、Codex、Claude Code 预设可绑定兼容 API 渠道和模型；API Key 仍由渠道设置单独管理。"
          action={
            <Button variant="outline" size="sm" disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? <RefreshCw size={13} className="animate-spin" /> : <Save size={13} />}
              {saving ? '保存中…' : '保存'}
            </Button>
          }
        >
        <SettingsCard divided={false}>
          {profiles.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">暂无 Agent Profile</div>
          ) : (
            <div className="divide-y divide-border/60">
              {profiles.map((profile) => {
                const selected = profile.id === selectedId
                return (
                  <div key={profile.id} className={selected ? 'bg-muted/20' : undefined}>
                    <div className="flex items-center gap-4 px-4 py-3">
                      <button
                        type="button"
                        className="min-w-0 flex-1 text-left"
                        onClick={() => setSelectedId(profile.id)}
                        aria-expanded={selected}
                      >
                        <div className="truncate text-sm font-medium">{profile.name}</div>
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                          <span>{RUNTIME_LABELS[profile.runtime]}</span>
                          <span>{profile.id}</span>
                          {profile.builtIn && <span>内置</span>}
                          <span className={profile.enabled ? 'text-emerald-600' : undefined}>
                            {profile.enabled ? '已启用' : '已停用'}
                          </span>
                        </div>
                      </button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={`编辑 ${profile.name}`}
                        onClick={() => setSelectedId(profile.id)}
                      >
                        <Pencil size={14} />
                        编辑
                      </Button>
                      <Switch
                        size="sm"
                        checked={profile.enabled}
                        disabled={saving}
                        aria-label={`${profile.enabled ? '停用' : '启用'} ${profile.name}`}
                        onCheckedChange={(enabled) => toggle(profile.id, enabled)}
                      />
                    </div>

                    {selected && (
                      <div className="agent-behavior-editor border-t border-border/50">
                        <div className="agent-behavior-editor-body">
                          <div className="agent-behavior-editor-group">
                            <div className="agent-behavior-editor-group-label">基本信息</div>
                            <div className="agent-behavior-form-grid">
                              <label className="agent-behavior-field">
                                <span className="agent-behavior-field-label">名称</span>
                                <input
                                  className="agent-behavior-input"
                                  value={profile.name}
                                  disabled={saving}
                                  onChange={(event) => changeProfile(profile.id, { name: event.target.value })}
                                />
                              </label>
                              <label className="agent-behavior-field">
                              <span className="agent-behavior-field-label">执行方式</span>
                                <select
                                  className="agent-behavior-input agent-behavior-select"
                                  value={profile.runtime}
                                  disabled={saving}
                                  onChange={(event) => changeProfile(profile.id, { runtime: event.target.value as AgentRuntime })}
                                >
                                  {Object.entries(RUNTIME_LABELS).map(([value, label]) => (
                                    <option key={value} value={value}>{label}</option>
                                  ))}
                                </select>
                              </label>
                            </div>
                            <label className="agent-behavior-field">
                              <span className="agent-behavior-field-label">描述</span>
                              <input
                                className="agent-behavior-input"
                                value={profile.description ?? ''}
                                disabled={saving}
                                onChange={(event) => changeProfile(profile.id, { description: optionalText(event.target.value) })}
                              />
                            </label>
                          </div>

                          <div className="agent-behavior-editor-group">
                            <div className="agent-behavior-editor-group-label">渠道与模型</div>
                            <p className="agent-behavior-editor-group-desc">绑定属于此预设并优先于任务临时选择；冲突会报错，不会静默换渠道或模型。</p>
                            <div className="agent-behavior-form-grid">
                              <label className="agent-behavior-field">
                                <span className="agent-behavior-field-label">渠道</span>
                                {(profile.runtime === 'pi' || profile.runtime === 'codex' || profile.runtime === 'claude-code') ? (
                                  <select className="agent-behavior-input agent-behavior-select" value={profile.channelId ?? ''} disabled={saving} onChange={(event) => changeProfile(profile.id, { channelId: optionalText(event.target.value) })}>
                                    <option value="">不固定（由任务决定）</option>
                                    {compatibleProfileChannels(channels, profile.runtime).map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}
                                    {profile.channelId && !compatibleProfileChannels(channels, profile.runtime).some((channel) => channel.id === profile.channelId) && <option value={profile.channelId}>已保存：{profile.channelId}（协议不兼容或当前不可用）</option>}
                                  </select>
                                ) : <span className="agent-behavior-field-hint">此运行时不支持 API 渠道绑定{profile.channelId ? `（已保存：${profile.channelId}）` : ''}</span>}
                              </label>
                              <label className="agent-behavior-field">
                                <span className="agent-behavior-field-label">模型</span>
                                {(profile.runtime === 'pi' || profile.runtime === 'codex' || profile.runtime === 'claude-code') ? (
                                  <select className="agent-behavior-input agent-behavior-select" value={profile.modelId ?? ''} disabled={saving} onChange={(event) => changeProfile(profile.id, { modelId: optionalText(event.target.value) })}>
                                    <option value="">不固定（由任务决定）</option>
                                    {(compatibleProfileChannels(channels, profile.runtime).find((channel) => channel.id === profile.channelId)?.models.filter((model) => model.enabled && !isMoaModelId(model.id)) ?? []).map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
                                    {profile.modelId && !(compatibleProfileChannels(channels, profile.runtime).find((channel) => channel.id === profile.channelId)?.models.some((model) => model.id === profile.modelId && model.enabled && !isMoaModelId(model.id))) && <option value={profile.modelId}>已保留原值：{profile.modelId}（{profile.channelId ? '当前不可用' : '待任务渠道确定'}）</option>}
                                  </select>
                                ) : <span className="agent-behavior-field-hint">此运行时不支持 API 模型绑定{profile.modelId ? `（已保存：${profile.modelId}）` : ''}</span>}
                              </label>
                            </div>
                          </div>

                          <div className="agent-behavior-editor-group">
                            <div className="agent-behavior-editor-group-label">行为与工具</div>
                            <label className="agent-behavior-field">
                                  <span className="agent-behavior-field-label">任务提示词</span>
                              <textarea
                                className="agent-behavior-input"
                                rows={4}
                                value={profile.systemPrompt ?? ''}
                                disabled={saving}
                                onChange={(event) => changeProfile(profile.id, { systemPrompt: optionalText(event.target.value) })}
                              />
                            </label>
                            <label className="agent-behavior-field">
                              <span className="agent-behavior-field-label">Pi 可用工具</span>
                              <input
                                className="agent-behavior-input"
                                value={commaSeparated(profile.tools)}
                                disabled={saving || profile.runtime !== 'pi'}
                                placeholder="Read, Edit, Bash"
                                onChange={(event) => changeProfile(profile.id, { tools: parseCommaSeparated(event.target.value) })}
                              />
                              <span className="agent-behavior-field-hint">多个工具用逗号分隔；仅支持工具的运行时读取此设置。</span>
                            </label>
                          </div>

                          <div className="agent-behavior-editor-group">
                            <div className="agent-behavior-editor-group-label">权限与工作区</div>
                            <p className="agent-behavior-editor-group-desc">实际权限由目标运行时与父任务审批策略决定；此页选项不保证命令行工具具备相同限制。</p>
                            <div className="agent-behavior-form-grid">
                              <label className="agent-behavior-field">
                                <span className="agent-behavior-field-label">权限</span>
                                <select
                                  className="agent-behavior-input agent-behavior-select"
                                  value={profile.permissionProfile}
                                  disabled={saving}
                                  onChange={(event) => changeProfile(profile.id, { permissionProfile: event.target.value as PermissionProfile })}
                                >
                                  {Object.entries(PERMISSION_LABELS).map(([value, label]) => (
                                    <option key={value} value={value}>{label}</option>
                                  ))}
                                </select>
                              </label>
                              <label className="agent-behavior-field">
                              <span className="agent-behavior-field-label">工作区范围</span>
                                <select
                                  className="agent-behavior-input agent-behavior-select"
                                  value={profile.workspacePolicy}
                                  disabled={saving}
                                  onChange={(event) => changeProfile(profile.id, { workspacePolicy: event.target.value as WorkspacePolicy })}
                                >
                                  {Object.entries(WORKSPACE_LABELS).map(([value, label]) => (
                                    <option key={value} value={value}>{label}</option>
                                  ))}
                                </select>
                              </label>
                            </div>
                            <label className="agent-behavior-field">
                                <span className="agent-behavior-field-label">工作区路径</span>
                              <input
                                className="agent-behavior-input agent-behavior-input--mono"
                                value={profile.workspacePath ?? ''}
                                disabled={saving || profile.workspacePolicy !== 'fixed'}
                                onChange={(event) => changeProfile(profile.id, { workspacePath: optionalText(event.target.value) })}
                              />
                              {profile.workspacePolicy === 'temporary' && <span className="agent-behavior-field-hint text-destructive">临时工作区暂不支持，保存会被拒绝。</span>}
                              {profile.workspacePolicy === 'fixed' && <span className="agent-behavior-field-hint">仅支持与父会话相同的工作区；不同 cwd 会在派发时拒绝。</span>}
                            </label>
                          </div>

                          <div className="agent-behavior-editor-group">
                            <div className="agent-behavior-editor-group-label">调度开关</div>
                            <div className="flex flex-col gap-2">
                              <SettingSwitch
                                label="允许 Pi 调用"
                                checked={profile.allowPiTask}
                                disabled={saving}
                                onCheckedChange={(allowPiTask) => changeProfile(profile.id, { allowPiTask })}
                              />
                              <SettingSwitch
                                label="允许后台运行"
                                checked={profile.allowBackground}
                                disabled={saving}
                                onCheckedChange={(allowBackground) => changeProfile(profile.id, { allowBackground })}
                              />
                              <SettingSwitch
                                label="执行前审批"
                                checked={profile.approvalRequired}
                                disabled={saving}
                                onCheckedChange={(approvalRequired) => changeProfile(profile.id, { approvalRequired })}
                              />
                              <span className="agent-behavior-field-hint">开启后，派发该预设前会弹出审批；拒绝则不会启动任务。</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </SettingsCard>
        </SettingsSection>
      </details>

      {notice && (
        <div className={`agent-behavior-notice agent-behavior-notice--${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
          {notice.kind === 'success' ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}
          <span className="agent-behavior-notice-copy">{notice.message}</span>
        </div>
      )}
    </div>
  )
}

function SettingSwitch({
  label,
  checked,
  disabled,
  onCheckedChange,
}: {
  label: string
  checked: boolean
  disabled: boolean
  onCheckedChange: (checked: boolean) => void
}): JSX.Element {
  return (
    <div className="flex min-h-[34px] items-center justify-between gap-3">
      <span className="agent-behavior-field-label">{label}</span>
      <Switch size="sm" checked={checked} disabled={disabled} aria-label={label} onCheckedChange={onCheckedChange} />
    </div>
  )
}
