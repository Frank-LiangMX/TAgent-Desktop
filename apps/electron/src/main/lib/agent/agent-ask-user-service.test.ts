/**
 * REGRESS-H vitest — AgentAskUserService 状态机
 *
 * 规格：docs/dev/core-loop/REGRESS-H-implement-brief.md 切片 4
 * 断言：
 * - handleAskUserQuestion 解析 questions（含 preview 截断 / 缺字段兜底）并发 ASK_USER_REQUEST，pending 等待
 * - respondToAskUser 注入 updatedInput.answers + resolve allow；未找到 requestId 返回 null
 * - abort signal → deny「操作已中止」
 * - clearSessionPending → deny「会话已结束」+ 清出 pending
 */
import { describe, expect, it } from 'vitest'
import { askUserService } from './agent-ask-user-service'
import type { AskUserRequest } from '@tagent/shared'

describe('AgentAskUserService（REGRESS-H）', () => {
  it('handleAskUserQuestion 解析 questions 并发请求；respond 注入 answers + allow', async () => {
    const ac = new AbortController()
    const sent: AskUserRequest[] = []
    const p = askUserService.handleAskUserQuestion(
      's1',
      {
        questions: [
          {
            question: 'Q1',
            header: 'h',
            multiSelect: true,
            options: [{ label: 'A', description: 'd', preview: 'p' }],
          },
        ],
      },
      ac.signal,
      (r) => sent.push(r)
    )

    // 同步发出请求 + 解析字段
    expect(sent).toHaveLength(1)
    const req = sent[0]!
    expect(req.sessionId).toBe('s1')
    expect(req.requestId).toBeTruthy()
    expect(req.questions).toEqual([
      {
        question: 'Q1',
        header: 'h',
        multiSelect: true,
        options: [{ label: 'A', description: 'd', preview: 'p' }],
      },
    ])
    // 保留原始 toolInput
    expect(Array.isArray(req.toolInput.questions)).toBe(true)
    // 未 respond 前 pending 含本请求
    expect(askUserService.getPendingRequests().some((r) => r.requestId === req.requestId)).toBe(true)

    // respond → 注入 answers + resolve allow
    const sid = askUserService.respondToAskUser(req.requestId, { Q1: 'A' })
    expect(sid).toBe('s1')
    const result = await p
    expect(result.behavior).toBe('allow')
    if (result.behavior === 'allow') {
      expect(result.updatedInput.answers).toEqual({ Q1: 'A' })
      expect(Array.isArray(result.updatedInput.questions)).toBe(true)
    }
    // respond 后 pending 已清
    expect(askUserService.getPendingRequests().some((r) => r.requestId === req.requestId)).toBe(false)
  })

  it('respondToAskUser 未找到 requestId → null', () => {
    expect(askUserService.respondToAskUser('not-exist', {})).toBeNull()
  })

  it('dismissToAskUser → deny「用户取消选择」+ interrupt，清 pending', async () => {
    const ac = new AbortController()
    const sent: AskUserRequest[] = []
    const p = askUserService.handleAskUserQuestion(
      's-dismiss',
      { questions: [{ question: 'Q?', options: [{ label: 'A' }] }] },
      ac.signal,
      (r) => sent.push(r),
    )
    const req = sent[0]!
    const sid = askUserService.dismissToAskUser(req.requestId)
    expect(sid).toBe('s-dismiss')
    await expect(p).resolves.toEqual({
      behavior: 'deny',
      message: '用户取消选择',
      interrupt: true,
    })
    expect(askUserService.getPendingRequests().some((r) => r.requestId === req.requestId)).toBe(
      false,
    )
    expect(askUserService.dismissToAskUser(req.requestId)).toBeNull()
  })

  it('abort signal → deny「操作已中止」', async () => {
    const ac = new AbortController()
    const p = askUserService.handleAskUserQuestion('s2', { questions: [] }, ac.signal, () => {})
    ac.abort()
    await expect(p).resolves.toEqual({ behavior: 'deny', message: '操作已中止' })
  })

  it('clearSessionPending → deny「会话已结束」+ 清出 pending', async () => {
    const ac = new AbortController()
    const p = askUserService.handleAskUserQuestion('s3', { questions: [] }, ac.signal, () => {})
    expect(askUserService.getPendingRequests().some((r) => r.sessionId === 's3')).toBe(true)
    askUserService.clearSessionPending('s3')
    await expect(p).resolves.toEqual({ behavior: 'deny', message: '会话已结束' })
    expect(askUserService.getPendingRequests().some((r) => r.sessionId === 's3')).toBe(false)
  })

  it('parseQuestions：preview 超 10_000 截断；options 非数组 → []；缺 question → 空', async () => {
    const ac = new AbortController()
    const sent: AskUserRequest[] = []
    const longPreview = 'x'.repeat(20_000)
    const p = askUserService.handleAskUserQuestion(
      's4',
      {
        questions: [
          { options: [{ label: 'A', preview: longPreview }] },
          { question: '', options: 'not-array' },
        ],
      },
      ac.signal,
      (r) => sent.push(r)
    )
    const q = sent[0]!.questions
    expect(q[0]!.options[0]!.preview?.length).toBe(10_000)
    expect(q[1]!.options).toEqual([])
    expect(q[1]!.question).toBe('')
    askUserService.clearSessionPending('s4')
    await expect(p).resolves.toEqual({ behavior: 'deny', message: '会话已结束' })
  })
})
