/**
 * ComposerRunTimer — 输入框上方的运行计时 pill
 *
 * 发送即开始（Chat startRun / 全局 stream sync 写 startedAt），覆盖思考期无产出。
 * startedAt 有值即显示（含 turn_end 软停后的工具间隙）；硬停（result/error/用户停）才清 null。
 * 绝对定位浮在输入框上方：不撑高 bottom-stack，避免整行 blur underlay 上扩；
 * pill 自身带玻璃底（如下箭头），只遮挡 pill 区域下的滚动内容。
 *
 * 视觉取自 uiverse _5797/perfect-termite-38（Searching orb loader），改用主题色：
 * 旋转 glow orb + 计时字符逐字 wave 动画（原 "Searching" 字样换成实时计时）。
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
  const duration = formatElapsedDuration(elapsedMs)
  // 拆字符做逐字 wave。子 span key 用索引：等长更新时复用 DOM、wave 时钟不断 → 波连续。
  // 长度变化（如 59s→1m 0s）时新增字从相位 0 起步、旧字停在旧相位中段 → 逐字错峰断裂。
  // 故给 __chars 容器 key={chars.length}：长度一变整组重挂，所有字同刻起步、相位重新连续。
  // 重挂恰逢内容变化（在介绍新时间），从左扫一次属预期，非 glitch。
  // 空格宽度由 .composer-run-timer__char 的 white-space: pre 保留。
  const chars = Array.from(duration)
  return (
    <div
      className="composer-run-timer"
      role="status"
      aria-live="polite"
      aria-label={`运行中 ${duration}`}
    >
      <span className="composer-run-timer__orb" aria-hidden />
      <span key={chars.length} className="composer-run-timer__chars" aria-hidden>
        {chars.map((ch, i) => (
          <span
            key={i}
            className="composer-run-timer__char"
            style={{ animationDelay: `${i * 0.08}s` }}
          >
            {ch}
          </span>
        ))}
      </span>
    </div>
  )
}
