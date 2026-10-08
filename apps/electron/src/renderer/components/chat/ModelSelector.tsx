/**
 * 输入框尾部的渠道 / 模型组合选择器。
 *
 * 运行时与外部 API 渠道是独立概念。首条消息发送后只锁定运行内核，
 * 同一内核内的渠道和模型仍可在后续轮次自由切换。
 *
 * 布局对齐 TAgent_General AgentModelSelector：当前模型头图 header +
 * 按渠道分组紧凑列表（每项带模型 logo）。材质用本项目 session-glass-popover /
 * session-list-row / session-glass-chip，不搬 General 的 token 体系。
 */
import { useMemo, useState } from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { ChevronDown, Cpu, HelpCircle, Network, ShieldCheck, TriangleAlert, Users } from 'lucide-react'
import {
  AppTooltip,
  Popover,
  PopoverContent,
  PopoverTrigger,
  MenuPopoverItem,
  MenuPopoverGroup,
  MenuPopoverSectionLabel,
  SegmentedTabs,
  SegmentedTabsItem,
} from '@tagent/ui'
import {
  type AgentRuntimeKind,
  type Channel,
  type ReasoningEffort,
  PROVIDER_LABELS,
  isMoaModelId,
} from '@tagent/shared'
import { cn } from '../../lib/utils'
import { channelsAtom } from '../../atoms/channel-atoms'
import { type ModelSelection } from '../../atoms/model-selection'
import {
  AGENT_RUNTIME_LABELS,
  channelAcceptsRuntime,
  isLegacyChannelForRuntime,
} from '../../atoms/agent-runtime'
import { getModelLogo, getChannelLogo } from '../../lib/model-logo'
import {
  chatProcessDisplayModeAtom,
  type ChatProcessDisplayMode,
} from '../../atoms/chat-display-prefs'
import { ReasoningSlider, REASONING_LABELS } from './ReasoningSlider'

/** 默认档，触发器上不回显（安全默认不占视觉带宽） */
const REASONING_DEFAULT: ReasoningEffort = 'medium'

interface ModelSelectorProps {
  selection: ModelSelection | null
  /**
   * 当前生效的运行内核：只列出该内核**实际承载**的渠道模型。
   * 换内核必须走独立的 AgentRuntimeSelector（事务性切换），不在这里混选。
   */
  runtime?: AgentRuntimeKind | null
  onSelect: (selection: ModelSelection) => void
  reasoningEffort?: ReasoningEffort
  onReasoningEffortChange?: (effort: ReasoningEffort) => void
  /** 运行内核切换在途：锁住模型选择，避免并发改动绑定 */
  disabled?: boolean
}

interface ChannelGroup {
  channel: Channel
  models: Channel['models']
}

export function ModelSelector({
  selection,
  runtime,
  onSelect,
  reasoningEffort,
  onReasoningEffortChange,
  disabled,
}: ModelSelectorProps): JSX.Element {
  const channels = useAtomValue(channelsAtom)
  const [processDisplayMode, setProcessDisplayMode] = useAtom(chatProcessDisplayModeAtom)
  const [open, setOpen] = useState(false)
  const activeChannel = channels.find((channel) => channel.id === selection?.channelId)
  const activeModel = activeChannel?.models.find((model) => model.id === selection?.modelId)
  /** 旧会话可能仍粘着 moa:*；会诊入口已迁到发送键旁 ▾，选择器不再提供预置 */
  const isMoaSelection = isMoaModelId(selection?.modelId)
  const activeAvailable = isMoaSelection
    ? false
    : Boolean(activeChannel?.enabled && activeModel?.enabled)
  const groups = channels
    .filter((channel) => (
      channel.enabled
      // runtime === null：会话还没有生效内核 → 不给任何模型，
      // 先让用户在 Agent 选择器里做一次显式选择（否则等于绕过内核事务）
      && runtime !== null
      && (runtime === undefined
        || channelAcceptsRuntime(channel, runtime)
        || (channel.id === selection?.channelId && isLegacyChannelForRuntime(channel, runtime)))
    ))
    .map((channel) => ({
      channel,
      models: channel.models.filter((model) => model.enabled),
    }))
    .filter((group) => group.models.length > 0)
  // Official runtimes only expose API channels. A legacy session may still
  // display its already-bound local channel, but it is never offered as a new
  // choice and is kept in its own compatibility section. This matters for old
  // Codex sessions, whose channel is `codex-internal` but whose runtime is no
  // longer represented by the old KSCC core region.
  const legacyGroups = groups.filter(({ channel }) =>
    channel.id === selection?.channelId &&
    (channel.provider === 'kscc-internal' || channel.provider === 'codex-internal'),
  )
  // 历史本机 kscc 渠道已停用：不再作为可选内核分组（仅 legacySection 中的已绑定渠道回显）。
  const internalGroups: typeof groups = []
  const externalGroups = groups.filter(({ channel }) =>
    channel.provider !== 'kscc-internal' && channel.provider !== 'codex-internal',
  )

  const totalAvailable = useMemo(
    () => legacyGroups.concat(internalGroups, externalGroups).reduce((sum, g) => sum + g.models.length, 0),
    [legacyGroups, internalGroups, externalGroups],
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
            {runtime ? channel.name : `${channel.name} · ${PROVIDER_LABELS[channel.provider]}`}
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
          disabled={disabled}
          className={cn(
            'flex min-w-0 max-w-[176px] items-center gap-1.5 rounded-full px-2 py-1 text-xs transition-colors',
            'text-muted-foreground hover:bg-foreground/10 hover:text-foreground',
            !activeAvailable && selection && 'text-destructive',
            disabled && 'pointer-events-none opacity-60',
          )}
          aria-label="选择模型"
        >
          {/* 触发器：模型 logo + 名称（渠道名收进弹窗，触发器只留模型名，省空间） */}
          {isMoaSelection ? (
            <Users className="size-3.5 shrink-0 text-primary/80" />
          ) : activeAvailable && activeModel ? (
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
            {isMoaSelection
              ? '请改选真实模型'
              : activeModel?.name || selection?.modelId || '选择模型'}
          </span>
          {/* 非默认档才回显，默认「均衡」保持触发器最短；会诊模式不适用思考强度 */}
          {!isMoaSelection && reasoningEffort && reasoningEffort !== REASONING_DEFAULT ? (
            <span className="model-selector__effort shrink-0 text-[10.5px] font-medium text-primary/80">
              {REASONING_LABELS[reasoningEffort]}
            </span>
          ) : null}
          <ChevronDown className="size-3 shrink-0 opacity-70" />
        </button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        side="top"
        sideOffset={8}
        collisionPadding={12}
        className="flex max-h-[var(--radix-popover-content-available-height)] w-[320px] flex-col overflow-hidden p-0"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {/* 当前模型 header：大头图 + 名称 + 渠道 + 可用数 chip */}
        <div className="px-3.5 pt-3 pb-2.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[11px] font-medium text-muted-foreground">当前模型</div>
              <div className="mt-1.5 flex min-w-0 items-center gap-2.5">
                {isMoaSelection ? (
                  <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                    <Users className="size-3.5 text-primary/80" />
                  </div>
                ) : activeAvailable && activeModel ? (
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
                    {isMoaSelection
                      ? '会诊已改为发送方式'
                      : activeModel?.name || selection?.modelId || '未选择模型'}
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {isMoaSelection
                      ? '请选下方真实模型；需要会诊时点发送旁 ▾'
                      : activeChannel?.name || '选择一个可用渠道模型'}
                  </div>
                </div>
              </div>
            </div>
            <span className="session-glass-chip shrink-0 px-2 py-0.5 text-[10px] text-muted-foreground">
              {totalAvailable} 个可用
            </span>
          </div>
        </div>

        {/* 思考强度：紧跟模型 header，不进下方滚动区，免得选完模型还得往回滚。
            会诊模式多模型会商汇总，不适用思考强度 → 隐藏滑块并说明。 */}
        {isMoaSelection ? (
          <div className="px-3.5 pb-3 text-[11px] leading-snug text-amber-700/90 dark:text-amber-400/90">
            会诊请点发送键旁 ▾ 选班底（仅本条）。请先选一个真实模型继续聊天。
          </div>
        ) : reasoningEffort && onReasoningEffortChange ? (
          <div className="px-3.5 pb-3">
            <div className="mb-2 text-[11px] font-medium text-muted-foreground">思考强度</div>
            <ReasoningSlider value={reasoningEffort} onChange={onReasoningEffortChange} />
          </div>
        ) : null}

        {/* 过程展示：与思考强度同区，全局偏好，不随会话切换 */}
        <div className="px-3.5 pb-3">
          <div className="mb-2 flex items-center gap-1">
            <span className="text-[11px] font-medium text-muted-foreground">过程展示</span>
            <AppTooltip
              label="完整＝实时展开思考链；简洁＝一行摘要，点开再看过程（类似 Cursor）。对所有会话生效。"
              side="top"
              multiline
            >
              <button
                type="button"
                className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:bg-foreground/10 hover:text-foreground"
                aria-label="过程展示说明"
                onClick={(e) => e.stopPropagation()}
              >
                <HelpCircle className="size-3.5" />
              </button>
            </AppTooltip>
          </div>
          <SegmentedTabs
            className="settings-segmented w-full"
            value={processDisplayMode}
            onValueChange={(v) => setProcessDisplayMode(v as ChatProcessDisplayMode)}
          >
            <SegmentedTabsItem value="concise">简洁</SegmentedTabsItem>
            <SegmentedTabsItem value="full">完整过程</SegmentedTabsItem>
          </SegmentedTabs>
        </div>

        {/* 分隔线（不用 MenuPopoverSeparator，避免 HMR/导出偶发未定义） */}
        <div className="mx-2 my-1 h-px bg-border/40" role="separator" />

        <div className="flex items-center gap-1 px-3.5 pb-1 pt-2">
          <span className="text-[11px] font-medium text-muted-foreground">可选模型</span>
          {/* 锁定提示收成问号：这段解释一次读懂即可，常驻一整块太占弹层高度 */}
          {runtime && (
            <AppTooltip
              label={`已锁定 ${AGENT_RUNTIME_LABELS[runtime]} 运行时的渠道模型，此区域内仍可随时切换模型。换主 Agent 请用输入区左侧的 Agent 选择器。`}
              side="top"
              multiline
            >
              <button
                type="button"
                className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:bg-foreground/10 hover:text-foreground"
                aria-label="为什么只有这些模型"
              >
                <HelpCircle className="size-3.5" />
              </button>
            </AppTooltip>
          )}
        </div>

        {/* 分组列表：唯一的滚动容器。外层只负责布局不滚，避免「列表滚到底
            再被外层接管」的双层滚动；min-h-0 是 flex 子项能真正滚动的前提。 */}
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {totalAvailable === 0 ? (
            <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">
              {runtime === null
                ? '还没有选定主 Agent：请先用左侧 Agent 选择器显式选择 Pi / Codex / Claude Code'
                : '该 Agent 下没有已启用的模型'}
            </div>
          ) : (
            <>
              {legacyGroups.length > 0 && (
                <div>
                  <MenuPopoverSectionLabel icon={<ShieldCheck className="size-3" />}>
                    历史绑定
                  </MenuPopoverSectionLabel>
                  {renderGroups(legacyGroups)}
                </div>
              )}

              {legacyGroups.length > 0 && (internalGroups.length > 0 || externalGroups.length > 0) && (
                <div className="mx-2 my-1.5 h-px bg-border/40" />
              )}

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
