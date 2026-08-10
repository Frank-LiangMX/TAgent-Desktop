/**
 * 发送键 + 旁侧 ▾（会诊 / 圆桌等发送方式）。
 * 有内容时：主钮实心圆；▾ 独立轻量 ghost，避免「胶囊切开」的粗分割线。
 *
 * 必须是模块级组件（勿写进 Chat 函数体，否则 Popover 因重挂载点不开）。
 */
import { useState } from 'react'
import { ArrowUp, ChevronDown, Users, MessagesSquare } from 'lucide-react'
import {
  AppTooltip,
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  MenuPopoverGroup,
  MenuPopoverItem,
  MenuPopoverSectionLabel,
  MenuPopoverSeparator,
} from '@tagent/ui'
import type { MoAPreset, Channel } from '@tagent/shared'
import { cn } from '../../lib/utils'

export interface SendSplitButtonProps {
  presets: MoAPreset[]
  hasDraft: boolean
  /** 普通单模型发送 */
  onSend: () => void
  /** 会诊本条：选预置后发送 */
  onConsultPreset: (presetId: string) => void
  /**
   * 圆桌讨论本条：选预置后发送（多轮讨论后总结人收口）。
   * 不传时菜单完全隐藏「用圆桌讨论发送」分组，向后兼容旧调用方。
   */
  onDiscussionPreset?: (presetId: string) => void
  className?: string
  /** 主发送钮尺寸：默认 size-9；运行中排队槽可用 size-8 */
  size?: 'md' | 'sm'
  /**
   * 当前渠道：决定是否为外部渠（外部菜单加计费提示；同模预置标「同模」）。
   * 不传 → 视作 kscc-internal（兼容旧调用）。
   */
  channel?: Channel
}

/** @deprecated 使用 SendSplitButton；保留别名避免旧 import 断裂 */
export type ConsultMenuProps = SendSplitButtonProps

export function SendSplitButton({
  presets,
  hasDraft,
  onSend,
  onConsultPreset,
  onDiscussionPreset,
  className,
  size = 'md',
  channel,
}: SendSplitButtonProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const enabled = presets.filter((p) => p.enabled)
  const isExternal = channel != null && channel.provider !== 'kscc-internal'
  const btnSize = size === 'sm' ? 'size-8' : 'size-9'
  const iconSize = size === 'sm' ? 'size-4' : 'size-5'
  const chevronBtn = size === 'sm' ? 'h-8 w-6' : 'h-9 w-7'
  const showDiscussionGroup = typeof onDiscussionPreset === 'function' && enabled.length > 0

  const sendButton = (
    <AppTooltip
      label={hasDraft ? '发送（当前模型）' : '先输入内容再发送'}
      side="top"
      disabled={open}
    >
      <Button
        type="button"
        variant={hasDraft ? 'default' : 'ghost'}
        size="icon"
        className={cn(
          btnSize,
          'rounded-full',
          hasDraft && 'shadow-sm',
          !hasDraft && 'text-muted-foreground',
        )}
        disabled={!hasDraft}
        onClick={onSend}
        aria-label="发送"
      >
        <ArrowUp className={iconSize} />
      </Button>
    </AppTooltip>
  )

  // 无会诊预置且无圆桌讨论组：退回单发送键（保持向后兼容）
  if (enabled.length === 0 && !showDiscussionGroup) {
    return <div className={cn('inline-flex', className)}>{sendButton}</div>
  }

  return (
    <div className={cn('inline-flex items-center gap-0.5', className)}>
      {sendButton}

      <Popover open={open} onOpenChange={setOpen}>
        <AppTooltip
          label={
            hasDraft
              ? '更多发送方式：用会诊 / 圆桌班底发送本条'
              : '先输入内容，再用会诊或圆桌方式发送'
          }
          side="top"
          disabled={open}
        >
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn(
                chevronBtn,
                'rounded-full text-muted-foreground hover:text-foreground',
                open && 'bg-accent text-foreground',
              )}
              aria-label="更多发送方式"
              aria-expanded={open}
            >
              <ChevronDown className="size-3.5 opacity-80" />
            </Button>
          </PopoverTrigger>
        </AppTooltip>
        <PopoverContent
          align="end"
          side="top"
          sideOffset={8}
          collisionPadding={12}
          className="w-[248px] overflow-hidden p-1.5"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <div className="px-2.5 pb-1 pt-1.5">
            <div className="text-[11px] font-semibold tracking-tight text-foreground/85">
              发送方式
            </div>
          </div>

          <MenuPopoverItem
            disabled={!hasDraft}
            icon={<ArrowUp className="size-4 text-primary/70" />}
            label="普通发送"
            description="当前模型 · 可调用工具"
            onClick={() => {
              if (!hasDraft) return
              setOpen(false)
              onSend()
            }}
          />

          <MenuPopoverSeparator />

          <MenuPopoverGroup
            heading={
              <MenuPopoverSectionLabel uppercase={false} className="m-0 w-full px-0 py-0">
                <span className="min-w-0">
                  <span className="block">会诊</span>
                  <span className="mt-0.5 block font-normal normal-case tracking-normal text-muted-foreground/65">
                    各答各的，再汇总
                  </span>
                </span>
              </MenuPopoverSectionLabel>
            }
          >
            {enabled.map((preset) => (
              <MenuPopoverItem
                key={`consult-${preset.id}`}
                disabled={!hasDraft}
                icon={<Users className="size-4 text-primary/70" />}
                label={preset.name}
                description={
                  preset.synthetic === 'channel-same-model'
                    ? `同模 · ${preset.references.length} 席`
                    : `${preset.references.length} 席`
                }
                onClick={() => {
                  if (!hasDraft) return
                  setOpen(false)
                  onConsultPreset(preset.id)
                }}
              />
            ))}
          </MenuPopoverGroup>

          {showDiscussionGroup && onDiscussionPreset && (
            <MenuPopoverGroup
              heading={
                <MenuPopoverSectionLabel uppercase={false} className="m-0 w-full px-0 py-0">
                  <span className="min-w-0">
                    <span className="block">圆桌</span>
                    <span className="mt-0.5 block font-normal normal-case tracking-normal text-muted-foreground/65">
                      互相讨论，出共识
                    </span>
                  </span>
                </MenuPopoverSectionLabel>
              }
            >
              {enabled.map((preset) => (
                <MenuPopoverItem
                  key={`discuss-${preset.id}`}
                  disabled={!hasDraft}
                  icon={<MessagesSquare className="size-4 text-primary/70" />}
                  label={preset.name}
                  description={`${preset.references.length} 席`}
                  onClick={() => {
                    if (!hasDraft) return
                    setOpen(false)
                    onDiscussionPreset(preset.id)
                  }}
                />
              ))}
            </MenuPopoverGroup>
          )}

          {isExternal ? (
            <div className="px-2.5 pb-1.5 pt-0.5 text-[10px] leading-snug text-muted-foreground/80">
              外部渠按席位分别计费
            </div>
          ) : null}
        </PopoverContent>
      </Popover>
    </div>
  )
}

/** @deprecated 请用 SendSplitButton */
export const ConsultMenu = SendSplitButton
