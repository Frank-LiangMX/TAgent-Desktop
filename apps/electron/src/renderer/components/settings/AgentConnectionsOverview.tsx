import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowRight, RefreshCw } from 'lucide-react'
import { Button, SettingsCard, SettingsSection } from '@tagent/ui'
import { isMoaModelId, type Channel } from '@tagent/shared'
import { channelAcceptsRuntime } from '../../atoms/agent-runtime'

export function AgentConnectionsOverview({ onNavigate }: {
  onNavigate: (tab: 'channels' | 'agent-cli') => void
}): JSX.Element {
  const [channels, setChannels] = useState<Channel[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const generation = useRef(0)
  const refresh = useCallback(async () => {
    const current = ++generation.current
    setLoading(true); setError(false)
    try { const list = await window.electronAPI.listChannels(); if (current === generation.current) setChannels(list) }
    catch { if (current === generation.current) setError(true) }
    finally { if (current === generation.current) setLoading(false) }
  }, [])
  useEffect(() => { void refresh(); return () => { generation.current++ } }, [refresh])
  const usable = channels.filter(channel => channelAcceptsRuntime(channel, 'pi') &&
    channel.models.some(model => model.enabled && !isMoaModelId(model.id)))
  const modelCount = usable.reduce((count, channel) => count + channel.models.filter(
    model => model.enabled && !isMoaModelId(model.id),
  ).length, 0)
  return <SettingsSection title="Pi Agent" description="内核已内置，所有模型通过 HTTP(S) 渠道接入。"
    action={<Button variant="outline" size="sm" onClick={() => void refresh()}><RefreshCw size={13} />重新检测</Button>}>
    <SettingsCard divided={false}>
      <article className="flex flex-col gap-3 p-4" aria-label="Pi">
        <div className="flex items-center justify-between gap-3">
          <h5 className="text-sm font-medium">Pi</h5>
          <Button variant="outline" size="sm" onClick={() => onNavigate('channels')} aria-label="配置 Pi 接入">配置 API 渠道<ArrowRight size={13} /></Button>
        </div>
        <p className="text-sm" role="status">{loading ? '正在读取渠道…' : error ? '渠道读取失败，请重新检测'
          : usable.length ? `${usable.length} 个渠道 · ${modelCount} 个模型已启用` : '尚未启用渠道或模型'}</p>
        <p className="text-xs text-muted-foreground">无需安装或登录本机 Runtime。API 连通性请在渠道页测试。</p>
        {usable.length > 0 && <p className="break-words text-xs text-muted-foreground">已启用渠道：{usable.map(channel => channel.name).join('、')}</p>}
      </article>
    </SettingsCard>
    <p className="mt-3 text-xs text-muted-foreground">需要配置 Pi 子代理角色时，
      <button type="button" className="ml-1 underline underline-offset-4" onClick={() => onNavigate('agent-cli')}>配置子代理</button>
    </p>
  </SettingsSection>
}
