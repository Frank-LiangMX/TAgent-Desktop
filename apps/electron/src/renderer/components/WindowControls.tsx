/**
 * WindowControls — Windows 自定义窗口控制按钮（最小化/最大化/关闭）
 *
 * 对齐 TAgent_General WindowControls：仅 Windows 渲染，替换 Electron 原生按钮，
 * fixed 叠在窗口右上角浮岛顶缘。mac 用系统红绿灯不渲染。
 */
import { useEffect, useState } from 'react'

export function WindowControls(): JSX.Element | null {
  const [isWindows, setIsWindows] = useState(false)
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    setIsWindows(navigator.userAgent.includes('Windows'))
  }, [])

  useEffect(() => {
    if (!isWindows) return
    void window.electronAPI.windowIsMaximized().then(setIsMaximized)
    const off = window.electronAPI.onWindowResize(() => {
      void window.electronAPI.windowIsMaximized().then((next) => {
        setIsMaximized((prev) => (prev === next ? prev : next))
      })
    })
    return off
  }, [isWindows])

  if (!isWindows) return null

  return (
    <div className="window-controls app-window-controls flex select-none titlebar-no-drag">
      {/* 最小化 */}
      <button
        type="button"
        className="window-control-btn"
        aria-label="最小化"
        onClick={() => window.electronAPI.windowMinimize()}
      >
        <svg width="12" height="12" viewBox="0 0 12 12">
          <rect x="1" y="5.5" width="10" height="1" fill="currentColor" />
        </svg>
      </button>
      {/* 最大化/还原 */}
      <button
        type="button"
        className="window-control-btn"
        aria-label={isMaximized ? '还原' : '最大化'}
        onClick={() => window.electronAPI.windowMaximize()}
      >
        {isMaximized ? (
          <svg width="12" height="12" viewBox="0 0 12 12">
            <rect x="3" y="0.5" width="8" height="8" rx="0.5" fill="none" stroke="currentColor" />
            <rect x="0.5" y="3" width="8" height="8" rx="0.5" fill="none" stroke="currentColor" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 12 12">
            <rect x="1" y="1" width="10" height="10" rx="0.5" fill="none" stroke="currentColor" />
          </svg>
        )}
      </button>
      {/* 关闭 */}
      <button
        type="button"
        className="window-control-btn window-control-close"
        aria-label="关闭"
        onClick={() => window.electronAPI.windowClose()}
      >
        <svg width="12" height="12" viewBox="0 0 12 12">
          <path d="M1 1 L11 11 M11 1 L1 11" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
    </div>
  )
}
