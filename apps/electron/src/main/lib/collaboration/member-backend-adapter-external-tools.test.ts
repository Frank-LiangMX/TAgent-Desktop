/**
 * 成员后端适配器 —— 外部渠道原生受限工具桥单测（Stage 4-3b 外部渠道）
 *
 * 验证 runExternalRoomToolTurn / buildRoomBridgeTools 的安全契约：
 * - schema 限权：只暴露 room_send/room_ask/room_reply 三把 TypeBox 受限工具，
 *   additionalProperties:false 锁死参数；绝不混入 Read/Bash/Edit/Write/Task 等会话工具。
 * - tool-call 转发：execute 把调用转发给宿主 hostToolHandler 真实校验/执行，绝不就地伪造。
 * - result 回注：工具结果由 Agent 回注下一轮 context（第二次 streamFn 调用的上下文里含工具输出）。
 * - unsupported fail-closed：无原生工具能力的渠道（openai/zhipu/custom/google）或未注入
 *   hostToolHandler 时，走纯文本 runner（createPiHttpSeatRunner，tools=[]），不接桥、不伪造。
 *
 * 通过 mock @tagent/pi-core（createHttpDirectStreamFn 可脚本化）+ mock
 * @earendil-works/pi-agent-core（FakeAgent 复刻标准 tool-use 循环）驱动；@earendil-works/pi-ai
 * 的 Type 不 mock，保证 TypeBox schema 是真实对象。不发真实 HTTP。
 */
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type {
  Channel,
  ChannelModel,
  CollaborationHostToolHandler,
  MemberTurnInput,
} from '@tagent/shared'

// ===== mock 状态（vi.hoisted 保证 vi.mock 工厂能引用） =====

const channelState = vi.hoisted(() => ({
  channels: [] as Channel[],
  decrypted: {} as Record<string, string>,
}))
const ksccState = vi.hoisted(() => ({ path: undefined as string | undefined }))

/** createHttpDirectStreamFn 工厂捕获 + 每次 streamFn 调用的 context/options + 可脚本化事件流 */
const httpState = vi.hoisted(() => ({
  factoryOpts: null as {
    provider: string
    apiKey: string
    baseUrl?: string
    modelId: string
  } | null,
  streamFnCalls: [] as Array<{ context: unknown; options: unknown }>,
  scripts: [] as Array<Array<Record<string, unknown>>>,
}))

/** FakeAgent 实例记录 + abort 计数（awaitPeer 停 loop 用） */
const agentState = vi.hoisted(() => ({
  instances: [] as Array<{
    config: {
      initialState: {
        systemPrompt: string
        tools: Array<{ name: string; execute: (id: string, args: unknown) => Promise<unknown> }>
      }
    }
  }>,
  abortCount: 0,
}))

vi.mock('../channel/channel-store', () => ({
  listChannels: () => channelState.channels,
  getChannel: (id: string) => channelState.channels.find((c) => c.id === id),
  getDecryptedApiKey: (id: string) => channelState.decrypted[id] ?? '',
}))

vi.mock('../adapters/claude/kscc-path', () => ({
  resolveKsccPath: () => ksccState.path,
}))

vi.mock('@tagent/pi-core', () => ({
  createHttpDirectStreamFn: (opts: unknown) => {
    httpState.factoryOpts = opts as typeof httpState.factoryOpts
    return (model: unknown, context: unknown, options: unknown) => {
      httpState.streamFnCalls.push({ context, options })
      const idx = httpState.streamFnCalls.length - 1
      const events = httpState.scripts[idx] ?? []
      return {
        async *[Symbol.asyncIterator]() {
          for (const e of events) yield e as never
        },
      }
    }
  },
  // 纯文本 runner（fail-closed 路径用）：记录调用、返回固定正文
  createPiHttpSeatRunner: vi.fn(() => ({
    runSeat: async () => 'pi-seat-text',
  })),
  createKsccSeatRunner: vi.fn(() => ({
    runSeat: async () => 'kscc-seat-text',
  })),
  // SUT 顶部 import 需要绑定，本测试不走 kscc bare 路径
  createKsccBareStreamFn: vi.fn(() => () => ({
    async *[Symbol.asyncIterator]() {
      /* empty */
    },
  })),
}))

// FakeAgent：复刻 Pi Agent 的标准 tool-use 循环——消费 streamFn 事件流，遇 tool_use 调
// execute，把结果回注 context 后再次请求 streamFn（result 回注）；awaitPeer/abort 停 loop。
// 它是外部依赖 @earendil-works/pi-agent-core 的测试替身，不是被测对象；被测是
// runExternalRoomToolTurn 的接线（tools / streamFn / hostToolHandler 转发与回注）。
const { FakeAgent } = vi.hoisted(() => {
  class FakeAgent {
    config: {
      initialState: {
        systemPrompt: string
        model: unknown
        thinkingLevel: string
        tools: Array<{ name: string; execute: (id: string, args: unknown) => Promise<unknown> }>
        messages: unknown[]
      }
      streamFn: (model: unknown, context: unknown, options: unknown) => AsyncIterable<Record<string, unknown>>
      toolExecution: string
    }
    subscribers: Array<(event: unknown) => void> = []
    aborted = false
    idle: Promise<void> | null = null
    constructor(config: FakeAgent['config']) {
      this.config = config
      agentState.instances.push(this as never)
    }
    subscribe(cb: (event: unknown) => void): () => void {
      this.subscribers.push(cb)
      return () => {
        this.subscribers = this.subscribers.filter((s) => s !== cb)
      }
    }
    private emit(event: unknown): void {
      for (const cb of this.subscribers) cb(event)
    }
    abort(): void {
      agentState.abortCount++
      this.aborted = true
    }
    async prompt(userPrompt: string): Promise<void> {
      this.idle = this.loop(userPrompt)
      await this.idle
    }
    async waitForIdle(): Promise<void> {
      if (this.idle) await this.idle
    }
    private async loop(userPrompt: string): Promise<void> {
      const { systemPrompt, tools, model } = this.config.initialState
      const context: {
        systemPrompt?: string
        messages: Array<Record<string, unknown>>
        tools: unknown
      } = {
        ...(systemPrompt ? { systemPrompt } : {}),
        messages: [{ role: 'user', content: userPrompt, timestamp: Date.now() }],
        tools,
      }
      let guard = 0
      while (!this.aborted && guard++ < 8) {
        const stream = await Promise.resolve(this.config.streamFn(model, context, {}))
        let doneEv: { reason?: string; message?: { content?: Array<Record<string, unknown>> } } | null =
          null
        const toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = []
        for await (const ev of stream) {
          if (this.aborted) break
          const e = ev as Record<string, unknown>
          if (e.type === 'text_delta') {
            this.emit({
              type: 'message_update',
              assistantMessageEvent: { type: 'text_delta', delta: e.delta },
            })
          } else if (e.type === 'toolcall_end' && e.toolCall) {
            toolCalls.push(e.toolCall as never)
          } else if (e.type === 'done') {
            doneEv = e as never
            const content = (e as { message?: { content?: Array<Record<string, unknown>> } }).message
              ?.content
            if (Array.isArray(content)) {
              for (const c of content) {
                if (c?.type === 'toolCall') {
                  const tc = c as { id: string; name: string; arguments: Record<string, unknown> }
                  if (!toolCalls.find((t) => t.id === tc.id)) toolCalls.push(tc)
                }
              }
            }
          }
        }
        if (this.aborted) break
        if (doneEv && doneEv.reason === 'toolUse' && toolCalls.length > 0) {
          // 追加 assistant 工具调用消息
          context.messages.push({ role: 'assistant', content: doneEv.message?.content ?? toolCalls })
          for (const tc of toolCalls) {
            const tool = tools.find((t) => t.name === tc.name)
            const result = tool
              ? ((await tool.execute(tc.id, tc.arguments)) as {
                  content: Array<{ type: string; text?: string }>
                  details: Record<string, unknown>
                })
              : { content: [{ type: 'text', text: `未知工具 ${tc.name}` }], details: {} }
            // result 回注：把工具结果作为下一轮 context 的 tool_result 消息
            context.messages.push({
              role: 'user',
              content: result.content,
              toolCallId: tc.id,
              timestamp: Date.now(),
            })
            if (this.aborted) break
          }
          if (this.aborted) break
          continue
        }
        break // stop / 无工具 → 本 turn 结束
      }
    }
  }
  return { FakeAgent }
})

vi.mock('@earendil-works/pi-agent-core', () => ({ Agent: FakeAgent }))

import {
  buildRoomBridgeTools,
  channelSupportsRoomToolBridge,
  ChannelBackendAdapter,
} from './member-backend-adapter'

// ===== fixtures =====

function fakeModel(id: string, enabled = true): ChannelModel {
  return { id, name: id, enabled, contextWindow: 200_000 }
}
function fakeChannel(over: Partial<Channel> & Pick<Channel, 'id' | 'provider'>): Channel {
  return {
    name: over.provider,
    baseUrl: 'https://example.anthropic',
    apiKey: '',
    models: [fakeModel('default-model')],
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  } as Channel
}

/** 一个 enabled 的 Anthropic 协议外部渠道（原生工具桥可达） */
function anthropicChannel(): Channel {
  return fakeChannel({
    id: 'ch-anth',
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    models: [fakeModel('claude-x')],
    defaultModelId: 'claude-x',
  })
}

function baseInput(over: Partial<MemberTurnInput>): MemberTurnInput {
  return {
    roomId: 'cr_1',
    memberId: 'cm_a',
    runId: 'run_1',
    triggerMessageId: 'msg_1',
    channelId: 'ch-anth',
    modelId: 'claude-x',
    systemPrompt: '你是协调者',
    prompt: '开始',
    signal: new AbortController().signal,
    ...over,
  }
}

beforeEach(() => {
  channelState.channels = [anthropicChannel()]
  channelState.decrypted = { 'ch-anth': 'sk-anth' }
  ksccState.path = undefined
  httpState.factoryOpts = null
  httpState.streamFnCalls = []
  httpState.scripts = []
  agentState.instances = []
  agentState.abortCount = 0
})

// ===== buildRoomBridgeTools：schema 限权 =====

describe('buildRoomBridgeTools — schema 限权', () => {
  test('仅暴露 room_send/room_ask/room_reply 三把工具，绝不混入会话工具', () => {
    const tools = buildRoomBridgeTools({
      hostToolHandler: vi.fn() as unknown as CollaborationHostToolHandler,
      abortAgent: vi.fn(),
    })
    expect(tools).toHaveLength(3)
    expect(tools.map((t) => t.name)).toEqual(['room_send', 'room_ask', 'room_reply'])
    // 绝不暴露 filesystem/shell/database 或会话工具
    const forbidden = ['Read', 'Bash', 'Edit', 'Write', 'Glob', 'Grep', 'Task', 'FilesystemTool']
    for (const name of forbidden) {
      expect(tools.find((t) => t.name === name)).toBeUndefined()
    }
  })

  test('room_send schema：toMemberId + message 必填，additionalProperties 锁死', () => {
    const tools = buildRoomBridgeTools({
      hostToolHandler: vi.fn() as unknown as CollaborationHostToolHandler,
      abortAgent: vi.fn(),
    })
    const schema = tools[0]!.parameters as Record<string, unknown>
    expect(schema.type).toBe('object')
    expect(Object.keys(schema.properties as object)).toEqual(['toMemberId', 'message'])
    expect(schema.required).toEqual(['toMemberId', 'message'])
    // 锁死：不接受模型塞进来的额外参数（如 path/command）
    expect(schema.additionalProperties).toBe(false)
  })

  test('room_ask schema：toMemberId + question 必填，expected 可选', () => {
    const tools = buildRoomBridgeTools({
      hostToolHandler: vi.fn() as unknown as CollaborationHostToolHandler,
      abortAgent: vi.fn(),
    })
    const schema = tools[1]!.parameters as Record<string, unknown>
    expect(schema.type).toBe('object')
    expect(Object.keys(schema.properties as object).sort()).toEqual(['expected', 'question', 'toMemberId'])
    expect(schema.required).toEqual(['toMemberId', 'question'])
  })

  test('room_reply schema：requestId + answer 必填', () => {
    const tools = buildRoomBridgeTools({
      hostToolHandler: vi.fn() as unknown as CollaborationHostToolHandler,
      abortAgent: vi.fn(),
    })
    const schema = tools[2]!.parameters as Record<string, unknown>
    expect(schema.type).toBe('object')
    expect(Object.keys(schema.properties as object)).toEqual(['requestId', 'answer'])
    expect(schema.required).toEqual(['requestId', 'answer'])
  })
})

// ===== buildRoomBridgeTools：tool-call 转发 =====

describe('buildRoomBridgeTools — tool-call 转发到宿主 hostToolHandler', () => {
  test('room_send.execute：把 {name, arguments(字符串化)} 转发给 handler 并返回其 output', async () => {
    const handler = vi.fn(
      async () => ({ output: '通知已发送（envelope=env_1）' }),
    ) as unknown as CollaborationHostToolHandler
    const tools = buildRoomBridgeTools({ hostToolHandler: handler, abortAgent: vi.fn() })
    const send = tools.find((t) => t.name === 'room_send')!
    const res = (await send.execute('tc-1', { toMemberId: 'cm_b', message: '看一下接口' })) as {
      content: Array<{ type: string; text: string }>
      details: { output: string }
    }
    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith({
      name: 'room_send',
      arguments: { toMemberId: 'cm_b', message: '看一下接口' },
    })
    // result 回注载荷：content 文本 = handler output（Agent 把它作为 tool_result 回喂）
    expect(res.content).toEqual([{ type: 'text', text: '通知已发送（envelope=env_1）' }])
    expect(res.details).toEqual({ output: '通知已发送（envelope=env_1）' })
  })

  test('数值参数被字符串化后转发（模型若传 number 也归一为 string）', async () => {
    const handler = vi.fn(async () => ({ output: 'ok' })) as unknown as CollaborationHostToolHandler
    const tools = buildRoomBridgeTools({ hostToolHandler: handler, abortAgent: vi.fn() })
    await tools.find((t) => t.name === 'room_reply')!.execute('tc-2', { requestId: 42, answer: 'done' })
    expect(handler).toHaveBeenCalledWith({
      name: 'room_reply',
      arguments: { requestId: '42', answer: 'done' },
    })
  })

  test('room_ask.execute：awaitPeer=true 触发 abortAgent 停 loop，仍回注 output', async () => {
    const handler = vi.fn(
      async () => ({ output: '提问已发送（request=req_1）', awaitPeer: true }),
    ) as unknown as CollaborationHostToolHandler
    const abortAgent = vi.fn()
    const tools = buildRoomBridgeTools({ hostToolHandler: handler, abortAgent })
    const ask = tools.find((t) => t.name === 'room_ask')!
    const res = (await ask.execute('tc-3', { toMemberId: 'cm_b', question: '接口对吗' })) as {
      content: Array<{ type: string; text: string }>
    }
    expect(handler).toHaveBeenCalledWith({
      name: 'room_ask',
      arguments: { toMemberId: 'cm_b', question: '接口对吗' },
    })
    expect(abortAgent).toHaveBeenCalledOnce()
    expect(res.content[0]!.text).toBe('提问已发送（request=req_1）')
  })

  test('room_send.execute：awaitPeer 缺省（false）不触发 abortAgent', async () => {
    const handler = vi.fn(async () => ({ output: 'sent' })) as unknown as CollaborationHostToolHandler
    const abortAgent = vi.fn()
    const tools = buildRoomBridgeTools({ hostToolHandler: handler, abortAgent })
    await tools.find((t) => t.name === 'room_send')!.execute('tc-4', {
      toMemberId: 'cm_b',
      message: 'hi',
    })
    expect(abortAgent).not.toHaveBeenCalled()
  })
})

// ===== runTurn：unsupported fail-closed 路由 =====

describe('ChannelBackendAdapter.runTurn — unsupported fail-closed', () => {
  test('OpenAI-completions 外部渠道（无原生工具能力）：走纯文本 runner，不接桥', async () => {
    channelState.channels = [
      fakeChannel({ id: 'ch-openai', provider: 'openai', baseUrl: 'https://api.openai.com/v1' }),
    ]
    channelState.decrypted = { 'ch-openai': 'sk-oai' }
    const handler = vi.fn(async () => ({ output: 'x' })) as unknown as CollaborationHostToolHandler

    const res = await new ChannelBackendAdapter().runTurn(
      baseInput({ channelId: 'ch-openai', modelId: 'gpt-4o', hostToolHandler: handler }),
    )
    // 纯文本 runner 返回
    expect(res.text).toBe('pi-seat-text')
    // 未接原生工具桥
    expect(httpState.factoryOpts).toBeNull()
    expect(httpState.streamFnCalls).toHaveLength(0)
    // 宿主 handler 也没被调用（纯文本 turn 不触发工具）
    expect(handler).not.toHaveBeenCalled()
    // probe 一致：openai 不声明支持
    expect(channelSupportsRoomToolBridge('ch-openai')).toBe(false)
  })

  test('Anthropic 协议渠道但未注入 hostToolHandler：fail closed 走纯文本，不伪造工具', async () => {
    // 故意不传 hostToolHandler
    const res = await new ChannelBackendAdapter().runTurn(baseInput({}))
    expect(res.text).toBe('pi-seat-text')
    expect(httpState.factoryOpts).toBeNull()
    expect(httpState.streamFnCalls).toHaveLength(0)
  })

  test('google / custom / zhipu(doubao/qwen) 等非 Anthropic 协议：probe 全 false', () => {
    channelState.channels = [
      fakeChannel({ id: 'ch-google', provider: 'google' }),
      fakeChannel({ id: 'ch-custom', provider: 'custom' }),
      fakeChannel({ id: 'ch-zhipu', provider: 'zhipu' }),
      fakeChannel({ id: 'ch-doubao', provider: 'doubao' }),
      fakeChannel({ id: 'ch-qwen', provider: 'qwen' }),
    ]
    for (const id of ['ch-google', 'ch-custom', 'ch-zhipu', 'ch-doubao', 'ch-qwen']) {
      expect(channelSupportsRoomToolBridge(id)).toBe(false)
    }
  })
})

// ===== runTurn：原生工具桥接线（tool-call 转发 + result 回注） =====

describe('ChannelBackendAdapter.runTurn — Anthropic 外部渠道原生工具桥', () => {
  test('接桥：createHttpDirectStreamFn 以解密凭据 + modelId 注入；systemPrompt 不被注入工具文本', async () => {
    httpState.scripts = [[{ type: 'done', reason: 'stop', message: { content: [{ type: 'text', text: '完成' }] } }]]
    const handler = vi.fn(async () => ({ output: 'x' })) as unknown as CollaborationHostToolHandler
    const systemPrompt = '你是协调者，只做协调。'
    await new ChannelBackendAdapter().runTurn(baseInput({ systemPrompt, hostToolHandler: handler }))

    // createHttpDirectStreamFn 被以解密凭据 + 渠道 provider/baseUrl/modelId 调用
    expect(httpState.factoryOpts).toMatchObject({
      provider: 'anthropic',
      apiKey: 'sk-anth',
      baseUrl: 'https://api.anthropic.com',
      modelId: 'claude-x',
    })
    // Agent 拿到的就是原始 systemPrompt——工具只通过原生 API 暴露，绝不往 prompt 塞工具文本
    const agent = agentState.instances[0]!
    expect(agent.config.initialState.systemPrompt).toBe(systemPrompt)
    expect(agent.config.initialState.tools.map((t: { name: string }) => t.name)).toEqual([
      'room_send',
      'room_ask',
      'room_reply',
    ])
  })

  test('tool-call 转发 + result 回注：room_send 工具结果回灌下一轮 context，模型继续输出', async () => {
    // 1st stream：模型发起 room_send 工具调用（tool_use）
    // 2nd stream：收到工具结果后继续，输出最终正文
    httpState.scripts = [
      [
        {
          type: 'toolcall_end',
          contentIndex: 0,
          toolCall: {
            type: 'toolCall',
            id: 'tc-1',
            name: 'room_send',
            arguments: { toMemberId: 'cm_b', message: '看一下接口' },
          },
        },
        {
          type: 'done',
          reason: 'toolUse',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'toolCall',
                id: 'tc-1',
                name: 'room_send',
                arguments: { toMemberId: 'cm_b', message: '看一下接口' },
              },
            ],
            stopReason: 'toolUse',
          },
        },
      ],
      [
        { type: 'text_delta', delta: '通知已发出，继续工作' },
        {
          type: 'done',
          reason: 'stop',
          message: { role: 'assistant', content: [{ type: 'text', text: '通知已发出，继续工作' }], stopReason: 'stop' },
        },
      ],
    ]
    const handler = vi.fn(
      async () => ({ output: '通知已发送（envelope=env_1）' }),
    ) as unknown as CollaborationHostToolHandler
    const deltas: string[] = []
    const res = await new ChannelBackendAdapter().runTurn(
      baseInput({ hostToolHandler: handler, onTextDelta: (d) => deltas.push(d) }),
    )

    // tool-call 转发：handler 收到 room_send 调用（真实校验/落盘由 service 侧 handler 做）
    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith({
      name: 'room_send',
      arguments: { toMemberId: 'cm_b', message: '看一下接口' },
    })
    // result 回注：streamFn 被调用两次；第二次的 context 里含工具结果（handler output）
    expect(httpState.streamFnCalls).toHaveLength(2)
    const secondContext = httpState.streamFnCalls[1]!.context as {
      messages: Array<{ role: string; content: unknown; toolCallId?: string }>
    }
    const reinjected = secondContext.messages.find((m) => m.toolCallId === 'tc-1')
    expect(reinjected).toBeTruthy()
    expect((reinjected!.content as Array<{ text: string }>)[0]!.text).toBe('通知已发送（envelope=env_1）')
    // 模型继续输出了最终正文（result 回注后同一模型循环继续）
    expect(res.text).toBe('通知已发出，继续工作')
    expect(deltas.join('')).toBe('通知已发出，继续工作')
  })

  test('awaitPeer：room_ask 成功后停掉 loop，不再次请求 streamFn（service 据此置 awaiting_peer）', async () => {
    httpState.scripts = [
      [
        {
          type: 'toolcall_end',
          contentIndex: 0,
          toolCall: {
            type: 'toolCall',
            id: 'tc-ask',
            name: 'room_ask',
            arguments: { toMemberId: 'cm_b', question: '接口定义对吗？' },
          },
        },
        {
          type: 'done',
          reason: 'toolUse',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'toolCall',
                id: 'tc-ask',
                name: 'room_ask',
                arguments: { toMemberId: 'cm_b', question: '接口定义对吗？' },
              },
            ],
            stopReason: 'toolUse',
          },
        },
      ],
    ]
    const handler = vi.fn(
      async () => ({ output: '提问已发送（request=req_1），正在等待。', awaitPeer: true }),
    ) as unknown as CollaborationHostToolHandler
    const res = await new ChannelBackendAdapter().runTurn(baseInput({ hostToolHandler: handler }))

    // 转发成功
    expect(handler).toHaveBeenCalledWith({
      name: 'room_ask',
      arguments: { toMemberId: 'cm_b', question: '接口定义对吗？' },
    })
    // awaitPeer 触发 abortAgent → Agent.abort 被调用
    expect(agentState.abortCount).toBeGreaterThanOrEqual(1)
    // loop 已停：没有第二次 streamFn 请求（不会在等待期间再做副作用）
    expect(httpState.streamFnCalls).toHaveLength(1)
    // 等待期间无正文
    expect(res.text).toBe('')
  })

  test('room_reply 同 turn 回注：工具结果回灌后模型继续，最终落盘正文', async () => {
    httpState.scripts = [
      [
        {
          type: 'toolcall_end',
          contentIndex: 0,
          toolCall: {
            type: 'toolCall',
            id: 'tc-reply',
            name: 'room_reply',
            arguments: { requestId: 'req_1', answer: '接口没问题，继续实现' },
          },
        },
        {
          type: 'done',
          reason: 'toolUse',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'toolCall',
                id: 'tc-reply',
                name: 'room_reply',
                arguments: { requestId: 'req_1', answer: '接口没问题，继续实现' },
              },
            ],
            stopReason: 'toolUse',
          },
        },
      ],
      [
        { type: 'text_delta', delta: '已回复协调者' },
        {
          type: 'done',
          reason: 'stop',
          message: { role: 'assistant', content: [{ type: 'text', text: '已回复协调者' }], stopReason: 'stop' },
        },
      ],
    ]
    const handler = vi.fn(async () => ({ output: '回复已发送（envelope=env_r）' })) as unknown as CollaborationHostToolHandler
    const res = await new ChannelBackendAdapter().runTurn(baseInput({ hostToolHandler: handler }))

    expect(handler).toHaveBeenCalledWith({
      name: 'room_reply',
      arguments: { requestId: 'req_1', answer: '接口没问题，继续实现' },
    })
    expect(httpState.streamFnCalls).toHaveLength(2)
    const secondContext = httpState.streamFnCalls[1]!.context as {
      messages: Array<{ toolCallId?: string; content: Array<{ text?: string }> }>
    }
    expect(
      secondContext.messages.find((m) => m.toolCallId === 'tc-reply')?.content[0]?.text,
    ).toBe('回复已发送（envelope=env_r）')
    expect(res.text).toBe('已回复协调者')
  })
})
