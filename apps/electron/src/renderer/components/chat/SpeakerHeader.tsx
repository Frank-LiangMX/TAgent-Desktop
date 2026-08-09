/**
 * SpeakerHeader — 助手 turn 说话人行（多 agent 预留）
 *
 * 头像：圆形模型 logo（getModelLogo）；无 modelId 时 monogram 兜底。
 * 名字优先；模型 id 仍作次要 glass pill。
 * 材质沿用磨砂玻璃，不引入实心彩气泡。
 */
import { getModelLogo } from '../../lib/model-logo'
import { AppTooltip } from '@tagent/ui'
import { cn } from '../../lib/utils'

/** 稳定色相槽：仅 monogram 兜底时用 */
const SPEAKER_SLOTS = 6

export function speakerSlotForName(name: string): number {
  let h = 0
  const s = name.trim() || '助手'
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h % SPEAKER_SLOTS
}

export function monogramFromName(name: string): string {
  const t = name.trim()
  if (!t) return '助'
  const bare = t.startsWith('@') ? t.slice(1) : t
  if (/[\u4e00-\u9fff]/.test(bare)) return bare.slice(0, 1)
  const parts = bare.split(/[\s._-]+/).filter(Boolean)
  if (parts.length >= 2) {
    return `${parts[0]![0] ?? ''}${parts[1]![0] ?? ''}`.toUpperCase().slice(0, 2)
  }
  return bare.slice(0, 2).toUpperCase()
}

export interface SpeakerHeaderProps {
  /** 主说话人显示名（角色名 / 助手） */
  name: string
  /** 模型 id：驱动圆形 logo；同时作次要 pill */
  modelId?: string
  /** 右侧状态：运行计时 / 墙钟 */
  statusLabel?: string
  isLive?: boolean
  /**
   * 本轮 @ 点名链。
   * 多角色时展示轻量 handoff：A → B → 当前
   */
  handoffLabels?: string[]
  className?: string
}

/**
 * 解析本轮应展示的 speaker 名：
 * - 有 @ 链 → 取最后一个（当前接话角色）
 * - 否则用模型名；再缺省才「助手」
 */
export function resolveSpeakerName(
  mentionLabels?: string[],
  modelId?: string,
): string {
  if (mentionLabels?.length) {
    const last = mentionLabels[mentionLabels.length - 1]!.trim()
    if (last) return last.startsWith('@') ? last.slice(1) : last
  }
  const model = modelId?.trim()
  if (model) return model
  return '助手'
}

export function SpeakerHeader({
  name,
  modelId,
  statusLabel,
  isLive = false,
  handoffLabels,
  className,
}: SpeakerHeaderProps): JSX.Element {
  // 无 @ 时 name 已是模型名；展示文案优先 name，logo 仍用 modelId
  const displayName = name.trim() || modelId?.trim() || '助手'
  const slot = speakerSlotForName(displayName)
  const mono = monogramFromName(displayName)
  // 有 modelId 就走 logo 图；匹配不到也会回退到 getModelLogo 默认图
  const logoSrc = modelId?.trim() ? getModelLogo(modelId.trim()) : undefined

  const chain = (handoffLabels ?? [])
    .map((l) => {
      const t = l.trim()
      return t.startsWith('@') ? t.slice(1) : t
    })
    .filter(Boolean)
  const prior =
    chain.length > 1
      ? chain.slice(0, -1)
      : chain.length === 1 && chain[0] !== displayName
        ? chain
        : []

  return (
    <div
      className={cn('agent-speaker', className)}
      data-speaker-slot={slot}
      data-has-logo={logoSrc ? 'true' : 'false'}
    >
      <div className="agent-speaker__avatar" aria-hidden>
        {logoSrc ? (
          <img
            src={logoSrc}
            alt=""
            className="agent-speaker__logo"
            draggable={false}
          />
        ) : (
          <span className="agent-speaker__mono">{mono}</span>
        )}
      </div>

      <div className="agent-speaker__main min-w-0">
        <div className="agent-speaker__line">
          {prior.length > 0 ? (
            <AppTooltip label="本轮点名顺序">
              <span className="agent-speaker__handoff">
                {prior.map((label, i) => (
                  <span key={`${label}-${i}`} className="agent-speaker__handoff-item">
                    {i > 0 ? (
                      <span className="agent-speaker__handoff-arrow" aria-hidden>
                        →
                      </span>
                    ) : null}
                    <span className="agent-speaker__handoff-name">{label}</span>
                  </span>
                ))}
                <span className="agent-speaker__handoff-arrow" aria-hidden>
                  →
                </span>
              </span>
            </AppTooltip>
          ) : null}
          {/* 无玻璃铭牌：名字纯文本；模型 id 仅 AppTooltip 悬停可见 */}
          <AppTooltip label={modelId ? `${displayName} · ${modelId}` : displayName}>
            <span className="agent-speaker__name">{displayName}</span>
          </AppTooltip>
        </div>
      </div>

      {statusLabel ? (
        <span
          className={cn(
            'agent-speaker__time',
            isLive && 'agent-speaker__time--live',
          )}
        >
          {statusLabel}
        </span>
      ) : null}
    </div>
  )
}
