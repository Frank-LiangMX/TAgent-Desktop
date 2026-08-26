import { describe, expect, it } from 'vitest'
import {
  createStreamPersistGateState,
  feedStreamPersistGate,
  flushStreamPersistGate,
} from './stream-persist-gate'

/** assistant 文本块（glm 真实形状：独立 uuid、stop_reason:null、单 block）。 */
function assistantText(uuid: string, text: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'assistant',
    uuid,
    message: { content: [{ type: 'text', text }], stop_reason: null },
    ...extra,
  }
}
function assistantThinking(uuid: string, thinking: string) {
  return { type: 'assistant', uuid, message: { content: [{ type: 'thinking', thinking }], stop_reason: null } }
}
function assistantToolUse(uuid: string, id: string) {
  return {
    type: 'assistant',
    uuid,
    message: { content: [{ type: 'tool_use', id, name: 'Bash', input: {} }], stop_reason: null },
  }
}
function userToolResult(uuid: string) {
  return { type: 'user', uuid, message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } }
}

/** 喂一个序列并 flush，返回「最终落盘」的全部消息（按落盘顺序）。 */
function runSequence(msgs: unknown[]): unknown[] {
  const s = createStreamPersistGateState()
  const persisted: unknown[] = []
  for (const m of msgs) persisted.push(...feedStreamPersistGate(s, m))
  persisted.push(...flushStreamPersistGate(s))
  return persisted
}

describe('stream-persist-gate（REGRESS-G 落盘闸口）', () => {
  it('stop_reason:null + 仅非空 text（独立 uuid）→ 落盘', () => {
    const persisted = runSequence([assistantText('u-text', '先探查一下目录结构。')])
    expect(persisted).toHaveLength(1)
    expect((persisted[0] as { uuid: string }).uuid).toBe('u-text')
  })

  it('显式 _partial:true → 不落盘（真流式快照）', () => {
    const persisted = runSequence([
      assistantText('u-p', '流式中', { _partial: true }),
    ])
    expect(persisted).toHaveLength(0)
  })

  it('同 uuid 流式中间态 → 不落盘，只落盘同 uuid 链的最后一条（final）', () => {
    // 累积式渠道形状：同 uuid 多条流式快照，最后一条才是 final
    const persisted = runSequence([
      assistantThinking('u-chain', '想一下'),
      { type: 'assistant', uuid: 'u-chain', message: { content: [{ type: 'thinking', thinking: '想一下' }, { type: 'text', text: '写到一半' }], stop_reason: null } },
      { type: 'assistant', uuid: 'u-chain', message: { content: [{ type: 'thinking', thinking: '想一下' }, { type: 'text', text: '写完了' }, { type: 'tool_use', id: 't1', name: 'Bash', input: {} }], stop_reason: 'tool_use' } },
    ])
    // 只落盘最后一条 final；前两条中间态不落盘
    expect(persisted).toHaveLength(1)
    const last = (persisted[0] as { message: { content: Array<{ type: string }> } }).message.content
    expect(last.some((b) => b.type === 'tool_use')).toBe(true)
    expect((last.find((b) => b.type === 'text') as unknown as { text: string }).text).toBe('写完了')
  })

  it('空 content 的 assistant → 不落盘', () => {
    const persisted = runSequence([
      { type: 'assistant', uuid: 'u-empty', message: { content: [], stop_reason: null } },
    ])
    expect(persisted).toHaveLength(0)
  })

  it('glm 真实多段形状（块独立 uuid、stop_reason:null）→ 全段落盘、无堆积', () => {
    // 思考 → 段间短文 → 工具 → 工具结果 → 思考 → 短文 → 工具 → 结果
    const persisted = runSequence([
      assistantThinking('u1', '先看目录'),
      assistantText('u2', '先探查一下目录规模。'),
      assistantToolUse('u3', 'call_1'),
      userToolResult('u4'),
      assistantThinking('u5', '摸清了'),
      assistantText('u6', '摸清了，开始改权限。'),
      assistantToolUse('u7', 'call_2'),
    ])
    const uuids = persisted.map((m) => (m as { uuid: string }).uuid)
    // 每条独立段落盘一次，无重复、无堆积
    expect(uuids).toEqual(['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7'])
  })

  it('工具阶段前的长 text → 只落盘压缩后的阶段摘要', () => {
    const persisted = runSequence([
      assistantText(
        'u-long',
        '我先看看当前目录。\n这目录确实没法让人眼瞅——全是二进制文件。\n换个能直接看的办法：我把缓存路径和资产名对照。\n然后再检查路径转换逻辑，最后补一个脚本。',
      ),
      assistantToolUse('u-tool', 'call-long'),
    ])
    const text = (persisted[0] as { message: { content: Array<{ text: string }> } }).message.content[0]!.text
    expect(text.length).toBeLessThanOrEqual(80)
    expect(text).not.toContain('；')
    expect(text).not.toContain('我先看看')
    expect((persisted[1] as { uuid: string }).uuid).toBe('u-tool')
  })

  it('不同阶段的相同摘要都保留，thinking 原文不被压缩', () => {
    const persisted = runSequence([
      assistantThinking('u-think-1', '完整 thinking：确认缓存路径。'),
      assistantText('u-progress-1', '已确认缓存路径，开始检查文件名。'),
      assistantToolUse('u-tool-1', 'call-1'),
      assistantThinking('u-think-2', '完整 thinking：确认缓存路径。'),
      assistantText('u-progress-2', '已确认缓存路径，开始检查文件名。'),
      assistantToolUse('u-tool-2', 'call-2'),
    ])
    expect(persisted.filter((msg) => (msg as { type?: string }).type === 'assistant')).toHaveLength(6)
    expect(persisted.filter((msg) => (msg as { uuid?: string }).uuid === 'u-think-1')).toHaveLength(1)
    expect(persisted.filter((msg) => (msg as { uuid?: string }).uuid === 'u-think-2')).toHaveLength(1)
  })
  it('tool_use-only 独立段（glm 块拆分）→ 落盘（工具/阶段/Files Changed 历史）', () => {
    const persisted = runSequence([assistantToolUse('u-tool', 'call_9')])
    expect(persisted).toHaveLength(1)
  })

  it('thinking-only 独立段（glm 块拆分）→ 落盘（重开仍可见「思考了 Ns」折叠）', () => {
    const persisted = runSequence([assistantThinking('u-think', '盘算一下')])
    expect(persisted).toHaveLength(1)
  })

  it('user 消息 → 立即落盘，并先 flush 待提交 assistant', () => {
    const s = createStreamPersistGateState()
    const out1 = feedStreamPersistGate(s, assistantText('u-a', '在思考…'))
    expect(out1).toEqual([]) // assistant 暂存
    const out2 = feedStreamPersistGate(s, userToolResult('u-b'))
    // 先 flush assistant u-a，再落盘 user u-b
    expect(out2.map((m) => (m as { uuid: string }).uuid)).toEqual(['u-a', 'u-b'])
    expect(flushStreamPersistGate(s)).toEqual([]) // pending 已清
  })

  it('显式 partial 被同 uuid final 替换 → 只落盘 final', () => {
    const persisted = runSequence([
      assistantText('u-r', '流式', { _partial: true }),
      assistantText('u-r', '完成。'),
    ])
    expect(persisted).toHaveLength(1)
    expect((persisted[0] as { message: { content: Array<{ text: string }> } }).message.content[0]!.text).toBe('完成。')
  })

  it('final assistant（stop_reason）含完整 thinking+text+tool → 原样完整落盘（delta/剥离路径不侵入落盘）', () => {
    // 风险1/4：delta 协议只剥 live sdk_message 主体（减 IPC）；落盘走原始全量 msg，final 完整不丢。
    const persisted = runSequence([
      {
        type: 'assistant',
        uuid: 'u-final',
        message: {
          content: [
            { type: 'thinking', thinking: '完整思考' },
            { type: 'text', text: '完整正文' },
            { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
          ],
          stop_reason: 'tool_use',
        },
      },
    ])
    expect(persisted).toHaveLength(1)
    const content = (persisted[0] as {
      message: { content: Array<{ type: string; thinking?: string; text?: string }> }
    }).message.content
    // final 完整落盘：thinking / text 主体未被 delta 剥离路径吃掉
    expect((content.find((b) => b.type === 'thinking') as { thinking: string }).thinking).toBe('完整思考')
    expect((content.find((b) => b.type === 'text') as { text: string }).text).toBe('完整正文')
    expect(content.some((b) => b.type === 'tool_use')).toBe(true)
  })
})
