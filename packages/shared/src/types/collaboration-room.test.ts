import { describe, expect, test } from 'vitest'
import {
  COLLABORATION_MENTION_ALL,
  COLLABORATION_ROOM_DEFAULT_MAX_A2A_DEPTH,
  COLLABORATION_ROOM_DEFAULT_MAX_CONCURRENT_RUNS,
  COLLABORATION_ROOM_HARD_MAX_A2A_DEPTH,
  COLLABORATION_ROOM_MAX_MEMBERS,
  COLLABORATION_RUN_ID_PREFIX,
  collaborationContinuationIdempotencyKey,
  collaborationRunIdempotencyKey,
  nextCollaborationMentionAliases,
  isCollaborationMemberStatus,
  isCollaborationRoomStatus,
  isCollaborationRunStatus,
  parseCollaborationMentions,
  resolveCollaborationMentions,
  stripCollaborationRoutableMentions,
  validateCreateCollaborationRoomInput,
  type CollaborationMember,
  type CreateCollaborationRoomInput,
} from './collaboration-room'

/** 构造最小成员（只供 mention 解析用） */
function mkMember(id: string, displayName: string): CollaborationMember {
  return {
    id,
    roomId: 'cr_x',
    displayName,
    roleSnapshot: { displayName },
    backend: 'channel',
    logicalSessionId: 'ls_' + id,
    permissionProfile: 'read-only',
    capabilities: {
      supportsResume: false,
      supportsLiveInput: false,
      supportsToolBridge: false,
      supportsStructuredEvents: false,
    },
    status: 'idle',
    isCoordinator: false,
    createdAt: 0,
    updatedAt: 0,
  }
}

describe('collaboration-room 常量', () => {
  test('默认并发与 A2A 深度对齐 02-RUNTIME-A2A-SPEC §9', () => {
    expect(COLLABORATION_ROOM_DEFAULT_MAX_CONCURRENT_RUNS).toBe(3)
    expect(COLLABORATION_ROOM_DEFAULT_MAX_A2A_DEPTH).toBe(4)
    expect(COLLABORATION_ROOM_HARD_MAX_A2A_DEPTH).toBe(10)
    expect(COLLABORATION_ROOM_MAX_MEMBERS).toBe(6)
  })

  test('run ID 前缀对齐', () => {
    expect(COLLABORATION_RUN_ID_PREFIX).toBe('run_')
  })
})

describe('isCollaborationRunStatus', () => {
  test('合法 run 状态', () => {
    expect(isCollaborationRunStatus('queued')).toBe(true)
    expect(isCollaborationRunStatus('running')).toBe(true)
    expect(isCollaborationRunStatus('done')).toBe(true)
    expect(isCollaborationRunStatus('failed')).toBe(true)
    expect(isCollaborationRunStatus('cancelled')).toBe(true)
    expect(isCollaborationRunStatus('blocked')).toBe(true)
  })

  test('非法 run 状态', () => {
    expect(isCollaborationRunStatus('active')).toBe(false)
    expect(isCollaborationRunStatus('interrupted')).toBe(false)
    expect(isCollaborationRunStatus(undefined)).toBe(false)
    expect(isCollaborationRunStatus(123)).toBe(false)
  })
})

describe('collaborationRunIdempotencyKey', () => {
  test('由 triggerMessageId + memberId 稳定派生（不含时间戳）', () => {
    const key1 = collaborationRunIdempotencyKey('msg_a', 'cm_b')
    const key2 = collaborationRunIdempotencyKey('msg_a', 'cm_b')
    expect(key1).toBe('msg_a:cm_b')
    expect(key1).toBe(key2)
  })

  test('不同触发或不同成员得到不同键', () => {
    expect(collaborationRunIdempotencyKey('msg_a', 'cm_b')).not.toBe(
      collaborationRunIdempotencyKey('msg_b', 'cm_b'),
    )
    expect(collaborationRunIdempotencyKey('msg_a', 'cm_b')).not.toBe(
      collaborationRunIdempotencyKey('msg_a', 'cm_c'),
    )
  })
})

describe('collaborationContinuationIdempotencyKey', () => {
  test('由 requestId + 提问者 memberId 稳定派生', () => {
    expect(collaborationContinuationIdempotencyKey('req_1', 'cm_a')).toBe(
      'a2a-continue:req_1:cm_a',
    )
    expect(collaborationContinuationIdempotencyKey('req_1', 'cm_a')).toBe(
      collaborationContinuationIdempotencyKey('req_1', 'cm_a'),
    )
  })

  test('不同 request 或不同成员得到不同键', () => {
    expect(collaborationContinuationIdempotencyKey('req_1', 'cm_a')).not.toBe(
      collaborationContinuationIdempotencyKey('req_2', 'cm_a'),
    )
    expect(collaborationContinuationIdempotencyKey('req_1', 'cm_a')).not.toBe(
      collaborationContinuationIdempotencyKey('req_1', 'cm_b'),
    )
  })
})

describe('isCollaborationRoomStatus', () => {
  test('合法房间状态', () => {
    expect(isCollaborationRoomStatus('active')).toBe(true)
    expect(isCollaborationRoomStatus('paused')).toBe(true)
    expect(isCollaborationRoomStatus('archived')).toBe(true)
    expect(isCollaborationRoomStatus('completed')).toBe(true)
  })

  test('非法房间状态', () => {
    expect(isCollaborationRoomStatus('running')).toBe(false)
    expect(isCollaborationRoomStatus('')).toBe(false)
    expect(isCollaborationRoomStatus(undefined)).toBe(false)
    expect(isCollaborationRoomStatus(null)).toBe(false)
    expect(isCollaborationRoomStatus(123)).toBe(false)
  })
})

describe('isCollaborationMemberStatus', () => {
  test('合法成员状态', () => {
    expect(isCollaborationMemberStatus('offline')).toBe(true)
    expect(isCollaborationMemberStatus('idle')).toBe(true)
    expect(isCollaborationMemberStatus('running')).toBe(true)
    expect(isCollaborationMemberStatus('awaiting_peer')).toBe(true)
    expect(isCollaborationMemberStatus('awaiting_user')).toBe(true)
    expect(isCollaborationMemberStatus('done')).toBe(true)
  })

  test('非法成员状态', () => {
    expect(isCollaborationMemberStatus('active')).toBe(false)
    expect(isCollaborationMemberStatus('archived')).toBe(false)
    expect(isCollaborationMemberStatus(undefined)).toBe(false)
  })
})

describe('validateCreateCollaborationRoomInput', () => {
  test('合法输入：无错误', () => {
    const input: CreateCollaborationRoomInput = {
      title: '前端重构小组',
      goal: '把旧 React Class 组件迁到 Hooks',
      members: [
        { displayName: '协调者', isCoordinator: true },
        { displayName: '前端工程师' },
      ],
    }
    expect(validateCreateCollaborationRoomInput(input)).toEqual([])
  })

  test('空白团队（无成员）也合法', () => {
    const input: CreateCollaborationRoomInput = { title: '空白团队' }
    expect(validateCreateCollaborationRoomInput(input)).toEqual([])
  })

  test('title 为空报错', () => {
    expect(validateCreateCollaborationRoomInput({ title: '' })).toContain('title 不能为空')
    expect(validateCreateCollaborationRoomInput({ title: '   ' })).toContain('title 不能为空')
  })

  test('title 超长报错', () => {
    const input: CreateCollaborationRoomInput = { title: 'x'.repeat(201) }
    expect(validateCreateCollaborationRoomInput(input)).toContain('title 长度不能超过 200')
  })

  test('成员超过上限报错', () => {
    const members = Array.from({ length: COLLABORATION_ROOM_MAX_MEMBERS + 1 }, () => ({
      displayName: '成员',
    }))
    const input: CreateCollaborationRoomInput = { title: 't', members }
    const errors = validateCreateCollaborationRoomInput(input)
    expect(errors.some((e) => e.includes('members 数量不能超过'))).toBe(true)
  })

  test('成员 displayName 为空报错', () => {
    const input: CreateCollaborationRoomInput = {
      title: 't',
      members: [{ displayName: '' }, { displayName: '好成员' }],
    }
    const errors = validateCreateCollaborationRoomInput(input)
    expect(errors.some((e) => e.includes('members[0].displayName 不能为空'))).toBe(true)
    expect(errors.some((e) => e.includes('members[1]'))).toBe(false)
  })

  test('maxConcurrentRuns 越界报错', () => {
    expect(
      validateCreateCollaborationRoomInput({ title: 't', maxConcurrentRuns: 0 }),
    ).toContain('maxConcurrentRuns 须在 1–16')
    expect(
      validateCreateCollaborationRoomInput({ title: 't', maxConcurrentRuns: 99 }),
    ).toContain('maxConcurrentRuns 须在 1–16')
  })

  test('maxA2ADepth 超过硬上限报错', () => {
    expect(
      validateCreateCollaborationRoomInput({ title: 't', maxA2ADepth: COLLABORATION_ROOM_HARD_MAX_A2A_DEPTH + 1 }),
    ).toContain(`maxA2ADepth 须在 1–${COLLABORATION_ROOM_HARD_MAX_A2A_DEPTH}`)
  })
})

describe('parseCollaborationMentions', () => {
  test('无 @ 返回空数组（调用方回落协调者）', () => {
    const members = [mkMember('cm_coord', '协调者'), mkMember('cm_dev', '开发')]
    expect(parseCollaborationMentions('你好，帮我看下', members)).toEqual([])
    expect(parseCollaborationMentions('', members)).toEqual([])
  })

  test('@displayName 精确命中（忽略大小写）', () => {
    const members = [mkMember('cm_coord', '协调者'), mkMember('cm_dev', '开发')]
    expect(parseCollaborationMentions('@开发 做点事', members)).toEqual(['cm_dev'])
    expect(parseCollaborationMentions('@协调者 @开发 两人都来', members)).toEqual([
      'cm_coord',
      'cm_dev',
    ])
  })

  test('英文 displayName 忽略大小写匹配', () => {
    const members = [mkMember('cm_a', 'Alice'), mkMember('cm_b', 'Bob')]
    expect(parseCollaborationMentions('@alice @BOB', members)).toEqual(['cm_a', 'cm_b'])
  })

  test('@all → 全部成员（含协调者，按成员顺序去重）', () => {
    const members = [
      mkMember('cm_coord', '协调者'),
      mkMember('cm_dev', '开发'),
      mkMember('cm_qa', '测试'),
    ]
    expect(parseCollaborationMentions('@all 一起上', members)).toEqual([
      'cm_coord',
      'cm_dev',
      'cm_qa',
    ])
    // @ALL 忽略大小写
    expect(parseCollaborationMentions('@ALL', members)).toEqual([
      'cm_coord',
      'cm_dev',
      'cm_qa',
    ])
  })

  test('@all 与具体点名共存：去重后仍为全部成员', () => {
    const members = [mkMember('cm_coord', '协调者'), mkMember('cm_dev', '开发')]
    expect(parseCollaborationMentions('@all @开发', members)).toEqual(['cm_coord', 'cm_dev'])
  })

  test('无匹配的 @ 忽略（不报错、不影响其他命中）', () => {
    const members = [mkMember('cm_dev', '开发')]
    expect(parseCollaborationMentions('@不存在', members)).toEqual([])
    expect(parseCollaborationMentions('@不存在 @开发', members)).toEqual(['cm_dev'])
  })

  test('末尾标点被剥掉（@开发。 → 开发）', () => {
    const members = [mkMember('cm_dev', '开发')]
    expect(parseCollaborationMentions('@开发。', members)).toEqual(['cm_dev'])
    expect(parseCollaborationMentions('@开发, @开发；', members)).toEqual(['cm_dev'])
  })

  test('同一成员多次 @ 仅记录一次', () => {
    const members = [mkMember('cm_dev', '开发')]
    expect(parseCollaborationMentions('@开发 @开发 @开发', members)).toEqual(['cm_dev'])
  })

  test('@all 特殊常量值为 all', () => {
    expect(COLLABORATION_MENTION_ALL).toBe('all')
  })

  test('改名后 @旧名 仍命中 mentionAliases', () => {
    const members = [
      mkMember('cm_dev', '主程'),
    ]
    members[0]!.mentionAliases = ['开发']
    expect(parseCollaborationMentions('@开发 看下', members)).toEqual(['cm_dev'])
    expect(parseCollaborationMentions('@主程 看下', members)).toEqual(['cm_dev'])
  })

  test('当前 displayName 占用同名时优先于别人的别名', () => {
    const oldDev = mkMember('cm_old', '主程')
    oldDev.mentionAliases = ['开发']
    const newDev = mkMember('cm_new', '开发')
    expect(parseCollaborationMentions('@开发', [oldDev, newDev])).toEqual(['cm_new'])
  })

  test('@memberId 精确命中', () => {
    const members = [mkMember('cm_dev', '开发')]
    expect(parseCollaborationMentions('@cm_dev 看下', members)).toEqual(['cm_dev'])
  })
})

describe('resolveCollaborationMentions（S3.5-a H1，04 §4.5）', () => {
  const members = () => [
    mkMember('cm_coord', '协调者'),
    mkMember('cm_dev', '开发'),
    mkMember('cm_qa', '测试'),
  ]
  const resolve = (
    text: string,
    opts: Partial<Parameters<typeof resolveCollaborationMentions>[0]> = {},
  ) =>
    resolveCollaborationMentions({
      text,
      members: members(),
      sender: { type: 'user' },
      ...opts,
    })

  test('M1 无 @、无 structured → []（调用方回落协调者）', () => {
    expect(resolve('你好').targetMemberIds).toEqual([])
    expect(resolve('').targetMemberIds).toEqual([])
  })

  test('M2 @开发 文本兜底 → 开发 id', () => {
    const r = resolve('@开发 看下')
    expect(r.targetMemberIds).toEqual(['cm_dev'])
    expect(r.dropped).toEqual([])
  })

  test('M3 结构化 {memberId:开发}，正文写 @协调者 → 只开发（正文忽略）', () => {
    const r = resolve('@协调者 你好', {
      structured: [{ kind: 'agent', memberId: 'cm_dev', displayNameSnapshot: '开发' }],
    })
    expect(r.targetMemberIds).toEqual(['cm_dev'])
  })

  test('M4 structured: [] + 正文 @开发 → []（明确无目标，不再扫正文）', () => {
    expect(resolve('@开发', { structured: [] }).targetMemberIds).toEqual([])
  })

  test('M5 @all 用户 → 全部成员原序', () => {
    const r = resolve('@all 一起上')
    expect(r.targetMemberIds).toEqual(['cm_coord', 'cm_dev', 'cm_qa'])
    expect(r.usedAll).toBe(true)
  })

  test('M6 成员 sender + 正文 @all → []', () => {
    const r = resolveCollaborationMentions({
      text: '@all',
      members: members(),
      sender: { type: 'member', memberId: 'cm_dev' },
    })
    expect(r.targetMemberIds).toEqual([])
    expect(r.usedAll).toBe(false)
  })

  test('M7 引用块内 @开发 不命中', () => {
    expect(
      resolve('<quoted_message message_id="m1" author="用户">@开发</quoted_message> 请看')
        .targetMemberIds,
    ).toEqual([])
  })

  test('M8 请看@开发。 → 命中（末尾句号剥离）', () => {
    expect(resolve('请看@开发。').targetMemberIds).toEqual(['cm_dev'])
  })

  test('M9 a@开发 → 不命中（ASCII 前边界）', () => {
    expect(resolve('a@开发').targetMemberIds).toEqual([])
  })

  test('M10 请@开发@开发 → 开发一次', () => {
    expect(resolve('请@开发@开发').targetMemberIds).toEqual(['cm_dev'])
  })

  test('M11 两成员都叫「开发」+ 文本 @开发 → [] + dropped ambiguous-name', () => {
    const dup = [mkMember('cm_a', '开发'), mkMember('cm_b', '开发')]
    const r = resolveCollaborationMentions({
      text: '@开发',
      members: dup,
      sender: { type: 'user' },
    })
    expect(r.targetMemberIds).toEqual([])
    expect(r.dropped).toEqual([{ token: '开发', reason: 'ambiguous-name' }])
  })

  test('M12 同名 + 结构化 memberId → 命中该 id', () => {
    const dup = [mkMember('cm_a', '开发'), mkMember('cm_b', '开发')]
    const r = resolveCollaborationMentions({
      text: '@开发',
      members: dup,
      sender: { type: 'user' },
      structured: [{ kind: 'agent', memberId: 'cm_b' }],
    })
    expect(r.targetMemberIds).toEqual(['cm_b'])
  })

  test('M14 未知 memberId 结构化项 → 丢掉，不抛', () => {
    const r = resolve('@开发', {
      structured: [
        { kind: 'agent', memberId: 'cm_ghost', displayNameSnapshot: '幽灵' },
        { kind: 'agent', memberId: 'cm_dev' },
      ],
    })
    expect(r.targetMemberIds).toEqual(['cm_dev'])
    expect(r.dropped).toEqual([{ token: '幽灵', reason: 'unknown-member-id' }])
  })
})

describe('stripCollaborationRoutableMentions（S3.5-a 投影剥 @）', () => {
  test('剥掉 routable @token 保留句末标点', () => {
    expect(stripCollaborationRoutableMentions('请看@开发。')).toBe('请看。')
    expect(stripCollaborationRoutableMentions('请@开发@开发')).toBe('请')
  })

  test('邮箱 / ASCII 前边界保留', () => {
    expect(stripCollaborationRoutableMentions('a@开发 联系 foo@bar.com')).toBe(
      'a@开发 联系 foo@bar.com',
    )
  })

  test('代码围栏内 @开发 保留', () => {
    expect(stripCollaborationRoutableMentions('```\n@开发\n```')).toBe('```\n@开发\n```')
  })
})

describe('nextCollaborationMentionAliases', () => {
  test('旧名进入别名，新名从别名摘掉', () => {
    expect(nextCollaborationMentionAliases(['前端'], '开发', '主程')).toEqual(['前端', '开发'])
    expect(nextCollaborationMentionAliases(['主程', '开发'], '主程', '开发')).toEqual(['主程'])
  })

  test('同名改写（仅大小写）不堆积别名', () => {
    expect(nextCollaborationMentionAliases(undefined, '开发', '开发')).toEqual([])
    expect(nextCollaborationMentionAliases(['开发'], '开发', '开发')).toEqual([])
  })
})
