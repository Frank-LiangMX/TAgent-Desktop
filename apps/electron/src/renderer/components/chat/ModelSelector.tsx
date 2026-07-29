/**
 * 输入框尾部的渠道 / 模型组合选择器。
 *
 * KSCC 内网与外部渠道是两套运行内核。首条消息发送后只锁定运行内核，
 * 同一内核内的渠道和模型仍可在后续轮次自由切换。
 */
import { useState } from 'react'
import { useAtomValue } from 'jotai'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@tagent/ui'
import { Check, ChevronDown, Cpu, Network, ShieldCheck, TriangleAlert } from 'lucide-react'
import { PROVIDER_LABELS, type Channel } from '@tagent/shared'
import { cn } from '../../lib/utils'
import { channelsAtom } from '../../atoms/channel-atoms'
import {
  getChannelCoreKind,
  type ChannelCoreKind,
  type ModelSelection,
} from '../../atoms/model-selection'

interface ModelSelectorProps {
  selection: ModelSelection | null
  lockedKind: ChannelCoreKind | null
  onSelect: (selection: ModelSelection) => void
}

interface ChannelGroup {
  channel: Channel
  models: Channel['models']
}

export function ModelSelector({
  selection,
  lockedKind,
  onSelect,
}: ModelSelectorProps): JSX.Element {
  const channels = useAtomValue(channelsAtom)
  const [open, setOpen] = useState(false)
  const activeChannel = channels.find((channel) => channel.id === selection?.channelId)
  const activeModel = activeChannel?.models.find((model) => model.id === selection?.modelId)
  const activeAvailable = Boolean(activeChannel?.enabled && activeModel?.enabled)
  const groups = channels
    .filter((channel) => (
      channel.enabled
      && (!lockedKind || getChannelCoreKind(channel) === lockedKind)
    ))
    .map((channel) => ({
      channel,
      models: channel.models.filter((model) => model.enabled),
    }))
    .filter((group) => group.models.length > 0)
  const allInternalGroups = groups.filter(({ channel }) => getChannelCoreKind(channel) === 'kscc')
  // 历史版本可能遗留多个 kscc-internal 记录。它们属于同一个内网运行时，
  // 选择器只展示一组；旧会话优先沿用自己记录的 channelId，避免兼容数据重复露出。
  const activeInternalGroup = activeChannel?.provider === 'kscc-internal'
    ? allInternalGroups.find(({ channel }) => channel.id === activeChannel.id)
    : undefined
  const internalGroups = (activeInternalGroup ?? allInternalGroups[0])
    ? [activeInternalGroup ?? allInternalGroups[0]!]
    : []
  const externalGroups = groups.filter(({ channel }) => getChannelCoreKind(channel) === 'external')

  const renderGroups = (items: ChannelGroup[]): JSX.Element[] => items.map(({ channel, models }) => (
    <CommandGroup
      key={channel.id}
      heading={lockedKind ? channel.name : `${channel.name} · ${PROVIDER_LABELS[channel.provider]}`}
    >
      {models.map((model) => {
        const selected = selection?.channelId === channel.id && selection.modelId === model.id
        return (
          <CommandItem
            key={`${channel.id}:${model.id}`}
            value={`${channel.id} ${channel.name} ${PROVIDER_LABELS[channel.provider]} ${model.name} ${model.id}`}
            className="rounded-glass-popover py-2"
            onSelect={() => {
              onSelect({ channelId: channel.id, modelId: model.id })
              setOpen(false)
            }}
          >
            <Cpu className="text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-xs font-medium">{model.name}</span>
                {channel.defaultModelId === model.id && (
                  <span className="shrink-0 text-[9px] text-muted-foreground">默认</span>
                )}
              </div>
              {model.name !== model.id && (
                <div className="truncate text-[10px] text-muted-foreground">{model.id}</div>
              )}
            </div>
            {selected && <Check className="shrink-0 text-primary" />}
          </CommandItem>
        )
      })}
    </CommandGroup>
  ))

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex min-w-0 max-w-[290px] items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition-colors',
            'text-muted-foreground hover:bg-accent hover:text-foreground',
            !activeAvailable && selection && 'text-destructive',
          )}
          aria-label="选择模型"
        >
          {!activeAvailable && selection
            ? <TriangleAlert className="size-3.5 shrink-0" />
            : <Cpu className="size-3.5 shrink-0" />}
          <span className="min-w-0 truncate font-medium text-foreground/85">
            {activeModel?.name || selection?.modelId || '选择模型'}
          </span>
          {activeChannel && (
            <span className="min-w-0 truncate text-[10px] text-foreground/40">
              · {activeChannel.name}
            </span>
          )}
          <ChevronDown className="size-3 shrink-0 opacity-70" />
        </button>
      </PopoverTrigger>

      <PopoverContent align="start" side="top" className="w-[360px] overflow-hidden p-0">
        <Command>
          {lockedKind && (
            <div className="flex items-start gap-2.5 border-b border-border/55 bg-muted/20 px-3 py-2.5">
              <div className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-primary/8 text-primary">
                <ShieldCheck className="size-3.5" />
              </div>
              <div className="min-w-0">
                <div className="text-xs font-medium text-foreground">
                  已锁定{lockedKind === 'kscc' ? '内网运行时' : '外部运行时'}
                </div>
                <p className="mt-0.5 text-[10.5px] leading-relaxed text-muted-foreground">
                  运行内核保持不变，此区域内的模型{lockedKind === 'external' ? '和渠道' : ''}仍可随时切换。
                </p>
              </div>
            </div>
          )}
          <CommandInput placeholder="搜索模型或渠道…" />
          <CommandList className="scrollbar-thin max-h-[340px]">
            <CommandEmpty>
              {groups.length === 0 ? '此运行区域没有已启用的模型' : '没有匹配的模型'}
            </CommandEmpty>

            {internalGroups.length > 0 && (
              <div>
                <div className="flex items-center gap-2 px-3 pb-1 pt-2.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">
                  <ShieldCheck className="size-3" />
                  内网服务
                </div>
                {renderGroups(internalGroups)}
              </div>
            )}

            {internalGroups.length > 0 && externalGroups.length > 0 && (
              <CommandSeparator className="mx-2" />
            )}

            {externalGroups.length > 0 && (
              <div>
                <div className="flex items-center gap-2 px-3 pb-1 pt-2.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">
                  <Network className="size-3" />
                  外部服务
                </div>
                {renderGroups(externalGroups)}
              </div>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
