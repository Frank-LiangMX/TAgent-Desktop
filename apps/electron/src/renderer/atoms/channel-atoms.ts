/**
 * 渠道状态（Jotai）
 *
 * 跨组件共享：设置页渠道管理 + App/Chat（显示/选择当前渠道）。
 * 用 Jotai 默认 store（无需 Provider），与项目约定一致（CLAUDE.md：状态管理用 Jotai）。
 */
import { atom } from 'jotai'
import type { Channel } from '@tagent/shared'
import {
  resolveModelSelection,
  type ModelSelection,
} from './model-selection'

/** kscc provider 标识（按 provider 识别 kscc，兼容 TAgent_General 用随机 UUID id 的情况） */
const KSCC_PROVIDER = 'kscc-internal'

/** 渠道列表（主进程读，apiKey 加密） */
export const channelsAtom = atom<Channel[]>([])

/** 当前选中渠道 ID（新会话用；默认 kscc-internal） */
export const selectedModelSelectionAtom = atom<ModelSelection | null>(null)

/** 兼容只消费渠道 ID 的旧调用；写入渠道时自动选择其默认/首个启用模型 */
export const selectedChannelIdAtom = atom(
  (get) => get(selectedModelSelectionAtom)?.channelId ?? null,
  (get, set, channelId: string | null) => {
    if (!channelId) {
      set(selectedModelSelectionAtom, null)
      return
    }
    const current = get(selectedModelSelectionAtom)
    const list = get(channelsAtom)
    const next = resolveModelSelection(
      list.filter((channel) => channel.id === channelId),
      current?.channelId === channelId ? current : null,
    )
    set(selectedModelSelectionAtom, next)
  },
)

/** kscc 内置渠道（派生，按 provider 识别） */
export const ksccChannelAtom = atom<Channel | undefined>((get) =>
  get(channelsAtom).find((c) => c.provider === KSCC_PROVIDER)
)

/** 外部渠道列表（派生，排除 kscc-internal） */
export const externalChannelsAtom = atom<Channel[]>((get) =>
  get(channelsAtom).filter((c) => c.provider !== KSCC_PROVIDER)
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
