import { describe, expect, test } from 'vitest'
import { createStore } from 'jotai/vanilla'
import {
  adoptSessionRunAtom,
  sessionRunMapAtom,
  softStopSessionRunAtom,
  startSessionRunAtom,
  stopSessionRunAtom,
} from './session-run-atoms'

describe('session run timer memory', () => {
  test('软停后 adopt(Date.now()) 仍用原 startedAt，不从 0 重计', () => {
    const store = createStore()
    const origin = 1_700_000_000_000
    store.set(startSessionRunAtom, { id: 's1', startedAt: origin })
    store.set(softStopSessionRunAtom, 's1')
    expect(store.get(sessionRunMapAtom).s1).toEqual({ running: false, startedAt: origin })

    store.set(adoptSessionRunAtom, { id: 's1', startedAt: origin + 81_000 })
    expect(store.get(sessionRunMapAtom).s1).toEqual({ running: true, startedAt: origin })
  })

  test('硬停才清记忆，之后 adopt 才接受新起点', () => {
    const store = createStore()
    store.set(startSessionRunAtom, { id: 's1', startedAt: 10 })
    store.set(stopSessionRunAtom, 's1')
    expect(store.get(sessionRunMapAtom).s1).toEqual({ running: false, startedAt: null })

    store.set(adoptSessionRunAtom, { id: 's1', startedAt: 99 })
    expect(store.get(sessionRunMapAtom).s1).toEqual({ running: true, startedAt: 99 })
  })
})
