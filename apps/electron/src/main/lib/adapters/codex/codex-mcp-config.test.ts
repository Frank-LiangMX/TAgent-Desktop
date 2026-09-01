import { describe, expect, it } from 'vitest'
import { buildCodexMcpThreadConfig } from './codex-mcp-config'

describe('buildCodexMcpThreadConfig', () => {
  it('投影 stdio 与 streamable HTTP MCP 配置', () => {
    expect(
      buildCodexMcpThreadConfig({
        local: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', 'demo-mcp'],
          env: { TOKEN: 'secret' },
          timeout: 45,
          enabled: true,
        },
        remote: {
          type: 'http',
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer token' },
          enabled: true,
        },
      }),
    ).toEqual({
      config: {
        mcp_servers: {
          local: {
            command: 'npx',
            args: ['-y', 'demo-mcp'],
            env: { TOKEN: 'secret' },
            startup_timeout_sec: 45,
          },
          remote: {
            url: 'https://example.com/mcp',
            http_headers: { Authorization: 'Bearer token' },
          },
        },
      },
      skipped: [],
    })
  })

  it('跳过禁用、无效和 legacy SSE 条目', () => {
    expect(
      buildCodexMcpThreadConfig({
        disabled: { type: 'stdio', command: 'x', enabled: false },
        invalid: { type: 'stdio', enabled: true },
        legacy: {
          type: 'sse',
          url: 'https://example.com/events',
          enabled: true,
        },
      }),
    ).toEqual({
      skipped: [
        { name: 'invalid', reason: 'stdio MCP 缺少 command' },
        {
          name: 'legacy',
          reason: 'Codex 不支持 TAgent 的 legacy SSE MCP 配置',
        },
      ],
    })
  })
})
