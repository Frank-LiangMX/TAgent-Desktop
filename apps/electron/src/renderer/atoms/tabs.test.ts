import { describe, expect, test } from 'vitest'

import {
  closeTab,
  MAX_SESSION_TABS,
  openTab,
  openTabWithLimit,
  trimTabsToLimit,
  type TabItem,
} from './tabs'

describe('session tabs', () => {
  test('stores the workspace id when a session tab is opened', () => {
    const result = openTab([], 'session-1', 'First session', 'workspace-a')

    expect(result.activeTabId).toBe('session-1')
    expect(result.tabs).toEqual([
      {
        id: 'session-1',
        sessionId: 'session-1',
        title: 'First session',
        workspaceId: 'workspace-a',
      },
    ])
  })

  test('keeps the existing workspace id when reopening without one', () => {
    const tabs: TabItem[] = [
      {
        id: 'session-1',
        sessionId: 'session-1',
        title: 'Old title',
        workspaceId: 'workspace-a',
      },
    ]

    const result = openTab(tabs, 'session-1', 'Updated title')

    expect(result.tabs).toHaveLength(1)
    expect(result.tabs[0]).toMatchObject({
      title: 'Updated title',
      workspaceId: 'workspace-a',
    })
  })

  test('accepts an explicit workspace correction when reopening a tab', () => {
    const tabs: TabItem[] = [
      {
        id: 'session-1',
        sessionId: 'session-1',
        title: 'Session',
        workspaceId: 'workspace-a',
      },
    ]

    const result = openTab(tabs, 'session-1', 'Session', 'workspace-b')

    expect(result.tabs[0]?.workspaceId).toBe('workspace-b')
  })

  test('carries persisted channel and model bindings into the tab', () => {
    const result = openTab(
      [],
      'session-1',
      'Bound session',
      'workspace-a',
      'channel-a',
      'model-a',
    )

    expect(result.tabs[0]).toMatchObject({
      channelId: 'channel-a',
      modelId: 'model-a',
    })
  })

  test('closing another tab does not alter remaining workspace ownership', () => {
    const tabs: TabItem[] = [
      {
        id: 'session-1',
        sessionId: 'session-1',
        title: 'First',
        workspaceId: 'workspace-a',
      },
      {
        id: 'session-2',
        sessionId: 'session-2',
        title: 'Second',
        workspaceId: 'workspace-b',
      },
    ]

    const result = closeTab(tabs, 'session-2', 'session-1')

    expect(result.activeTabId).toBe('session-2')
    expect(result.tabs).toEqual([tabs[1]])
  })

  test('replaces the earliest non-running tab after reaching the tab limit', () => {
    const tabs: TabItem[] = Array.from({ length: MAX_SESSION_TABS }, (_, index) => ({
      id: `session-${index + 1}`,
      sessionId: `session-${index + 1}`,
      title: `Session ${index + 1}`,
    }))

    const result = openTabWithLimit(
      tabs,
      'session-5',
      'Session 5',
      (sessionId) => sessionId === 'session-1' || sessionId === 'session-3',
    )

    expect(result.blocked).toBe(false)
    expect(result.evictedTab?.id).toBe('session-2')
    expect(result.tabs.map((tab) => tab.id)).toEqual([
      'session-1',
      'session-3',
      'session-4',
      'session-5',
    ])
    expect(result.activeTabId).toBe('session-5')
  })

  test('does not replace a tab when every open tab is running', () => {
    const tabs: TabItem[] = Array.from({ length: MAX_SESSION_TABS }, (_, index) => ({
      id: `session-${index + 1}`,
      sessionId: `session-${index + 1}`,
      title: `Session ${index + 1}`,
    }))

    const result = openTabWithLimit(tabs, 'session-5', 'Session 5', () => true)

    expect(result).toMatchObject({ tabs, activeTabId: null, blocked: true })
    expect(result.evictedTab).toBeUndefined()
  })

  test('trims historical overflow without stopping running tabs', () => {
    const tabs: TabItem[] = Array.from({ length: MAX_SESSION_TABS + 2 }, (_, index) => ({
      id: `session-${index + 1}`,
      sessionId: `session-${index + 1}`,
      title: `Session ${index + 1}`,
    }))

    const result = trimTabsToLimit(
      tabs,
      (sessionId) => sessionId === 'session-1' || sessionId === 'session-4',
    )

    expect(result.tabs.map((tab) => tab.id)).toEqual([
      'session-1',
      'session-4',
      'session-5',
      'session-6',
    ])
    expect(result.evictedTabs.map((tab) => tab.id)).toEqual(['session-2', 'session-3'])
  })
})
