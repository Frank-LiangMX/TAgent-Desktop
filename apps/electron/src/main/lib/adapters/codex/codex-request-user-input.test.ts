import { describe, expect, it } from 'vitest'
import {
  buildCodexAskUserInput,
  buildCodexRequestUserInputResponse,
  parseCodexRequestUserInputParams,
} from './codex-request-user-input'

const params = {
  threadId: 'thr_1',
  turnId: 'turn_1',
  itemId: 'item_1',
  isBlocking: true,
  autoResolutionMs: null,
  questions: [
    {
      id: 'strategy',
      header: '方案',
      question: '选择实现方案',
      isOther: false,
      isSecret: false,
      options: [
        { label: 'A', description: '保守改造' },
        { label: 'B', description: '完整重构' },
      ],
    },
    {
      id: 'token',
      header: '凭据',
      question: '输入临时口令',
      isOther: true,
      isSecret: true,
      options: null,
    },
  ],
} as const

describe('Codex requestUserInput 映射', () => {
  it('校验协议参数并转成现有 AskUser 输入', () => {
    const parsed = parseCodexRequestUserInputParams(params)
    expect(parsed).not.toBeNull()
    expect(buildCodexAskUserInput(parsed!)).toEqual({
      questions: [
        {
          answerKey: 'strategy',
          header: '方案',
          question: '选择实现方案',
          options: [
            { label: 'A', description: '保守改造' },
            { label: 'B', description: '完整重构' },
          ],
          multiSelect: false,
          allowOther: false,
          secret: false,
        },
        {
          answerKey: 'token',
          header: '凭据',
          question: '输入临时口令',
          options: [],
          multiSelect: false,
          allowOther: true,
          secret: true,
        },
      ],
    })
  })

  it('按 question id 映射回 App Server answers 数组', () => {
    const parsed = parseCodexRequestUserInputParams(params)!
    expect(
      buildCodexRequestUserInputResponse(parsed, {
        strategy: 'B',
        token: 'secret-value',
        ignored: 'x',
      }),
    ).toEqual({
      answers: {
        strategy: { answers: ['B'] },
        token: { answers: ['secret-value'] },
      },
    })
    expect(buildCodexRequestUserInputResponse(parsed, undefined)).toEqual({
      answers: {},
    })
  })

  it('拒绝缺少协议必填字段的问题', () => {
    expect(
      parseCodexRequestUserInputParams({
        ...params,
        questions: [{ question: 'missing id' }],
      }),
    ).toBeNull()
  })
})
