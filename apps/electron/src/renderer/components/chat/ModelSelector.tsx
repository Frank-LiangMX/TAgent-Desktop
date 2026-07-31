/**
 * 输入框尾部的渠道 / 模型组合选择器。
 *
 * KSCC 内网与外部渠道是两套运行内核。首条消息发送后只锁定运行内核，
 * 同一内核内的渠道和模型仍可在后续轮次自由切换。
 *
 * 布局对齐 TAgent_General AgentModelSelector：当前模型头图 header +
 * 按渠道分组紧凑列表（每项带模型 logo）。材质用本项目 session-glass-popover /
 * session-list-row / session-glass-chip，不搬 General 的 token 体系。
 */
import { useMemo, useState } from 'react'
import { useAtomValue } from 'jotai'
import { ChevronDown, Cpu, Network, ShieldCheck, TriangleAlert } from 'lucide-react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  MenuPopoverItem,
  MenuPopoverGroup,
  MenuPopoverSectionLabel,
  MenuPopoverSeparator,
} from '@tagent/ui'
import { type Channel, PROVIDER_LABELS } from '@tagent/shared'
import { cn } from '../../lib/utils'
import { channelsAtom } from '../../atoms/channel-atoms'
import {
  getChannelCoreKind,
  type ChannelCoreKind,
  type ModelSelection,
} from '../../atoms/model-selection'
import { getModelLogo, getChannelLogo } from '../../lib/model-logo'

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

  const totalAvailable = useMemo(
    () => internalGroups.concat(externalGroups).reduce((sum, g) => sum + g.models.length, 0),
    [internalGroups, externalGroups],
  )

  const renderGroups = (items: ChannelGroup[]): JSX.Element[] => items.map(({ channel, models }) => (
    <MenuPopoverGroup
      key={channel.id}
      heading={
        <>
          <img
            src={getChannelLogo(channel)}
            alt={channel.name}
            className="size-5 shrink-0 rounded-md object-cover"
          />
          <span className="truncate text-[11px] font-medium text-foreground/70">
            {lockedKind ? channel.name : `${channel.name} · ${PROVIDER_LABELS[channel.provider]}`}
          </span>
        </>
      }
    >
      {models.map((model) => {
        const selected = selection?.channelId === channel.id && selection.modelId === model.id
        const isDefault = channel.defaultModelId === model.id
        return (
          <MenuPopoverItem
            key={`${channel.id}:${model.id}`}
            selected={selected}
            icon={
              <img
                src={getModelLogo(model.id, channel.provider)}
                alt={model.name}
                className="size-4 rounded object-cover"
              />
            }
            label={model.name}
            trailing={isDefault && (
              <span className="session-glass-chip ml-1 px-1.5 py-0.5 text-[9.5px] font-medium text-muted-foreground">
                默认
              </span>
            )}
            onClick={() => {
              onSelect({ channelId: channel.id, modelId: model.id })
              setOpen(false)
            }}
          />
        )
      })}
    </MenuPopoverGroup>
  ))

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex min-w-0 max-w-[150px] items-center gap-1.5 rounded-full px-2 py-1 text-xs transition-colors',
            'text-muted-foreground hover:bg-foreground/10 hover:text-foreground',
            !activeAvailable && selection && 'text-destructive',
          )}
          aria-label="选择模型"
        >
          {/* 触发器：模型 logo + 名称（渠道名收进弹窗，触发器只留模型名，省空间） */}
          {activeAvailable && activeModel ? (
            <img
              src={getModelLogo(activeModel.id, activeChannel!.provider)}
              alt={activeModel.name}
              className="size-4 shrink-0 rounded object-cover"
            />
          ) : !activeAvailable && selection ? (
            <TriangleAlert className="size-3.5 shrink-0" />
          ) : (
            <Cpu className="size-3.5 shrink-0" />
          )}
          <span className="min-w-0 truncate font-medium text-foreground/85">
            {activeModel?.name || selection?.modelId || '选择模型'}
          </span>
          <ChevronDown className="size-3 shrink-0 opacity-70" />
        </button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        side="top"
        sideOffset={8}
        className="w-[320px] overflow-hidden p-0"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {/* 当前模型 header：大头图 + 名称 + 渠道 + 可用数 chip */}
        <div className="px-3.5 pt-3 pb-2.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[11px] font-medium text-muted-foreground">当前模型</div>
              <div className="mt-1.5 flex min-w-0 items-center gap-2.5">
                {activeAvailable && activeModel ? (
                  <img
                    src={getModelLogo(activeModel.id, activeChannel!.provider)}
                    alt={activeModel.name}
                    className="size-7 shrink-0 rounded-lg object-cover"
                  />
                ) : (
                  <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-foreground/8">
                    <Cpu className="size-3.5 text-muted-foreground" />
                  </div>
                )}
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-foreground">
                    {activeModel?.name || selection?.modelId || '未选择模型'}
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {activeChannel?.name || '选择一个可用渠道模型'}
                  </div>
                </div>
              </div>
            </div>
            <span className="session-glass-chip shrink-0 px-2 py-0.5 text-[10px] text-muted-foreground">
              {totalAvailable} 个可用
            </span>
          </div>
        </div>

        {/* 锁定提示（已绑定运行内核时） */}
        {lockedKind && (
          <div className="mx-3 mb-1 flex items-start gap-2 rounded-lg bg-primary/8 px-2.5 py-2 text-foreground/80">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-primary" />
            <p className="text-[10.5px] leading-relaxed">
              已锁定{lockedKind === 'kscc' ? '内网' : '外部'}运行时，此区域内的模型
              {lockedKind === 'external' ? '和渠道' : ''}仍可随时切换。
            </p>
          </div>
        )}

        {/* 分隔线 */}
        <MenuPopoverSeparator />

        <div className="px-3.5 pb-1 pt-2">
          <div className="text-[11px] font-medium text-muted-foreground">可选模型</div>
        </div>

        {/* 分组列表 */}
        <div className="scrollbar-thin max-h-[280px] overflow-y-auto px-2 pb-2">
          {totalAvailable === 0 ? (
            <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">
              此运行区域没有已启用的模型
            </div>
          ) : (
            <>
              {internalGroups.length > 0 && (
                <div>
                  <MenuPopoverSectionLabel icon={<ShieldCheck className="size-3" />}>
                    内网服务
                  </MenuPopoverSectionLabel>
                  {renderGroups(internalGroups)}
                </div>
              )}

              {internalGroups.length > 0 && externalGroups.length > 0 && (
                <div className="mx-2 my-1.5 h-px bg-border/40" />
              )}

              {externalGroups.length > 0 && (
                <div>
                  <MenuPopoverSectionLabel icon={<Network className="size-3" />}>
                    外部服务
                  </MenuPopoverSectionLabel>
                  {renderGroups(externalGroups)}
                </div>
              )}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
