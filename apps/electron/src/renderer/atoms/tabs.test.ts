import { describe, expect, test } from 'vitest'

import { closeTab, openTab, type TabItem } from './tabs'

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
})
