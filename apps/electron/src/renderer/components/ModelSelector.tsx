/**
 * ModelSelector — 输入框尾部的渠道选择 Popover pill
 *
 * 对齐 TAgent_General AgentModelSelector 的形态（Cpu 图标 + 名称 + ChevronDown），
 * 自己搭，不搬其代码。会话绑核后 locked 不可切（kscc↔external 互斥）。
 *
 * 当前架构：会话绑渠道，渠道带默认模型；此处选渠道，模型随渠道。
 * 核内换模型的独立 UI 留后续。
 */
import { useAtomValue } from 'jotai'
import { Popover, PopoverTrigger, PopoverContent } from '@tagent/ui'
import { Cpu, ChevronDown, Check } from 'lucide-react'
import { cn } from '../lib/utils'
import { channelsAtom } from '../atoms/channel-atoms'

interface ModelSelectorProps {
  /** 当前生效渠道 ID（sentChannelId ?? session.channelId ?? selectedChannelId） */
  effectiveChannelId: string | null
  /** 会话已绑核 → 不可切 */
  locked: boolean
  /** 切换渠道（未锁定时调） */
  onSelectChannel: (id: string) => void
}

export function ModelSelector({
  effectiveChannelId,
  locked,
  onSelectChannel,
}: ModelSelectorProps): JSX.Element {
  const channels = useAtomValue(channelsAtom)
  const enabled = channels.filter((c) => c.enabled)
  const active = channels.find((c) => c.id === effectiveChannelId)

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={locked}
          className={cn(
            'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition-colors',
            'text-muted-foreground hover:bg-accent hover:text-foreground',
            locked && 'cursor-not-allowed opacity-60 hover:bg-transparent hover:text-muted-foreground',
          )}
        >
          <Cpu className="size-3.5" />
          <span className="max-w-[120px] truncate font-medium text-foreground/80">
            {active ? active.name : '未选择'}
          </span>
          {active?.defaultModelId && (
            <span className="max-w-[100px] truncate text-foreground/40">
              · {active.defaultModelId}
            </span>
          )}
          <ChevronDown className="size-3 opacity-70" />
        </button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-64 p-2">
        <div className="space-y-0.5">
          {enabled.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">无可用渠道</div>
          )}
          {enabled.map((c) => (
            <button
              key={c.id}
              onClick={() => onSelectChannel(c.id)}
              className={cn(
                'flex w-full items-center gap-2 rounded-glass-popover px-2 py-1.5 text-left text-xs transition-colors',
                'hover:bg-accent',
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{c.name}</div>
                <div className="truncate text-[10px] text-muted-foreground">
                  {c.defaultModelId ?? '无默认模型'}
                </div>
              </div>
              {c.id === effectiveChannelId && (
                <Check className="size-3.5 shrink-0 text-primary" />
              )}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
