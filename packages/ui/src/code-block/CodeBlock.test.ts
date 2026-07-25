import { describe, expect, test } from 'vitest'

import { resolveShikiTheme, shouldUsePlainTextColors } from './CodeBlock'

describe('CodeBlock plain-text colors', () => {
  test.each(['', 'text', 'plaintext', 'txt', 'TEXT'])(
    'uses the active theme foreground for %j fences',
    (language) => {
      expect(shouldUsePlainTextColors(language)).toBe(true)
    }
  )

  test.each(['typescript', 'python', 'bash', 'mermaid'])(
    'keeps Shiki token colors for %s fences',
    (language) => {
      expect(shouldUsePlainTextColors(language)).toBe(false)
    }
  )
})

describe('CodeBlock Shiki theme', () => {
  test('uses github-light in light mode', () => {
    expect(resolveShikiTheme(false)).toBe('github-light')
  })

  test('uses github-dark in dark mode', () => {
    expect(resolveShikiTheme(true)).toBe('github-dark')
  })
})
