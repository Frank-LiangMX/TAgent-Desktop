import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { describe, expect, it, vi } from 'vitest'
import {
  CodexDynamicToolRegistry,
  dispatchCodexDynamicToolCall,
  parseCodexDynamicToolCallParams,
  resolveCodexDynamicToolPermission,
} from './codex-dynamic-tools'

function tool(execute = vi.fn()): AgentTool {
  return {
    name: 'tagent_echo',
    label: 'tagent_echo',
    description: 'Echo a value.',
    parameters: Type.Object({
      value: Type.String({ description: 'Value to echo.' }),
    }),
    execute,
  }
}

const call = {
  threadId: 'thr_1',
  turnId: 'turn_1',
  callId: 'call_1',
  namespace: null,
  tool: 'tagent_echo',
  arguments: { value: 'hello' },
}

describe('CodexDynamicToolRegistry', () => {
  it('把 Pi AgentTool 转为 App Server dynamicTools spec', () => {
    const registry = new CodexDynamicToolRegistry([
      { tool: tool(), permission: 'read-only' },
    ])
    expect(registry.specs).toEqual([
      {
        type: 'function',
        name: 'tagent_echo',
        description: 'Echo a value.',
        inputSchema: expect.objectContaining({
          type: 'object',
          properties: {
            value: expect.objectContaining({
              type: 'string',
              description: 'Value to echo.',
            }),
          },
          required: ['value'],
        }),
      },
    ])
  })

  it('执行工具并把文本和图片结果转换为 App Server 响应', async () => {
    const execute = vi.fn(async () => ({
      content: [
        { type: 'text' as const, text: 'done' },
        {
          type: 'image' as const,
          data: 'aW1hZ2U=',
          mimeType: 'image/png',
        },
      ],
      details: {},
    }))
    const registry = new CodexDynamicToolRegistry([
      { tool: tool(execute), permission: 'permission' },
    ])
    const resolved = registry.resolve(call)!
    await expect(registry.execute(resolved)).resolves.toEqual({
      contentItems: [
        { type: 'inputText', text: 'done' },
        {
          type: 'inputImage',
          imageUrl: 'data:image/png;base64,aW1hZ2U=',
        },
      ],
      success: true,
    })
    expect(execute).toHaveBeenCalledWith(
      'call_1',
      { value: 'hello' },
      undefined,
    )
  })

  it('拒绝未知 namespace、未知工具和非对象参数', () => {
    const registry = new CodexDynamicToolRegistry([
      { tool: tool(), permission: 'read-only' },
    ])
    expect(registry.resolve({ ...call, namespace: 'browser' })).toBeUndefined()
    expect(registry.resolve({ ...call, tool: 'missing' })).toBeUndefined()
    expect(registry.resolve({ ...call, arguments: 'bad' })).toBeUndefined()
  })

  it('工具异常转换为 success:false，不打断 App Server RPC', async () => {
    const execute = vi.fn(async () => {
      throw new Error('boom')
    })
    const registry = new CodexDynamicToolRegistry([
      {
        tool: tool(execute),
        permission: 'permission',
      },
    ])
    await expect(registry.execute(registry.resolve(call)!)).resolves.toEqual({
      contentItems: [{ type: 'inputText', text: '错误：boom' }],
      success: false,
    })
  })

  it('拒绝重复工具名和非法协议参数', () => {
    expect(
      () =>
        new CodexDynamicToolRegistry([
          { tool: tool(), permission: 'read-only' },
          { tool: tool(), permission: 'permission' },
        ]),
    ).toThrow(/重名/)
    expect(
      parseCodexDynamicToolCallParams({ ...call, callId: undefined }),
    ).toBeUndefined()
  })

  it('为内置 browser、KB、kanban 工具提供显式权限分类', () => {
    expect(resolveCodexDynamicToolPermission('kb_search')).toBe('read-only')
    expect(resolveCodexDynamicToolPermission('browser_type')).toBe(
      'permission',
    )
    expect(resolveCodexDynamicToolPermission('kb_propose_save')).toBe(
      'self-authorized',
    )
    expect(() => resolveCodexDynamicToolPermission('unknown_tool')).toThrow(
      /缺少权限分类/,
    )
  })

  it('按只读、权限和自身确认策略分派 Dynamic Tool', async () => {
    const readExecute = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'read' }],
      details: {},
    }))
    const permissionExecute = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'write' }],
      details: {},
    }))
    const selfAuthorizedExecute = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'saved' }],
      details: {},
    }))
    const registry = new CodexDynamicToolRegistry([
      {
        tool: { ...tool(readExecute), name: 'kb_search' },
        permission: 'read-only',
      },
      {
        tool: { ...tool(permissionExecute), name: 'browser_type' },
        permission: 'permission',
      },
      {
        tool: { ...tool(selfAuthorizedExecute), name: 'kb_propose_save' },
        permission: 'self-authorized',
      },
    ])
    const requestPermission = vi.fn(async () => ({
      behavior: 'deny' as const,
      message: 'denied',
    }))

    await dispatchCodexDynamicToolCall({
      registry,
      params: { ...call, tool: 'kb_search' },
      executionMode: 'chat',
      permissionMode: 'auto',
      requestPermission,
    })
    expect(readExecute).toHaveBeenCalledOnce()
    expect(requestPermission).not.toHaveBeenCalled()

    await expect(
      dispatchCodexDynamicToolCall({
        registry,
        params: { ...call, tool: 'browser_type' },
        executionMode: 'work',
        permissionMode: 'auto',
        requestPermission,
      }),
    ).resolves.toEqual({
      contentItems: [{ type: 'inputText', text: '错误：denied' }],
      success: false,
    })
    expect(permissionExecute).not.toHaveBeenCalled()

    await dispatchCodexDynamicToolCall({
      registry,
      params: { ...call, tool: 'kb_propose_save' },
      executionMode: 'work',
      permissionMode: 'auto',
      requestPermission,
    })
    expect(selfAuthorizedExecute).toHaveBeenCalledOnce()
    expect(requestPermission).toHaveBeenCalledTimes(1)

    await dispatchCodexDynamicToolCall({
      registry,
      params: { ...call, tool: 'kb_propose_save' },
      executionMode: 'chat',
      permissionMode: 'auto',
      requestPermission,
    })
    await dispatchCodexDynamicToolCall({
      registry,
      params: { ...call, tool: 'kb_propose_save' },
      executionMode: 'work',
      permissionMode: 'plan',
      requestPermission,
    })
    expect(selfAuthorizedExecute).toHaveBeenCalledOnce()
    expect(requestPermission).toHaveBeenCalledTimes(3)
  })
})
