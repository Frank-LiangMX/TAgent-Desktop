import { describe, expect, test } from 'vitest'
import { applyUniqueWorkspacePatch } from './collaboration-room-service'

describe('applyUniqueWorkspacePatch', () => {
  test('replaces the single matching span', () => {
    expect(applyUniqueWorkspacePatch('a\nb\nc', 'b', 'B', 100)).toEqual({ ok: true, content: 'a\nB\nc' })
  })

  test('rejects missing and duplicate oldText', () => {
    expect(applyUniqueWorkspacePatch('abc', 'x', 'y', 100)).toMatchObject({ ok: false })
    expect(applyUniqueWorkspacePatch('aba', 'a', 'x', 100)).toMatchObject({ ok: false, reason: expect.stringContaining('不唯一') })
  })

  test('rejects empty oldText and oversized result', () => {
    expect(applyUniqueWorkspacePatch('abc', '', 'x', 100)).toMatchObject({ ok: false })
    expect(applyUniqueWorkspacePatch('abc', 'a', '1234', 3)).toMatchObject({ ok: false })
  })
})
