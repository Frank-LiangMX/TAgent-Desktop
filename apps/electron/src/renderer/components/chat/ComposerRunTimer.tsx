/**
 * ComposerRunTimer — 输入框上方的运行计时 pill
 *
 * 发送即开始（Chat.tsx 在 startRun 时同步写 runStartedAt），覆盖"思考期无产出"
 * 阶段；完成/切会话/出错清零（runStartedAt=null → 返回 null 不渲染）。
 * 挂在 session-composer-cluster 内、输入框正上方，跟随输入框位置变化。
 * 复用 useLiveElapsedMs / formatElapsedDuration，不新增 formatter / atom。
 */
import { useLiveElapsedMs, formatElapsedDuration } from '../../lib/time-utils'

export function ComposerRunTimer({
  startedAt,
}: {
  startedAt: number | null
}): JSX.Element | null {
  const live = startedAt != null
  const elapsedMs = useLiveElapsedMs(startedAt ?? undefined, live)
  if (!live) return null
  return (
    <div
      className="composer-run-timer"
      role="status"
      aria-live="polite"
      aria-label={`运行中 ${formatElapsedDuration(elapsedMs)}`}
    >
      <span className="composer-run-timer__dot" aria-hidden />
      <span className="composer-run-timer__text">
        运行 {formatElapsedDuration(elapsedMs)}
      </span>
    </div>
  )
}
