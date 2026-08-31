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

  test('kb_* 工具用中文短语（兼容 MCP 前缀）', () => {
    expect(getToolPhrase('kb_search', { query: '接线顺序' }).label).toBe(
      '检索知识库「接线顺序」',
    )
    expect(getToolPhrase('mcp__kb__kb_search', { query: '接线' }).label).toBe(
      '检索知识库「接线」',
    )
    expect(getToolPhrase('kb_search', {}).label).toBe('检索知识库')
    expect(getToolPhrase('kb_search', { query: '  ' }).label).toBe('检索知识库')

    expect(getToolPhrase('kb_list_roots', {}).label).toBe('列出知识库')
    expect(getToolPhrase('mcp__kb__kb_list_roots', {}).label).toBe('列出知识库')

    expect(getToolPhrase('kb_get', { documentId: 'd1' }).label).toBe('读取知识文档')
    expect(getToolPhrase('kb_get', { path: 'guide.md' }).label).toBe('读取知识文件')
    expect(getToolPhrase('kb_get', {}).label).toBe('读取知识库')
    expect(getToolPhrase('mcp__kb__kb_get', { documentId: 'd1' }).label).toBe(
      '读取知识文档',
    )

    // 刀 3：kb_list_available 口头荐库用的可发现元数据查询
    expect(getToolPhrase('kb_list_available', {}).label).toBe('查看可挂知识库')
    expect(getToolPhrase('mcp__kb__kb_list_available', {}).label).toBe(
      '查看可挂知识库',
    )
  })

  test('kb_search loading label 带正在', () => {
    expect(
      getToolPhrase('kb_search', { query: '接线' }).loadingLabel,
    ).toContain('正在检索知识库')
  })
})

describe('summarizeToolResult', () => {
  test('first non-empty line', () => {
    expect(summarizeToolResult('\nhello\nworld')).toBe('hello')
  })
  test('error', () => {
    expect(summarizeToolResult('x', true)).toBe('失败')
  })
  test('kb_search JSON（text blocks）→ 命中 N 条', () => {
    const content = [
      { type: 'text', text: JSON.stringify({ count: 2, hits: [{}, {}] }) },
    ]
    expect(summarizeToolResult(content)).toBe('命中 2 条')
  })
  test('kb_search JSON（string）→ 命中 N 条；空命中 → 命中 0 条', () => {
    expect(summarizeToolResult(JSON.stringify({ count: 0, hits: [] }))).toBe(
      '命中 0 条',
    )
  })
  test('kb_list_roots（有 count 无 hits）不误判为命中', () => {
    const content = [
      {
        type: 'text',
        text: JSON.stringify({ count: 3, roots: [], knowledgeBases: [] }),
      },
    ]
    // 无 hits → 走原有「首行」逻辑（首行是 `{`，截断后返回）
    expect(summarizeToolResult(content)).not.toContain('命中')
  })
  test('kb_list_available（刀 3）→ 可发现 N 个库 / 无可发现库 / 已挂库', () => {
    const found = [
      { type: 'text', text: JSON.stringify({ bound: false, available: [{}, {}] }) },
    ]
    expect(summarizeToolResult(found)).toBe('可发现 2 个库')
    expect(
      summarizeToolResult(JSON.stringify({ bound: false, available: [] })),
    ).toBe('无可发现库')
    expect(
      summarizeToolResult(JSON.stringify({ bound: true, available: [] })),
    ).toBe('已挂库')
  })
  test('非 JSON 文本不受影响', () => {
    expect(summarizeToolResult('纯文本结果')).toBe('纯文本结果')
  })
})
