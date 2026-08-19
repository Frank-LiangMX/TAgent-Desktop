import { describe, expect, test } from 'vitest'
import { isGroupHeaderDrag, pruneEmptyDockGroups } from './dock-dnd'

describe('dock-dnd', () => {
  test('无 panelId 视为标签栏整组拖', () => {
    expect(isGroupHeaderDrag(undefined)).toBe(true)
    expect(isGroupHeaderDrag({ panelId: null })).toBe(true)
    expect(isGroupHeaderDrag({ panelId: '' })).toBe(true)
    expect(isGroupHeaderDrag({ panelId: 'sess-1' })).toBe(false)
  })

  test('清掉空 group，全空时留一个', () => {
    const a = { size: 0 }
    const b = { size: 2 }
    const c = { size: 0 }
    const removed: unknown[] = []
    pruneEmptyDockGroups({
      groups: [a, b, c],
      removeGroup: (group) => {
        removed.push(group)
      },
    })
    expect(removed).toEqual([a, c])

    const only = { size: 0 }
    const kept: unknown[] = []
    pruneEmptyDockGroups({
      groups: [only],
      removeGroup: (group) => {
        kept.push(group)
      },
    })
    expect(kept).toEqual([])
  })
})
