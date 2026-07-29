import type { WorkspaceMcpConfig } from '@tagent/shared'
import { describe, expect, it } from 'vitest'
import {
  buildMcpEntry,
  createMcpDraft,
  entryToDraft,
  listMcpServers,
  parseArgs,
  parseEnv,
  parseHeaders,
  parseTimeout,
  summarizeMcpEntry,
  validateMcpDraft,
  type McpDraft,
} from './mcp-settings-model'

describe('mcp settings model', () => {
  it('requires a name and a command for the default stdio draft', () => {
    const result = validateMcpDraft(createMcpDraft())
    expect(result.valid).toBe(false)
    expect(result.errors.name).toBeTruthy()
    expect(result.errors.command).toBeTruthy()
  })

  it('requires command for stdio and a valid url for http/sse', () => {
    expect(
      validateMcpDraft({ ...createMcpDraft(), name: 'a', type: 'stdio' }).errors.command
    ).toBeTruthy()

    const http = validateMcpDraft({ ...createMcpDraft(), name: 'a', type: 'http' })
    expect(http.errors.url).toBeTruthy()

    const badUrl = validateMcpDraft({ ...createMcpDraft(), name: 'a', type: 'sse', url: 'not-a-url' })
    expect(badUrl.errors.url).toBeTruthy()

    const ok = validateMcpDraft({ ...createMcpDraft(), name: 'a', type: 'http', url: 'https://x.com/mcp' })
    expect(ok.valid).toBe(true)
  })

  it('rejects a non-positive timeout', () => {
    const result = validateMcpDraft({ ...createMcpDraft(), name: 'a', command: 'npx', timeout: 'abc' })
    expect(result.errors.timeout).toBeTruthy()
  })

  it('parses args as whitespace or JSON array', () => {
    expect(parseArgs('-y  server  x')).toEqual(['-y', 'server', 'x'])
    expect(parseArgs('["-y","server"]')).toEqual(['-y', 'server'])
    expect(parseArgs('["-y", 1]')).toEqual(['-y']) // 非字符串元素过滤
    expect(parseArgs('')).toEqual([])
  })

  it('parses env and headers multiline', () => {
    expect(parseEnv('FOO=bar\n BAZ=qux\n=skip\nbad')).toEqual({ FOO: 'bar', BAZ: 'qux' })
    expect(parseHeaders('Authorization: Bearer x\nX-Api-Key=secret')).toEqual({
      Authorization: 'Bearer x',
      'X-Api-Key': 'secret',
    })
  })

  it('parses timeout only when a positive integer', () => {
    expect(parseTimeout('')).toBeUndefined()
    expect(parseTimeout('30')).toBe(30)
    expect(parseTimeout('0')).toBeUndefined()
    expect(parseTimeout('-3')).toBeUndefined()
    expect(parseTimeout('2.5')).toBeUndefined()
  })

  it('builds an entry and preserves lastTestResult from existing', () => {
    const draft: McpDraft = {
      ...createMcpDraft(),
      name: 'fs',
      type: 'stdio',
      command: 'npx',
      args: '-y fs /tmp',
      env: 'A=1',
      timeout: '10',
      enabled: true,
    }
    const entry = buildMcpEntry(draft)
    expect(entry).toMatchObject({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'fs', '/tmp'],
      env: { A: '1' },
      timeout: 10,
      enabled: true,
    })
    expect(entry.lastTestResult).toBeUndefined()

    const withResult = buildMcpEntry(draft, {
      ...entry,
      lastTestResult: { success: true, message: 'ok', timestamp: 1 },
    })
    expect(withResult.lastTestResult).toEqual({ success: true, message: 'ok', timestamp: 1 })
  })

  it('round-trips an http entry through a draft', () => {
    const entry = buildMcpEntry({
      ...createMcpDraft(),
      name: 'fs',
      type: 'http',
      url: 'https://x.com/mcp',
      headers: 'Authorization: Bearer y',
      timeout: '20',
    })
    const draft = entryToDraft('fs', entry)
    expect(draft.url).toBe('https://x.com/mcp')
    expect(draft.timeout).toBe('20')
    expect(draft.headers).toBe('Authorization: Bearer y')
  })

  it('summarizes stdio command and http url', () => {
    expect(summarizeMcpEntry({ type: 'stdio', command: 'npx', args: ['-y', 'fs'], enabled: true })).toBe(
      'npx -y fs'
    )
    expect(summarizeMcpEntry({ type: 'http', url: 'https://x.com', enabled: true })).toBe('https://x.com')
    expect(summarizeMcpEntry({ type: 'stdio', enabled: true })).toBe('(未配置命令)')
  })

  it('lists servers from a config preserving insertion order', () => {
    const config: WorkspaceMcpConfig = {
      servers: {
        a: { type: 'stdio', command: 'x', enabled: true },
        b: { type: 'http', url: 'https://y', enabled: false },
      },
    }
    expect(listMcpServers(config).map((s) => s.name)).toEqual(['a', 'b'])
    expect(listMcpServers({ servers: {} })).toEqual([])
  })
})
