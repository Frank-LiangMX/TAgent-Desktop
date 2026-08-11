/**
 * 协作室持久化仓库（atomic-json，Stage 1）
 *
 * 三份独立 JSON 文件，均放在 ~/.tagent[-dev]/collaboration/ 下：
 * - rooms.json    { version, rooms:    CollaborationRoom[]    }
 * - members.json  { version, members: CollaborationMember[] }
 * - messages.json { version, messages: CollaborationMessage[] }
 *
 * 读写均走 atomic-json（tmp + .bak + rename），损坏自愈从 .bak 恢复。
 * Stage 1 为单用户本地骨架，三文件各自原子写；createRoom 先写 rooms 再写 members，
 * 若 members 写失败则房间已落盘、成员缺失（可接受降级，S2+ 再补事务/回滚）。
 *
 * 设计参考：apps/electron/src/main/lib/channel/channel-store.ts（CRUD + atomic-json）
 */
import type {
  CollaborationRoom,
  CollaborationMember,
  CollaborationMessage,
} from '@tagent/shared'
import { readJsonSafe, writeJsonAtomic } from '../atomic-json'
import {
  getCollaborationRoomsPath,
  getCollaborationMembersPath,
  getCollaborationMessagesPath,
} from '../config/config-paths'

/** 配置版本号 */
const CONFIG_VERSION = 1

// ===== rooms.json =====

interface RoomsConfig {
  version: number
  rooms: CollaborationRoom[]
}

function readRoomsConfig(): RoomsConfig {
  const parsed = readJsonSafe<RoomsConfig | null>(getCollaborationRoomsPath(), null)
  if (!parsed || !Array.isArray(parsed.rooms)) {
    return { version: CONFIG_VERSION, rooms: [] }
  }
  return parsed
}

function writeRoomsConfig(config: RoomsConfig): void {
  try {
    writeJsonAtomic(getCollaborationRoomsPath(), config)
  } catch (err) {
    console.error('[协作室存储] 写入 rooms.json 失败:', err)
    throw new Error('写入协作室房间数据失败')
  }
}

/** 读取全部房间（原始顺序） */
export function loadRooms(): CollaborationRoom[] {
  return readRoomsConfig().rooms
}

/** 全量写回房间列表 */
export function saveRooms(rooms: CollaborationRoom[]): void {
  writeRoomsConfig({ version: CONFIG_VERSION, rooms })
}

/** upsert 单个房间（按 id） */
export function upsertRoom(room: CollaborationRoom): void {
  const config = readRoomsConfig()
  const idx = config.rooms.findIndex((r) => r.id === room.id)
  if (idx === -1) config.rooms.push(room)
  else config.rooms[idx] = room
  writeRoomsConfig(config)
}

/** 取单个房间 */
export function getRoom(roomId: string): CollaborationRoom | undefined {
  return readRoomsConfig().rooms.find((r) => r.id === roomId)
}

// ===== members.json =====

interface MembersConfig {
  version: number
  members: CollaborationMember[]
}

function readMembersConfig(): MembersConfig {
  const parsed = readJsonSafe<MembersConfig | null>(getCollaborationMembersPath(), null)
  if (!parsed || !Array.isArray(parsed.members)) {
    return { version: CONFIG_VERSION, members: [] }
  }
  return parsed
}

function writeMembersConfig(config: MembersConfig): void {
  try {
    writeJsonAtomic(getCollaborationMembersPath(), config)
  } catch (err) {
    console.error('[协作室存储] 写入 members.json 失败:', err)
    throw new Error('写入协作室成员数据失败')
  }
}

/** 读取全部成员（可选按房间过滤） */
export function loadMembers(roomId?: string): CollaborationMember[] {
  const all = readMembersConfig().members
  return roomId ? all.filter((m) => m.roomId === roomId) : all
}

/** 全量写回成员列表 */
export function saveMembers(members: CollaborationMember[]): void {
  writeMembersConfig({ version: CONFIG_VERSION, members })
}

/** 追加成员（不做去重，由调用方保证 id 唯一） */
export function appendMembers(newMembers: CollaborationMember[]): void {
  if (newMembers.length === 0) return
  const config = readMembersConfig()
  config.members.push(...newMembers)
  writeMembersConfig(config)
}

/** 列出某房间全部成员 */
export function listMembersByRoom(roomId: string): CollaborationMember[] {
  return loadMembers(roomId)
}

// ===== messages.json =====

interface MessagesConfig {
  version: number
  messages: CollaborationMessage[]
}

function readMessagesConfig(): MessagesConfig {
  const parsed = readJsonSafe<MessagesConfig | null>(getCollaborationMessagesPath(), null)
  if (!parsed || !Array.isArray(parsed.messages)) {
    return { version: CONFIG_VERSION, messages: [] }
  }
  return parsed
}

function writeMessagesConfig(config: MessagesConfig): void {
  try {
    writeJsonAtomic(getCollaborationMessagesPath(), config)
  } catch (err) {
    console.error('[协作室存储] 写入 messages.json 失败:', err)
    throw new Error('写入协作室消息数据失败')
  }
}

/** 列出某房间全部消息（按 createdAt 升序） */
export function listMessagesByRoom(roomId: string): CollaborationMessage[] {
  const all = readMessagesConfig().messages
  return all
    .filter((m) => m.roomId === roomId)
    .sort((a, b) => a.createdAt - b.createdAt)
}

/** 追加单条消息 */
export function appendMessage(message: CollaborationMessage): void {
  const config = readMessagesConfig()
  config.messages.push(message)
  writeMessagesConfig(config)
}
