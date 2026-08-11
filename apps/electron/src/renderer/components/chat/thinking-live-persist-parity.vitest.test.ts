/**
 * REGRESS：同会话 live 思考 与 冷启动 reload 重建 一致（concise 时间线 thinking step）
 *
 * 现象（用户报告）：上一刀去掉 concise 下完整思考流式（LiveThinkingBody）后，
 *   - 思考落盘后，当前会话（live/同会话）里仍不显示
 *   - 关闭会话再打开（loadSession 从持久化重建）思考又显示出来
 *
 * 根因（经核查确认）：
 *   - 主进程对 partial assistant 调 stripPartialAssistantBody 把 thinking 主体剥成空串再发 renderer
 *     （session-service.ts handleSdkStreamMessage）；落盘喂的是原始全量 msg（不剥）。
 *   - B 路径（reload）：loadSession 经 sdkMessageToIR 原样映射 block.thinking → 每段 item 自带完整 thinking，
 *     位置正确（leading 思考在顶部 fold / 中段思考在 stage.steps）。
 *   - A 路径（live 同会话）：renderer 收到的是剥空后的 irMessage，thinking 自己 uuid 的 item 主体为 ''；
 *     真实思考只活在 streamState.thinking。对 GLM（无 final 非空 thinking 校准）streamState.thinking
 *     跨段累积（shouldClearStreamThinking 对剥空块不触发），result/turn_end 时
 *     commitStreamThinkingToLastAssistant 把全程累积的思考 graft 到**末条主线 assistant**（另一 uuid 的
 *     text/tool item）→ 同会话时间线把所有思考拼到末条、位置错；reload 却每段自带 → 不一致。
 *
 * 修复（最小、对称 tool_start 的 text 提交）：在 sdk_message 到达 tool_use/text（当前思考段结束信号）时，
 *   把 streamState.thinking graft 到末条主线 assistant（对 GLM = thinking 自己那条 uuid 的 item，因其
 *   thinking 主体被剥空、排在 tool/text 之前）再清——每段思考落在原位置，对齐落盘 reload 形态。
 *   kscc 累计快照：final 带非空 thinking 经 shouldClearStreamThinking 清过 streamState.thinking → 此处 no-op。
 *
 * 本测试用真 reducer（applySdkMessageToItems / applyThinkingDeltaToState / applySdkMessageToStreamState /
 * commitStreamThinkingToLastAssistant / commitStreamTextToLastAssistant）逐帧推进 (items, streamState)，
 * 模拟主进程「剥空 partial + 派生 delta」链路 + 段边界提交，断言：
 *   1. A 路径（修复后）buildConciseTimeline 的 thinking step 位置/内容 == B 路径（持久化原样重建）。
 *   2. A 路径（修复前，只在 result 提交）思考被拼到末条 assistant → 与 B 路径不一致（锁根因）。
 */
import { describe, expect, it } from 'vitest'
import { buildTurnPresentation } from './session-turn-model'
import { buildConciseTimeline } from './concise-timeline-model'
import {
  applySdkMessageToItems,
  applyThinkingDeltaToState,
  applyTextDelta,
  applySdkMessageToStreamState,
  EMPTY_STREAM_STATE,
  commitStreamTextToLastAssistant,
  commitStreamThinkingToLastAssistant,
  type SessionStreamState,
} from './stream-item-model'
import type { TAgentMessage } from '@tagent/shared'

interface Item {
  key: string
  message?: TAgentMessage
  streamUuid?: string
  streaming?: boolean
  streamingText?: string
  streamingThinking?: string
}

let keySeq = 0
const allocKey = (): string => `m${keySeq++}`

/** GLM 独立块：独立 uuid、stop_reason 始终 null、_partial:true；主体被主进程剥空。 */
function glmStrippedBlock(
  uuid: string,
  block: TAgentMessage['content'][number],
): TAgentMessage {
  const stripped =
    block.type === 'text'
      ? { type: 'text' as const, text: '' }
      : block.type === 'thinking'
        ? { type: 'thinking' as const, thinking: '' }
        : block
  return { type: 'assistant', uuid, _partial: true, createdAt: 1, content: [stripped] } as TAgentMessage
}

function userToolResult(id: string): TAgentMessage {
  return { type: 'user', content: [{ type: 'tool_result', toolUseId: id, content: 'ok' }] }
}

/**
 * 喂一条 GLM 块：先派生 delta 进 streamState，再发剥空后的 sdk_message。
 * - segmentCommit=true（修复后）：incoming 是 tool_use/text 时，先把 streamState.thinking graft 到末条
 *   主线 assistant 再清——对齐落盘 reload 每段 item 自带 thinking。
 * - segmentCommit=false（修复前）：只在 result/turn_end 边界提交（全程累积到末条 assistant）。
 */
function feedBlock(
  items: Item[],
  stream: SessionStreamState,
  uuid: string,
  fullBlock: TAgentMessage['content'][number],
  segmentCommit: boolean,
): { items: Item[]; stream: SessionStreamState } {
  let s = stream
  // 派生 delta（主进程 DeltaTracker 单块首帧 = 全量 append）
  if (fullBlock.type === 'thinking') s = applyThinkingDeltaToState(s, (fullBlock as { thinking: string }).thinking)
  if (fullBlock.type === 'text') s = applyTextDelta(s, (fullBlock as { text: string }).text)
  const irMessage = glmStrippedBlock(uuid, fullBlock)

  // 段边界提交（修复点）：incoming 是 tool_use/text → 当前思考段结束，先 graft thinking 到末条主线 assistant
  const incomingNonThinking =
    irMessage.content.some((b) => b.type === 'tool_use' || b.type === 'text')
  let nextItems = items
  if (segmentCommit && incomingNonThinking) {
    const clearThinking = irMessage.content.some(
      (b) => b.type === 'thinking' && typeof (b as { thinking?: string }).thinking === 'string' && (b as { thinking: string }).thinking.trim().length > 0,
    )
    if (!clearThinking && s.thinking.trim()) {
      nextItems = commitStreamThinkingToLastAssistant(nextItems, s.thinking.trim()) as Item[]
      s = { ...s, thinking: '' }
    }
  }

  nextItems = applySdkMessageToItems(nextItems, irMessage, allocKey) as Item[]
  s = applySdkMessageToStreamState(s, irMessage)
  return { items: nextItems, stream: s }
}

/** 回合边界提交（result/turn_end）：先思考再正文，再 resetStreamState。 */
function commitBoundary(
  items: Item[],
  stream: SessionStreamState,
): { items: Item[]; stream: SessionStreamState } {
  let nextItems = items
  const pendingThink = stream.thinking.trim()
  if (pendingThink) nextItems = commitStreamThinkingToLastAssistant(nextItems, pendingThink) as Item[]
  const pendingText = stream.text.trim()
  if (pendingText) nextItems = commitStreamTextToLastAssistant(nextItems, pendingText) as Item[]
  return { items: nextItems, stream: { ...EMPTY_STREAM_STATE } }
}

/** 两段思考 + 两工具 + 最终正文（覆盖 leading 思考与中段思考） */
const LEADING_THINK = '先摸清 Proma 结构再决定改造面（这是首轮工具前的 leading 思考，应进顶部 fold）'
const MID_THINK =
  'Proma 我看了结构——它不是外围扩展，而是拿 **pi / Claude Agent SDK** 当内核，改造深度明显更激进。'
const FINAL_TEXT = '已改成阶段工作块 + 进度短总结，下面是改动说明。'

/** 构造 GLM 块序列（thinking / tool / text 各自独立 uuid）。 */
function glmBlocks(): Array<{ uuid: string; block: TAgentMessage['content'][number] }> {
  return [
    { uuid: 'glm-lead', block: { type: 'thinking', thinking: LEADING_THINK } },
    { uuid: 'glm-r1', block: { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'a.ts' } } as never },
    { uuid: 'glm-mid', block: { type: 'thinking', thinking: MID_THINK } },
    { uuid: 'glm-e1', block: { type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: 'b.ts' } } as never },
    { uuid: 'glm-final', block: { type: 'text', text: FINAL_TEXT } },
  ]
}

/** 推进整轮（含 tool_result），返回结束后的 (items, stream)。 */
function runTurn(segmentCommit: boolean): { items: Item[]; stream: SessionStreamState } {
  let items: Item[] = []
  let stream: SessionStreamState = { ...EMPTY_STREAM_STATE }
  for (const b of glmBlocks()) {
    const r = feedBlock(items, stream, b.uuid, b.block, segmentCommit)
    items = r.items
    stream = r.stream
    // 工具后插 tool_result（不参与 streamState）
    if (b.block.type === 'tool_use') {
      const id = (b.block as { id: string }).id
      items = applySdkMessageToItems(items, userToolResult(id), allocKey) as Item[]
    }
  }
  return commitBoundary(items, stream)
}

/** B 路径：从持久化原样重建（每段 item 自带完整 thinking，未经剥离）。 */
function persistedItems(): Item[] {
  const items: Item[] = []
  for (const b of glmBlocks()) {
    items.push({ key: `h${keySeq++}`, message: { type: 'assistant', uuid: b.uuid, _partial: true, createdAt: 1, content: [b.block] } as TAgentMessage })
    if (b.block.type === 'tool_use') {
      const id = (b.block as { id: string }).id
      items.push({ key: `h${keySeq++}`, message: userToolResult(id) })
    }
  }
  return items
}

/** 投影成 concise 时间线的 thinking step 描述（kind + 所属段 + thinking 正文）。 */
function timelineThinking(items: Item[]): {
  segKind: string
  stageKeys: string[]
  standaloneThink: string[]
  midThinkInStage: string[]
} {
  const pres = buildTurnPresentation(
    { kind: 'assistant-turn', key: 't', items, isStreaming: false },
    { isLiveTurn: false, displayMode: 'concise' },
  )
  const segs = buildConciseTimeline(pres.process, {
    answerTexts: pres.answerTexts,
    streamingText: pres.streamingText,
    isLive: false,
  })
  const standaloneThink: string[] = []
  const midThinkInStage: string[] = []
  for (const s of segs) {
    if (s.kind === 'thinking') standaloneThink.push((s as { thinking: string }).thinking)
    if (s.kind === 'work_stage') {
      for (const step of (s as { steps: Array<{ kind: string; thinking?: string }> }).steps) {
        if (step.kind === 'thinking' && step.thinking && step.thinking.trim()) {
          midThinkInStage.push(step.thinking)
        }
      }
    }
  }
  return {
    segKind: segs.map((s) => s.kind).join('|'),
    stageKeys: segs.filter((s) => s.kind === 'work_stage').map((s) => (s as { steps: unknown[] }).steps.length.toString()),
    standaloneThink,
    midThinkInStage,
  }
}

describe('同会话 live 思考 vs 冷启动 reload 重建一致（concise thinking step）', () => {
  it('B 路径（持久化原样）：leading 思考进顶部 fold，中段思考进 stage.steps', () => {
    const tl = timelineThinking(persistedItems())
    // leading 思考 → 独立 thinking fold（工具前）
    expect(tl.standaloneThink).toEqual([LEADING_THINK])
    // 中段思考 → work_stage.steps（Read 与 Edit 之间）
    expect(tl.midThinkInStage).toEqual([MID_THINK])
  })

  it('A 路径 修复前（只在 result 提交）：两段思考被拼到末条 assistant → 与 B 路径不一致', () => {
    const { items } = runTurn(false) // segmentCommit=false：模拟修复前
    const tl = timelineThinking(items)
    const tlB = timelineThinking(persistedItems())
    // 根因锁定：修复前 leading + 中段思考全程累积，result 时 graft 到末条 assistant（glm-final text），
    // 落到末段之后 → leading 思考不再进顶部 fold（standaloneThink 为空或被并入末条）
    expect(tl.standaloneThink).not.toEqual(tlB.standaloneThink)
    expect(tl.midThinkInStage).not.toEqual(tlB.midThinkInStage)
  })

  it('A 路径 修复后（段边界提交）：thinking step 位置/内容与 B 路径（持久化重建）一致', () => {
    const { items } = runTurn(true) // segmentCommit=true：模拟修复后
    const tl = timelineThinking(items)
    const tlB = timelineThinking(persistedItems())
    // 修复后：leading 思考进顶部 fold、中段思考进 stage.steps，与 reload 一致
    expect(tl.standaloneThink).toEqual(tlB.standaloneThink)
    expect(tl.midThinkInStage).toEqual(tlB.midThinkInStage)
    // 明确内容：leading 思考在顶部 fold，中段思考在 stage.steps
    expect(tl.standaloneThink).toEqual([LEADING_THINK])
    expect(tl.midThinkInStage).toEqual([MID_THINK])
  })

  it('A 路径 修复后：turn 完成 memory 中含 thinking → timeline 含 thinking step（不依赖关开会话）', () => {
    const { items } = runTurn(true)
    // 末条主线 assistant 仍带思考（graft 进各自段 item，非全程累积到末条）
    const lastMain = (() => {
      for (let i = items.length - 1; i >= 0; i--) {
        const m = items[i]?.message
        if (m?.type === 'assistant' && !m.parentToolUseId) return m
      }
      throw new Error('无主线 assistant')
    })()
    const hasAnyThinking = items.some(
      (it) =>
        it.message?.type === 'assistant' &&
        !it.message.parentToolUseId &&
        it.message.content.some(
          (b) => b.type === 'thinking' && typeof (b as { thinking?: string }).thinking === 'string' && (b as { thinking: string }).thinking.trim().length > 0,
        ),
    )
    expect(hasAnyThinking).toBe(true)
    // glm-final（末条 text item）本身不带思考（思考 graft 到各自 thinking uuid item）
    const lastMainHasThinking = lastMain.content.some(
      (b) => b.type === 'thinking' && typeof (b as { thinking?: string }).thinking === 'string' && (b as { thinking: string }).thinking.trim().length > 0,
    )
    expect(lastMainHasThinking).toBe(false)
    // timeline 仍含 thinking step（leading fold + 中段 stage step）
    const tl = timelineThinking(items)
    expect(tl.standaloneThink).toEqual([LEADING_THINK])
    expect(tl.midThinkInStage).toEqual([MID_THINK])
  })
})
