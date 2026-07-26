/**
 * TabBar — 会话标签栏（多会话 tab，顶对齐 rail/sidebar）
 *
 * 选中态用滑动底板（active-plate）：绝对定位在 tab 列后，JS 测 active tab 位置
 * 驱动 transform 平滑滑动（对齐 TAgent_General updateActivePlate）。
 * tab 本身选中时透明，只 primary 文字/icon；底板显玻璃填充。
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useRef } from 'react'
import { TabBarItem } from './TabBarItem'
import {
  tabsAtom,
  activeTabIdAtom,
  closeTab,
  type TabItem,
} from '../../atoms/tabs'

interface TabBarProps {
  runningSessionIds?: Set<string>
}

export function TabBar({ runningSessionIds }: TabBarProps): JSX.Element | null {
  const tabs = useAtomValue(tabsAtom)
  const activeTabId = useAtomValue(activeTabIdAtom)
  const setTabs = useSetAtom(tabsAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)

  const listRef = useRef<HTMLDivElement>(null)
  const plateRef = useRef<HTMLDivElement>(null)

  // 测 active tab 位置，驱动 plate 滑动
  useEffect(() => {
    const list = listRef.current
    const plate = plateRef.current
    if (!list || !plate) return

    const update = (): void => {
      const active = list.querySelector<HTMLElement>('[data-active]')
      if (!active) {
        plate.style.opacity = '0'
        return
      }
      plate.style.opacity = '1'
      plate.style.width = `${active.offsetWidth}px`
      plate.style.transform = `translateX(${active.offsetLeft}px)`
    }

    update()
    // tab 列变化/active 变化时重测；ResizeObserver 抓容器尺寸变化
    const ro = new ResizeObserver(update)
    ro.observe(list)
    return () => ro.disconnect()
  }, [tabs, activeTabId])

  if (tabs.length === 0) return null

  const handleClose = (tab: TabItem): void => {
    const { tabs: next, activeTabId: nextActive } = closeTab(tabs, activeTabId, tab.id)
    setTabs(next)
    setActiveTabId(nextActive)
  }

  return (
    <div className="app-workspace-tab-strip titlebar-drag-region shrink-0">
      <div ref={listRef} role="tablist" className="app-workspace-tab-list titlebar-no-drag">
        {/* 滑动底板：绝对定位在 tab 列后，opacity/width/transform 由 JS 驱动 */}
        <div ref={plateRef} className="app-workspace-tab-active-plate" />
        {tabs.map((tab) => (
          <TabBarItem
            key={tab.id}
            tab={tab}
            active={tab.id === activeTabId}
            running={runningSessionIds?.has(tab.sessionId)}
            onActivate={() => setActiveTabId(tab.id)}
            onClose={() => handleClose(tab)}
          />
        ))}
      </div>
    </div>
  )
}
