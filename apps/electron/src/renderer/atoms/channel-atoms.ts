/**
 * 渠道状态（Jotai）
 *
 * 跨组件共享：设置页渠道管理 + App/Chat（显示/选择当前渠道）。
 * 用 Jotai 默认 store（无需 Provider），与项目约定一致（CLAUDE.md：状态管理用 Jotai）。
 */
import { atom } from 'jotai'
import { isBuiltinChannelProvider, isGatewayProvider, resolveChannelDefaultModelId, type Channel } from '@tagent/shared'
import {
  resolveModelSelection,
  type ModelSelection,
} from './model-selection'

/** 内置网关渠道 provider 标识（按 provider 识别，兼容随机 UUID id 的情况） */
const GATEWAY_PROVIDER = 'kscc-gateway'

/** 渠道列表（主进程读，apiKey 加密） */
export const channelsAtom = atom<Channel[]>([])

/** 当前选中渠道 ID（新会话用） */
export const selectedModelSelectionAtom = atom<ModelSelection | null>(null)

/**
 * 兼容只消费渠道 ID 的旧调用；写入渠道时**以该渠道**的默认/首个启用模型为准。
 *
 * 注意：这里不用 `resolveModelSelection`——那套策略只回答「新会话默认跑什么」
 * （Pi 优先，无外部渠道即 null），会把显式写入的本机渠道清空。
 */
export const selectedChannelIdAtom = atom(
  (get) => get(selectedModelSelectionAtom)?.channelId ?? null,
  (get, set, channelId: string | null) => {
    if (!channelId) {
      set(selectedModelSelectionAtom, null)
      return
    }
    const current = get(selectedModelSelectionAtom)
    if (current?.channelId === channelId) return
    const channel = get(channelsAtom).find((item) => item.id === channelId)
    const modelId = resolveChannelDefaultModelId(channel)
    set(
      selectedModelSelectionAtom,
      modelId ? { channelId, modelId } : null,
    )
  },
)

/** 内置网关渠道（派生，按 provider 识别）；MoA 班底的「本机档」以此为准 */
export const gatewayChannelAtom = atom<Channel | undefined>((get) =>
  get(channelsAtom).find((c) => c.provider === GATEWAY_PROVIDER)
)

/** Codex 本机渠道（派生） */
export const codexChannelAtom = atom<Channel | undefined>((get) =>
  get(channelsAtom).find((c) => c.provider === 'codex-internal')
)

/**
 * 「内置服务」区块展示的渠道：仅内置网关渠道。
 *
 * legacy `kscc-internal`（CLI 通路已移除）与 `codex-internal` 都不在此列——
 * ADR-0012 明确「渠道页不再固定展示 Codex App Server 和 KSCC 卡片」。
 */
export const builtinChannelsAtom = atom<Channel[]>((get) =>
  get(channelsAtom).filter((c) => isGatewayProvider(c.provider))
)

/** 外部渠道列表（派生，排除内置渠道） */
export const externalChannelsAtom = atom<Channel[]>((get) =>
  get(channelsAtom).filter((c) => !isBuiltinChannelProvider(c.provider))
)

/** 当前选中渠道对象（派生） */
export const selectedChannelAtom = atom<Channel | undefined>((get) => {
  const id = get(selectedChannelIdAtom)
  const list = get(channelsAtom)
  return id ? list.find((c) => c.id === id) : undefined
})

/** 拉取渠道列表（write-only）；确保当前选择仍指向一个已启用渠道 */
export const loadChannelsAtom = atom(null, async (get, set) => {
  const list = await window.electronAPI.listChannels()
  set(channelsAtom, list)
  const selected = get(selectedModelSelectionAtom)
  set(selectedModelSelectionAtom, resolveModelSelection(list, selected))
})

/** 侧栏刷新触发计数（Chat 发完消息后 bump，Sidebar 监听刷新） */
export const sessionsRefreshAtom = atom(0)

/** bump 侧栏刷新（write-only） */
export const bumpSessionsRefreshAtom = atom(null, (get, set) => {
  set(sessionsRefreshAtom, get(sessionsRefreshAtom) + 1)
})
