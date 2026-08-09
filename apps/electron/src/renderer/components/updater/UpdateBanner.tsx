/**
 * 更新提示横幅
 *
 * 底部浮岛玻璃条，跟随主题 --glass-rgb / --scene-a-rgb。
 * 发现新版本 → 下载中 → 已就绪（安装） / 错误（重试）
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { Download, RefreshCw, CheckCircle2, AlertCircle, X, Loader2 } from 'lucide-react'
import {
  updateStateAtom,
  checkForUpdatesAtom,
  installWhenIdleAtom,
  cancelIdleInstallAtom,
} from '../../atoms/updater'
import { useState, useEffect } from 'react'
import { AppTooltip } from '@tagent/ui'

export function UpdateBanner(): JSX.Element | null {
  const state = useAtomValue(updateStateAtom)
  const checkForUpdates = useSetAtom(checkForUpdatesAtom)
  const installWhenIdle = useSetAtom(installWhenIdleAtom)
  const cancelIdleInstall = useSetAtom(cancelIdleInstallAtom)
  const [dismissed, setDismissed] = useState(false)

  // 状态回到 idle/not-available 时重置 dismiss
  useEffect(() => {
    if (state.status === 'idle' || state.status === 'not-available') {
      setDismissed(false)
    }
  }, [state.status])

  if (state.status === 'idle' || state.status === 'not-available' || dismissed) return null

  const handleDismiss = (): void => setDismissed(true)

  if (state.status === 'downloading') {
    const pct = Math.round(state.progress.percent)
    return (
      <div className="upd-banner" data-variant="downloading">
        <span className="upd-banner-dot" data-state="spin">
          <Loader2 size={13} className="upd-spin" />
        </span>
        <span className="upd-banner-label">正在下载 v{state.version}</span>
        <span className="upd-banner-pct">{pct}%</span>
        <div className="upd-banner-track">
          <div className="upd-banner-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>
    )
  }

  if (state.status === 'downloaded') {
    return (
      <div className="upd-banner" data-variant="ready">
        <span className="upd-banner-dot" data-state="done">
          <CheckCircle2 size={13} />
        </span>
        <span className="upd-banner-label">v{state.version} 已就绪，将在 Agent 空闲后安装</span>
        <div className="upd-banner-actions">
          <button
            type="button"
            className="upd-banner-btn"
            data-style="primary"
            onClick={() => void installWhenIdle()}
          >
            立即排队
          </button>
          <button
            type="button"
            className="upd-banner-btn"
            data-style="ghost"
            onClick={() => {
              void cancelIdleInstall()
              handleDismiss()
            }}
          >
            稍后
          </button>
        </div>
      </div>
    )
  }

  if (state.status === 'available') {
    return (
      <div className="upd-banner" data-variant="info">
        <span className="upd-banner-dot" data-state="info">
          <Download size={13} />
        </span>
        <span className="upd-banner-label">发现新版本 v{state.version}，正在后台下载…</span>
        <button
          type="button"
          className="upd-banner-x"
          onClick={handleDismiss}
          aria-label="关闭"
        >
          <X size={11} />
        </button>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="upd-banner" data-variant="error">
        <span className="upd-banner-dot" data-state="error">
          <AlertCircle size={13} />
        </span>
        <AppTooltip label={state.error} multiline>
          <span className="upd-banner-label">更新检查失败</span>
        </AppTooltip>
        <button
          type="button"
          className="upd-banner-btn"
          data-style="ghost"
          onClick={() => void checkForUpdates()}
        >
          <RefreshCw size={11} />
          重试
        </button>
        <button
          type="button"
          className="upd-banner-x"
          onClick={handleDismiss}
          aria-label="关闭"
        >
          <X size={11} />
        </button>
      </div>
    )
  }

  return null
}
