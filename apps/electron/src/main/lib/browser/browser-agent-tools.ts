import { Type } from '@earendil-works/pi-ai'
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import { getBrowserController } from '../ipc/browser-service'

export const BROWSER_SYSTEM_PROMPT = '## 受管浏览器\n网页/实时查询策略：如果当前会话已绑定知识库，且知识库提示要求先调用 kb_search，必须先完成 kb_search，不能先调用 WebSearch 或 WebFetch；仅当知识库模式允许通用补充且知识库检索结果不足时，才可使用网页工具。没有知识库前置要求时，如果当前运行时提供 WebSearch 或 WebFetch，可先使用它们获取初步结果；如果工具失败、为空、过短、缺乏来源或时效性不足，系统会注入回退指令，此时必须调用 browser_open，再使用 browser_observe、browser_click、browser_type、browser_scroll 或 browser_screenshot 完成网页核验。如果当前运行时没有普通网页搜索工具，网页查询直接使用 browser_open。用户明确要求打开网页或执行网页交互时，直接使用 browser_open。遇到登录、验证码或风控挑战时，调用 browser_takeover，让用户在网页标签中完成操作；用户完成后再调用 browser_resume。'

export interface BrowserToolContext {
  sessionId: string
}

function textResult(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] }
}

function piText(text: string): AgentToolResult<Record<string, unknown>> {
  return { content: [{ type: 'text', text }], details: {} }
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

export async function handleBrowserOpen(
  args: Record<string, unknown>,
  ctx: BrowserToolContext,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    const state = await getBrowserController().open(
      ctx.sessionId,
      args.url != null ? String(args.url) : undefined,
      args.title != null ? String(args.title) : undefined,
    )
    return textResult(json({ ok: true, state }))
  } catch (error) {
    return textResult('错误：' + (error instanceof Error ? error.message : String(error)))
  }
}

export async function handleBrowserObserve(
  ctx: BrowserToolContext,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    return textResult(json(await getBrowserController().observe(ctx.sessionId)))
  } catch (error) {
    return textResult('错误：' + (error instanceof Error ? error.message : String(error)))
  }
}

export async function handleBrowserNavigate(
  args: Record<string, unknown>,
  ctx: BrowserToolContext,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    return textResult(json(await getBrowserController().navigate({
      sessionId: ctx.sessionId,
      url: String(args.url ?? ''),
    })))
  } catch (error) {
    return textResult('错误：' + (error instanceof Error ? error.message : String(error)))
  }
}

export async function handleBrowserClick(
  args: Record<string, unknown>,
  ctx: BrowserToolContext,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    return textResult(json(await getBrowserController().click({
      sessionId: ctx.sessionId,
      ref: String(args.ref ?? ''),
    })))
  } catch (error) {
    return textResult('错误：' + (error instanceof Error ? error.message : String(error)))
  }
}

export async function handleBrowserType(
  args: Record<string, unknown>,
  ctx: BrowserToolContext,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    return textResult(json(await getBrowserController().type({
      sessionId: ctx.sessionId,
      ref: String(args.ref ?? ''),
      text: String(args.text ?? ''),
      pressEnter: args.pressEnter === true,
    })))
  } catch (error) {
    return textResult('错误：' + (error instanceof Error ? error.message : String(error)))
  }
}

export async function handleBrowserScroll(
  args: Record<string, unknown>,
  ctx: BrowserToolContext,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    return textResult(json(await getBrowserController().scroll({
      sessionId: ctx.sessionId,
      deltaX: typeof args.deltaX === 'number' ? args.deltaX : 0,
      deltaY: typeof args.deltaY === 'number' ? args.deltaY : 700,
    })))
  } catch (error) {
    return textResult('错误：' + (error instanceof Error ? error.message : String(error)))
  }
}

export async function handleBrowserScreenshot(
  ctx: BrowserToolContext,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    const screenshot = await getBrowserController().screenshot(ctx.sessionId)
    return textResult(json({
      ok: true,
      tabId: screenshot.tabId,
      width: screenshot.width,
      height: screenshot.height,
      note: '截图已生成并可在浏览器标签页中查看；Agent 侧不内联大图数据。',
    }))
  } catch (error) {
    return textResult('错误：' + (error instanceof Error ? error.message : String(error)))
  }
}

export async function handleBrowserTakeover(
  args: Record<string, unknown>,
  ctx: BrowserToolContext,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  return textResult(json(getBrowserController().takeover(ctx.sessionId, args.reason != null ? String(args.reason) : undefined)))
}

export async function handleBrowserResume(
  ctx: BrowserToolContext,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  return textResult(json(getBrowserController().resume(ctx.sessionId)))
}

export function buildPiBrowserTools(ctx: BrowserToolContext): AgentTool[] {
  return [
    {
      name: 'browser_open',
      label: 'browser_open',
      description: '打开受管浏览器标签页。只允许 http(s) 网页；登录、验证码等步骤由用户在标签页中完成。',
      parameters: Type.Object({
        url: Type.Optional(Type.String({ description: '完整的 http(s) URL' })),
        title: Type.Optional(Type.String({ description: '浏览器 Dockview 标签标题' })),
      }),
      execute: async (_id, params) => piText((await handleBrowserOpen(params as Record<string, unknown>, ctx)).content[0]!.text),
    },
    {
      name: 'browser_navigate',
      label: 'browser_navigate',
      description: '在当前浏览器标签中导航到 http(s) URL。',
      parameters: Type.Object({ url: Type.String() }),
      execute: async (_id, params) => piText((await handleBrowserNavigate(params as Record<string, unknown>, ctx)).content[0]!.text),
    },
    {
      name: 'browser_observe',
      label: 'browser_observe',
      description: '观察当前网页可交互元素，返回短期有效的 b-generation-index 引用。',
      parameters: Type.Object({}),
      execute: async () => piText((await handleBrowserObserve(ctx)).content[0]!.text),
    },
    {
      name: 'browser_click',
      label: 'browser_click',
      description: '点击 browser_observe 返回的页面元素引用。',
      parameters: Type.Object({ ref: Type.String() }),
      execute: async (_id, params) => piText((await handleBrowserClick(params as Record<string, unknown>, ctx)).content[0]!.text),
    },
    {
      name: 'browser_type',
      label: 'browser_type',
      description: '向 browser_observe 返回的可编辑元素输入文本，可选择按 Enter。',
      parameters: Type.Object({ ref: Type.String(), text: Type.String(), pressEnter: Type.Optional(Type.Boolean()) }),
      execute: async (_id, params) => piText((await handleBrowserType(params as Record<string, unknown>, ctx)).content[0]!.text),
    },
    {
      name: 'browser_scroll',
      label: 'browser_scroll',
      description: '滚动当前网页。',
      parameters: Type.Object({ deltaY: Type.Optional(Type.Number()), deltaX: Type.Optional(Type.Number()) }),
      execute: async (_id, params) => piText((await handleBrowserScroll(params as Record<string, unknown>, ctx)).content[0]!.text),
    },
    {
      name: 'browser_screenshot',
      label: 'browser_screenshot',
      description: '生成当前网页截图，并在浏览器标签页中提供查看。',
      parameters: Type.Object({}),
      execute: async () => piText((await handleBrowserScreenshot(ctx)).content[0]!.text),
    },
    {
      name: 'browser_takeover',
      label: 'browser_takeover',
      description: '暂停自动操作并请求用户在网页中完成登录、验证码或其他人工步骤。',
      parameters: Type.Object({ reason: Type.Optional(Type.String()) }),
      execute: async (_id, params) => piText((await handleBrowserTakeover(params as Record<string, unknown>, ctx)).content[0]!.text),
    },
    {
      name: 'browser_resume',
      label: 'browser_resume',
      description: '用户完成人工步骤后恢复浏览器自动操作。',
      parameters: Type.Object({}),
      execute: async () => piText((await handleBrowserResume(ctx)).content[0]!.text),
    },
  ]
}

export async function injectBrowserMcpServer(
  mcpServers: Record<string, unknown>,
  ctx: BrowserToolContext,
): Promise<void> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  const { z } = await import('zod')
  const tools: any[] = []
  tools.push(
    sdk.tool(
      'browser_open',
      '打开受管浏览器标签页，只允许 http(s)，登录和验证码由用户接管。',
      { url: z.string().optional(), title: z.string().optional() },
      async (args: Record<string, unknown>) => handleBrowserOpen(args, ctx),
    ),
    sdk.tool(
      'browser_navigate',
      '导航到 http(s) URL。',
      { url: z.string() },
      async (args: Record<string, unknown>) => handleBrowserNavigate(args, ctx),
    ),
    sdk.tool(
      'browser_observe',
      '观察可交互网页元素并返回短期有效引用。',
      {},
      async () => handleBrowserObserve(ctx),
      { annotations: { readOnlyHint: true } },
    ),
    sdk.tool(
      'browser_click',
      '点击页面元素引用。',
      { ref: z.string() },
      async (args: Record<string, unknown>) => handleBrowserClick(args, ctx),
    ),
    sdk.tool(
      'browser_type',
      '向页面可编辑元素输入文字。',
      { ref: z.string(), text: z.string(), pressEnter: z.boolean().optional() },
      async (args: Record<string, unknown>) => handleBrowserType(args, ctx),
    ),
    sdk.tool(
      'browser_scroll',
      '滚动网页。',
      { deltaY: z.number().optional(), deltaX: z.number().optional() },
      async (args: Record<string, unknown>) => handleBrowserScroll(args, ctx),
    ),
    sdk.tool(
      'browser_screenshot',
      '生成当前网页截图。',
      {},
      async () => handleBrowserScreenshot(ctx),
      { annotations: { readOnlyHint: true } },
    ),
    sdk.tool(
      'browser_takeover',
      '请求用户在网页中完成登录、验证码或其他人工步骤。',
      { reason: z.string().optional() },
      async (args: Record<string, unknown>) => handleBrowserTakeover(args, ctx),
    ),
    sdk.tool(
      'browser_resume',
      '恢复浏览器自动操作。',
      {},
      async () => handleBrowserResume(ctx),
    ),
  )
  mcpServers.browser = sdk.createSdkMcpServer({
    name: 'browser',
    version: '1.0.0',
    tools,
  })
}
