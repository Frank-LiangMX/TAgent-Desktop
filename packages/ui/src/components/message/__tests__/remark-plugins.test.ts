import { describe, expect, test } from 'vitest'

import { remarkMentions, remarkPreserveBreaks } from '../index'

describe('remarkMentions', () => {
  test('converts @file: mentions to mention:// links', () => {
    const plugin = remarkMentions()
    const tree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [{ type: 'text', value: 'Check @file:src/utils.ts for details' }],
        },
      ],
    }

    plugin(tree)

    const paragraph = tree.children[0]!
    expect(paragraph.children).toHaveLength(3)
    expect(paragraph.children[0]).toEqual({ type: 'text', value: 'Check ' })
    expect(paragraph.children[1]).toEqual({
      type: 'link',
      url: 'mention://file/src%2Futils.ts',
      children: [{ type: 'text', value: '@file:src/utils.ts' }],
    })
    expect(paragraph.children[2]).toEqual({ type: 'text', value: ' for details' })
  })

  test('converts /skill: mentions', () => {
    const plugin = remarkMentions()
    const tree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [{ type: 'text', value: 'Use /skill:code-review' }],
        },
      ],
    }

    plugin(tree)

    const paragraph = tree.children[0]!
    expect(paragraph.children[1]).toEqual({
      type: 'link',
      url: 'mention://skill/code-review',
      children: [{ type: 'text', value: '/skill:code-review' }],
    })
  })

  test('converts #mcp: mentions', () => {
    const plugin = remarkMentions()
    const tree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [{ type: 'text', value: 'Call #mcp:my-server' }],
        },
      ],
    }

    plugin(tree)

    const paragraph = tree.children[0]!
    expect(paragraph.children[1]).toEqual({
      type: 'link',
      url: 'mention://mcp/my-server',
      children: [{ type: 'text', value: '#mcp:my-server' }],
    })
  })

  test('converts &session: mentions', () => {
    const plugin = remarkMentions()
    const tree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [{ type: 'text', value: 'See &session:abc123' }],
        },
      ],
    }

    plugin(tree)

    const paragraph = tree.children[0]!
    expect(paragraph.children[1]).toEqual({
      type: 'link',
      url: 'mention://session/abc123',
      children: [{ type: 'text', value: '&session:abc123' }],
    })
  })

  test('does not modify text without mentions', () => {
    const plugin = remarkMentions()
    const tree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [{ type: 'text', value: 'No mentions here' }],
        },
      ],
    }

    plugin(tree)

    const paragraph = tree.children[0]!
    expect(paragraph.children).toHaveLength(1)
    expect(paragraph.children[0]).toEqual({ type: 'text', value: 'No mentions here' })
  })

  test('skips code and inlineCode nodes', () => {
    const plugin = remarkMentions()
    const tree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'text', value: 'Before ' },
            { type: 'inlineCode', value: '@file:test.ts' },
            { type: 'text', value: ' after' },
          ],
        },
      ],
    }

    plugin(tree)

    const paragraph = tree.children[0]!
    // inlineCode should not be processed
    expect(paragraph.children[1]).toEqual({ type: 'inlineCode', value: '@file:test.ts' })
  })
})

describe('remarkPreserveBreaks', () => {
  test('converts newlines to break nodes', () => {
    const plugin = remarkPreserveBreaks()
    const tree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [{ type: 'text', value: 'Line 1\nLine 2\nLine 3' }],
        },
      ],
    }

    plugin(tree)

    const paragraph = tree.children[0]!
    expect(paragraph.children).toHaveLength(5) // text, break, text, break, text
    expect(paragraph.children[0]).toEqual({ type: 'text', value: 'Line 1' })
    expect(paragraph.children[1]).toEqual({ type: 'break' })
    expect(paragraph.children[2]).toEqual({ type: 'text', value: 'Line 2' })
    expect(paragraph.children[3]).toEqual({ type: 'break' })
    expect(paragraph.children[4]).toEqual({ type: 'text', value: 'Line 3' })
  })

  test('does not modify text without newlines', () => {
    const plugin = remarkPreserveBreaks()
    const tree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [{ type: 'text', value: 'No newlines' }],
        },
      ],
    }

    plugin(tree)

    const paragraph = tree.children[0]!
    expect(paragraph.children).toHaveLength(1)
    expect(paragraph.children[0]).toEqual({ type: 'text', value: 'No newlines' })
  })

  test('skips code and inlineCode nodes', () => {
    const plugin = remarkPreserveBreaks()
    const tree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'text', value: 'Before\nAfter' },
            { type: 'code', value: 'line1\nline2' },
          ],
        },
      ],
    }

    plugin(tree)

    const paragraph = tree.children[0]!
    // text should be processed into [text, break, text]
    expect(paragraph.children[0]).toEqual({ type: 'text', value: 'Before' })
    expect(paragraph.children[1]).toEqual({ type: 'break' })
    expect(paragraph.children[2]).toEqual({ type: 'text', value: 'After' })
    // code should not be processed
    expect(paragraph.children[3]).toEqual({ type: 'code', value: 'line1\nline2' })
  })
})
