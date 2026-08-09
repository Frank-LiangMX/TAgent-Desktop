/**
 * 分裂发送键：主按钮 = 普通发送；旁侧 ▾ = 用会诊班底发送本条。
 * 会诊是「发送方式」变体，不是常开选项/模式。
 *
 * 必须是模块级组件（勿写进 Chat 函数体，否则 Popover 因重挂载点不开）。
 */
import { useState } from 'react'
import { ArrowUp, ChevronDown, Users } from 'lucide-react'
import {
  AppTooltip,
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  MenuPopoverGroup,
  MenuPopoverItem,
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
  className,
  size = 'md',
  channel,
}: SendSplitButtonProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const enabled = presets.filter((p) => p.enabled)
  const isExternal = channel != null && channel.provider !== 'kscc-internal'
  const btnSize = size === 'sm' ? 'size-8' : 'size-9'
  const iconSize = size === 'sm' ? 'size-4' : 'size-5'
  const chevronBtn = size === 'sm' ? 'h-8 w-7' : 'h-9 w-8'

  // 无会诊预置：退回单发送键
  if (enabled.length === 0) {
    return (
      <Button
        type="button"
        variant={hasDraft ? 'default' : 'ghost'}
        size="icon"
        className={cn(btnSize, 'rounded-full', className)}
        disabled={!hasDraft}
        onClick={onSend}
        aria-label="发送"
      >
        <ArrowUp className={iconSize} />
      </Button>
    )
  }

  return (
    <div
      className={cn(
        'inline-flex items-stretch overflow-hidden rounded-full',
        hasDraft ? 'bg-primary text-primary-foreground' : 'bg-transparent',
        className,
      )}
    >
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
            'rounded-none rounded-l-full',
            hasDraft && 'hover:bg-primary/90',
          )}
          disabled={!hasDraft}
          onClick={onSend}
          aria-label="发送"
        >
          <ArrowUp className={iconSize} />
        </Button>
      </AppTooltip>

      <div
        className={cn(
          'w-px self-stretch',
          hasDraft ? 'bg-primary-foreground/25' : 'bg-border/50',
        )}
        aria-hidden
      />

      <Popover open={open} onOpenChange={setOpen}>
        <AppTooltip
          label={
            hasDraft
              ? '更多发送方式：用会诊班底发送本条'
              : '先输入内容，再用会诊方式发送'
          }
          side="top"
          disabled={open}
        >
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant={hasDraft ? 'default' : 'ghost'}
              size="icon"
              className={cn(
                chevronBtn,
                'rounded-none rounded-r-full',
                hasDraft && 'hover:bg-primary/90',
              )}
              aria-label="更多发送方式"
              aria-expanded={open}
            >
              <ChevronDown className="size-3.5 opacity-90" />
            </Button>
          </PopoverTrigger>
        </AppTooltip>
        <PopoverContent
          align="end"
          side="top"
          sideOffset={8}
          collisionPadding={12}
          className="w-[280px] overflow-hidden p-0"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <div className="px-3.5 pt-3 pb-2">
            <div className="text-[11px] font-medium text-muted-foreground">发送方式</div>
            <div className="mt-1 text-[10.5px] leading-snug text-muted-foreground/85">
              左侧箭头 = 当前模型发送。下列为会诊发送：多模型交卷后汇总，仅本条生效。
            </div>
            <div className="mt-0.5 text-[10.5px] leading-snug text-muted-foreground/70">
              会诊席位无工具；查本地仓库请用左侧 ↑。
            </div>
            {isExternal && (
              <div className="mt-1 text-[10.5px] leading-snug text-amber-600 dark:text-amber-400">
                外部渠会诊：将按预置席位分别计费。
              </div>
            )}
          </div>
          <MenuPopoverGroup
            heading={
              <span className="truncate text-[11px] font-medium text-foreground/70">
                用会诊班底发送
              </span>
            }
          >
            {enabled.map((preset) => (
              <MenuPopoverItem
                key={`consult-${preset.id}`}
                disabled={!hasDraft}
                icon={<Users className="size-4 text-primary/70" />}
                label={preset.name}
                trailing={
                  preset.synthetic === 'channel-same-model' ? (
                    <span className="ml-1 px-1.5 py-0.5 text-[9.5px] font-medium text-amber-600 dark:text-amber-400">
                      同模
                    </span>
                  ) : (
                    <span className="ml-1 px-1.5 py-0.5 text-[9.5px] font-medium text-muted-foreground">
                      {preset.references.length} 参 + 汇
                    </span>
                  )
                }
                onClick={() => {
                  if (!hasDraft) return
                  setOpen(false)
                  onConsultPreset(preset.id)
                }}
              />
            ))}
          </MenuPopoverGroup>
        </PopoverContent>
      </Popover>
    </div>
  )
}

/** @deprecated 请用 SendSplitButton */
export const ConsultMenu = SendSplitButton
