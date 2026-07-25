import { describe, expect, test } from 'bun:test'

import {
  COMPACTION_IN_PROGRESS_LABEL,
  getCompactBoundaryLabel,
  isSdkCompactBoundaryMessage,
  isSdkCompactingStatusMessage,
  isSdkStandaloneSystemMessage,
} from './sdk-compaction'

describe('isSdkCompactingStatusMessage', () => {
  test('recognizes SDK status compacting', () => {
    expect(
      isSdkCompactingStatusMessage({
        type: 'system',
        subtype: 'status',
        status: 'compacting',
      })
    ).toBe(true)
  })

  test('recognizes legacy compacting subtype', () => {
    expect(
      isSdkCompactingStatusMessage({
        type: 'system',
        subtype: 'compacting',
      })
    ).toBe(true)
  })

  test('rejects requesting status', () => {
    expect(
      isSdkCompactingStatusMessage({
        type: 'system',
        subtype: 'status',
        status: 'requesting',
      })
    ).toBe(false)
  })
})

describe('getCompactBoundaryLabel', () => {
  test('labels auto vs manual', () => {
    expect(getCompactBoundaryLabel({ trigger: 'auto' })).toBe('上下文已自动压缩')
    expect(getCompactBoundaryLabel({ trigger: 'manual' })).toBe('上下文已压缩')
    expect(getCompactBoundaryLabel(undefined)).toBe('上下文已压缩')
  })
})

describe('isSdkStandaloneSystemMessage', () => {
  test('includes compacting status and compact boundary', () => {
    expect(isSdkCompactBoundaryMessage({ type: 'system', subtype: 'compact_boundary' })).toBe(true)
    expect(
      isSdkStandaloneSystemMessage({
        type: 'system',
        subtype: 'status',
        status: 'compacting',
      })
    ).toBe(true)
  })
})

describe('COMPACTION_IN_PROGRESS_LABEL', () => {
  test('matches Codex-style copy', () => {
    expect(COMPACTION_IN_PROGRESS_LABEL).toBe('压缩上下文')
  })
})
