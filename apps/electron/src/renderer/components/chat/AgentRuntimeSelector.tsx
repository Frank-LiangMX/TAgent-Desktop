/**
 * AgentRuntimeSelector — 输入区**独立**的「主 Agent」内核选择器。
 *
 * 与模型选择器分离：模型只在当前内核支持的渠道里选，内核本身是一个显式动作。
 * - 草稿会话：只改本地选择，首条消息发送时物化（不需要持久化切换 API）
 * - 已物化会话：走事务性 `switchSessionRuntime`（忙时要求先停止；失败保持原选择）
 *
 * 三内核（ADR-0012）：Pi / Codex / Claude Code。
 * 目标内核没有可用渠道时仍允许点击，由切换流程给出配置提示，绝不静默换用其它内核；
 * 内部 backend 细节（codex-app-server / kscc）仍由 Chat 通过既有 meta 通道同步。
 */
import { useState } from 'react'
import {
  Braces,
  Check,
  ChevronDown,
  Cloud,
  Download,
  LoaderCircle,
  SquareTerminal,
} from 'lucide-react'
import {
  AppTooltip,
  MenuPopoverItem,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@tagent/ui'
import type { AgentRuntimeKind, Channel, CodexRuntimeStatus } from '@tagent/shared'
import { cn } from '../../lib/utils'
import {
  AGENT_RUNTIME_DESCRIPTIONS,
  AGENT_RUNTIME_LABELS,
  AGENT_RUNTIME_ORDER,
  isRuntimeAvailable,
  isLegacyChannelForRuntime,
} from '../../atoms/agent-runtime'

const RUNTIME_ICONS: Record<AgentRuntimeKind, typeof Cloud> = {
  pi: Cloud,
  codex: Braces,
  'claude-code': SquareTerminal,
}

export interface AgentRuntimeSelectorProps {
  /** 当前生效内核；渠道缺失等情况下为 null（触发器显示「未选择」） */
  runtime: AgentRuntimeKind | null
  channels: Channel[]
  /** 切换在途：禁用入口并显示转圈（调用方同时禁用发送） */
  pending?: boolean
  /** 会话运行中：本切片要求用户先停止本轮 */
  busy?: boolean
  onSelect: (runtime: AgentRuntimeKind) => void
  codexRuntimeStatus?: CodexRuntimeStatus | null
  codexRuntimeInstalling?: boolean
  onInstallCodexRuntime?: () => void | Promise<void>
  /** 草稿会话：切换只改本地，首条消息发送时生效 */
  draft?: boolean
  /** 窄栏：触发器只留图标 */
  compact?: boolean
  disabled?: boolean
}

export function AgentRuntimeSelector({
  runtime,
  channels,
  pending,
  busy,
  onSelect,
  codexRuntimeStatus,
  codexRuntimeInstalling,
  onInstallCodexRuntime,
  draft,
  compact,
  disabled,
}: AgentRuntimeSelectorProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const TriggerIcon = runtime ? RUNTIME_ICONS[runtime] : Cloud
  const currentAvailable = runtime
    ? isRuntimeAvailable(channels, runtime) || channels.some((channel) => isLegacyChannelForRuntime(channel, runtime))
    : false
  const piAvailable = isRuntimeAvailable(channels, 'pi')
  const locked = Boolean(disabled || pending || busy)

  const descriptionFor = (kind: AgentRuntimeKind): string => {
    if (kind === 'codex') {
      if (codexRuntimeStatus?.available) {
        const runtimeDescription = `App Server ${codexRuntimeStatus.version ?? ''} · ${
          codexRuntimeStatus.source === 'managed' ? 'TAgent 托管' : '本机安装'
        }`.trim()
        return isRuntimeAvailable(channels, 'codex')
          ? `${runtimeDescription} · API 协议自动适配`
          : runtimeDescription
      }
      if (codexRuntimeStatus) {
        return (
          (isRuntimeAvailable(channels, 'codex') ? '' : '未配置 Codex 渠道 · ') +
          (codexRuntimeStatus.reason || '未检测到可用的 Codex App Server')
        )
      }
      return '正在检测 App Server Runtime'
    }
    if (kind === 'pi') {
      return isRuntimeAvailable(channels, 'pi')
        ? AGENT_RUNTIME_DESCRIPTIONS.pi
        : '未配置可用的外部 API 渠道（设置 → 渠道）'
    }
    return isRuntimeAvailable(channels, 'claude-code')
      ? AGENT_RUNTIME_DESCRIPTIONS['claude-code']
      : '未配置可用的外部 API 渠道（协议由 TAgent 自动适配）'
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className="inline-flex h-7 shrink-0 items-center">
        <AppTooltip
          label={
            busy
              ? '运行中：请先停止当前回合再切换主 Agent'
              : `主 Agent：${runtime ? AGENT_RUNTIME_LABELS[runtime] : '未选择'}${
                  draft ? '（首条消息发送时生效）' : ''
                }`
          }
          side="top"
          multiline
        >
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              className={cn(
                'flex h-7 min-w-0 items-center gap-1.5 rounded-full px-2 text-xs transition-colors',
                'text-muted-foreground hover:bg-foreground/10 hover:text-foreground',
                open && 'bg-foreground/10 text-foreground',
                runtime && !currentAvailable && 'text-destructive',
              )}
              aria-label={`选择主 Agent：${runtime ? AGENT_RUNTIME_LABELS[runtime] : '未选择'}`}
            >
              {pending ? (
                <LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden />
              ) : (
                <TriggerIcon className="size-3.5 shrink-0" aria-hidden />
              )}
              {!compact ? (
                <span className="min-w-0 truncate font-medium text-foreground/85">
                  {runtime ? AGENT_RUNTIME_LABELS[runtime] : '选择 Agent'}
                </span>
              ) : null}
              <ChevronDown className="size-3 shrink-0 opacity-70" aria-hidden />
            </button>
          </PopoverTrigger>
        </AppTooltip>
      </div>

      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-[268px] p-1.5"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="px-2 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          主 Agent
        </div>

        {AGENT_RUNTIME_ORDER.map((kind) => {
          const Icon = RUNTIME_ICONS[kind]
          const selected = runtime === kind
          return (
            <MenuPopoverItem
              key={kind}
              icon={kind === 'codex' && codexRuntimeInstalling
                ? <LoaderCircle className="size-3.5 animate-spin" />
                : <Icon className="size-3.5" />}
              label={AGENT_RUNTIME_LABELS[kind]}
              description={descriptionFor(kind)}
              selected={selected}
              disabled={locked}
              trailing={
                selected ? (
                  <Check className="size-3.5 text-primary" strokeWidth={2.5} />
                ) : null
              }
              onClick={() => {
                setOpen(false)
                onSelect(kind)
              }}
            />
          )
        })}

        {codexRuntimeStatus &&
        !codexRuntimeStatus.available &&
        codexRuntimeStatus.managedInstallSupported ? (
          <MenuPopoverItem
            icon={
              codexRuntimeInstalling ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <Download className="size-3.5" />
              )
            }
            label={codexRuntimeInstalling ? '正在安装 Codex Runtime' : '安装 Codex Runtime'}
            description={`官方 ${codexRuntimeStatus.managedVersion ?? ''} · 约 ${Math.ceil(
              (codexRuntimeStatus.managedDownloadBytes ?? 0) / 1024 / 1024,
            )} MB`}
            disabled={codexRuntimeInstalling}
            onClick={() => {
              void onInstallCodexRuntime?.()
            }}
          />
        ) : null}

        <div className="mx-1 my-1 h-px bg-border/40" />

        <div className="px-2 pb-1.5 text-[10.5px] leading-snug text-muted-foreground">
          {busy
            ? '当前回合运行中：请先停止，再切换主 Agent。'
            : draft
              ? '草稿会话：切换只改本地选择，首条消息发送时生效。'
              : '切换后从下一条消息起交给新内核，并带上最近可见对话的节选（不是完整迁移）。'}
        </div>
        {!piAvailable ? (
          <div className="px-2 pb-1 text-[10.5px] leading-snug text-amber-700/90 dark:text-amber-400/90">
            未检测到可用的外部 API 渠道，Pi 暂不可用；请先在「设置 → 渠道」配置 API 渠道，或用本选择器
            显式选择 Codex / Claude Code。TAgent 不会自动改用其它内核。
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
