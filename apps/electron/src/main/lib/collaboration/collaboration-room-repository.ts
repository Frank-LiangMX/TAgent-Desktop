/**
 * 协作室持久化仓库（atomic-json）
 *
 * 四份独立 JSON 文件，均放在 ~/.tagent[-dev]/collaboration/ 下：
 * - rooms.json    { version, rooms:    CollaborationRoom[]    }
 * - members.json  { version, members: CollaborationMember[] }
 * - messages.json { version, messages: CollaborationMessage[] }
 * - runs.json     { version, runs:    CollaborationRun[]     }
 *
 * 读写均走 atomic-json（tmp + .bak + rename），损坏自愈从 .bak 恢复。
 * Stage 1 为单用户本地骨架，各文件各自原子写；createRoom 先写 rooms 再写 members，
 * 若 members 写失败则房间已落盘、成员缺失（可接受降级，S2+ 再补事务/回滚）。
 * Stage 2 新增 runs.json：run 状态机由 service 驱动，重启时 sweep 假 running（见
 * collaboration-room-service.recoverInterruptedRuns）。
 *
 * 设计参考：apps/electron/src/main/lib/channel/channel-store.ts（CRUD + atomic-json）
 */
import type {
  CollaborationRoom,
  CollaborationMember,
  CollaborationMessage,
  CollaborationRun,
  CollaborationMailboxEnvelope,
  CollaborationRoomSummary,
  CollaborationRoomTask,
  CollaborationArtifact,
  CollaborationUserApprovalRequest,
  CollaborationMemberPreset,
  CollaborationRoomEvent,
} from '@tagent/shared'
import { randomBytes } from 'node:crypto'
import { readJsonSafe, writeJsonAtomic } from '../atomic-json'
import {
  getCollaborationRoomsPath,
  getCollaborationMembersPath,
  getCollaborationMessagesPath,
  getCollaborationEventsPath,
  getCollaborationRunsPath,
  getCollaborationMailboxPath,
  getCollaborationSummariesPath,
  getCollaborationRoomTasksPath,
  getCollaborationArtifactsPath,
  getCollaborationUserApprovalsPath,
  getCollaborationMemberPresetsPath,
} from '../config/config-paths'

/** 配置版本号 */
const CONFIG_VERSION = 1

// ===== member-presets.json =====

interface MemberPresetsConfig {
  version: number
  presets: CollaborationMemberPreset[]
}

function readMemberPresetsConfig(): MemberPresetsConfig {
  const parsed = readJsonSafe<MemberPresetsConfig | null>(getCollaborationMemberPresetsPath(), null)
  if (!parsed || !Array.isArray(parsed.presets)) return { version: CONFIG_VERSION, presets: [] }
  return parsed
}

function writeMemberPresetsConfig(config: MemberPresetsConfig): void {
  writeJsonAtomic(getCollaborationMemberPresetsPath(), config)
}

export function listCollaborationMemberPresets(): CollaborationMemberPreset[] {
  return readMemberPresetsConfig().presets.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function saveCollaborationMemberPreset(input: {
  id?: string
  name: string
  description?: string
  members: CollaborationMemberPreset['members']
}): CollaborationMemberPreset {
  const name = input.name.trim()
  if (!name) throw new Error('成员配置名称不能为空')
  if (!Array.isArray(input.members) || input.members.length === 0) {
    throw new Error('成员配置至少需要一个成员')
  }
  const now = Date.now()
  const config = readMemberPresetsConfig()
  const existing = input.id ? config.presets.find((preset) => preset.id === input.id) : undefined
  const preset: CollaborationMemberPreset = {
    id: existing?.id ?? `cmp_${now.toString(36)}${randomBytes(4).toString('hex')}`,
    name,
    ...(input.description?.trim() ? { description: input.description.trim() } : {}),
    // 深拷贝配置，避免调用方后续修改引用影响已保存模板。
    members: JSON.parse(JSON.stringify(input.members)) as CollaborationMemberPreset['members'],
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  const index = config.presets.findIndex((item) => item.id === preset.id)
  if (index >= 0) config.presets[index] = preset
  else config.presets.push(preset)
  writeMemberPresetsConfig(config)
  return preset
}

export function deleteCollaborationMemberPreset(id: string): boolean {
  const config = readMemberPresetsConfig()
  const next = config.presets.filter((preset) => preset.id !== id)
  if (next.length === config.presets.length) return false
  writeMemberPresetsConfig({ ...config, presets: next })
  return true
}

/**
 * 读盘归一化：补齐 S4.5 前历史房间缺失的 a2aHandoffEnabled（默认 true）。
 * A2A 交接为协作室核心能力，旧数据缺省视为启用，与 createRoom 默认一致。
 */
function normalizeRoom(room: CollaborationRoom): CollaborationRoom {
  if (room.a2aHandoffEnabled === undefined) {
    return { ...room, a2aHandoffEnabled: true }
  }
  return room
}

// ===== user-approvals.json =====

interface UserApprovalsConfig {
  version: number
  requests: CollaborationUserApprovalRequest[]
}

function readUserApprovalsConfig(): UserApprovalsConfig {
  const parsed = readJsonSafe<UserApprovalsConfig | null>(getCollaborationUserApprovalsPath(), null)
  if (!parsed || !Array.isArray(parsed.requests)) return { version: CONFIG_VERSION, requests: [] }
  return parsed
}

function writeUserApprovalsConfig(config: UserApprovalsConfig): void {
  writeJsonAtomic(getCollaborationUserApprovalsPath(), config)
}

export function listUserApprovalRequests(roomId?: string): CollaborationUserApprovalRequest[] {
  const all = readUserApprovalsConfig().requests
  return (roomId ? all.filter((r) => r.roomId === roomId) : all).sort((a, b) => a.createdAt - b.createdAt)
}

export function getUserApprovalRequest(id: string): CollaborationUserApprovalRequest | undefined {
  return readUserApprovalsConfig().requests.find((r) => r.id === id)
}

export function upsertUserApprovalRequest(request: CollaborationUserApprovalRequest): void {
  const config = readUserApprovalsConfig()
  const index = config.requests.findIndex((r) => r.id === request.id)
  if (index < 0) config.requests.push(request)
  else config.requests[index] = request
  writeUserApprovalsConfig(config)
}

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
  return readRoomsConfig().rooms.map(normalizeRoom)
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
  const room = readRoomsConfig().rooms.find((r) => r.id === roomId)
  return room ? normalizeRoom(room) : undefined
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

/** 取单个成员（全局搜索） */
export function getMember(memberId: string): CollaborationMember | undefined {
  return readMembersConfig().members.find((m) => m.id === memberId)
}

/** upsert 单个成员（按 id；用于状态机更新 status） */
export function upsertMember(member: CollaborationMember): void {
  const config = readMembersConfig()
  const idx = config.members.findIndex((m) => m.id === member.id)
  if (idx === -1) config.members.push(member)
  else config.members[idx] = member
  writeMembersConfig(config)
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

// ===== events.json（RoomEvent 本地事件账本） =====

interface EventsConfig {
  version: number
  events: CollaborationRoomEvent[]
}

function readEventsConfig(): EventsConfig {
  const parsed = readJsonSafe<EventsConfig | null>(getCollaborationEventsPath(), null)
  if (!parsed || !Array.isArray(parsed.events)) {
    return { version: CONFIG_VERSION, events: [] }
  }
  return parsed
}

function writeEventsConfig(config: EventsConfig): void {
  try {
    writeJsonAtomic(getCollaborationEventsPath(), config)
  } catch (err) {
    console.error("[协作室存储] 写入 events.json 失败:", err)
    throw new Error("写入协作室事件数据失败")
  }
}

export function listRoomEvents(roomId: string): CollaborationRoomEvent[] {
  return readEventsConfig()
    .events.filter((event) => event.roomId === roomId)
    .sort((a, b) => a.sequence - b.sequence)
}

export function getLatestRoomEventSequence(roomId: string): number {
  return listRoomEvents(roomId).reduce(
    (latest, event) => Math.max(latest, event.sequence),
    0,
  )
}

export function appendRoomEvent(
  input: Omit<CollaborationRoomEvent, "id" | "sequence" | "createdAt"> & {
    expectedSequence?: number
  },
): CollaborationRoomEvent {
  const roomId = input.roomId.trim()
  const actorUserId = input.actorUserId.trim()
  if (!roomId || !actorUserId) throw new Error("RoomEvent 的 roomId、actorUserId 必填")
  const config = readEventsConfig()
  const existing = input.idempotencyKey
    ? config.events.find(
        (event) =>
          event.roomId === roomId &&
          event.idempotencyKey === input.idempotencyKey,
      )
    : undefined
  if (existing) return existing
  const sequence = config.events
    .filter((event) => event.roomId === roomId)
    .reduce((latest, event) => Math.max(latest, event.sequence), 0)
  if (
    input.expectedSequence !== undefined &&
    input.expectedSequence !== sequence
  ) {
    throw new Error("RoomEvent sequence 冲突，请重新读取房间状态")
  }
  const now = Date.now()
  const event: CollaborationRoomEvent = {
    id: "cre_" + now.toString(36) + "_" + randomBytes(6).toString("hex"),
    roomId,
    sequence: sequence + 1,
    type: input.type,
    actorUserId,
    ...(input.entityId ? { entityId: input.entityId } : {}),
    ...(input.causationId ? { causationId: input.causationId } : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    payload: JSON.parse(JSON.stringify(input.payload ?? {})) as Record<
      string,
      unknown
    >,
    createdAt: now,
  }
  config.events.push(event)
  writeEventsConfig(config)
  return event
}

// ===== runs.json =====

interface RunsConfig {
  version: number
  runs: CollaborationRun[]
}

function readRunsConfig(): RunsConfig {
  const parsed = readJsonSafe<RunsConfig | null>(getCollaborationRunsPath(), null)
  if (!parsed || !Array.isArray(parsed.runs)) {
    return { version: CONFIG_VERSION, runs: [] }
  }
  return parsed
}

function writeRunsConfig(config: RunsConfig): void {
  try {
    writeJsonAtomic(getCollaborationRunsPath(), config)
  } catch (err) {
    console.error('[协作室存储] 写入 runs.json 失败:', err)
    throw new Error('写入协作室运行数据失败')
  }
}

/** 读取全部 run（可选按房间过滤） */
export function loadRuns(roomId?: string): CollaborationRun[] {
  const all = readRunsConfig().runs
  return roomId ? all.filter((r) => r.roomId === roomId) : all
}

/** 全量写回 run 列表 */
export function saveRuns(runs: CollaborationRun[]): void {
  writeRunsConfig({ version: CONFIG_VERSION, runs })
}

/** upsert 单个 run（按 id） */
export function upsertRun(run: CollaborationRun): void {
  const config = readRunsConfig()
  const idx = config.runs.findIndex((r) => r.id === run.id)
  if (idx === -1) config.runs.push(run)
  else config.runs[idx] = run
  writeRunsConfig(config)
}

/** 取单个 run */
export function getRun(runId: string): CollaborationRun | undefined {
  return readRunsConfig().runs.find((r) => r.id === runId)
}

/** 列出某房间全部 run（按 createdAt 升序，即入队顺序） */
export function listRunsByRoom(roomId: string): CollaborationRun[] {
  // run 无 createdAt 字段，用 startedAt 兜底；都无则保持插入顺序（稳定）
  return loadRuns(roomId).slice().sort((a, b) => {
    const ta = a.startedAt ?? 0
    const tb = b.startedAt ?? 0
    return ta - tb
  })
}

/** 列出某成员全部 run */
export function listRunsByMember(memberId: string): CollaborationRun[] {
  return loadRuns().filter((r) => r.memberId === memberId)
}

/** 按幂等键查 run（入队去重用；返回首个匹配，不分状态） */
export function findRunByIdempotencyKey(idempotencyKey: string): CollaborationRun | undefined {
  return readRunsConfig().runs.find((r) => r.idempotencyKey === idempotencyKey)
}

/** 列出处于指定状态集合的 run（重启恢复用：找出假 running/queued） */
export function listRunsByStatus(statuses: CollaborationRun['status'][]): CollaborationRun[] {
  const set = new Set(statuses)
  return readRunsConfig().runs.filter((r) => set.has(r.status))
}

// ===== mailbox.json（S4 A2A 信箱） =====

interface MailboxConfig {
  version: number
  envelopes: CollaborationMailboxEnvelope[]
}

function readMailboxConfig(): MailboxConfig {
  const parsed = readJsonSafe<MailboxConfig | null>(getCollaborationMailboxPath(), null)
  if (!parsed || !Array.isArray(parsed.envelopes)) {
    return { version: CONFIG_VERSION, envelopes: [] }
  }
  return parsed
}

function writeMailboxConfig(config: MailboxConfig): void {
  try {
    writeJsonAtomic(getCollaborationMailboxPath(), config)
  } catch (err) {
    console.error('[协作室存储] 写入 mailbox.json 失败:', err)
    throw new Error('写入协作室信箱数据失败')
  }
}

/** 列出某房间全部信封（按 createdAt 升序） */
export function listMailboxByRoom(roomId: string): CollaborationMailboxEnvelope[] {
  return readMailboxConfig()
    .envelopes.filter((e) => e.roomId === roomId)
    .sort((a, b) => a.createdAt - b.createdAt)
}

/** 列出投递给某成员、仍处于激活态的信封（pending/delivered），按时间升序 */
export function listActiveMailboxForMember(memberId: string): CollaborationMailboxEnvelope[] {
  return readMailboxConfig()
    .envelopes.filter(
      (e) => e.toMemberId === memberId && (e.state === 'pending' || e.state === 'delivered'),
    )
    .sort((a, b) => a.createdAt - b.createdAt)
}

/** 按 requestId 列出相关信封（用于重复回复检测） */
export function listMailboxByRequest(requestId: string): CollaborationMailboxEnvelope[] {
  return readMailboxConfig().envelopes.filter((e) => e.requestId === requestId)
}

/** 取单个信封 */
export function getMailboxEnvelope(envelopeId: string): CollaborationMailboxEnvelope | undefined {
  return readMailboxConfig().envelopes.find((e) => e.id === envelopeId)
}

/** 追加单封信封（不做去重，由调用方保证 id 唯一） */
export function appendMailboxEnvelope(envelope: CollaborationMailboxEnvelope): void {
  const config = readMailboxConfig()
  config.envelopes.push(envelope)
  writeMailboxConfig(config)
}

/** upsert 单封信封（按 id；状态机迁移用） */
export function upsertMailboxEnvelope(envelope: CollaborationMailboxEnvelope): void {
  const config = readMailboxConfig()
  const idx = config.envelopes.findIndex((e) => e.id === envelope.id)
  if (idx === -1) config.envelopes.push(envelope)
  else config.envelopes[idx] = envelope
  writeMailboxConfig(config)
}

/** 列出处于指定状态集合的信封（重启恢复用：找出未决 pending/delivered） */
export function listMailboxByStatus(
  states: CollaborationMailboxEnvelope['state'][],
): CollaborationMailboxEnvelope[] {
  const set = new Set(states)
  return readMailboxConfig().envelopes.filter((e) => set.has(e.state))
}

// ===== summaries.json（S3.5-b 房间共享摘要，04 §6.2） =====

interface SummariesConfig {
  version: number
  summaries: CollaborationRoomSummary[]
}

function readSummariesConfig(): SummariesConfig {
  const parsed = readJsonSafe<SummariesConfig | null>(getCollaborationSummariesPath(), null)
  if (!parsed || !Array.isArray(parsed.summaries)) {
    return { version: CONFIG_VERSION, summaries: [] }
  }
  return parsed
}

function writeSummariesConfig(config: SummariesConfig): void {
  try {
    writeJsonAtomic(getCollaborationSummariesPath(), config)
  } catch (err) {
    console.error('[协作室存储] 写入 summaries.json 失败:', err)
    throw new Error('写入协作室房间摘要失败')
  }
}

/** 取某房间的摘要记录（不存在返回 undefined）。 */
export function getCollaborationSummary(roomId: string): CollaborationRoomSummary | undefined {
  return readSummariesConfig().summaries.find((s) => s.roomId === roomId)
}

/** 全量 upsert（无条件写，仅供内部/一次性；并发路径请用 saveSummaryIfCurrent）。 */
export function saveCollaborationSummary(summary: CollaborationRoomSummary): void {
  const config = readSummariesConfig()
  const idx = config.summaries.findIndex((s) => s.roomId === summary.roomId)
  if (idx === -1) config.summaries.push(summary)
  else config.summaries[idx] = summary
  writeSummariesConfig(config)
}

/**
 * CAS 写（04 §6.2）：仅当现存行的 (generation, version, summaryThroughMessageId) 等于
 * `expected` 时才写入 `next`；否则不写并返回 false。防并发提交覆盖（commit 主路径用）。
 *
 * @returns 是否成功写入
 */
export function saveCollaborationSummaryIfCurrent(
  roomId: string,
  expected: Pick<CollaborationRoomSummary, 'generation' | 'version' | 'summaryThroughMessageId'>,
  next: CollaborationRoomSummary,
): boolean {
  const config = readSummariesConfig()
  const idx = config.summaries.findIndex((s) => s.roomId === roomId)
  const current = idx === -1 ? undefined : config.summaries[idx]
  const keyMatches =
    (current?.generation ?? 0) === expected.generation &&
    (current?.version ?? 0) === expected.version &&
    (current?.summaryThroughMessageId ?? '') === expected.summaryThroughMessageId
  if (!keyMatches) return false
  if (idx === -1) config.summaries.push(next)
  else config.summaries[idx] = next
  writeSummariesConfig(config)
  return true
}

/**
 * 抢占一个总结租约（04 §6.2）：仅当当前无未过期的进行中租约时，才把该行置为
 * `summarizing` 并签发 runToken + leaseExpiresAt。返回抢到的基线记录（含当时
 * generation/version/锚点，供 commit CAS 对比）；租约在有效期内则返回 `baseline=null`。
 *
 * 返回对象：
 * - `{ ok: false }`：有未过期租约，不抢跑（等待下一次阈值）。
 * - `{ ok: true, baseline }`：抢占成功。`baseline` 为首条基线（当前行或新建缺省行），
 *   commit 时须以其 generation/version/锚点做 CAS。
 */
export function claimCollaborationSummary(
  roomId: string,
  runToken: string,
  leaseMs: number,
  now: number,
):
  | { ok: true; baseline: CollaborationRoomSummary }
  | { ok: false; reason: 'lease-active' | 'generation-mismatch' } {
  const config = readSummariesConfig()
  const idx = config.summaries.findIndex((s) => s.roomId === roomId)
  const current = idx === -1 ? undefined : config.summaries[idx]

  if (current && current.status === 'summarizing' && current.leaseExpiresAt !== undefined) {
    if (current.leaseExpiresAt > now) {
      return { ok: false, reason: 'lease-active' }
    }
  }

  const baseline: CollaborationRoomSummary = current ?? {
    roomId,
    summary: '',
    summaryThroughMessageId: '',
    summarizedUtteranceCount: 0,
    version: 0,
    generation: 0,
    status: 'idle',
    updatedAt: now,
    lastError: null,
  }
  const claimed: CollaborationRoomSummary = {
    ...baseline,
    status: 'summarizing',
    runToken,
    leaseExpiresAt: now + leaseMs,
    lastError: null,
    updatedAt: now,
  }
  if (idx === -1) config.summaries.push(claimed)
  else config.summaries[idx] = claimed
  writeSummariesConfig(config)
  return { ok: true, baseline }
}

/**
 * 提交一次成功总结（04 §6.2）：仅当现存行 generation 与 `baseline.generation` 一致（且
 * 持有的 runToken 仍匹配）才写入成功稿并 advance anchor/version；否则不写并返回 false
 *（旧摘要保留；调用方应把该行置为 failed）。
 *
 * @param baseline claim 时返回的基线记录
 * @param summarizeResult 新摘要正文
 * @param throughMessageId 本次已覆盖到的最后一条有效发言 ID（新锚点）
 * @param utteranceCount 新累计有效发言数
 */
export function commitCollaborationSummary(
  roomId: string,
  runToken: string,
  baseline: Pick<CollaborationRoomSummary, 'generation' | 'version' | 'summaryThroughMessageId'>,
  nextSummary: string,
  throughMessageId: string,
  utteranceCount: number,
  now: number,
): boolean {
  const config = readSummariesConfig()
  const idx = config.summaries.findIndex((s) => s.roomId === roomId)
  const current = idx === -1 ? undefined : config.summaries[idx]
  if (!current) return false
  // 租约 token 不匹配（已被抢/过期回收）→ 不写
  if (current.runToken !== undefined && current.runToken !== runToken) return false
  if (current.generation !== baseline.generation) return false
  if (current.version !== baseline.version) return false
  if (current.summaryThroughMessageId !== baseline.summaryThroughMessageId) return false

  config.summaries[idx] = {
    roomId,
    summary: nextSummary,
    summaryThroughMessageId: throughMessageId,
    summarizedUtteranceCount: utteranceCount,
    version: baseline.version + 1,
    generation: baseline.generation,
    status: 'success',
    updatedAt: now,
    lastError: null,
  }
  writeSummariesConfig(config)
  return true
}

/**
 * 使进行中的总结失效（房间清空 / 目标重写，04 §6.2）：generation +1 并回到 idle，
 * 保留既有摘要文本与锚点。进行中的 claim 因其 baseline.generation 过期而 commit 失败。
 */
export function invalidateCollaborationSummaryGeneration(roomId: string): number {
  const config = readSummariesConfig()
  const idx = config.summaries.findIndex((s) => s.roomId === roomId)
  const current = idx === -1 ? undefined : config.summaries[idx]
  const generation = (current?.generation ?? 0) + 1
  const next: CollaborationRoomSummary = {
    roomId,
    summary: current?.summary ?? '',
    summaryThroughMessageId: current?.summaryThroughMessageId ?? '',
    summarizedUtteranceCount: current?.summarizedUtteranceCount ?? 0,
    version: current?.version ?? 0,
    generation,
    status: 'idle',
    updatedAt: Date.now(),
    lastError: null,
  }
  if (idx === -1) config.summaries.push(next)
  else config.summaries[idx] = next
  writeSummariesConfig(config)
  return generation
}

// ===== room-tasks.json（S5 轻量 room task 真值，无看板时） =====
//
// 仅在房间未挂载看板时承载任务真值（02-RUNTIME-A2A-SPEC §2.6 / 不变量 §15.7）。
// 挂载看板后 service 层拒绝 create/update，状态归 kanban repository；本表只保留历史。

interface RoomTasksConfig {
  version: number
  tasks: CollaborationRoomTask[]
}

function readRoomTasksConfig(): RoomTasksConfig {
  const parsed = readJsonSafe<RoomTasksConfig | null>(getCollaborationRoomTasksPath(), null)
  if (!parsed || !Array.isArray(parsed.tasks)) {
    return { version: CONFIG_VERSION, tasks: [] }
  }
  return parsed
}

function writeRoomTasksConfig(config: RoomTasksConfig): void {
  try {
    writeJsonAtomic(getCollaborationRoomTasksPath(), config)
  } catch (err) {
    console.error('[协作室存储] 写入 room-tasks.json 失败:', err)
    throw new Error('写入协作室任务数据失败')
  }
}

/** 读取全部 room task */
export function loadRoomTasks(): CollaborationRoomTask[] {
  return readRoomTasksConfig().tasks
}

/** 列出某房间全部 room task（按 createdAt 升序，次按 id 稳定） */
export function listRoomTasksByRoom(roomId: string): CollaborationRoomTask[] {
  return readRoomTasksConfig()
    .tasks.filter((t) => t.roomId === roomId)
    .sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
}

/** 取单个 room task（全局搜索） */
export function getRoomTask(taskId: string): CollaborationRoomTask | undefined {
  return readRoomTasksConfig().tasks.find((t) => t.id === taskId)
}

/** upsert 单个 room task（按 id） */
export function upsertRoomTask(task: CollaborationRoomTask): void {
  const config = readRoomTasksConfig()
  const idx = config.tasks.findIndex((t) => t.id === task.id)
  if (idx === -1) config.tasks.push(task)
  else config.tasks[idx] = task
  writeRoomTasksConfig(config)
}

/**
 * CAS 写：仅当现存 task 的 version 等于 `expectedVersion` 时才写入 `next`；否则不写并返回
 * false。防并发提交覆盖（乐观并发；调用方传入上次读到的 version）。新增 task（现存不存在）
 * 时要求 `expectedVersion === 0`，避免把"不存在"误当"version=0 已存在"写入。
 *
 * @returns 是否成功写入
 */
export function saveRoomTaskIfCurrent(
  taskId: string,
  expectedVersion: number,
  next: CollaborationRoomTask,
): boolean {
  const config = readRoomTasksConfig()
  const idx = config.tasks.findIndex((t) => t.id === taskId)
  const current = idx === -1 ? undefined : config.tasks[idx]
  const currentVersion = current?.version ?? 0
  if (currentVersion !== expectedVersion) return false
  if (idx === -1) config.tasks.push(next)
  else config.tasks[idx] = next
  writeRoomTasksConfig(config)
  return true
}

// ===== artifacts.json（S5 room_publish_artifact 产物审计） =====
//
// 02-RUNTIME-A2A-SPEC §2.6：保存工作区相对路径、作者 member/run/task、hash。相对路径与 hash
// 由 service 严格校验后写入，模型不得自报绝对路径或 hash。本表只追加（产物不可变），
// 不提供 update；service 负责全部守卫，仓库只做持久化与查询。

interface ArtifactsConfig {
  version: number
  artifacts: CollaborationArtifact[]
}

function readArtifactsConfig(): ArtifactsConfig {
  const parsed = readArtifactsConfigSafe()
  if (!parsed || !Array.isArray(parsed.artifacts)) {
    return { version: CONFIG_VERSION, artifacts: [] }
  }
  return parsed
}

function readArtifactsConfigSafe(): ArtifactsConfig | null {
  return readJsonSafe<ArtifactsConfig | null>(getCollaborationArtifactsPath(), null)
}

function writeArtifactsConfig(config: ArtifactsConfig): void {
  try {
    writeJsonAtomic(getCollaborationArtifactsPath(), config)
  } catch (err) {
    console.error('[协作室存储] 写入 artifacts.json 失败:', err)
    throw new Error('写入协作室产物数据失败')
  }
}

/** 读取全部产物（原始顺序） */
export function loadArtifacts(): CollaborationArtifact[] {
  return readArtifactsConfig().artifacts
}

/** 列出某房间全部产物（按 createdAt 升序，次按 id 稳定） */
export function listArtifactsByRoom(roomId: string): CollaborationArtifact[] {
  return readArtifactsConfig()
    .artifacts.filter((a) => a.roomId === roomId)
    .sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
}

/** 取单个产物（全局搜索） */
export function getArtifact(artifactId: string): CollaborationArtifact | undefined {
  return readArtifactsConfig().artifacts.find((a) => a.id === artifactId)
}

/** 追加单个产物（只追加；由 service 保证 id 唯一与全部字段已校验） */
export function appendArtifact(artifact: CollaborationArtifact): void {
  const config = readArtifactsConfig()
  config.artifacts.push(artifact)
  writeArtifactsConfig(config)
}
