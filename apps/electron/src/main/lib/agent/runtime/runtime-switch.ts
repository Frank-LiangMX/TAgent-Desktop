/**
 * 三内核手动切换（ADR-0011 §5 首期切片）**纯逻辑**。
 *
 * 这里只放可单测的判定与拼装，不碰 IPC / 适配器 / 磁盘：
 * - 目标内核 ↔ 渠道 provider ↔ 适配器 kind 的映射与兼容校验
 * - 静默（quiescence）判定：running / stopping / 审批在途 / 切换在途
 * - 切换事务的 meta patch（归档原生绑定 + 清空生效原生 id + 待投递交接资料）
 * - 交接资料正文生成与一次性注入、投递成功后的消费 patch
 *
 * 见 docs/decisions/ADR-0011-three-runtime-agent-workbench.md §4 / §5。
 * 宿主侧调用方：apps/electron/src/main/lib/ipc/session-service.ts。
 */
import type {
  AgentRuntimeKind,
  AgentSessionMeta,
  Channel,
  RuntimeHandoff,
  RuntimeNativeBinding,
  SessionRuntimeSwitchInput,
  TAgentMessage,
} from '@tagent/shared'
import {
  buildMoAHistoryFromMessages,
  isChannelCompatibleWithRuntime,
  isMoaModelId,
  panelMessageToHistoryIR,
} from '@tagent/shared'

/**
 * 适配器分组（与 main/lib/adapters/index.ts 的 `ChannelKind` 同形）。
 * 在此重声明以避免 shared 反向依赖主进程适配器工厂。
 */
export type RuntimeAdapterKind = 'external' | 'codex' | 'claude-code'

/** 用户可见的内核名（错误文案 / 交接资料标题共用，不出现内部实现名）。 */
export const RUNTIME_DISPLAY_NAME: Record<AgentRuntimeKind, string> = {
  pi: 'Pi',
  codex: 'Codex',
  'claude-code': 'Claude Code',
}

/** 交接资料正文里「近期可见对话」的字符预算（复用 MoA 历史注入口径）。 */
export const RUNTIME_HANDOFF_HISTORY_CHAR_BUDGET = 12_000
/** 交接资料正文总预算上限（含目标/约束/成果路径等固定段落）。 */
export const RUNTIME_HANDOFF_TOTAL_CHAR_BUDGET = 14_000
/**
 * 切换事务等待旧内核「停止后原生终态」上限（毫秒）。
 * 超时即视为「未能确认静默」→ 拒绝切换（fail-closed），不默认放行。
 */
export const RUNTIME_SWITCH_SETTLE_TIMEOUT_MS = 15_000
/** 目标 / 约束段落单条文本截断长度。 */
const HANDOFF_SNIPPET_CHARS = 1_200

/** Legacy provider hint used only for records without an explicit runtime binding. */
export function expectedProviderFor(runtime: AgentRuntimeKind): string | 'external' {
  switch (runtime) {
    case 'codex':
      return 'codex-internal'
    case 'claude-code':
      return 'external'
    case 'pi':
      return 'external'
  }
}

/** 目标内核对应的适配器分组。 */
export function adapterKindForRuntime(runtime: AgentRuntimeKind): RuntimeAdapterKind {
  switch (runtime) {
    case 'codex':
      return 'codex'
    case 'claude-code':
      return 'claude-code'
    case 'pi':
      return 'external'
  }
}

/** 目标内核写入 `meta.internalBackend` 的值（Pi 无本机后端概念 → undefined）。 */
export function internalBackendForRuntime(
  runtime: AgentRuntimeKind,
): AgentSessionMeta['internalBackend'] {
  if (runtime === 'codex') return 'codex-app-server'
  if (runtime === 'claude-code') return 'claude-code'
  return undefined
}

/**
 * 渠道是否可作为该内核的承载渠道。
 * - codex / kscc：provider 必须精确等于本机渠道
 * - pi：必须**不是**本机渠道（kscc-internal / codex-internal），即外部 API 渠道
 * - 渠道必须 enabled
 */
export function channelAcceptsRuntime(
  channel: Pick<Channel, 'provider' | 'apiProtocol' | 'enabled'>,
  runtime: AgentRuntimeKind,
): boolean {
  return isChannelCompatibleWithRuntime(channel, runtime)
}

/**
 * 从会话 meta 反推当前生效的内核；无渠道 / 渠道缺失 / 已废弃的本机 CLI 记录 → undefined。
 */
export function resolveBoundRuntime(
  meta: Pick<AgentSessionMeta, 'agentRuntime' | 'channelId' | 'internalBackend' | 'sdkSessionId' | 'codexThreadId'> | undefined,
  resolveChannelProvider: (channelId: string) => string | undefined,
): AgentRuntimeKind | undefined {
  if (meta?.agentRuntime) return meta.agentRuntime
  const channelId = meta?.channelId
  if (!channelId) return undefined
  const provider = resolveChannelProvider(channelId)
  if (!provider) return undefined
  if (provider === 'codex-internal') return 'codex'
  if (provider === 'kscc-internal') {
    // 历史本机渠道：codex 后端仍可识别；claude-code / kscc 后端已不可运行（返回 undefined）。
    if (meta?.internalBackend === 'codex-app-server') return 'codex'
    if (meta?.codexThreadId) return 'codex'
    return undefined
  }
  return 'pi'
}

/** 该内核在 meta 上**当前生效**的原生会话 id。 */
export function activeNativeSessionId(
  meta: Pick<AgentSessionMeta, 'sdkSessionId' | 'codexThreadId'> | undefined,
  runtime: AgentRuntimeKind,
): string | undefined {
  if (runtime === 'codex') return meta?.codexThreadId
  if (runtime === 'claude-code') return meta?.sdkSessionId
  return undefined
}

/**
 * 仅凭 meta 字段反推内核（渠道不可查时的兜底；能查渠道时应优先用 resolveBoundRuntime）。
 *
 * 历史 kscc CLI 记录（`internalBackend === 'kscc'` 或仅有 `sdkSessionId`）已不可运行，
 * 无从归一到任何现行内核 → 返回 undefined。
 */
export function inferRuntimeFromMeta(
  meta: Pick<AgentSessionMeta, 'agentRuntime' | 'internalBackend' | 'sdkSessionId' | 'codexThreadId'> | undefined,
): AgentRuntimeKind | undefined {
  if (meta?.agentRuntime) return meta.agentRuntime
  if (meta?.internalBackend === 'codex-app-server') return 'codex'
  if (meta?.internalBackend === 'claude-code') return 'claude-code'
  if (meta?.codexThreadId) return 'codex'
  return undefined
}

// ===== 静默（quiescence）判定 =====

export type RuntimeSwitchRejectionCode =
  | 'session_not_persisted'
  | 'invalid_input'
  | 'channel_not_found'
  | 'channel_disabled'
  | 'channel_runtime_mismatch'
  | 'runtime_unavailable'
  | 'model_not_found'
  | 'model_disabled'
  | 'moa_model_unsupported'
  | 'busy'
  | 'stopping'
  | 'approval_active'
  | 'send_in_flight'
  | 'switch_in_flight'

export interface RuntimeSwitchRejection {
  ok: false
  code: RuntimeSwitchRejectionCode
  message: string
}

export type RuntimeSwitchValidation = RuntimeSwitchRejection | {
  ok: true
  /** 目标适配器分组 */
  adapterKind: RuntimeAdapterKind
  /** 写入 meta.internalBackend 的值 */
  internalBackend: AgentSessionMeta['internalBackend']
  /** 目标内核 */
  toRuntime: AgentRuntimeKind
  /** 切换前生效的内核（无从判断 → undefined） */
  fromRuntime?: AgentRuntimeKind
  /** 是否跨内核（同内核只更新渠道/模型，不重置原生上下文、不生成交接资料） */
  crossRuntime: boolean
  /** 解析后的模型 id（codex 旧模型 id 归一留给 adapter 层，此处原样返回） */
  modelId: string
}

/** 静默状态探针（由 session-service 按运行时 / 审批服务实测后传入）。 */
export interface RuntimeSwitchQuiescence {
  /** 当前回合是否在跑 */
  turnInFlight: boolean
  /** 软中断是否在途（adapter 尚未受理完中断请求） */
  interrupting: boolean
  /**
   * 停止请求已受理、但 runLoop 还没观察到本轮**原生终态**（result / generator 结束 / 抛错收尾）。
   *
   * 这是本切片最关键的一条：`interrupt()` 返回 / `isInterrupting()===false` 只代表适配器受理了
   * 中断请求（Claude SDK 控制请求受理 / Pi `agent.abort()` 置标志 / Codex `turn/interrupt` 应答），
   * **不**代表工具与子进程已停。旧内核仍可能在写同一 workspace，故必须 fail-closed。
   */
  unsettledStop: boolean
  /** 是否有本轮 send 尚未走完 handleSend（含 MoA 编排） */
  sendInFlight: boolean
  /** 是否有审批类请求在等用户（AskUserQuestion / ExitPlanMode / KB propose-save / 工具权限） */
  approvalActive: boolean
}

/**
 * 静默判定：切换前后都不能有两个同时工作的主执行者。
 *
 * 本切片要求用户**先停止**再切换（不做花式自动取消），因此非静默一律 fail-closed 拒绝。
 */
export function validateRuntimeSwitchQuiescence(
  q: RuntimeSwitchQuiescence,
): RuntimeSwitchRejection | { ok: true } {
  if (q.turnInFlight) {
    return {
      ok: false,
      code: 'busy',
      message: '当前回合仍在执行，请先停止本轮再切换运行内核',
    }
  }
  if (q.unsettledStop) {
    return {
      ok: false,
      code: 'stopping',
      message: '已请求停止，但旧内核尚未确认本轮停稳（可能仍有工具在收尾），请稍候再切换运行内核',
    }
  }
  if (q.interrupting) {
    return {
      ok: false,
      code: 'stopping',
      message: '上一轮仍在停止中，请稍候再切换运行内核',
    }
  }
  if (q.sendInFlight) {
    return {
      ok: false,
      code: 'send_in_flight',
      message: '本轮消息仍在处理，请稍候再切换运行内核',
    }
  }
  if (q.approvalActive) {
    return {
      ok: false,
      code: 'approval_active',
      message: '存在等待确认的审批请求，请先处理后再切换运行内核',
    }
  }
  return { ok: true }
}

/** 渠道 + 模型侧校验所需的最小上下文（保持纯函数，便于单测）。 */
export interface RuntimeSwitchTargetContext {
  /** 目标会话 meta；undefined = 草稿会话（未持久化） */
  meta: AgentSessionMeta | undefined
  /** 按 input.channelId 查到的渠道；undefined = 不存在 */
  channel: Pick<Channel, 'id' | 'name' | 'provider' | 'apiProtocol' | 'enabled' | 'models'> | undefined
  /** 目标内核在本机是否可用（如未安装 kscc） */
  runtimeAvailable?: boolean
  /** 不可用时的具体原因（透传给用户） */
  runtimeUnavailableReason?: string
  /** 当前生效内核（由调用方按 meta + 渠道反推） */
  fromRuntime?: AgentRuntimeKind
}

/**
 * 切换目标校验：会话已持久化 + 渠道启用且与目标内核兼容 + 模型启用且非 MoA 虚拟模型。
 * 不做任何权限放宽、不静默换内核：任一条不满足都返回具体拒绝原因。
 */
export function validateRuntimeSwitchTarget(
  input: Pick<SessionRuntimeSwitchInput, 'channelId' | 'modelId' | 'runtime'>,
  ctx: RuntimeSwitchTargetContext,
): RuntimeSwitchValidation {
  if (!input.channelId || !input.modelId) {
    return { ok: false, code: 'invalid_input', message: '切换运行内核需要同时指定渠道与模型' }
  }
  if (input.runtime !== 'pi' && input.runtime !== 'codex' && input.runtime !== 'claude-code') {
    return {
      ok: false,
      code: 'invalid_input',
      message: `未知的运行内核：${String(input.runtime)}`,
    }
  }
  if (!ctx.meta) {
    return {
      ok: false,
      code: 'session_not_persisted',
      message: '会话尚未持久化，草稿会话请直接在输入区选择运行内核与模型',
    }
  }
  if (isMoaModelId(input.modelId)) {
    return {
      ok: false,
      code: 'moa_model_unsupported',
      message: 'MoA 会诊/圆桌是虚拟模型，不能作为运行内核的绑定模型',
    }
  }
  const channel = ctx.channel
  if (!channel) {
    return {
      ok: false,
      code: 'channel_not_found',
      message: `渠道不存在：${input.channelId}（请在渠道管理中添加）`,
    }
  }
  if (!channel.enabled) {
    return {
      ok: false,
      code: 'channel_disabled',
      message: `渠道「${channel.name}」已禁用，请先启用`,
    }
  }
  if (!channelAcceptsRuntime(channel, input.runtime)) {
    return {
      ok: false,
      code: 'channel_runtime_mismatch',
      message: `渠道「${channel.name}」不适用于${RUNTIME_DISPLAY_NAME[input.runtime]}，请选择该内核支持的渠道`,
    }
  }
  if (ctx.runtimeAvailable === false) {
    return {
      ok: false,
      code: 'runtime_unavailable',
      message:
        ctx.runtimeUnavailableReason ??
        `${RUNTIME_DISPLAY_NAME[input.runtime]} 当前不可用，请检查运行时安装与登录状态`,
    }
  }
  const model = channel.models.find((m) => m.id === input.modelId)
  if (!model) {
    return {
      ok: false,
      code: 'model_not_found',
      message: `模型「${input.modelId}」不属于渠道「${channel.name}」`,
    }
  }
  if (!model.enabled) {
    return {
      ok: false,
      code: 'model_disabled',
      message: `模型「${model.name ?? model.id}」已停用，请选择该内核下的可用模型`,
    }
  }
  const adapterKind = adapterKindForRuntime(input.runtime)
  return {
    ok: true,
    adapterKind,
    internalBackend: internalBackendForRuntime(input.runtime),
    toRuntime: input.runtime,
    fromRuntime: ctx.fromRuntime,
    // fromRuntime 未知（渠道已删/无渠道）时按跨内核处理：宁可新开原生上下文，也不 resume 过期上下文
    // Same-runtime API channel changes also need a fresh native context: the old process may
    // retain a different base URL/key. Treat that rebind like a handoff instead of resuming it.
    crossRuntime:
      ctx.fromRuntime !== input.runtime ||
      ctx.meta.channelId !== input.channelId ||
      ctx.meta.modelId !== input.modelId,
    modelId: input.modelId,
  }
}

// ===== 交接资料 =====

/** 交接资料正文的可见历史提取结果。 */
export interface RuntimeHandoffMaterial {
  /** 近期可见对话（`[用户]·[助手]` 标签，已按字符预算从最旧截断） */
  historyText: string
  /** 首条用户消息（会话初始目标，截断） */
  initialGoal: string
  /** 最后一条用户消息（最新要求，截断） */
  latestAsk: string
  /** 交接时的面板消息总条数（截止位置） */
  sourcePanelMessageCount: number
}

/**
 * 从 TAgent 面板原始消息（SDKMessage / IR 混排）提取交接资料素材。
 *
 * - 只取**可见**内容：`panelMessageToHistoryIR` + `buildMoAHistoryFromMessages`
 *   已跳过 thinking / 纯工具调用，不会把隐藏思考或阶段噪声带给目标内核。
 * - **不**排除末条轮次（切换发生在两次发送之间，末条是真实历史，不是「本轮议题」）。
 * - 读失败 / 空面板 → 空字符串，交接仍可进行（只是内容更少）。
 */
export function extractRuntimeHandoffMaterial(
  rawPanel: readonly unknown[],
  opts: { charBudget?: number } = {},
): RuntimeHandoffMaterial {
  const irs: TAgentMessage[] = []
  for (const raw of rawPanel) {
    const ir = panelMessageToHistoryIR(raw)
    if (ir) irs.push(ir)
  }
  const historyText = buildMoAHistoryFromMessages(irs, {
    excludeTrailingTurn: false,
    charBudget: opts.charBudget ?? RUNTIME_HANDOFF_HISTORY_CHAR_BUDGET,
  })
  const userTexts = irs
    .filter((m) => m.type === 'user')
    .map((m) => extractVisibleText(m))
    .filter(Boolean)
  return {
    historyText,
    initialGoal: truncate(userTexts[0] ?? '', HANDOFF_SNIPPET_CHARS),
    latestAsk: truncate(userTexts[userTexts.length - 1] ?? '', HANDOFF_SNIPPET_CHARS),
    sourcePanelMessageCount: rawPanel.length,
  }
}

/** 只取消息里的可见 text 块（忽略 thinking / tool_use 结构）。 */
function extractVisibleText(msg: TAgentMessage): string {
  const parts: string[] = []
  for (const block of msg.content) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      parts.push(block.text.trim())
    }
  }
  return parts.join('\n').trim()
}

function truncate(text: string, max: number): string {
  const t = text.trim()
  if (t.length <= max) return t
  return `${t.slice(0, max)}…[已截断]`
}

export interface RuntimeHandoffConstraints {
  /** 执行形态（Chat / Work），切换不改变它 */
  executionMode?: string
  /** 权限档，切换不改变它 */
  permissionMode?: string
  /** 工作区项目目录（绝对路径；成果文件通常在此） */
  workspacePath?: string
  /** 会话附加的外部目录（成果路径线索） */
  attachedDirectories?: string[]
  /** 会话附加的外部文件（成果路径线索） */
  attachedFiles?: string[]
}

/**
 * 生成交接资料正文。
 *
 * 明确区分：用户指令 / 助手结论 / 工具结果（后者由 historyText 的 `[工具结果]` 前缀承载），
 * 不把旧内核的判断提升为用户授权；并声明省略范围与历史查询入口。
 */
export function buildRuntimeHandoffContent(params: {
  from: AgentRuntimeKind
  to: AgentRuntimeKind
  material: RuntimeHandoffMaterial
  constraints: RuntimeHandoffConstraints
  /** 可用成果路径线索（宿主侧可从工具记录派生；缺省不列） */
  artifactHints?: string[]
}): string {
  const { from, to, material, constraints } = params
  const lines: string[] = []
  lines.push(
    `[交接资料 · 来自 ${RUNTIME_DISPLAY_NAME[from]}]`,
    `本会话此前由 ${RUNTIME_DISPLAY_NAME[from]} 处理，现改由你（${RUNTIME_DISPLAY_NAME[to]}）继续。以下是接续所需的上下文，` +
      `由 TAgent 宿主从会话可见记录整理，不是新的用户指令。`,
    '',
  )

  lines.push('【当前目标与最新要求】')
  if (material.initialGoal) lines.push(`- 会话初始目标：${material.initialGoal}`)
  if (material.latestAsk && material.latestAsk !== material.initialGoal) {
    lines.push(`- 最近一次要求：${material.latestAsk}`)
  }
  if (!material.initialGoal && !material.latestAsk) lines.push('- （无可见用户消息）')
  lines.push('')

  lines.push('【必须保持的约束】')
  const modeLabel = constraints.executionMode === 'chat' ? 'Chat（只读讨论）' : 'Work（可动手执行）'
  lines.push(`- 执行形态：${modeLabel}（切换不改变执行形态，请按该形态边界工作）`)
  if (constraints.permissionMode) {
    lines.push(`- 权限档：${constraints.permissionMode}（切换不会放宽权限，遇到拒绝请如实说明）`)
  }
  if (constraints.workspacePath) {
    lines.push(`- 工作区目录：${constraints.workspacePath}`)
  }
  lines.push('- 交接资料是背景信息；如与用户当前消息冲突，以用户当前消息为准。')
  lines.push('')

  const hints = params.artifactHints ?? []
  const paths = [
    ...(constraints.attachedDirectories ?? []),
    ...(constraints.attachedFiles ?? []),
    ...hints,
  ]
  if (paths.length > 0) {
    lines.push('【已有成果 / 相关路径】')
    for (const p of paths.slice(0, 20)) lines.push(`- ${p}`)
    lines.push('（路径仅为线索，需要时请自行读取核实）')
    lines.push('')
  }

  lines.push('【近期可见对话】')
  lines.push(material.historyText.trim() || '（无可见历史）')
  lines.push('')
  lines.push(
    `【说明】以上是最近 ${material.sourcePanelMessageCount} 条会话记录中按「最近优先、` +
      `${RUNTIME_HANDOFF_HISTORY_CHAR_BUDGET} 字符预算」截取的可见内容：` +
      `较早的历史、中段的约束细节与隐藏推理过程可能被省略，完整记录请在 TAgent 会话历史中查看。` +
      `这不等同于完整上下文迁移。`,
  )

  const content = lines.join('\n')
  return content.length > RUNTIME_HANDOFF_TOTAL_CHAR_BUDGET
    ? `${content.slice(0, RUNTIME_HANDOFF_TOTAL_CHAR_BUDGET)}\n【说明】交接资料超预算已截断，较早内容与部分约束未带入。`
    : content
}

// ===== 切换事务串行化 =====

/**
 * 按 key（会话 id）串行化的任务闸门。
 *
 * 用途：运行内核切换是读-校验-落盘的事务，两个切换并发会写出半截绑定。
 * 后到的任务**排队等待**前一个落盘完，然后在下一次校验里重新看静默状态（fail-closed）。
 */
export function createKeyedSerialQueue(): {
  run: <T>(key: string, task: () => Promise<T> | T) => Promise<T>
  /** 当前仍有排队/在跑任务的 key 数量（测试与观测用） */
  pendingKeys: () => number
} {
  const chains = new Map<string, Promise<unknown>>()
  return {
    run<T>(key: string, task: () => Promise<T> | T): Promise<T> {
      const previous = chains.get(key) ?? Promise.resolve()
      const run = previous.then(task, task)
      const settled = run.then(
        () => undefined,
        () => undefined,
      )
      chains.set(key, settled)
      void settled.then(() => {
        if (chains.get(key) === settled) chains.delete(key)
      })
      return run
    },
    pendingKeys: () => chains.size,
  }
}

// ===== 切换事务 patch =====

/** 切换事务的 meta patch + 交接资料（由 session-service 落盘）。 */
export interface RuntimeSwitchPlan {
  patch: Partial<AgentSessionMeta>
  /** 跨内核切换时需要持久化的待投递交接资料；同内核 = undefined */
  handoff?: RuntimeHandoff
}

/**
 * 生成切换事务的 meta patch。
 *
 * - 归档来源内核的原生绑定（channelId / modelId / nativeSessionId / 同步游标）
 * - 跨内核时**清空**生效原生 id（`sdkSessionId` / `codexThreadId`）：目标内核本轮
 *   全新开原生上下文，避免 resume 过期上下文；旧 id 已归档到 runtimeBindings
 * - 同内核只更新渠道 / 模型，保留原生 id（继续 resume）
 * - 覆盖 channelId / modelId / internalBackend；**不动** executionMode / permissionMode /
 *   workspaceId / 权限相关字段
 * - runtimeSwitchRevision +1
 */
export function planRuntimeSwitch(params: {
  meta: AgentSessionMeta
  target: Extract<RuntimeSwitchValidation, { ok: true }>
  channelId: string
  modelId: string
  now: number
  handoffContent?: string
  sourcePanelMessageCount?: number
}): RuntimeSwitchPlan {
  const { meta, target, channelId, modelId, now } = params
  const fromRuntime = target.fromRuntime ?? inferRuntimeFromMeta(meta)
  const bindings: Partial<Record<AgentRuntimeKind, RuntimeNativeBinding>> = {
    ...(meta.runtimeBindings ?? {}),
  }
  // 归档来源绑定（保留最近一次同步位置）；来源内核未知（历史 kscc 记录）时无从归档
  if (fromRuntime) {
    const previousBinding: RuntimeNativeBinding = {
      ...(bindings[fromRuntime] ?? {}),
      channelId: meta.channelId,
      modelId: meta.modelId,
      nativeSessionId: activeNativeSessionId(meta, fromRuntime) ?? bindings[fromRuntime]?.nativeSessionId,
      lastSyncedAt: now,
    }
    if (previousBinding.nativeSessionId === undefined) delete previousBinding.nativeSessionId
    bindings[fromRuntime] = previousBinding
  }

  const patch: Partial<AgentSessionMeta> = {
    agentRuntime: target.toRuntime,
    channelId,
    modelId,
    internalBackend: target.internalBackend,
    runtimeBindings: bindings,
    runtimeSwitchRevision: (meta.runtimeSwitchRevision ?? 0) + 1,
  }

  let handoff: RuntimeHandoff | undefined
  if (target.crossRuntime) {
    // 跨内核：目标内核本轮全新开原生上下文（旧 id 已归档进 runtimeBindings）
    patch.sdkSessionId = undefined
    patch.codexThreadId = undefined
    const content = (params.handoffContent ?? '').trim()
    // 无可见历史可交接时不写空记录（下次发送仍靠既有面板历史注入补上下文）
    // 来源内核未知（历史 kscc）时亦不写交接记录（RuntimeHandoff.from 需真实内核）。
    if (content && fromRuntime) {
      patch.runtimeHandoff = {
        from: fromRuntime,
        to: target.toRuntime,
        content,
        createdAt: now,
        sourcePanelMessageCount: params.sourcePanelMessageCount ?? 0,
      }
      handoff = patch.runtimeHandoff
    }
  }
  return { patch, handoff }
}

/** 交接资料是否待投递（存在即待投递；投递成功后会从 meta 清除）。 */
export function hasPendingHandoff(
  meta: Pick<AgentSessionMeta, 'runtimeHandoff'> | undefined,
): boolean {
  return Boolean(meta?.runtimeHandoff?.content)
}

/**
 * 本轮是否应当注入待投递交接资料。
 *
 * 只在 `attempts === 0` 时注入：一次切换只自动投递一次，避免「目标内核每次普通轮次都重吃
 * 整段历史」。上一次尝试若在目标内核产出任何原生输出**之前**就失败/被停，
 * `planHandoffAttemptOutcome` 会把 `attempts` 归零 → 用户下一次发送可重投（用户驱动，非自动）。
 */
export function shouldInjectHandoff(
  meta: Pick<AgentSessionMeta, 'runtimeHandoff'> | undefined,
): boolean {
  if (!hasPendingHandoff(meta)) return false
  return (meta?.runtimeHandoff?.attempts ?? 0) === 0
}

/** 注入前落盘的尝试标记（进程在投递中途死掉时状态依然诚实可查）。 */
export function planHandoffAttempt(params: {
  meta: Pick<AgentSessionMeta, 'runtimeHandoff'>
  now: number
}): Partial<AgentSessionMeta> | undefined {
  const handoff = params.meta.runtimeHandoff
  if (!handoff?.content) return undefined
  return {
    runtimeHandoff: {
      ...handoff,
      attempts: (handoff.attempts ?? 0) + 1,
      lastAttemptAt: params.now,
      lastOutcome: 'pending',
    },
  }
}

/** 目标内核对本轮交接的观察结局（由 session-service 依据原生流与终态判定）。 */
export type HandoffAttemptOutcome =
  /** 观察到本轮成功终态（result / 完成） */
  | 'success'
  /** 本轮出错结束 */
  | 'error'
  /** 本轮被用户/宿主停止 */
  | 'stopped'
  /** 目标运行时在产出任何原生输出前就没起来（spawn / 构建 query 失败） */
  | 'startup-failed'

/**
 * 决定本轮尝试后如何改写 `runtimeHandoff`（纯函数，session-service 调用后落盘）。
 *
 * - `success` → **消费**：清除待投递记录并推进目标内核绑定同步游标。
 * - `startup-failed` → 归零 attempts + 标记 `retryable`：目标内核从未收到任何东西，允许下次重投。
 * - `error` / `stopped`：
 *   - 目标内核本轮**未产出任何原生输出** → 同 `startup-failed`（可重投）；
 *   - 已产出输出 → 标记 `ambiguous`，保留 attempts（不自动重复注入，避免普通轮次反复吃全量上下文）。
 *
 * 修订号守卫：注入时的 `attemptRevision` 与当前 `meta.runtimeSwitchRevision` 不一致时
 * （说明期间又发生过切换，pending 属于新一次切换）一律不动作。
 */
export function planHandoffAttemptOutcome(params: {
  meta: AgentSessionMeta
  /** 注入时快照的切换代数 */
  attemptRevision: number
  outcome: HandoffAttemptOutcome
  /** 目标内核本轮是否已产出过原生输出（成功终态也视为已产出） */
  sawNativeOutput: boolean
  now: number
  /** success 时必填：目标内核当前原生会话 id（若有） */
  nativeSessionId?: string
  /** success 时必填：目标内核同步游标（面板消息条数） */
  syncedPanelMessageCount?: number
}): Partial<AgentSessionMeta> | undefined {
  const handoff = params.meta.runtimeHandoff
  if (!handoff?.content) return undefined
  // 期间又切换过 → 本次尝试的 pending 已不属于当前交接，交给新的交接负责
  if ((params.meta.runtimeSwitchRevision ?? 0) !== params.attemptRevision) {
    return undefined
  }

  if (params.outcome === 'success') {
    return {
      ...planHandoffDelivery({
        meta: params.meta,
        runtime: handoff.to,
        now: params.now,
        panelMessageCount: params.syncedPanelMessageCount ?? handoff.sourcePanelMessageCount,
        ...(params.nativeSessionId ? { nativeSessionId: params.nativeSessionId } : {}),
      }),
      runtimeHandoff: undefined,
    }
  }

  const produced = params.outcome === 'startup-failed' ? false : params.sawNativeOutput
  if (!produced) {
    return {
      runtimeHandoff: {
        ...handoff,
        attempts: 0,
        lastOutcome: 'retryable',
      },
    }
  }
  return {
    runtimeHandoff: {
      ...handoff,
      lastOutcome: 'ambiguous',
    },
  }
}

/**
 * 把待投递交接资料拼进本轮 prompt（一次性）。
 * 返回 undefined 表示无待投递（调用方不改 prompt）。
 */
export function applyRuntimeHandoffToPrompt(
  prompt: string,
  handoff: RuntimeHandoff | undefined,
): string | undefined {
  const content = handoff?.content?.trim()
  if (!content) return undefined
  return [
    '## 跨内核交接（接续上一内核的会话）',
    content,
    '## 用户本轮消息',
    prompt,
  ].join('\n\n')
}

/**
 * 投递成功后的消费 patch：清空待投递交接资料，并把目标内核绑定的同步游标推进。
 * 仅在目标内核确实收到本轮消息（adapter send 未抛错）后调用。
 */
export function planHandoffDelivery(params: {
  meta: AgentSessionMeta
  runtime: AgentRuntimeKind
  now: number
  panelMessageCount: number
  /** 目标内核本轮回填的原生会话 id（若有） */
  nativeSessionId?: string
}): Partial<AgentSessionMeta> {
  const { meta, runtime, now } = params
  const bindings: Partial<Record<AgentRuntimeKind, RuntimeNativeBinding>> = {
    ...(meta.runtimeBindings ?? {}),
  }
  bindings[runtime] = {
    ...(bindings[runtime] ?? {}),
    channelId: meta.channelId,
    modelId: meta.modelId,
    ...(params.nativeSessionId ? { nativeSessionId: params.nativeSessionId } : {}),
    lastSyncedAt: now,
    syncedPanelMessageCount: params.panelMessageCount,
  }
  return {
    runtimeBindings: bindings,
    runtimeHandoff: undefined,
  }
}
