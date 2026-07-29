import { describe, expect, test } from 'bun:test'
import { getToolPhrase, summarizeToolResult } from './tool-phrase'

describe('getToolPhrase', () => {
  test('Read uses path or file_path', () => {
    expect(getToolPhrase('Read', { path: 'src/a.ts' }).label).toBe('读取 a.ts')
    expect(getToolPhrase('Read', { file_path: 'pkg/b.ts' }).label).toBe('读取 b.ts')
  })

  test('Bash shows truncated command', () => {
    expect(getToolPhrase('Bash', { command: 'ls -la' }).label).toBe('执行 ls -la')
    const long = getToolPhrase('Bash', { command: 'x'.repeat(100) }).label
    expect(long.startsWith('执行 ')).toBe(true)
    expect(long.endsWith('…')).toBe(true)
  })

  test('loading label is progressive', () => {
    expect(getToolPhrase('Read', { path: 'a.ts' }).loadingLabel).toContain('正在')
  })
})

describe('summarizeToolResult', () => {
  test('first non-empty line', () => {
    expect(summarizeToolResult('\nhello\nworld')).toBe('hello')
  })
  test('error', () => {
    expect(summarizeToolResult('x', true)).toBe('失败')
  })
})
