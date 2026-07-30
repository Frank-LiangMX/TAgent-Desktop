/**
 * 多会话标签 state（精简版，对齐 TAgent_General tab-atoms 但砍掉屎山）
 *
 * tabs：打开的会话列表；activeTabId：当前激活 tab。
 * 一个会话一个 tab（id = sessionId，简化）。切 tab 用 Chat key=sessionId 重建。
 * 不做：mode 分桶/preview/draft/LRU/持久化（先内存态）。
 */
import { atom } from 'jotai'

export interface TabItem {
  /** tab id（= sessionId，简化） */
  id: string
  /** 会话 id */
  sessionId: string
  /** tab 标题（会话标题） */
  title: string
  /** 会话所属工作区；会话创建时确定，不依赖全局选择 */
  workspaceId?: string
  /** 已持久化会话绑定的渠道；新会话发送首条消息前为空 */
  channelId?: string
  /** 已持久化会话绑定的模型；新会话发送首条消息前为空 */
  modelId?: string
}

/** 打开的会话 tab 列表 */
export const tabsAtom = atom<TabItem[]>([])

/** 当前激活 tab id */
export const activeTabIdAtom = atom<string | null>(null)

/** 当前激活 tab 对象 */
export const activeTabAtom = atom<TabItem | null>((get) => {
  const id = get(activeTabIdAtom)
  const tabs = get(tabsAtom)
  return tabs.find((t) => t.id === id) ?? null
})

/**
 * 开 tab：已开则激活，未开追加 + 激活。返回新 { tabs, activeTabId }。
 */
export function openTab(
  tabs: TabItem[],
  sessionId: string,
  title: string,
  workspaceId?: string,
  channelId?: string,
  modelId?: string,
): { tabs: TabItem[]; activeTabId: string } {
  const existing = tabs.find((t) => t.sessionId === sessionId)
  if (existing) {
    // 已开：更新标题 + 激活
    const next = tabs.map((t) =>
      t.id === existing.id
        ? {
            ...t,
            title,
            workspaceId: workspaceId ?? t.workspaceId,
            channelId: channelId ?? t.channelId,
            modelId: modelId ?? t.modelId,
          }
        : t,
    )
    return { tabs: next, activeTabId: existing.id }
  }
  // 未开：追加 + 激活
  const newTab: TabItem = {
    id: sessionId,
    sessionId,
    title,
    workspaceId,
    ...(channelId ? { channelId } : {}),
    ...(modelId ? { modelId } : {}),
  }
  return { tabs: [...tabs, newTab], activeTabId: newTab.id }
}

/**
 * 关 tab：移除 + 激活相邻（优先右邻，否则左邻，否则 null）。
 */
export function closeTab(
  tabs: TabItem[],
  activeTabId: string | null,
  tabId: string
): { tabs: TabItem[]; activeTabId: string | null } {
  const idx = tabs.findIndex((t) => t.id === tabId)
  if (idx === -1) return { tabs, activeTabId }
  const next = tabs.filter((t) => t.id !== tabId)
  // 关的是激活 tab → 选相邻
  if (activeTabId === tabId) {
    const neighbor = next[idx] ?? next[idx - 1] ?? null
    return { tabs: next, activeTabId: neighbor?.id ?? null }
  }
  return { tabs: next, activeTabId }
}

/**
 * 首条消息发送时把草稿会话物化为真实 tab（append + 激活）。
 *
 * 与 openTab 的区别：草稿态（无 tab）才追加；已存在则只升级绑定字段 + 激活，
 * 不覆盖 title。对齐 codex：新会话页不占 tab，发送后才生成 tab。
 */
export function materializeTab(
  tabs: TabItem[],
  sessionId: string,
  title: string,
  workspaceId?: string,
  channelId?: string,
  modelId?: string,
): { tabs: TabItem[]; activeTabId: string } {
  const existing = tabs.find((t) => t.sessionId === sessionId)
  if (existing) {
    const next = tabs.map((t) =>
      t.id === existing.id
        ? {
            ...t,
            channelId: channelId ?? t.channelId,
            modelId: modelId ?? t.modelId,
            workspaceId: workspaceId ?? t.workspaceId,
          }
        : t,
    )
    return { tabs: next, activeTabId: existing.id }
  }
  const newTab: TabItem = {
    id: sessionId,
    sessionId,
    title,
    workspaceId,
    ...(channelId ? { channelId } : {}),
    ...(modelId ? { modelId } : {}),
  }
  return { tabs: [...tabs, newTab], activeTabId: newTab.id }
}
