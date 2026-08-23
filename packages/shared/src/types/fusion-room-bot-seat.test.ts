import { describe, expect, test } from 'vitest'
import type { BotProfileRecord } from './fusion-session'
import { createRoomBotSeatFromProfile } from './fusion-session'

const makeRecord = (): BotProfileRecord => ({
  profile: {
    id: 'bot-researcher',
    ownerUserId: 'user-a',
    displayName: '研究员',
    status: 'active',
    currentConfigRevisionId: 'bot-researcher-r2',
    memoryNamespace: 'bot-researcher',
    createdAt: 1,
    updatedAt: 2,
  },
  revisions: [{
    id: 'bot-researcher-r2',
    botProfileId: 'bot-researcher',
    version: 2,
    backend: 'channel',
    channelId: 'channel-a',
    modelId: 'model-a',
    roleSnapshot: {
      displayName: '研究员',
      description: '负责研究',
      systemPrompt: '先查证再回答',
    },
    permissionProfile: 'workspace-write',
    capabilities: {
      supportsResume: true,
      supportsLiveInput: true,
      supportsToolBridge: true,
      supportsStructuredEvents: true,
    },
    createdAt: 2,
  }],
})

describe('createRoomBotSeatFromProfile', () => {
  test('复制当前 revision 为独立房间席位快照', () => {
    const record = makeRecord()
    const seat = createRoomBotSeatFromProfile(record, {
      id: 'seat-1',
      roomId: 'room-1',
      logicalSessionId: 'room-1-bot-researcher',
      createdAt: 100,
      isCoordinator: true,
    })
    expect(seat.botProfileId).toBe('bot-researcher')
    expect(seat.configRevisionId).toBe('bot-researcher-r2')
    expect(seat.channelId).toBe('channel-a')
    expect(seat.modelId).toBe('model-a')
    expect(seat.isCoordinator).toBe(true)
    expect(seat.status).toBe('idle')

    record.revisions[0]!.roleSnapshot.systemPrompt = '后续新内容'
    record.revisions[0]!.capabilities.supportsToolBridge = false
    expect(seat.roleSnapshot.systemPrompt).toBe('先查证再回答')
    expect(seat.capabilities.supportsToolBridge).toBe(true)
  })

  test('当前 revision 缺失或 Bot 已归档时拒绝加入新房间', () => {
    const record = makeRecord()
    record.profile.currentConfigRevisionId = 'missing'
    expect(() => createRoomBotSeatFromProfile(record, {
      id: 'seat-1', roomId: 'room-1', logicalSessionId: 'logical-1', createdAt: 100,
    })).toThrow('当前 revision 不存在')

    const archived = makeRecord()
    archived.profile.status = 'archived'
    expect(() => createRoomBotSeatFromProfile(archived, {
      id: 'seat-1', roomId: 'room-1', logicalSessionId: 'logical-1', createdAt: 100,
    })).toThrow('已归档')
  })
})