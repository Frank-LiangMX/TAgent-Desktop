/**
 * 软重置切换模拟测试（Phase 4 前置验证）
 *
 * 目的：在写 Phase 1-4 正式代码前，先用纯 fs + mock LLM/mock spawn 模拟
 *   kscc resume 核软重置的完整链路，验证 D9 降级方案（新 query + 上下文回填）
 *   能跑通，避免方向性错误。
 *
 * 模拟链路（对照 memory-phase4-kscc-soft-reset.md）：
 *   1. 会话 A 长驻，往 SDK JSONL-A 追加消息（含工具结果，模拟膨胀）
 *   2. A 达 60% 阈值 → 拉起 B，后台压缩（mock LLM 读 JSONL-A → 产出摘要 + 事实）
 *      生成 JSONL-B；A 继续追加（模拟压缩期间又聊几轮）
 *   3. A 达 75% → 原子切换：
 *      a. 补尾：shadowCursor 之后 A 新增的消息追加到 JSONL-B
 *      b. mock spawn 新 kscc（新 query + session_recovery prompt 注入 B 的摘要 + 补尾原文）
 *      c. meta.sdkSessionId 改指 B
 *      d. JSONL-A 归档（rename .archived）
 *   4. 验证：B 转正成新 A，面板历史完整（面板份只追加不受影响），旧 A 归档可回溯。
 *
 * 这个测试不依赖 Phase 1.2 的存储分离函数（还没写），自己直接操作 fs 模拟两份 JSONL。
 * 等 Phase 1-4 落地后，此测试可改为调真实 session-store / kscc-soft-reset，届时保留作集成测试。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SDKMessage } from '@tagent/shared'

vi.mock('electron', () => ({ app: { isPackaged: false } }))

// ===== 测试夹具：消息构造 =====

function userMsg(text: string, uuid: string): SDKMessage {
  return {
    type: 'user',
    uuid,
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
  } as unknown as SDKMessage
}

function assistantMsg(text: string, uuid: string): SDKMessage {
  return {
    type: 'assistant',
    uuid,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
  } as unknown as SDKMessage
}

function toolResultMsg(toolUseId: string, output: string, uuid: string): SDKMessage {
  return {
    type: 'user',
    uuid,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text: output }] }],
    },
    parent_tool_use_id: null,
  } as unknown as SDKMessage
}

// 粗 token 估算（CHARS_PER_TOKEN=4，对照 General agent-context-utils.ts L16）
function estimateTokens(messages: SDKMessage[]): number {
  const chars = messages.reduce((sum, m) => {
    const content = (m as any).message?.content ?? []
    if (!Array.isArray(content)) return sum
    return (
      sum +
      content.reduce((s: number, b: any) => {
        if (b.text) return s + b.text.length
        // tool_result 的 output 在 b.content（数组）里
        if (b.type === 'tool_result' && Array.isArray(b.content)) {
          return s + b.content.reduce((cs: number, cb: any) => cs + (cb.text?.length ?? 0), 0)
        }
        return s
      }, 0)
    )
  }, 0)
  return Math.ceil(chars / 4)
}

// ===== 模拟软重置协调器（纯逻辑，不 spawn 真进程）=====

interface ShadowState {
  sdkSessionId: string          // 当前主 A 的 SDK session id
  shadowSessionId?: string      // 影子 B 的 session slug
  shadowState: 'idle' | 'compacting' | 'ready' | 'switching' | 'switched'
  shadowCursor?: string         // 拉起 B 时 A 末尾消息 uuid
  shadowChainPrev?: string      // 单向链前驱
}

interface MockLLMCompactionOutput {
  summary: string
  facts: string[]
}

/**
 * mock LLM 压缩：读 messages，产出摘要 + 事实。
 * 真实实现走 consolidation streamFn，这里用确定性逻辑模拟。
 */
function mockLLMCompact(messages: SDKMessage[]): MockLLMCompactionOutput {
  const userTexts = messages
    .filter((m) => (m as any).message?.role === 'user')
    .flatMap((m) => ((m as any).message?.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text))
  const summary = `[压缩摘要] 共 ${messages.length} 条消息。用户要点：${userTexts.slice(0, 3).join(' / ')}`
  const facts = userTexts.filter((t) => t.includes('我叫') || t.includes('偏好') || t.includes('用')).slice(0, 3)
  return { summary, facts }
}

/**
 * 模拟 buildRecoveryPrompt（对照 General agent-orchestrator.ts L489-509）：
 * 把压缩摘要 + 补尾的最近原文拼成 session_recovery prompt，作为新 query 注入 B。
 */
function buildRecoveryPrompt(summary: string, tailMessages: SDKMessage[]): string {
  const tailText = tailMessages
    .map((m) => {
      const role = (m as any).message?.role
      const content = (m as any).message?.content ?? []
      const text = content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
      return `${role}: ${text}`
    })
    .join('\n')
  return `<session_recovery>\n${summary}\n\n<recent_turns>\n${tailText}\n</recent_turns>\n</session_recovery>`
}

// ===== 测试 =====

describe('kscc 软重置切换模拟（D9 降级方案）', () => {
  let workDir: string
  let slug: string
  let sdkJsonlA: string
  let panelJsonl: string

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'tagent-softreset-'))
    slug = 'F--test-project'
    const sessionDir = join(workDir, 'projects', slug)
    mkdirSync(sessionDir, { recursive: true })
    sdkJsonlA = join(sessionDir, 'session-A.jsonl')
    panelJsonl = join(sessionDir, 'session-A.messages.jsonl')
  })

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  function appendJsonl(path: string, messages: SDKMessage[]) {
    const lines = messages.map((m) => JSON.stringify(m)).join('\n') + '\n'
    appendFileSync(path, lines, 'utf8')
  }

  function readJsonl(path: string): SDKMessage[] {
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  }

  it('A→B 转正：拉起 B → 后台压缩 → 补尾 → 原子切换 → 归档 A，面板历史完整', () => {
    // --- 阶段 0：会话 A 起步 ---
    const safeContextLimit = 180_000 // GLM-5.2 模拟安全线
    let state: ShadowState = { sdkSessionId: 'session-A', shadowState: 'idle' }

    // 模拟 A 聊了若干轮（含工具结果膨胀），同时双写 SDK 份 + 面板份
    const earlyMsgs = [
      userMsg('我叫 Frank，用 Mac', 'u1'),
      assistantMsg('你好 Frank', 'a1'),
      userMsg('帮我读大文件', 'u2'),
      toolResultMsg('t1', 'X'.repeat(20_000), 'u3'), // 大工具结果，膨胀主体
      assistantMsg('文件内容是…', 'a2'),
    ]
    appendJsonl(sdkJsonlA, earlyMsgs)
    appendJsonl(panelJsonl, earlyMsgs) // 面板份同步双写

    // --- 阶段 1：A 继续膨胀到 60% 阈值 ---
    // 继续追加直到粗估 token 达 60% safeContextLimit（累加估算，避免 O(n²) 重读）
    let moreMsgs: SDKMessage[] = []
    let turn = 4
    let tokensSoFar = estimateTokens([...earlyMsgs])
    while (tokensSoFar < safeContextLimit * 0.62) { // 0.62 留余量，确保读全文件重算后仍 ≥0.6
      const tr = toolResultMsg(`t${turn}`, 'Y'.repeat(8_000), `u${turn + 1}`)
      const as = assistantMsg(`结果 ${turn}`, `a${turn}`)
      moreMsgs.push(tr, as)
      tokensSoFar += estimateTokens([tr, as])
      turn += 2
    }
    appendJsonl(sdkJsonlA, moreMsgs)
    appendJsonl(panelJsonl, moreMsgs)

    const allAMsgs = readJsonl(sdkJsonlA)
    const tokensA = estimateTokens(allAMsgs)
    expect(tokensA).toBeGreaterThanOrEqual(safeContextLimit * 0.6)

    // --- 阶段 2：拉起 B，后台压缩 ---
    state.shadowState = 'compacting'
    state.shadowCursor = (allAMsgs[allAMsgs.length - 1] as any).uuid // 记录拉起时刻 A 末尾 uuid
    const sdkJsonlB = join(workDir, 'projects', slug, 'session-B.jsonl')
    state.shadowSessionId = 'session-B'

    // B 后台压缩：读 JSONL-A 全量 → mock LLM → 生成摘要 + 事实
    const { summary, facts } = mockLLMCompact(allAMsgs)
    expect(summary).toContain('压缩摘要')
    expect(facts.length).toBeGreaterThan(0)
    // 事实进 L5（这里只验证产出，不写真 L5）
    expect(facts.some((f) => f.includes('Frank'))).toBe(true)

    // 生成 JSONL-B：压缩摘要作为首条 system/summary 消息
    const summaryMsg = {
      type: 'user',
      uuid: 'b-summary',
      message: { role: 'user', content: [{ type: 'text', text: summary }] },
      parent_tool_use_id: null,
    } as unknown as SDKMessage
    appendJsonl(sdkJsonlB, [summaryMsg])

    // A 在 B 压缩期间继续聊（模拟不阻塞）—— 追加到 A，量要够让 A 过 75%（累加估算）
    const duringCompaction: SDKMessage[] = []
    let postTurn = 0
    let postTokens = tokensSoFar // 接续 A 当前 token
    while (postTokens < safeContextLimit * 0.77) { // 0.77 留余量，确保 ≥0.75
      const tr = toolResultMsg(`t-post-${postTurn}`, 'Z'.repeat(8_000), `u-after-${postTurn}`)
      const as = assistantMsg(`后补 ${postTurn}`, `a-after-${postTurn}`)
      duringCompaction.push(tr, as)
      postTokens += estimateTokens([tr, as])
      postTurn += 1
    }
    appendJsonl(sdkJsonlA, duringCompaction)
    appendJsonl(panelJsonl, duringCompaction) // 面板份继续双写

    state.shadowState = 'ready'
    // 拉起时 A 末尾 uuid = moreMsgs 最后一条 assistantMsg（循环 turn 每次 +2，结束时比最后编号多 2）
    expect(state.shadowCursor).toBe(`a${turn - 2}`)

    // --- 阶段 3：A 达 75% → 原子切换 ---
    // 继续追加让 A 过 75%（压缩期间又加了几条）
    const allALatest = readJsonl(sdkJsonlA)
    expect(estimateTokens(allALatest)).toBeGreaterThanOrEqual(safeContextLimit * 0.75)

    state.shadowState = 'switching'

    // a. 补尾：shadowCursor 之后 A 新增的消息 → 追加到 JSONL-B
    const cursorIdx = allALatest.findIndex((m) => (m as any).uuid === state.shadowCursor)
    expect(cursorIdx).toBeGreaterThanOrEqual(0)
    const tailMessages = allALatest.slice(cursorIdx + 1)
    expect(tailMessages.length).toBe(duringCompaction.length) // 压缩期间新增的全部
    appendJsonl(sdkJsonlB, tailMessages)

    // b. mock spawn 新 kscc：新 query + session_recovery prompt（D9 降级方案，不 resume 预写 JSONL）
    const recoveryPrompt = buildRecoveryPrompt(summary, tailMessages)
    expect(recoveryPrompt).toContain('<session_recovery>')
    expect(recoveryPrompt).toContain('后补 0') // 补尾原文在 prompt 里
    // 模拟新进程拿到新 sdkSessionId
    const newSdkSessionId = 'session-B' // B 转正后的 id

    // c. meta.sdkSessionId 改指 B（原子：先确认 B spawn 成功再改）
    const prevSdkSessionId = state.sdkSessionId
    state.sdkSessionId = newSdkSessionId
    state.shadowChainPrev = prevSdkSessionId // 单向链前驱

    // d. 归档 A：rename .archived
    const archivedA = sdkJsonlA + '.archived'
    renameSync(sdkJsonlA, archivedA)
    state.shadowState = 'switched'

    // --- 阶段 4：验证 B 转正 ---
    // B 成新 A，下次 60% 拉新影子 C，shadowState 重置 idle
    state.shadowState = 'idle'
    state.shadowSessionId = undefined
    state.shadowCursor = undefined

    expect(state.sdkSessionId).toBe('session-B')
    expect(state.shadowState).toBe('idle')
    expect(state.shadowChainPrev).toBe('session-A') // 可回溯

    // B 的 JSONL 有内容（摘要 + 补尾）
    const bMsgs = readJsonl(sdkJsonlB)
    expect(bMsgs.length).toBe(1 + duringCompaction.length) // 1 摘要 + 补尾全部
    expect((bMsgs[0] as any).uuid).toBe('b-summary')

    // A 已归档
    expect(existsSync(archivedA)).toBe(true)
    expect(existsSync(sdkJsonlA)).toBe(false)

    // ★ 关键验证：面板历史完整（D5 分离的核心收益）
    // 面板份从起步到现在一直只追加，跨 A/B 切换无感，用户看到完整历史
    const panelMsgs = readJsonl(panelJsonl)
    expect(panelMsgs.length).toBe(earlyMsgs.length + moreMsgs.length + duringCompaction.length)
    // 面板里早期消息一个不少（包括工具结果原文）
    expect(panelMsgs.some((m) => (m as any).uuid === 'u1')).toBe(true) // 我叫 Frank
    expect(panelMsgs.some((m) => (m as any).uuid === 'u3')).toBe(true) // 大工具结果
    expect(panelMsgs.some((m) => (m as any).uuid === 'u-after-1')).toBe(true) // 压缩期间的消息

    // SDK 份 B 比面板份小很多（压缩了），但面板份完整
    const bTokens = estimateTokens(bMsgs)
    const panelTokens = estimateTokens(panelMsgs)
    expect(bTokens).toBeLessThan(panelTokens)
  })

  it('切换原子性：B spawn 失败时回滚，不归档 A，A 继续可用', () => {
    // 先给 A 写初始内容（模拟会话已有历史）
    appendJsonl(sdkJsonlA, [userMsg('已有历史', 'u-pre'), assistantMsg('ok', 'a-pre')])
    let state: ShadowState = { sdkSessionId: 'session-A', shadowState: 'ready' }
    const sdkJsonlB = join(workDir, 'projects', slug, 'session-B-fail.jsonl')
    // 预写 B
    appendJsonl(sdkJsonlB, [userMsg('B 摘要', 'b1')])
    state.shadowSessionId = 'session-B-fail'
    state.shadowState = 'switching'

    // 模拟 spawn B 失败（抛错）
    let spawnOk = false
    try {
      // mock: spawn 抛错
      throw new Error('spawn kscc failed')
    } catch {
      spawnOk = false
    }

    if (!spawnOk) {
      // 回滚：不归档 A，不改 sdkSessionId，shadowState 回 ready 重试
      state.shadowState = 'ready'
      // sdkSessionId 仍是 A
      expect(state.sdkSessionId).toBe('session-A')
      // A 的 JSONL 没动（没归档）
      expect(existsSync(sdkJsonlA)).toBe(true)
    }

    // A 仍可继续聊（append 到 A）
    appendJsonl(sdkJsonlA, [userMsg('继续聊', 'u-rollback')])
    const aMsgs = readJsonl(sdkJsonlA)
    expect(aMsgs.some((m) => (m as any).uuid === 'u-rollback')).toBe(true)
  })

  it('廉价清理：45% 阈值先 drop_old_tool_results，不拉影子', () => {
    // 模拟 A 到 45%，先廉价清理（丢老工具结果），不调 LLM
    const msgs = [
      userMsg('任务开始', 'u1'),          // 0 firstN
      assistantMsg('开始', 'a1'),          // 1 firstN
      userMsg('读文件1和2', 'u2'),         // 2 firstN
      toolResultMsg('t1', 'OLD'.repeat(1000), 'u3'), // 3 middle — 老工具结果
      toolResultMsg('t2', 'OLD'.repeat(1000), 'u4'), // 4 middle — 老工具结果
      userMsg('继续', 'u5'),               // 5 lastN 起（-6 = 索引5）
      assistantMsg('ok', 'a6'),           // 6
      userMsg('再读', 'u7'),               // 7
      toolResultMsg('t3', 'RECENT', 'u8'), // 8
      assistantMsg('done', 'a9'),          // 9
      userMsg('收尾', 'u10'),              // 10
    ]
    // PROTECT_FIRST_N=3 / PROTECT_LAST_N=6
    const firstN = msgs.slice(0, 3)
    const middle = msgs.slice(3, -6)   // 索引 3,4 = 两条纯 tool_result
    const lastN = msgs.slice(-6)
    expect(middle.length).toBe(2)
    // middle 里纯 tool_result 的可丢（u3/u4）
    const droppable = middle.filter((m) => {
      const content = (m as any).message?.content ?? []
      return Array.isArray(content) && content.length > 0 && content.every((b: any) => b.type === 'tool_result')
    })
    expect(droppable.length).toBe(2)
    const kept = [...firstN, ...middle.filter((m) => !droppable.includes(m)), ...lastN]
    expect(kept.length).toBe(msgs.length - 2)
    // 面板份不丢（D5：面板仍见完整工具结果）
    expect(msgs.some((m) => (m as any).uuid === 'u3')).toBe(true)
  })
})
