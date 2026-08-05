/**
 * ComposerRunTimer — 输入框上方的运行计时 pill
 *
 * 发送即开始（Chat startRun / 全局 stream sync 写 startedAt），覆盖思考期无产出。
 * startedAt 有值即显示（含 turn_end 软停后的工具间隙）；硬停（result/error/用户停）才清 null。
 * 绝对定位浮在输入框上方：不撑高 bottom-stack，避免整行 blur underlay 上扩；
 * pill 自身带玻璃底（如下箭头），只遮挡 pill 区域下的滚动内容。
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
