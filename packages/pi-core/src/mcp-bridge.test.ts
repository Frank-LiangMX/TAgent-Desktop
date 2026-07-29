import { describe, expect, it } from 'vitest'
import { testMcpServer } from './mcp-bridge'

/**
 * testMcpServer 真实探测的形状单测。
 *
 * 只覆盖「不发起真实可达连接」的失败分支（缺 command/url、命令不存在），
 * 用以证明：返回 { success, message } 形状、且不抛错（非占位实现）。
 * 真正 stdio/http/sse 可达性由人工/集成测试验证。
 */
describe('testMcpServer', () => {
  it('returns a non-throwing failure result for stdio missing command', async () => {
    const result = await testMcpServer('no-cmd', { type: 'stdio', enabled: false })
    expect(result.success).toBe(false)
    expect(typeof result.message).toBe('string')
    expect(result.message.length).toBeGreaterThan(0)
    expect(result.message).toContain('command')
  })

  it('returns a failure result for http missing url', async () => {
    const result = await testMcpServer('no-url', { type: 'http', enabled: true })
    expect(result.success).toBe(false)
    expect(result.message).toContain('url')
  })

  it('returns a failure result for sse missing url', async () => {
    const result = await testMcpServer('no-url-sse', { type: 'sse', enabled: true })
    expect(result.success).toBe(false)
    expect(result.message).toContain('url')
  })

  it('attempts a real stdio spawn and fails gracefully on ENOENT', async () => {
    const result = await testMcpServer('bad-cmd', {
      type: 'stdio',
      command: 'this-command-does-not-exist-xyz',
      enabled: true,
      timeout: 5,
    })
    expect(result.success).toBe(false)
    expect(typeof result.message).toBe('string')
    expect(result.message.length).toBeGreaterThan(0)
  }, 20000)
})
