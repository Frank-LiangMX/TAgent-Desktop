/**
 * Pi 核子代理 task 工具
 *
 * 主 Agent 调用 task 工具 → 创建子 Pi Agent（限制 tools + 自定义 prompt）→
 * 子 Agent 执行 → 收集结果 → 返回 tool_result 给主 Agent。
 *
 * 子 Agent 是独立的 Pi Agent 实例（内存，无进程），执行完成后销毁。
 * 进度通过 onTaskEvent 推送 task_started / task_progress / task_notification，
 * 供主会话入口卡展示；完整 token 流仍不进主时间线（Checkpoint 2 W6）。
 */
import path from 'node:path'
import { Type } from '@earendil-works/pi-ai'
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import {
  isAutoModeAutoAllowTool,
  isWriteTool,
  resolveChannelRequestHeaders,
  type TAgentDesktopStreamPayload,
} from '@tagent/shared'
import { listChannels, getDecryptedApiKey } from '../../channel/channel-store'
import type { PiAgentAdapterConfig } from './pi-agent-adapter'
import {
  buildBuiltinSubagentDefinitions,
  resolveSubagentDefinition,
} from '../../agent/subagent-definitions'
import { resolvePiTaskAgent } from './agent-catalog-resolver'
import { listAgentProfiles } from '../../agent/agent-catalog-service'
import {
  buildDelegationModelPrompt,
  listDelegationModelCandidates,
  validateDelegationModelSelection,
} from '../../agent/delegation-model-policy'
import { tryReserveDelegationSlot } from '../../agent/delegation-capacity'
import { bashHooksForSession } from '../../agent/session-process-registry'
import { bindWorkspaceFileTool } from './workspace-file-tool'
import { budgetInstruction, budgetSummaryInstruction, delegatedBudget } from './subagent-budget'
import {
  parseTaskDelegationMode,
  type BackgroundCallbackPayload,
} from '../../agent/background-delegation'
import {
  enqueueParentCallback,
  notifyParentBackgroundEvent,
  registerBackgroundTask,
  unregisterBackgroundTask,
} from '../../agent/background-delegation-service'

// ESM-only 包延迟加载
type PiCoreModule = typeof import('@tagent/pi-core')
type PiAgentCoreModule = typeof import('@earendil-works/pi-agent-core')

/** task 工具参数 schema */
const taskSchema = Type.Object({
  /** 新 Agent 目录入口；传入后优先于 subagent_type / cli。 */
  agent: Type.Optional(
    Type.String({
      description: 'Agent 目录 profile id；仅允许调用 enabled 且 allowPiTask=true 的 profile。',
    }),
  ),
  subagent_type: Type.Optional(Type.String({
    description:
      '子代理类型：explorer（只读探索）、code-reviewer（代码审查，角色库 reviewer 投影）、researcher（技术调研）；亦可使用角色库 id：reviewer、analyst、coder、generalist 等。',
  })),
  prompt: Type.String({ description: '子代理要执行的任务描述' }),
  description: Type.Optional(Type.String({ description: '任务简短描述（日志用）' })),
  /** 可选的已配置渠道 id；填写后子代理可跨渠道调用。 */
  channel: Type.Optional(
    Type.String({ description: '已配置渠道 id；不填则继承父会话渠道。' }),
  ),
  /** 可选的已配置模型 id；填写后从指定渠道或唯一匹配渠道调用。 */
  model: Type.Optional(
    Type.String({ description: '已配置模型 id；不填则继承父会话模型。' }),
  ),
  /**
   * 父轮等不等。缺省 background：立刻返回任务 id，子代理独立跑完再回投。
   * foreground：本轮干等，结论作为 tool_result（旧行为）。
   */
  mode: Type.Optional(
    Type.Union([Type.Literal('foreground'), Type.Literal('background')], {
      description:
        'foreground=本轮等待结果；background=立刻返回，子代理在后台跑完后回投结论。默认 background。',
    }),
  ),
  selectionReason: Type.Optional(Type.String({ description: '选择 profile / channel / model 的理由；显式绑定时必填。' })),
  complexity: Type.Optional(
    Type.Union([Type.Literal('simple'), Type.Literal('standard'), Type.Literal('complex')]),
  ),
})

/**
 * 子代理生命周期事件（与 AgentEvent 中 task_* 同形；走 tagent_event 通道）。
 * 不用 Extract&lt;TAgentEvent&gt;——TAgentEvent 不含这三类。
 */
export type SubagentTaskLifecycleEvent =
  | {
      type: 'task_started'
      taskId: string
      toolUseId?: string
      description: string
      taskType?: string
    }
  | {
      type: 'task_progress'
      toolUseId: string
      taskId?: string
      description?: string
      lastToolName?: string
      taskType?: string
    }
  | {
      type: 'task_notification'
      taskId: string
      toolUseId?: string
      status: 'completed' | 'partial' | 'failed' | 'stopped'
      summary: string
      taskType?: string
    }

/** 子代理生命周期事件回调（推到父会话流，供入口卡 reduceTaskEvent） */
export type SubagentTaskEventSink = (event: SubagentTaskLifecycleEvent) => void

function resolveSubagentChannelConfig(opts: {
  parent: PiAgentAdapterConfig
  parentChannelId?: string | null
  requestedChannelId?: string
  requestedModelId?: string
}): {
  config: PiAgentAdapterConfig
  modelId: string
  channelId?: string
  availableModelIds: Set<string>
} {
  const channels = listChannels()
  const parentChannel = opts.parentChannelId
    ? channels.find((c) => c.id === opts.parentChannelId)
    : undefined
  if (opts.parentChannelId && (!parentChannel || !parentChannel.enabled) && !opts.requestedChannelId) {
    throw new Error(`父会话渠道「${opts.parentChannelId}」不存在或未启用`)
  }
  let channel = opts.requestedChannelId
    ? channels.find((c) => c.id === opts.requestedChannelId)
    : parentChannel
  if (opts.requestedChannelId && (!channel || !channel.enabled)) {
    throw new Error(`子代理指定的渠道「${opts.requestedChannelId}」不存在或未启用`)
  }
  if (opts.requestedModelId && !opts.requestedChannelId &&
      (!channel || !channel.models.some((m) => m.enabled && m.id === opts.requestedModelId))) {
    const matches = channels.filter(
      (c) => c.enabled && c.models.some((m) => m.enabled && m.id === opts.requestedModelId),
    )
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? `没有已启用渠道配置模型「${opts.requestedModelId}」`
          : `模型「${opts.requestedModelId}」在多个渠道存在，请同时指定 channel`,
      )
    }
    channel = matches[0]
  }
  if (!channel) {
    throw new Error('子代理无法确定已配置的父渠道，拒绝继承未绑定 channel/model')
  }
  const inheritedModelId = channel === parentChannel ? opts.parent.modelId : undefined
  const model = channel.models.find(
    (m) => m.enabled && m.id === (opts.requestedModelId ?? inheritedModelId ?? channel.defaultModelId),
  )
  if (!model) throw new Error(`渠道「${channel.name}」未启用指定模型「${opts.requestedModelId ?? inheritedModelId ?? ''}」`)
  const availableModelIds = new Set(channel.models.filter((m) => m.enabled).map((m) => m.id))
  if (channel.provider === 'kscc-internal') {
    throw new Error('该渠道已停用（历史 kscc CLI 通路已移除），不能作为 Pi 子代理渠道')
  }
  if (channel.provider === 'codex-internal') {
    throw new Error('Codex App Server 暂不支持作为 Pi 子代理渠道，请选择已配置 API Key 的渠道')
  }
  const apiKey = getDecryptedApiKey(channel.id)
  if (!apiKey) throw new Error(`渠道「${channel.name}」未配置 API Key`)
  return {
    config: {
      type: 'external',
      provider: channel.provider,
      apiProtocol: channel.apiProtocol,
      apiKey,
      baseUrl: channel.baseUrl,
      modelId: model.id,
      contextWindow: model.contextWindow,
      thinkingEnabled: false,
      headers: resolveChannelRequestHeaders(channel.provider, apiKey),
    },
    modelId: model.id,
    channelId: channel.id,
    availableModelIds,
  }
}

/** 子代理名容错：近名归一 + 角色库 id 直通 */
function resolveSubagentType(raw: string, available: string[]): string {
  if (available.includes(raw)) return raw
  // 角色库 id 可能未进 available 快照但 resolveSubagentDefinition 能解析
  if (resolveSubagentDefinition(raw, { claudeAvailable: false })) return raw

  const lower = raw.toLowerCase()
  if (lower === 'explore' || lower === '探索' || lower.includes('explor')) {
    const hit = available.find((n) => n === 'explorer')
    if (hit) return hit
  }
  if (lower === 'general' || lower === '通用' || lower === 'generalist') {
    if (available.includes('generalist')) return 'generalist'
    const hit = available.find((n) => n === 'explorer')
    if (hit) return hit
  }
  if (lower.includes('review') || lower.includes('审查')) {
    const hit = available.find((n) => n === 'code-reviewer' || n === 'reviewer')
    if (hit) return hit
  }
  if (lower.includes('research') || lower.includes('调研')) {
    const hit = available.find((n) => n === 'researcher')
    if (hit) return hit
  }
  if (lower.includes('architect') || lower.includes('架构') || lower === 'analyst') {
    if (available.includes('analyst')) return 'analyst'
  }
  if (lower.includes('coder') || lower.includes('后端') || lower.includes('implement')) {
    if (available.includes('coder')) return 'coder'
  }
  return raw
}

/** task 工具详情 */
export interface TaskToolDetails {
  subagentType: string
  resultLength: number
  toolCalls: number
  durationMs: number
  failureReason?: string
  stopReason?: string
  outcome?: 'completed' | 'partial' | 'failed' | 'stopped'
  budgetReason?: string
}

/**
 * 与主会话 beforeToolCall / PermissionService.createBeforeToolCall 兼容的钩子签名。
 * arguments 标可选以兼容 pi-agent-core 入参；父会话钩子（required arguments）可直接传入。
 */
export type SubagentBeforeToolCall = (ctx: {
  toolCall: { name: string; arguments: Record<string, unknown> }
  args?: unknown
}) => Promise<{ block: true; reason: string } | undefined>

export type SubagentApprovalRequest = (profileName: string, signal?: AbortSignal) => Promise<boolean>

/**
 * 创建 task 工具实例
 *
 * @param parentSessionId - 父会话 ID（日志用）
 * @param channelConfig - 渠道配置（子 Agent 复用 streamFn）
 * @param cwd - 工作目录
 * @param piCore - 已加载的 pi-core 模块
 * @param piAgentCore - 已加载的 pi-agent-core 模块
 * @param beforeToolCall - 父会话权限钩子（危险命令 + Chat 只读等）；缺失时拒绝派发
 * @param onTaskEvent - 进度事件出口（入口卡）；缺省则静默（仅 tool_result）
 * @param emitPayload - 推 IR 到父会话流（CLI 子代理详情 parentToolUseId 消息）；缺省则详情页无过程
 * @param sessionPreferredCliId - 保留旧签名的会话 CLI 偏好；Pi 主线不再自动使用它，只有
 *   task 显式传 cli 才启动 CLI 兼容后端。
 */
export function createTaskTool(
  parentSessionId: string,
  channelConfig: PiAgentAdapterConfig,
  cwd: string,
  piCore: PiCoreModule,
  piAgentCore: PiAgentCoreModule,
  beforeToolCall?: SubagentBeforeToolCall,
  onTaskEvent?: SubagentTaskEventSink,
  emitPayload?: (p: TAgentDesktopStreamPayload) => void,
  sessionPreferredCliId?: string | null,
  snapshotParentMessages?: () => unknown[],
  sessionChannelId?: string | null,
  requestApproval?: SubagentApprovalRequest,
): AgentTool<typeof taskSchema, TaskToolDetails> {
  // A delegated task must inherit the parent session's complete permission hook.
  // The pi-core fallback is intentionally not safe for Chat/plan/approval policy.
  const subBeforeToolCall = beforeToolCall

  const profileHint = listAgentProfiles()
    .filter((profile) => profile.enabled && profile.allowPiTask)
    .map((profile) => `${profile.id} (runtime=${profile.runtime}, channel=${profile.channelId ?? 'inherit'}, model=${profile.modelId ?? 'inherit'})`)
    .join('; ')

  return {
    name: 'task',
    label: 'task',
    description:
      '派发子任务给独立子代理执行。子代理有独立上下文，默认后台运行：立刻返回任务 id，父轮继续；子代理完成后把结论回投给主会话。需要本轮就用结果时传 mode=foreground。支持并行派发多个子代理。' +
      ' complexity 控制执行预算：simple 20 次工具/120 秒，standard（默认）40 次/300 秒，complex 80 次/600 秒；到达预算后返回 partial 阶段结果，主代理需检查未完成范围并接手，不能声称全部完成。' +
      `\n可用 Agent profiles（仅 enabled 且 allowPiTask；不含 API Key）：${profileHint || '无'}`,
    parameters: taskSchema,
    executionMode: 'parallel',
    execute: async (_toolCallId, params, signal): Promise<AgentToolResult<TaskToolDetails>> => {
      const startTime = Date.now()
      const toolUseId = _toolCallId
      const taskId = _toolCallId
      if (!subBeforeToolCall) {
        throw new Error('子代理缺少父会话权限处理器，已拒绝派发')
      }
      const catalogAgent = resolvePiTaskAgent(params.agent)
      if (catalogAgent?.profile.skills?.length || catalogAgent?.profile.mcpServers?.length) {
        throw new Error(`Agent「${catalogAgent.profile.name}」配置了暂不支持的 skills/mcpServers，当前不能安全派发`)
      }
      const explicitBinding = Boolean(params.agent || params.channel || params.model)
      const selectionReason = params.selectionReason?.trim()
      if (explicitBinding && !selectionReason) {
        throw new Error('显式选择子代理 profile / channel / model 时必须提供 selectionReason')
      }
      /** Profile 是权限上限；父会话的审批钩子仍然保留，不能由 Profile 绕过。 */
      const profileBeforeToolCall: SubagentBeforeToolCall = async (ctx) => {
        if (catalogAgent?.profile.permissionProfile === 'read-only') {
          const input =
            (ctx.args as Record<string, unknown> | undefined) ??
            ctx.toolCall.arguments ??
            {}
          if (
            ctx.toolCall.name !== 'AskUserQuestion' &&
            (!isAutoModeAutoAllowTool(ctx.toolCall.name, input, cwd) ||
              isWriteTool(ctx.toolCall.name, input))
          ) {
            return {
              block: true,
              reason: `Agent「${catalogAgent.profile.name}」是只读 Profile，不能执行写入或非只读工具`,
            }
          }
        }
        return subBeforeToolCall!(ctx)
      }
      // Pi 非 Claude 渠道：子代理继承父模型（不写死 haiku）
      const builtinAgents = buildBuiltinSubagentDefinitions(false)
      const legacySubagentType = params.subagent_type?.trim()
      const subagentType = catalogAgent
        ? catalogAgent.profile.id
        : legacySubagentType
          ? resolveSubagentType(legacySubagentType, Object.keys(builtinAgents))
          : ''

      // 目录命中 或 角色库动态投影
      const def =
        catalogAgent
          ? undefined
          : builtinAgents[subagentType] ??
            resolveSubagentDefinition(subagentType, { claudeAvailable: false })
      if (!catalogAgent && !def?.prompt) {
        throw new Error(
          `未知的子代理类型: ${params.subagent_type ?? '(未提供)'}。可用: ${Object.keys(builtinAgents).join(', ')} 或角色库 id`,
        )
      }
      const resolvedDef = def

      const description =
        (typeof params.description === 'string' && params.description.trim()) ||
        params.prompt.slice(0, 60)

      // CLI 只接受 task 参数显式指定；旧的会话 CLI 偏好不再自动把 Pi 子代理切到进程外。
      const requestedChannelId =
        typeof params.channel === 'string' && params.channel.trim() ? params.channel.trim() : undefined
      const requestedModelId =
        typeof params.model === 'string' && params.model.trim() ? params.model.trim() : undefined
      const profileChannelId = catalogAgent?.profile.channelId?.trim() || undefined
      const profileModelId = catalogAgent?.profile.modelId?.trim() || undefined
      const effectiveRequestedChannelId = profileChannelId ?? requestedChannelId
      const effectiveRequestedModelId = profileModelId ?? requestedModelId
      if (profileChannelId && requestedChannelId && profileChannelId !== requestedChannelId) {
        throw new Error('task channel 与 Agent profile channel 冲突')
      }
      if (profileModelId && requestedModelId && profileModelId !== requestedModelId) {
        throw new Error('task model 与 Agent profile model 冲突')
      }
      if (requestedChannelId && !requestedModelId && !profileModelId && requestedChannelId !== sessionChannelId) {
        throw new Error('跨渠道派发必须同时指定 model')
      }
      const effectiveCwd = catalogAgent?.workspacePath ?? cwd
      if (catalogAgent?.profile.workspacePolicy === 'fixed' &&
        catalogAgent.workspacePath &&
        !sameWorkspace(catalogAgent.workspacePath, cwd)) {
        throw new Error(`Agent「${catalogAgent.profile.name}」的 fixed workspace 必须与父会话 workspace 相同`)
      }
      if (signal?.aborted) throw new Error('子代理任务在启动前已取消')

      console.log(
        `[子代理 ${parentSessionId}] 启动 ${subagentType}（角色投影）: ${description}` +
          (effectiveRequestedChannelId || effectiveRequestedModelId
            ? ` [model=${effectiveRequestedModelId ?? 'default'}${effectiveRequestedChannelId ? `@${effectiveRequestedChannelId}` : ''}]`
            : ''),
      )

      const mode = parseTaskDelegationMode(params.mode)
      if (catalogAgent && mode === 'background' && !catalogAgent.profile.allowBackground) {
        throw new Error(`Agent「${catalogAgent.profile.name}」未允许后台运行，请改用 mode=foreground`)
      }
      const taskAbort = new AbortController()
      const abortTask = (): void => taskAbort.abort()
      if (signal) signal.addEventListener('abort', abortTask, { once: true })
      registerBackgroundTask({ taskId, parentSessionId, description, subagentType, startedAt: startTime, abort: taskAbort })
      let releaseSlot: (() => void) | undefined
      const cleanupTask = (): void => {
        unregisterBackgroundTask(taskId)
        releaseSlot?.()
        if (signal) signal.removeEventListener('abort', abortTask)
      }
      const runSignal = taskAbort.signal
      if (catalogAgent?.profile.approvalRequired) {
        try {
          if (!requestApproval) throw new Error(`Agent「${catalogAgent.profile.name}」需要审批，但当前没有 approval hook`)
          if (!(await requestApproval(catalogAgent.profile.name, runSignal))) {
            throw new Error(`Agent「${catalogAgent.profile.name}」审批未通过`)
          }
        } catch (error) {
          cleanupTask()
          throw error
        }
      }
      const emitStarted = (sink?: SubagentTaskEventSink): void => {
        sink?.({
          type: 'task_started',
          taskId,
          toolUseId,
          description,
          taskType: 'local_agent',
        })
      }

      // Approval may have yielded while the parent was stopped. Never start a child afterward.
      if (runSignal.aborted || signal?.aborted) {
        cleanupTask()
        throw new Error('子代理任务在启动前已取消')
      }
      try {
        releaseSlot = tryReserveDelegationSlot(parentSessionId, taskId) ?? undefined
      } catch (error) {
        cleanupTask()
        throw error
      }
      if (!releaseSlot) {
        cleanupTask()
        return {
          content: [{ type: 'text', text: '[子代理 status=failed]\n子代理已达父会话共享并发上限。' }],
          details: { subagentType, resultLength: 0, toolCalls: 0, durationMs: 0, outcome: 'failed', failureReason: '子代理已达父会话共享并发上限' },
        }
      }

      if (mode === 'background') {
        let fork: unknown[]
        try {
          fork = snapshotParentMessages?.() ?? []
          emitStarted(onTaskEvent)
        } catch (error) {
          cleanupTask()
          throw error
        }
        void runDelegatedTask(runSignal)
          .then((outcome) => {
            const stopped = runSignal.aborted || outcome.status === 'stopped'
            const payload: BackgroundCallbackPayload = {
              taskId,
              description,
              subagentType,
              status: outcome.status,
              summary: outcome.summary,
              resultText: outcome.resultText,
              durationMs: outcome.details.durationMs,
              fork,
            }
            notifyParentBackgroundEvent(parentSessionId, {
              type: 'task_notification',
              taskId,
              toolUseId,
              status: outcome.status,
              summary: outcome.summary,
              taskType: 'local_agent',
            })
            if (!stopped) enqueueParentCallback(parentSessionId, payload)
          })
          .catch((err) => {
            const stopped = runSignal.aborted
            const msg = err instanceof Error ? err.message : String(err)
            notifyParentBackgroundEvent(parentSessionId, {
              type: 'task_notification',
              taskId,
              toolUseId,
              status: stopped ? 'stopped' : 'failed',
              summary: stopped ? '已停止' : '执行失败',
              taskType: 'local_agent',
            })
            if (!stopped) enqueueParentCallback(parentSessionId, {
              taskId,
              description,
              subagentType,
              status: 'failed',
              summary: '执行失败',
              resultText: `[子代理异常] ${msg}`,
              durationMs: Date.now() - startTime,
              fork,
            })
          })
          .finally(() => {
            cleanupTask()
          })
          .catch(() => console.warn('[子代理] 完成通知未能投递；任务已清理'))
        const ack = `已派出后台子代理 ${taskId}（${subagentType}：${description}）。父轮继续；完成后会把结论回投到本会话，请届时收口，不要空等。`
        return {
          content: [{ type: 'text', text: ack }],
          details: { subagentType, resultLength: ack.length, toolCalls: 0, durationMs: Date.now() - startTime },
        }
      }

      try {
        emitStarted(onTaskEvent)
        return await runDelegatedTask(runSignal)
      } finally {
        cleanupTask()
      }

      async function runDelegatedTask(
        execSignal: AbortSignal | undefined,
      ): Promise<AgentToolResult<TaskToolDetails> & { status: 'completed' | 'partial' | 'failed' | 'stopped'; summary: string; resultText: string }> {
      const resolvedChannelConfig = resolveSubagentChannelConfig({
        parent: channelConfig,
        parentChannelId: sessionChannelId,
        requestedChannelId: effectiveRequestedChannelId,
        requestedModelId: effectiveRequestedModelId,
      })
      const bindingChannelId = resolvedChannelConfig.channelId ?? effectiveRequestedChannelId ?? sessionChannelId
      if (!bindingChannelId) throw new Error('子代理无法确定实际 channelId，拒绝使用未绑定模型')
      validateDelegationModelSelection({
        channelId: bindingChannelId,
        modelId: resolvedChannelConfig.modelId,
        selectionReason: selectionReason || '继承父会话真实 channel/model 绑定',
        complexity: params.complexity,
      })
      // 创建子 Agent（限制 tools，自定义 systemPrompt；可按 task 参数切换已配置渠道/模型）
      // 挂 beforeToolCall：与主会话同权限（至少危险命令 + Chat 只读）
      const subTools = resolveSubagentTools(
        catalogAgent?.profile.tools ?? resolvedDef?.tools ?? [],
        piCore,
        effectiveCwd,
        parentSessionId,
      )
      const effectiveModelId = effectiveRequestedModelId
      const subStreamFn = createSubagentStreamFn(resolvedChannelConfig.config, piCore, effectiveModelId)
      const budget = delegatedBudget(params.complexity)
      const executionStartedAt = Date.now()
      let toolCallCount = 0
      let budgetReason = ''
      let summaryRequested = false

      const subAgent = new piAgentCore.Agent({
        initialState: {
          systemPrompt: `${catalogAgent?.profile.systemPrompt ?? resolvedDef?.prompt ?? ''}\n\n${budgetInstruction(budget.toolCalls, budget.timeoutMs)}`,
          model: buildSubagentModel(resolvedChannelConfig.config, effectiveModelId),
          thinkingLevel: 'off',
          tools: subTools,
          messages: [],
        },
        streamFn: (model, context, options) => {
          if (summaryRequested) {
            throw new Error('子代理在预算收尾后仍请求工具，未生成阶段报告')
          }
          if (toolCallCount >= budget.toolCalls) budgetReason ||= `达到 ${budget.toolCalls} 次工具调用预算`
          if (Date.now() - executionStartedAt >= budget.timeoutMs - budget.summaryMs) budgetReason ||= '已进入时间预算的收尾阶段'
          if (!budgetReason) return subStreamFn(model, context, options)
          summaryRequested = true
          if (timeoutHandle) clearTimeout(timeoutHandle)
          timeoutHandle = setTimeout(() => {
            failed = true
            failureReason ||= '子代理阶段报告生成超时'
            subAgent.abort()
          }, Math.max(0, Math.min(budget.summaryMs, budget.timeoutMs - (Date.now() - executionStartedAt))))
          return subStreamFn(model, {
            ...context,
            tools: [],
            systemPrompt: `${context.systemPrompt ?? ''}\n\n${budgetSummaryInstruction(budgetReason)}`,
          }, options)
        },
        toolExecution: 'sequential',
        beforeToolCall: async (ctx) => {
          if (summaryRequested || toolCallCount > budget.toolCalls || Date.now() - executionStartedAt >= budget.timeoutMs - budget.summaryMs) {
            budgetReason ||= toolCallCount > budget.toolCalls ? `达到 ${budget.toolCalls} 次工具调用预算` : '已进入时间预算的收尾阶段'
            return { block: true, reason: budgetSummaryInstruction(budgetReason) }
          }
          return profileBeforeToolCall(ctx)
        },
      })

      // 收集子 Agent 的文本输出
      let lastText = ''
      let lastNonEmptyText = ''
      let failed = false
      let failureReason = ''
      let lastAssistant: { stopReason?: string; errorMessage?: string; content?: unknown[] } | undefined
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined

      const unsubscribe = subAgent.subscribe(async (event) => {
        if (event.type === 'message_end') {
          const message = (event as { message?: { role?: string; stopReason?: string; errorMessage?: string; content?: unknown[] } }).message
          if (message?.role !== 'assistant') return
          lastAssistant = message
          const content = Array.isArray(message?.content) ? message.content : []
          const text = content
            .filter((block): block is { type: 'text'; text: string } =>
              Boolean(block) && typeof block === 'object' &&
              (block as { type?: unknown }).type === 'text' &&
              typeof (block as { text?: unknown }).text === 'string',
            )
            .map((block) => block.text)
            .join('')
          lastText = text
          if (text.trim()) lastNonEmptyText = text
          if (message?.errorMessage) {
            failed = true
            failureReason ||= message.errorMessage
          }
        } else if (event.type === 'tool_execution_start') {
          toolCallCount++
          const toolName =
            typeof (event as { toolName?: string }).toolName === 'string'
              ? (event as { toolName: string }).toolName
              : 'tool'
          onTaskEvent?.({
            type: 'task_progress',
            toolUseId,
            taskId,
            lastToolName: toolName,
            taskType: 'local_agent',
          })
          notifyParentBackgroundEvent(parentSessionId, {
            type: 'task_progress',
            taskId,
            toolUseId,
            lastToolName: toolName,
            taskType: 'local_agent',
          })
        }
      })

      try {
        // 执行子 Agent（带 abort signal）
        if (execSignal?.aborted) {
          failed = true
          failureReason ||= '子代理任务在 prompt 前已取消'
        } else {
          const onAbort = (): void => { void subAgent.abort() }
          if (execSignal) execSignal.addEventListener('abort', onAbort, { once: true })
          try {
            timeoutHandle = setTimeout(() => {
              failed = true
              failureReason ||= `子代理超时（${budget.timeoutMs}ms）`
              void subAgent.abort()
            }, budget.timeoutMs)
            await subAgent.prompt(params.prompt)
            await subAgent.waitForIdle()
            const finalContent = Array.isArray(lastAssistant?.content) ? lastAssistant.content : []
            const finalHasToolUse = finalContent.some((block) =>
              Boolean(block) && typeof block === 'object' &&
              (block as { type?: unknown }).type === 'toolCall',
            )
            if (!lastAssistant) {
              failed = true
              failureReason ||= '子代理未产生最终 assistant message_end'
            } else if (lastAssistant.stopReason !== 'stop') {
              failed = true
              failureReason ||= `子代理终态不是 stop（${lastAssistant.stopReason || 'unknown'}）`
            } else if (finalHasToolUse || !lastText.trim()) {
              failed = true
              failureReason ||= finalHasToolUse ? '最终 assistant 仍包含 tool use' : '最终 assistant 无文本'
            }
          } finally {
            if (execSignal) execSignal.removeEventListener('abort', onAbort)
          }
        }
      } catch (err) {
        failed = true
        const msg = err instanceof Error ? err.message : String(err)
        failureReason ||= msg
        console.error(`[子代理 ${parentSessionId}] ${subagentType} 执行失败:`, msg)
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle)
        unsubscribe()
        subAgent.abort()
      }

      const durationMs = Date.now() - startTime
      const aborted = Boolean(execSignal?.aborted)
      const resultText = failed
        ? lastNonEmptyText ? `[未完成的阶段输出]\n${lastNonEmptyText}` : '(子代理无文本输出)'
        : lastText
      const finalResultText = failed && failureReason
        ? `[子代理${aborted ? '已停止' : '执行失败'}] ${failureReason}\n${toolCallCount} 次工具调用尝试 · ${Math.round(durationMs / 1000)}s\n${resultText}`
        : budgetReason ? `[阶段结果，任务尚未全部完成] ${budgetReason}\n${resultText}` : resultText
      // 截断过长结果（主 Agent context 有限）
      const truncated = finalResultText.length > 12000
        ? finalResultText.slice(0, 12000) + `\n... (截断，共 ${finalResultText.length} 字符)`
        : finalResultText

      const status: 'completed' | 'partial' | 'failed' | 'stopped' = aborted
        ? 'stopped'
        : failed
          ? 'failed'
          : budgetReason ? 'partial' : 'completed'
      const summary =
        status === 'completed'
          ? `${toolCallCount} 次工具 · ${Math.round(durationMs / 1000)}s`
          : status === 'partial'
            ? `${budgetReason} · 已返回阶段结果`
          : status === 'failed'
            ? failureReason.slice(0, 240) || '执行失败'
            : '已停止'

      onTaskEvent?.({
        type: 'task_notification',
        taskId,
        toolUseId,
        status,
        summary,
        taskType: 'local_agent',
      })

      console.log(`[子代理 ${parentSessionId}] ${taskId} ${subagentType} ${status}: ${toolCallCount} 次工具调用尝试, ${durationMs}ms${failureReason ? `, ${failureReason}` : ''}`)

      return {
          content: [{ type: 'text', text: `[子代理 status=${status}]\n${truncated}` }],
        details: {
          subagentType,
          resultLength: resultText.length,
          toolCalls: toolCallCount,
          durationMs,
          outcome: status,
          ...(budgetReason ? { budgetReason } : {}),
          ...(failureReason ? { failureReason } : {}),
          ...(lastAssistant?.stopReason ? { stopReason: lastAssistant.stopReason } : {}),
        },
        status,
        summary,
          resultText: finalResultText,
      }
      }
    },
  }
}

/** 根据子代理定义的 tools 列表，从 pi-core 取对应工具（限制子代理可用工具） */
function resolveSubagentTools(
  toolNames: string[],
  piCore: PiCoreModule,
  cwd: string,
  sessionId: string,
): AgentTool[] {
  const allTools = piCore.defaultTools
  if (toolNames.length === 0) {
    return allTools
      .filter((t) => t.name !== 'task')
      .map((t) =>
        t.name === 'Bash'
          ? piCore.createBashTool(cwd, bashHooksForSession(sessionId))
          : bindWorkspaceFileTool(t, cwd),
      )
  }
  const allowed = new Set(toolNames)
  return allTools
    .filter((t) => allowed.has(t.name) && t.name !== 'task')
    .map((t) =>
      t.name === 'Bash'
        ? piCore.createBashTool(cwd, bashHooksForSession(sessionId))
        : bindWorkspaceFileTool(t, cwd),
    )
}

/** 为子 Agent 创建 streamFn（复用父 Agent 的渠道配置；可选角色 model 覆盖） */
function createSubagentStreamFn(
  channelConfig: PiAgentAdapterConfig,
  piCore: PiCoreModule,
  modelOverride?: string,
) {
  return piCore.createHttpDirectStreamFn({
    apiProtocol: channelConfig.apiProtocol,
    provider: channelConfig.provider,
    apiKey: channelConfig.apiKey,
    baseUrl: channelConfig.baseUrl,
    modelId: modelOverride || channelConfig.modelId,
    contextWindow: channelConfig.contextWindow,
    thinkingEnabled: false,
    headers: channelConfig.headers,
  })
}

/** 构造子 Agent 占位 Model（role.modelPool 首项可覆盖） */
function buildSubagentModel(channelConfig: PiAgentAdapterConfig, modelOverride?: string) {
  const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const id = modelOverride || channelConfig.modelId
  return {
    id,
    name: id,
    api: (channelConfig.apiProtocol === 'openai-chat' ? 'openai-completions' : channelConfig.apiProtocol ?? resolveApiForProvider(channelConfig.provider)) as 'anthropic-messages' | 'openai-completions' | 'openai-responses' | 'google-generative-ai',
    provider: channelConfig.provider,
    baseUrl: channelConfig.baseUrl ?? '',
    reasoning: false,
    input: ['text'] as ('text' | 'image')[],
    cost: ZERO_COST,
    contextWindow:
      channelConfig.contextWindow && channelConfig.contextWindow > 0
        ? channelConfig.contextWindow
        : 200_000,
    maxTokens: 8_192,
  }
}

function resolveApiForProvider(provider: string): string {
  switch (provider) {
    case 'anthropic': return 'anthropic-messages'
    case 'deepseek': return 'openai-completions'
    case 'openai': return 'openai-responses'
    case 'google': return 'google-generative-ai'
    default: return 'openai-completions'
  }
}

function resolvedParentModel(channelConfig: PiAgentAdapterConfig): string {
  return channelConfig.modelId
}

function sameWorkspace(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
}

/** Expose the model inventory without credentials for the main model's tool discovery. */
export function createDelegationModelsTool(): AgentTool<ReturnType<typeof Type.Object>, { candidates: number }> {
  const parameters = Type.Object({})
  return {
    name: 'delegation_models',
    label: 'delegation_models',
    description: buildDelegationModelPrompt(),
    parameters,
    execute: async () => {
      const candidates = listDelegationModelCandidates()
      return {
        content: [{ type: 'text', text: JSON.stringify(candidates) }],
        details: { candidates: candidates.length },
      }
    },
  } as AgentTool<ReturnType<typeof Type.Object>, { candidates: number }>
}
