import { isChannelCompatibleWithRuntime } from '@tagent/shared'
import { useCallback, useEffect, useState } from 'react'
import { Button, SettingsCard, SettingsPageIntro, SettingsSection, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tagent/ui'
import type { Automation, Channel, WpsChatSummary, WpsCollectionSummary, WpsConnectionInput, WpsDesktopApi, WpsPublicConfig, WpsUserAuthState } from '@tagent/shared'

type Api = WpsDesktopApi & {
  listChannels(): Promise<Channel[]>
  listAutomations(): Promise<Automation[]>
  toggleAutomation(id: string): Promise<Automation>
}
const api = (): Api => window.electronAPI as unknown as Api
const initial: WpsConnectionInput = { reportScope: { includeChats: true, includeDocuments: true, chatIds: [] } }

export function WpsWorkspace(): JSX.Element {
  const [config, setConfig] = useState<WpsPublicConfig>()
  const [draft, setDraft] = useState(initial)
  const [auth, setAuth] = useState<WpsUserAuthState>({ loggedIn: false })
  const [channels, setChannels] = useState<Channel[]>([])
  const [jobs, setJobs] = useState<Automation[]>([])
  const [chats, setChats] = useState<WpsChatSummary[]>([])
  const [channelId, setChannelId] = useState('')
  const [modelId, setModelId] = useState('')
  const [time, setTime] = useState('18:00')
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [summary, setSummary] = useState<WpsCollectionSummary>()
  const channel = channels.find(item => item.id === channelId)
  const models = channel?.models.filter(item => item.enabled) ?? []
  const dirty = !!config && JSON.stringify(draft.reportScope) !== JSON.stringify(config.reportScope)

  const refreshJobs = useCallback(async () => { setJobs((await api().listAutomations()).filter(item => item.wpsDailyReport)) }, [])
  useEffect(() => {
    let alive = true
    const unsubscribe = api().onWpsUserAuthChanged(state => {
      if (alive) { setAuth(state); setSummary(undefined); if (!state.loggedIn) setChats([]) }
    })
    void Promise.all([api().getWpsConfig(), api().getWpsUserAuth(), api().listChannels(), api().listAutomations()]).then(([c, a, list, tasks]) => {
      if (!alive) return
      setConfig(c); setDraft({ reportScope: c.reportScope }); setAuth(a)
      const enabled = list.filter(item => isChannelCompatibleWithRuntime(item, 'pi') && item.models.some(model => model.enabled))
      setChannels(enabled); setChannelId(enabled[0]?.id ?? '')
      setModelId(enabled[0]?.defaultModelId ?? enabled[0]?.models.find(model => model.enabled)?.id ?? '')
      setJobs(tasks.filter(item => item.wpsDailyReport))
    }).catch(cause => { if (alive) setError(String(cause instanceof Error ? cause.message : cause)) })
      .finally(() => { if (alive) setBusy(false) })
    return () => { alive = false; unsubscribe() }
  }, [])

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true); setError(''); setNotice('')
    try { await action() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const save = async (): Promise<void> => {
    const c = await api().saveWpsConfig(draft)
    setConfig(c); setDraft({ reportScope: c.reportScope }); setAuth(await api().getWpsUserAuth()); setSummary(undefined)
    setNotice('采集范围已保存。新增采集权限后需要重新授权；已创建日报任务保留创建时的范围。')
  }
  const changeScope = (key: 'includeChats' | 'includeDocuments', checked: boolean): void => {
    setDraft(current => ({ ...current, reportScope: { ...current.reportScope, [key]: checked } }))
  }
  const selectedJobs = jobs.filter(item => item.wpsDailyReport?.accountId === auth.userId)
  return <div className="settings-page">
    <SettingsPageIntro title="WPS 连接与自动化" description="配置本人 WPS 365 账号授权、采集范围和自动日报任务。报告正文请在“日报与周报”中查看。" />
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    <SettingsSection title="开始使用" description="连接自己的 WPS 账号，授权后即可读取本人工作资料。">
      <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
        <li>点击「连接 WPS」，在弹出的 WPS 网页中登录自己的账号并同意授权。</li>
        <li>返回应用，点击「验证今日采集」，确认聊天和文档是否能读取。</li>
        <li>选择 HTTP AI 渠道、模型和时间，启用每日工作日报。AI 渠道用于生成总结，与 WPS 登录分开。</li>
      </ol>
    </SettingsSection>
    <SettingsSection title="本人账号" description="登录方式由 WPS 官方网页提供。授权成功后，应用会自动显示连接状态。">
      <SettingsCard>
        <div className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="text-sm">
            <p>{auth.loading ? '请在 WPS 网页完成登录和授权…' : auth.loggedIn ? `已连接 · ${auth.userName || auth.userId}` : '尚未连接 WPS'}</p>
            {auth.canCreateDocuments && <p className="mt-1 text-muted-foreground">已授权创建云文档</p>}
            {auth.errorMessage && <p className="mt-1 text-destructive">{auth.errorMessage}</p>}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy || auth.loading} onClick={() => void run(async () => {
              if (dirty) await save()
              setAuth(await api().loginWpsUser())
            })}>
              {auth.loggedIn ? '重新授权' : '连接 WPS'}
            </Button>
            {!auth.canCreateDocuments && <Button variant="outline" disabled={busy || auth.loading} onClick={() => void run(async () => {
              if (dirty) await save()
              setAuth(await api().loginWpsUser(true))
            })}>授权创建云文档</Button>}
            {(auth.loggedIn || auth.loading) && <Button variant="outline" disabled={busy} onClick={() => void run(async () => { setAuth(await api().logoutWpsUser()) })}>断开连接</Button>}
          </div>
        </div>
      </SettingsCard>
      <p className="mt-3 text-sm text-muted-foreground">在 Work 模式中要求 Agent 将日报或周报保存为 WPS 云文档。首次使用请点击「授权创建云文档」；文档保存到 WPS 的「MCP/智能文档」文件夹。</p>
      {config && !config.available && <p role="status" className="mt-3 text-sm text-muted-foreground">WPS 登录组件未准备好；点击后会显示具体错误。</p>}
    </SettingsSection>
    <SettingsSection title="采集范围" description="默认收集本人当天发出的消息。选中的会话增加沟通上下文；文档贡献以修改者及版本记录为依据。">
      <SettingsCard>
        <div className="space-y-3 p-4 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" disabled={busy || auth.loading} checked={draft.reportScope.includeChats} onChange={event => changeScope('includeChats', event.target.checked)} />本人聊天消息</label>
          <label className="flex items-center gap-2"><input type="checkbox" disabled={busy || auth.loading} checked={draft.reportScope.includeDocuments} onChange={event => changeScope('includeDocuments', event.target.checked)} />当天变更的可访问云文档</label>
          {draft.reportScope.includeChats && <>
            <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-muted-foreground">额外读取上下文的会话 · 已选 {draft.reportScope.chatIds.length}</span>
              <Button variant="outline" size="sm" disabled={busy || !auth.loggedIn || dirty} onClick={() => void run(async () => { setChats(await api().listWpsReportChats()) })}>选择会话</Button></div>
            {chats.length > 0 && <div className="max-h-64 space-y-2 overflow-y-auto rounded-lg border border-border p-3">
              {chats.map(chat => <label key={chat.id} className="flex items-start gap-2">
                <input type="checkbox" className="mt-1" disabled={busy} checked={draft.reportScope.chatIds.includes(chat.id)} onChange={event => {
                  setDraft(current => ({ ...current, reportScope: { ...current.reportScope,
                    chatIds: event.target.checked ? [...current.reportScope.chatIds, chat.id] : current.reportScope.chatIds.filter(id => id !== chat.id) } }))
                }} /><span className="break-all">{chat.title}</span>
              </label>)}
            </div>}
            {draft.reportScope.chatIds.length > 0 && <Button variant="ghost" size="sm" disabled={busy} onClick={() => setDraft(current => ({ ...current, reportScope: { ...current.reportScope, chatIds: [] } }))}>清空上下文会话</Button>}
          </>}
        </div>
      </SettingsCard>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button disabled={busy || auth.loading || !dirty} onClick={() => void run(save)}>保存采集范围</Button>
        <Button variant="outline" disabled={busy || dirty || !auth.loggedIn} onClick={() => void run(async () => { setSummary(await api().collectWpsDaily()) })}>验证今日采集</Button>
      </div>
      {summary && <div role="status" className="mt-3 space-y-2 rounded-xl border border-border p-4 text-sm">
        <p>{summary.date} · 本人消息 {summary.ownMessageCount} 条 · 文档 {summary.documentCount} 份 · {summary.complete ? '采集完成' : '采集存在缺口'}</p>
        {summary.warnings.map(message => <p key={message} className="text-muted-foreground">{message}</p>)}
      </div>}
    </SettingsSection>
    <SettingsSection title="每天生成日报" description={`按本机时区 ${Intl.DateTimeFormat().resolvedOptions().timeZone} 执行。应用关闭期间不运行；重新打开后补报最近七天。日报保存在应用任务中。`}>
      <SettingsCard><div className="space-y-4 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-2 text-sm"><span>AI 渠道（HTTP · Pi）</span>
            <Select value={channelId} onValueChange={value => { setChannelId(value); const c = channels.find(item => item.id === value); setModelId(c?.defaultModelId ?? c?.models.find(model => model.enabled)?.id ?? '') }} disabled={busy}>
              <SelectTrigger><SelectValue placeholder="选择渠道" /></SelectTrigger><SelectContent>{channels.map(item => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent>
            </Select>
          </label>
          <label className="space-y-2 text-sm"><span>模型</span>
            <Select value={modelId} onValueChange={setModelId} disabled={busy}><SelectTrigger><SelectValue placeholder="选择模型" /></SelectTrigger><SelectContent>{models.map(item => <SelectItem key={item.id} value={item.id}>{item.id}</SelectItem>)}</SelectContent></Select>
          </label>
        </div>
        <label className="flex items-center justify-between gap-3 text-sm"><span>每日生成时间</span><input aria-label="每日生成时间" type="time" className="rounded-md border border-border bg-background px-3 py-2" disabled={busy} value={time} onChange={event => setTime(event.target.value)} /></label>
        <Button disabled={busy || dirty || !auth.loggedIn || !channelId || !modelId || selectedJobs.some(item => item.enabled)} onClick={() => void run(async () => {
          await api().createWpsDailyReport({ channelId, modelId, timeOfDay: time }); await refreshJobs(); setNotice('每日工作日报已启用，可在定时任务中查看、修改和暂停。')
        })}>启用每日工作日报</Button>
        {jobs.map(job => <div key={job.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3 text-sm">
          <span>{job.name} · {job.timeOfDay} · {job.enabled ? '已启用' : '已暂停'}{job.wpsDailyReport?.accountId !== auth.userId ? ' · 绑定其他账号' : ''}</span>
          <Button variant="outline" size="sm" disabled={busy || (!job.enabled && job.wpsDailyReport?.accountId !== auth.userId)} onClick={() => void run(async () => { await api().toggleAutomation(job.id); await refreshJobs() })}>{job.enabled ? '暂停' : '恢复'}</Button>
        </div>)}
      </div></SettingsCard>
      <p className="mt-3 text-xs text-muted-foreground">授权后也可直接让 Agent“总结今天的 WPS 工作日报”。日报及读取的证据保存在应用任务中，不自动写入知识库，不自动发送给其他人。图片、语音和附件暂不自动转写。</p>
    </SettingsSection>
  </div>
}
