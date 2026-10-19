import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Download, Film, LoaderCircle } from 'lucide-react'
import { Button, SettingsCard, SettingsPageIntro, SettingsSection, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tagent/ui'

type Model = { id: 'base' | 'small'; label: string; bytes: number; installed: boolean; size?: number }
type Status = { selected: 'base' | 'small'; models: Model[]; downloading?: { id: 'base' | 'small'; receivedBytes: number; totalBytes: number }; runtime: { installed: boolean; version: string; size?: number } }
type RuntimeProgress = { receivedBytes: number; totalBytes: number }
type VideoApi = {
  videoModels?: {
    getStatus(): Promise<Status>
    download(id: 'base' | 'small'): Promise<Status>
    downloadRuntime(): Promise<Status>
    select(id: 'base' | 'small'): Promise<Status>
    onProgress(cb: (progress: Status['downloading']) => void): () => void
    onRuntimeProgress(cb: (progress: RuntimeProgress) => void): () => void
  }
}

const api = (): VideoApi => window.electronAPI as unknown as VideoApi
const formatBytes = (bytes: number): string => bytes >= 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024)} MB` : `${Math.round(bytes / 1024)} KB`

export function VideoSettings(): JSX.Element {
  const [status, setStatus] = useState<Status>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [runtimeProgress, setRuntimeProgress] = useState<RuntimeProgress>()
  const models = status?.models ?? []
  const selected = models.find(model => model.id === status?.selected)
  const downloading = status?.downloading
  const progress = useMemo(() => downloading && downloading.totalBytes > 0 ? Math.min(100, Math.round(downloading.receivedBytes / downloading.totalBytes * 100)) : 0, [downloading])

  useEffect(() => {
    let alive = true
    const videoModels = api().videoModels
    if (!videoModels) return
    const off = videoModels.onProgress(progressState => {
      if (alive && progressState) setStatus(current => current ? { ...current, downloading: progressState } : current)
    })
    const offRuntime = videoModels.onRuntimeProgress(progressState => { if (alive) setRuntimeProgress(progressState) })
    void videoModels.getStatus().then(next => { if (alive) setStatus(next) }).catch(cause => { if (alive) setError(String(cause)) })
    return () => { alive = false; off(); offRuntime() }
  }, [])

  const download = async (): Promise<void> => {
    if (!videoModelsApi() || !status) return
    setBusy(true); setError(''); setNotice('')
    try {
      const next = await videoModelsApi()!.download(status.selected)
      setStatus(next); setNotice('语音模型已准备好；视频分析会在本机自动尝试转写音频。')
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }

  const downloadRuntime = async (): Promise<void> => {
    const videoModels = videoModelsApi()
    if (!videoModels) return
    setBusy(true); setError(''); setNotice('')
    try { setStatus(await videoModels.downloadRuntime()); setRuntimeProgress(undefined); setNotice('本地语音引擎已准备好。') }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }

  const select = async (id: 'base' | 'small'): Promise<void> => {
    if (!videoModelsApi()) return
    setError(''); setNotice('')
    try { setStatus(await videoModelsApi()!.select(id)) } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }

  return <div className="settings-page">
    <SettingsPageIntro title="视频分析" description="发送视频链接后，自动提取关键画面和字幕；语音模型按需下载，不会随安装包强制安装。" />
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    <SettingsSection title="本地语音模型" description="模型在本机运行，视频音频不会因为 Whisper 转写而上传到第三方服务。">
      <SettingsCard divided={false}>
        <div className="space-y-4 p-4">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 text-muted-foreground"><Film size={18} /></span>
            <div className="min-w-0 flex-1 text-sm">
              <p className="font-medium">视频语音转写</p>
              <p className="mt-1 text-muted-foreground">没有字幕的视频会先使用关键画面分析；下载模型后，会额外尝试生成带时间点的语音转写。</p>
            </div>
            {selected?.installed ? <span className="inline-flex items-center gap-1 text-xs text-emerald-600"><CheckCircle2 size={14} />已安装</span> : <span className="text-xs text-muted-foreground">按需下载</span>}
          </div>
          <div className="border border-border p-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <div><p className="font-medium">本地语音引擎</p><p className="mt-1 text-xs text-muted-foreground">首次使用时下载约 8 MB；它负责真正执行 Whisper 转写。</p></div>
              {status?.runtime.installed ? <span className="inline-flex items-center gap-1 text-xs text-emerald-600"><CheckCircle2 size={14} />已准备</span> : <span className="text-xs text-muted-foreground">未安装</span>}
            </div>
            {runtimeProgress && <div className="mt-3 space-y-1" role="status"><div className="flex justify-between text-xs text-muted-foreground"><span>正在下载语音引擎…</span><span>{Math.round(runtimeProgress.receivedBytes / Math.max(1, runtimeProgress.totalBytes) * 100)}%</span></div><div className="h-1.5 overflow-hidden bg-muted"><div className="h-full bg-primary" style={{ width: `${Math.min(100, runtimeProgress.receivedBytes / Math.max(1, runtimeProgress.totalBytes) * 100)}%` }} /></div></div>}
            {!status?.runtime.installed && <Button className="mt-3" size="sm" disabled={busy || Boolean(downloading) || Boolean(runtimeProgress)} onClick={() => void downloadRuntime()}><Download size={14} />下载语音引擎</Button>}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {models.map(model => <button key={model.id} type="button" className={`flex items-center justify-between border p-3 text-left text-sm ${status?.selected === model.id ? 'border-primary bg-primary/5' : 'border-border'}`} onClick={() => void select(model.id)} disabled={busy || Boolean(downloading)}>
              <span><strong>{model.label}</strong><span className="ml-2 text-xs text-muted-foreground">{formatBytes(model.bytes)}</span><span className="mt-1 block text-xs text-muted-foreground">{model.id === 'base' ? '速度优先，适合大多数电脑' : '准确率更高，占用更多空间'}</span></span>
              {status?.selected === model.id && <CheckCircle2 size={16} className="text-primary" />}
            </button>)}
          </div>
          {downloading && <div className="space-y-2" role="status"><div className="flex justify-between text-xs text-muted-foreground"><span>正在下载 {downloading.id} 模型…</span><span>{progress}%</span></div><div className="h-1.5 overflow-hidden bg-muted"><div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} /></div><p className="text-xs text-muted-foreground">{formatBytes(downloading.receivedBytes)} / {formatBytes(downloading.totalBytes)}</p></div>}
          <Button disabled={busy || Boolean(downloading) || Boolean(selected?.installed)} onClick={() => void download()}><Download size={14} />{busy ? <><LoaderCircle size={14} className="animate-spin" />正在下载…</> : selected?.installed ? '模型已安装' : `下载 ${selected?.label ?? 'Base'} 模型`}</Button>
        </div>
      </SettingsCard>
    </SettingsSection>
  </div>
}

function videoModelsApi(): NonNullable<VideoApi['videoModels']> | undefined { return api().videoModels }
