import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowRight, Download, LoaderCircle, RefreshCw } from 'lucide-react'
import { Button, SettingsCard, SettingsSection } from '@tagent/ui'
import { isMoaModelId, type Channel, type CodexRuntimeStatus } from '@tagent/shared'
import { AGENT_RUNTIME_LABELS, AGENT_RUNTIME_ORDER, channelAcceptsRuntime } from '../../atoms/agent-runtime'

type Snapshot<T> = { value: T | null; loading: boolean; error: boolean }
const initial = { value: null, loading: true, error: false }

export function AgentConnectionsOverview({ onNavigate }: {
  onNavigate: (tab: 'channels' | 'agent-cli') => void
}): JSX.Element {
  const [channels, setChannels] = useState<Snapshot<Channel[]>>(initial)
  const [codex, setCodex] = useState<Snapshot<CodexRuntimeStatus>>(initial)
  const [installing, setInstalling] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)
  const generation = useRef(0)

  const refresh = useCallback(() => {
    const current = ++generation.current
    setChannels({ value: null, loading: true, error: false })
    setCodex({ value: null, loading: true, error: false })
    // Independent checks: a stalled runtime probe must not hide channel configuration.
    void Promise.resolve().then(() => window.electronAPI.listChannels()).then(
      (value) => { if (current === generation.current) setChannels({ value, loading: false, error: false }) },
      () => { if (current === generation.current) setChannels({ value: null, loading: false, error: true }) },
    )
    void Promise.resolve().then(() => window.electronAPI.getCodexRuntimeStatus()).then(
      (value) => { if (current === generation.current) setCodex({ value, loading: false, error: false }) },
      () => { if (current === generation.current) setCodex({ value: null, loading: false, error: true }) },
    )
  }, [])

  useEffect(() => {
    refresh()
    return () => { generation.current++ }
  }, [refresh])

  const installCodexRuntime = async (): Promise<void> => {
    if (installing) return
    setInstalling(true)
    setInstallError(null)
    try {
      const result = await window.electronAPI.installCodexRuntime()
      setCodex({ value: result.status, loading: false, error: false })
      if (result.ok) {
        refresh()
      } else {
        setInstallError(result.error ?? 'Codex Runtime 安装失败')
      }
    } catch (error) {
      setInstallError(error instanceof Error ? error.message : 'Codex Runtime 安装失败')
    } finally {
      setInstalling(false)
    }
  }

  return (
    <SettingsSection
      title="主会话 Agent"
      description="在这里检查接入，在聊天输入框选择 Agent 和模型。普通聊天无需配置子任务预设。"
      action={
        <Button variant="outline" size="sm" onClick={refresh}>
          <RefreshCw size={13} aria-hidden="true" />重新检测
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        {AGENT_RUNTIME_ORDER.map((runtime) => {
          const configured = (channels.value ?? []).filter((channel) =>
            channelAcceptsRuntime(channel, runtime),
          )
          const usable = configured.filter((channel) =>
            channel.models.some((model) => model.enabled && !isMoaModelId(model.id)),
          )
          const modelCount = usable.reduce((count, channel) => count + channel.models.filter(
            (model) => model.enabled && !isMoaModelId(model.id),
          ).length, 0)
          const configStatus = channels.loading ? '正在读取渠道…'
            : channels.error ? '渠道读取失败，请重新检测'
              : usable.length ? `${usable.length} 个渠道 · ${modelCount} 个模型已启用`
                : configured.length ? '渠道已启用，还需启用模型' : '尚未启用渠道'
          return (
            <SettingsCard key={runtime} divided={false}>
              <article className="flex flex-col gap-3 p-4" aria-label={AGENT_RUNTIME_LABELS[runtime]}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h5 className="text-sm font-medium">{AGENT_RUNTIME_LABELS[runtime]}</h5>
                  <Button variant="outline" size="sm" onClick={() => onNavigate('channels')}
                    aria-label={`配置 ${AGENT_RUNTIME_LABELS[runtime]} 接入`}>
                    {runtime === 'pi' ? '配置 API 渠道' : '配置接入'}<ArrowRight size={13} aria-hidden="true" />
                  </Button>
                </div>
                <p className="text-sm text-muted-foreground">
                  {runtime === 'pi' ? 'TAgent 定制内核，使用你配置的 API Key 和模型。'
                    : runtime === 'codex' ? '使用官方 Codex 执行循环；Runtime 状态在这里检测。'
                      : '使用已 bundled 的官方 Claude Code SDK；网络与凭据状态由 API 渠道决定。'}
                </p>
                <div className="text-sm" role="status">
                  <p>{configStatus}</p>
                  {runtime === 'pi' && <p className="mt-1 text-xs text-muted-foreground">内核已内置 · API 连通性请在渠道页测试</p>}
                  {runtime === 'codex' && <p className="mt-1 text-xs text-muted-foreground">
                    {codex.loading ? '正在检测本机程序…' : codex.error ? '程序检测失败，请重新检测'
                      : codex.value?.available ? '已找到本机程序 · 登录和连通性未验证'
                      : '本机程序不可用 · 可在此安装 TAgent 托管 Runtime'}
                  </p>}
                  {runtime === 'codex' && codex.value && !codex.value.available && codex.value.managedInstallSupported && (
                    <Button variant="outline" size="sm" className="mt-2" disabled={installing} onClick={() => void installCodexRuntime()}>
                      {installing ? <LoaderCircle size={13} className="animate-spin" /> : <Download size={13} />}
                      {installing ? '正在安装…' : '安装 Codex Runtime'}
                    </Button>
                  )}
                  {runtime === 'codex' && installError && (
                    <p className="mt-2 text-xs text-destructive" role="alert">{installError}</p>
                  )}
                </div>
                {usable.length > 0 && <p className="break-words text-xs text-muted-foreground">
                  已启用渠道：{usable.map((channel) => channel.name).join('、')}
                </p>}
              </article>
            </SettingsCard>
          )
        })}
        {channels.value && channels.value.some((channel) =>
          channel.provider === 'kscc-internal' || channel.provider === 'codex-internal',
        ) && (
          <details className="rounded-xl border border-border/50 px-4 py-3">
            <summary className="cursor-pointer text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              历史运行时兼容
            </summary>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              旧 KSCC / Codex 内部渠道只保留给已绑定的历史会话，不会出现在新会话的 Agent 或模型选择中。
            </p>
            <div className="mt-3 flex flex-col gap-2">
              {channels.value.filter((channel) =>
                channel.provider === 'kscc-internal' || channel.provider === 'codex-internal',
              ).map((channel) => (
                <div key={channel.id} className="flex items-center justify-between gap-3 text-xs">
                  <span className="truncate">{channel.name}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {channel.provider === 'codex-internal' ? 'Codex 旧绑定' : 'KSCC 旧绑定'}
                  </span>
                </div>
              ))}
            </div>
          </details>
        )}
        <p className="text-xs text-muted-foreground">想让其他 Agent 帮忙执行子任务？
          <button type="button" className="ml-1 rounded-sm underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
            onClick={() => onNavigate('agent-cli')}>配置子代理</button>
        </p>
      </div>
    </SettingsSection>
  )
}
