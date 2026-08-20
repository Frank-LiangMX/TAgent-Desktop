import { describe, expect, test } from 'vitest'
import { isAllowedBrowserUrl, normalizeBrowserUrl } from './browser-policy'

describe('browser URL policy', () => {
  test('allows normal http(s) pages and about:blank', () => {
    expect(isAllowedBrowserUrl('https://example.com/login')).toBe(true)
    expect(isAllowedBrowserUrl('http://localhost:3000')).toBe(true)
    expect(isAllowedBrowserUrl('about:blank')).toBe(true)
    expect(normalizeBrowserUrl('https://example.com/path')).toBe('https://example.com/path')
  })

  test('rejects local schemes and malformed URLs', () => {
    expect(isAllowedBrowserUrl('file:///C:/secret.txt')).toBe(false)
    expect(isAllowedBrowserUrl('data:text/html,hello')).toBe(false)
    expect(isAllowedBrowserUrl('javascript:alert(1)')).toBe(false)
    expect(isAllowedBrowserUrl('not a url')).toBe(false)
    expect(() => normalizeBrowserUrl('file:///tmp/a')).toThrow()
  })
})
