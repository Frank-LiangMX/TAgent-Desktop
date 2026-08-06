/**
 * 设置页「关于」中的更新检查器
 *
 * 玻璃行卡片样式，对齐 settings-row + settings-env-item 视觉。
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { RefreshCw, Loader2, Download, CheckCircle2, AlertCircle, ArrowUpRight } from 'lucide-react'
import {
  updateStateAtom,
  checkForUpdatesAtom,
  installWhenIdleAtom,
} from '../../atoms/updater'

export function UpdateChecker(): JSX.Element {
  const state = useAtomValue(updateStateAtom)
  const checkForUpdates = useSetAtom(checkForUpdatesAtom)
  const installWhenIdle = useSetAtom(installWhenIdleAtom)

  const isChecking = state.status === 'checking'
  const isDownloading = state.status === 'downloading'
  const isDownloaded = state.status === 'downloaded'
  const isError = state.status === 'error'
  const isAvailable = state.status === 'available'
  const isNotAvailable = state.status === 'not-available'
  const isIdle = state.status === 'idle'
  const busy = isChecking || isDownloading

  const dotState =
    isDownloaded ? 'done' :
    isError ? 'error' :
    isAvailable || isDownloading ? 'info' :
    'idle'

  return (
    <div className="upd-checker">
      <div className="upd-checker-main">
        <span className="upd-checker-dot" data-state={dotState}>
          {isChecking || isDownloading ? (
            <Loader2 size={13} className="upd-spin" />
          ) : isDownloaded ? (
            <CheckCircle2 size={13} />
          ) : isError ? (
            <AlertCircle size={13} />
          ) : isAvailable ? (
            <Download size={13} />
          ) : isNotAvailable ? (
            <CheckCircle2 size={13} />
          ) : (
            <RefreshCw size={13} />
          )}
        </span>

        <div className="upd-checker-body">
          <div className="upd-checker-title">
            {isIdle && '检查是否有新版本'}
            {isChecking && '正在检查…'}
            {isAvailable && `发现 v${state.version}，正在后台下载…`}
            {isDownloading && `下载中 · ${Math.round(state.progress.percent)}%`}
            {isDownloaded && `v${state.version} 已就绪`}
            {isNotAvailable && '已是最新版本'}
            {isError && '检查失败'}
          </div>
          <div className="upd-checker-sub">
            {isIdle && '启动后自动检查，也可手动触发'}
            {isChecking && '正在从 GitHub 拉取版本信息'}
            {isAvailable && '下载完成后会通知你安装'}
            {isDownloading && `${formatBytes(state.progress.transferred)} / ${formatBytes(state.progress.total)}`}
            {isDownloaded && '点击「空闲时安装」将在所有 Agent 结束后自动安装'}
            {isNotAvailable && '当前版本是最新的'}
            {isError && (state.error || '网络或 GitHub 不可达，稍后自动重试')}
          </div>
        </div>

        <div className="upd-checker-action">
          {!isDownloaded && (
            <button
              type="button"
              className="upd-checker-btn"
              onClick={() => void checkForUpdates()}
              disabled={busy}
            >
              {isChecking ? (
                <Loader2 size={12} className="upd-spin" />
              ) : (
                <RefreshCw size={12} />
              )}
              检查更新
            </button>
          )}
          {isDownloaded && (
            <button
              type="button"
              className="upd-checker-btn"
              data-style="accent"
              onClick={() => void installWhenIdle()}
            >
              <ArrowUpRight size={12} />
              空闲时安装
            </button>
          )}
        </div>
      </div>

      {isDownloading && (
        <div className="upd-checker-track">
          <div className="upd-checker-fill" style={{ width: `${state.progress.percent}%` }} />
        </div>
      )}

      {isError && state.error && (
        <div className="upd-checker-err">{state.error.slice(0, 200)}</div>
      )}
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes < 1) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let val = bytes
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024
    i++
  }
  return `${val.toFixed(val < 10 ? 1 : 0)} ${units[i]}`
}
