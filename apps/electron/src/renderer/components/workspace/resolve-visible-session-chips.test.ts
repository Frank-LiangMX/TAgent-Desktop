import { describe, expect, it } from 'vitest'
import { resolveVisibleSessionChips } from './resolve-visible-session-chips'

const tabs = [
  { id: 'a', sessionId: 'a', title: '会话 A' },
  { id: 'b', sessionId: 'b', title: '会话 B（出错）' },
]

describe('resolveVisibleSessionChips', () => {
  it('非分屏：只保留当前激活 tab，后台 tab 不登顶', () => {
    const chips = resolveVisibleSessionChips({
      splitDockMode: false,
      visibleSessions: [],
      openTabs: tabs,
      activeTabId: 'a',
      activeSessionId: 'a',
    })
    expect(chips).toEqual([{ id: 'a', sessionId: 'a', title: '会话 A' }])
  })

  it('非分屏：activeTabId 缺失时回退 activeSessionId', () => {
    const chips = resolveVisibleSessionChips({
      splitDockMode: false,
      visibleSessions: [],
      openTabs: tabs,
      activeTabId: null,
      activeSessionId: 'b',
    })
    expect(chips).toEqual([{ id: 'b', sessionId: 'b', title: '会话 B（出错）' }])
  })

  it('分屏：按 visibleSessions，可多芯片', () => {
    const chips = resolveVisibleSessionChips({
      splitDockMode: true,
      visibleSessions: [
        { sessionId: 'a', title: '面板 A' },
        { sessionId: 'b', title: '面板 B' },
      ],
      openTabs: tabs,
      activeTabId: 'a',
      activeSessionId: 'a',
    })
    expect(chips).toEqual([
      { id: 'a', sessionId: 'a', title: '会话 A' },
      { id: 'b', sessionId: 'b', title: '会话 B（出错）' },
    ])
  })

  it('无可见会话 → 空列表', () => {
    expect(
      resolveVisibleSessionChips({
        splitDockMode: false,
        visibleSessions: [],
        openTabs: tabs,
        activeTabId: null,
        activeSessionId: null,
      }),
    ).toEqual([])
  })
})
