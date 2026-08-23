/**
 * 协作室产物（S5 room_publish_artifact）聚焦测试
 *
 * 分层覆盖：
 * 1. repository：artifacts.json 追加 / 列出 / 读取 / 跨房间隔离 / 重启读取
 * 2. 纯路径解析 resolveArtifactTargetPath：绝对路径 / 反斜杠 / `..` / NUL / 盘符 / UNC /
 *    符号链接逃逸 / 越出根 / 合法嵌套（不读 DB、不写盘）
 * 3. service.roomPublishArtifact：授权（active room/active run/成员归属/workspace-write/
 *    绑定工作区）、越界（绝对/.. /符号链接）、按实际字节求 sha256、落盘审计 + 可追溯 artifact 消息、
 *    taskId 同房间校验、内容尺寸/空内容、summary 超长、目标已存在为目录、重启读取
 *
 * 通过 TAGENT_CONFIG_DIR 指向临时目录，与 collaboration-room-task.test.ts 同构。
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  mkdirSync,
  symlinkSync,
  realpathSync,
  writeFileSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import {
  COLLABORATION_ARTIFACT_ID_PREFIX,
  COLLABORATION_ARTIFACT_MAX_CONTENT_BYTES,
  COLLABORATION_ARTIFACT_SUMMARY_MAX_LENGTH,
  type CollaborationArtifact,
  type CollaborationPermissionProfile,
  type CollaborationRun,
} from '@tagent/shared'
import {
  CollaborationRoomService,
  resolveArtifactTargetPath,
} from './collaboration-room-service'
import {
  appendArtifact,
  getArtifact,
  listArtifactsByRoom,
  loadArtifacts,
} from './collaboration-room-repository'
import { getRoom, upsertRoom, upsertRun } from './collaboration-room-repository'
import { getOrCreateWorkspace } from '../workspace/workspace-manager'
import { getCollaborationRoomWorkspaceDir } from '../config/config-paths'

let tmpDir: string
/** 测试期间创建的工作区项目目录，结束后统一清理 */
const wsDirs: string[] = []

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'tagent-collab-artifact-test-'))
  process.env.TAGENT_CONFIG_DIR = tmpDir
})

afterAll(() => {
  delete process.env.TAGENT_CONFIG_DIR
  for (const dir of wsDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

/** 给某成员造一个 running run（直接落盘，不经调度器），返回 runId。 */
function mkRunningRun(roomId: string, memberId: string): string {
  const runId = `run_${roomId}_${memberId}`
  const run: CollaborationRun = {
    id: runId,
    roomId,
    memberId,
    triggerMessageId: `msg_${roomId}_${memberId}`,
    idempotencyKey: `msg_${roomId}_${memberId}:${memberId}`,
    status: 'running',
    attempt: 0,
  }
  upsertRun(run)
  return runId
}

/**
 * 造一个绑定工作区的房间 + 一个指定权限的协调者成员 + running run。
 * 每次新建独立工作区目录，避免测试间文件互相覆盖。
 */
function mkWriterRoom(
  svc: CollaborationRoomService,
  title: string,
  opts: { permissionProfile?: CollaborationPermissionProfile } = {},
): {
  room: ReturnType<CollaborationRoomService['createRoom']>
  writerId: string
  runId: string
  wsProjectDir: string
} {
  const wsProjectDir = mkdtempSync(join(tmpdir(), 'tagent-artifact-ws-'))
  wsDirs.push(wsProjectDir)
  const workspace = getOrCreateWorkspace(wsProjectDir)
  const room = svc.createRoom({
    title,
    workspaceId: workspace.id,
    members: [
      {
        displayName: '开发',
        isCoordinator: true,
        permissionProfile: opts.permissionProfile ?? 'workspace-write',
      },
    ],
  })
  const roomWorkspaceDir = getCollaborationRoomWorkspaceDir(room.id)
  const writerId = svc.listMembers(room.id)[0]!.id
  const runId = mkRunningRun(room.id, writerId)
  return { room, writerId, runId, wsProjectDir: roomWorkspaceDir }
}

/** 计算一段文本 UTF-8 字节的 sha256（hex），用于和落盘 artifact 比对。 */
function sha256Of(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
}

// ===== repository：artifacts.json CRUD =====

describe('collaboration-room-repository artifacts CRUD', () => {
  test('appendArtifact + listArtifactsByRoom：跨房间隔离 + 升序', () => {
    const a1: CollaborationArtifact = {
      id: `${COLLABORATION_ARTIFACT_ID_PREFIX}${randomUUID()}`,
      roomId: 'cr_repo_a',
      memberId: 'cm_a',
      runId: 'run_a',
      relativePath: 'a/1.txt',
      sha256: 'h1',
      byteSize: 1,
      createdAt: 100,
    }
    const a2: CollaborationArtifact = {
      id: `${COLLABORATION_ARTIFACT_ID_PREFIX}${randomUUID()}`,
      roomId: 'cr_repo_a',
      memberId: 'cm_a',
      relativePath: 'a/2.txt',
      sha256: 'h2',
      byteSize: 2,
      createdAt: 50,
    }
    const b1: CollaborationArtifact = {
      id: `${COLLABORATION_ARTIFACT_ID_PREFIX}${randomUUID()}`,
      roomId: 'cr_repo_b',
      memberId: 'cm_b',
      relativePath: 'b/1.txt',
      sha256: 'h3',
      byteSize: 3,
      createdAt: 10,
    }
    appendArtifact(a1)
    appendArtifact(a2)
    appendArtifact(b1)

    // A 房间按 createdAt 升序（50 在 100 前）
    expect(listArtifactsByRoom('cr_repo_a').map((a) => a.id)).toEqual([a2.id, a1.id])
    // B 房间隔离
    expect(listArtifactsByRoom('cr_repo_b').map((a) => a.id)).toEqual([b1.id])
    expect(listArtifactsByRoom('cr_no_exist')).toEqual([])
  })

  test('getArtifact：存在 / 不存在', () => {
    const art: CollaborationArtifact = {
      id: `${COLLABORATION_ARTIFACT_ID_PREFIX}${randomUUID()}`,
      roomId: 'cr_repo_get',
      memberId: 'cm_g',
      relativePath: 'g.txt',
      sha256: 'hg',
      byteSize: 7,
      createdAt: 1,
    }
    appendArtifact(art)
    expect(getArtifact(art.id)?.id).toBe(art.id)
    expect(getArtifact(`${COLLABORATION_ARTIFACT_ID_PREFIX}no`)).toBeUndefined()
  })

  test('loadArtifacts：返回全部（含跨房间）', () => {
    const before = loadArtifacts().length
    appendArtifact({
      id: `${COLLABORATION_ARTIFACT_ID_PREFIX}${randomUUID()}`,
      roomId: 'cr_repo_load',
      memberId: 'cm_l',
      relativePath: 'l.txt',
      sha256: 'hl',
      byteSize: 1,
      createdAt: 1,
    })
    expect(loadArtifacts().length).toBe(before + 1)
  })
})

// ===== 纯路径解析 resolveArtifactTargetPath =====

describe('resolveArtifactTargetPath 纯路径安全', () => {
  // 用一个真实存在的目录作为 root（realpath，避免 macOS tmpdir 符号链接干扰）
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tagent-artifact-root-')))
  wsDirs.push(root)

  test('合法相对路径：返回 absPath + 正斜杠 relativePath', () => {
    const r = resolveArtifactTargetPath(root, 'docs/api.md')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.relativePath).toBe('docs/api.md')
    expect(r.absPath).toBe(join(root, 'docs', 'api.md'))
  })

  test('规范化：前导 ./ 与重复 // 被忽略，. 段被剔除', () => {
    const r = resolveArtifactTargetPath(root, './docs//./x.txt')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.relativePath).toBe('docs/x.txt')
  })

  test('拒绝：绝对路径（/ 开头）', () => {
    expect(resolveArtifactTargetPath(root, '/etc/passwd').ok).toBe(false)
  })

  test('拒绝：Win 盘符绝对路径', () => {
    const r = resolveArtifactTargetPath(root, 'C:/secret.txt')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/绝对路径/)
  })

  test('拒绝：UNC //server/share', () => {
    expect(resolveArtifactTargetPath(root, '//server/share/x').ok).toBe(false)
  })

  test('拒绝：反斜杠（只允许正斜杠）', () => {
    const r = resolveArtifactTargetPath(root, 'docs\\evil.md')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/正斜杠/)
  })

  test('拒绝：.. 越界（顶层与深层）', () => {
    expect(resolveArtifactTargetPath(root, '../escape.txt').ok).toBe(false)
    expect(resolveArtifactTargetPath(root, 'docs/../../escape.txt').ok).toBe(false)
    expect(resolveArtifactTargetPath(root, 'a/../../../escape.txt').ok).toBe(false)
  })

  test('拒绝：空 / 仅空白 / 仅 . 与 /', () => {
    expect(resolveArtifactTargetPath(root, '').ok).toBe(false)
    expect(resolveArtifactTargetPath(root, '   ').ok).toBe(false)
    expect(resolveArtifactTargetPath(root, '././.').ok).toBe(false)
    expect(resolveArtifactTargetPath(root, '///').ok).toBe(false)
  })

  test('拒绝：NUL 字符', () => {
    expect(resolveArtifactTargetPath(root, 'a/\0b.txt').ok).toBe(false)
  })

  test('符号链接逃逸：路径组件是符号链接 → 拒绝', (t) => {
    const linkPath = join(root, 'evil-link')
    const outside = mkdtempSync(join(tmpdir(), 'tagent-artifact-outside-'))
    wsDirs.push(outside)
    try {
      symlinkSync(outside, linkPath, 'dir')
    } catch {
      // Windows 无开发者模式/无权限创建符号链接 → 本平台跳过该用例
      t.skip()
      return
    }
    // 经符号链接组件写入 → 拒绝（即便词法上在根内）
    const r = resolveArtifactTargetPath(root, 'evil-link/x.txt')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/符号链接/)
  })
})

// ===== service.roomPublishArtifact：授权 / 越界 / hash / 落盘 =====

describe('CollaborationRoomService.roomPublishArtifact 成功路径', () => {
  test('workspace-write 成员：写入文件 + 实际字节 sha256 + 落盘 artifact + artifact 消息', () => {
    const svc = CollaborationRoomService.create()
    const { room, writerId, runId, wsProjectDir } = mkWriterRoom(svc, 'happy')
    const content = 'hello world\n'
    const expectedSha = sha256Of(content)

    const res = svc.roomPublishArtifact({
      roomId: room.id,
      fromRunId: runId,
      relativePath: 'docs/api.md',
      content,
      summary: '接口文档初稿',
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.artifactId).toMatch(new RegExp(`^${COLLABORATION_ARTIFACT_ID_PREFIX}`))
    expect(res.sha256).toBe(expectedSha)
    expect(res.byteSize).toBe(Buffer.from(content, 'utf8').byteLength)
    expect(res.relativePath).toBe('docs/api.md')

    // 文件确实写入工作区，内容一致
    const written = readFileSync(join(wsProjectDir, 'docs', 'api.md'), 'utf8')
    expect(written).toBe(content)

    // artifact 审计记录落盘
    const art = svc.getArtifactById(res.artifactId)
    expect(art?.roomId).toBe(room.id)
    expect(art?.memberId).toBe(writerId)
    expect(art?.runId).toBe(runId)
    expect(art?.relativePath).toBe('docs/api.md')
    expect(art?.sha256).toBe(expectedSha)
    expect(art?.byteSize).toBe(Buffer.from(content, 'utf8').byteLength)
    expect(art?.summary).toBe('接口文档初稿')
    expect(art?.createdAt).toBeTypeOf('number')

    // 可追溯 artifact 消息（kind=artifact，携带 runId/rootMessageId/causationId）
    const msgs = svc.listMessages(room.id).filter((m) => m.kind === 'artifact')
    expect(msgs).toHaveLength(1)
    const am = msgs[0]!
    expect(am.authorType).toBe('member')
    expect(am.authorId).toBe(writerId)
    expect(am.runId).toBe(runId)
    expect(am.rootMessageId).toBe(`msg_${room.id}_${writerId}`)
    expect(am.causationId).toBe(runId)
    expect(am.content).toContain('docs/api.md')
    expect(am.content).toContain(expectedSha.slice(0, 12))
    expect(am.content).toContain('接口文档初稿')
    // listArtifacts 也能读到
    expect(svc.listArtifacts(room.id).map((a) => a.id)).toContain(res.artifactId)
  })

  test('嵌套路径会自动创建父目录', () => {
    const svc = CollaborationRoomService.create()
    const { room, runId, wsProjectDir } = mkWriterRoom(svc, 'nested')
    const res = svc.roomPublishArtifact({
      roomId: room.id,
      fromRunId: runId,
      relativePath: 'a/b/c/deep.txt',
      content: 'deep',
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(existsSync(join(wsProjectDir, 'a', 'b', 'c', 'deep.txt'))).toBe(true)
    expect(readFileSync(join(wsProjectDir, 'a', 'b', 'c', 'deep.txt'), 'utf8')).toBe('deep')
  })

  test('关联 taskId：同房间任务 → 落盘 artifact.taskId + 消息 taskId', () => {
    const svc = CollaborationRoomService.create()
    const { room, writerId, runId } = mkWriterRoom(svc, 'with-task')
    const task = svc.createRoomTask({
      roomId: room.id,
      title: '写文档',
      assigneeMemberId: writerId,
    })
    const res = svc.roomPublishArtifact({
      roomId: room.id,
      fromRunId: runId,
      relativePath: 'out.txt',
      content: 'x',
      taskId: task.id,
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(svc.getArtifactById(res.artifactId)?.taskId).toBe(task.id)
    const am = svc.listMessages(room.id).filter((m) => m.kind === 'artifact')[0]!
    expect(am.taskId).toBe(task.id)
  })

  test('无 summary / 无 taskId：仍能发布，消息不含「说明：」', () => {
    const svc = CollaborationRoomService.create()
    const { room, runId } = mkWriterRoom(svc, 'no-summary')
    const res = svc.roomPublishArtifact({
      roomId: room.id,
      fromRunId: runId,
      relativePath: 'plain.txt',
      content: 'plain',
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const art = svc.getArtifactById(res.artifactId)
    expect(art?.summary).toBeUndefined()
    expect(art?.taskId).toBeUndefined()
    const am = svc.listMessages(room.id).filter((m) => m.kind === 'artifact')[0]!
    expect(am.content).not.toContain('说明：')
  })

  test('awaiting_peer run 也能发布（run 状态不迁移）', () => {
    const svc = CollaborationRoomService.create()
    const { room, runId } = mkWriterRoom(svc, 'awaiting')
    // 把 run 置为 awaiting_peer
    const existing = svc.getRunById(runId)!
    upsertRun({ ...existing, status: 'awaiting_peer' })
    const res = svc.roomPublishArtifact({
      roomId: room.id,
      fromRunId: runId,
      relativePath: 'x.txt',
      content: 'x',
    })
    expect(res.ok).toBe(true)
    // run 状态仍是 awaiting_peer（发布产物不暂停/不恢复 run）
    expect(svc.getRunById(runId)?.status).toBe('awaiting_peer')
  })
})

describe('CollaborationRoomService.roomPublishArtifact 授权守卫', () => {
  test('拒绝：房间不存在', () => {
    const svc = CollaborationRoomService.create()
    const res = svc.roomPublishArtifact({
      roomId: 'cr_no',
      fromRunId: 'run_no',
      relativePath: 'x.txt',
      content: 'x',
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/房间不存在/)
  })

  test('拒绝：房间非 active（paused）', () => {
    const svc = CollaborationRoomService.create()
    const { room, runId } = mkWriterRoom(svc, 'paused')
    upsertRoom({ ...getRoom(room.id)!, status: 'paused' })
    const res = svc.roomPublishArtifact({
      roomId: room.id,
      fromRunId: runId,
      relativePath: 'x.txt',
      content: 'x',
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/非 active/)
  })

  test('拒绝：run 不存在', () => {
    const svc = CollaborationRoomService.create()
    const { room } = mkWriterRoom(svc, 'no-run')
    const res = svc.roomPublishArtifact({
      roomId: room.id,
      fromRunId: 'run_no',
      relativePath: 'x.txt',
      content: 'x',
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/run 不存在/)
  })

  test('拒绝：run 非 running/awaiting_peer（done）', () => {
    const svc = CollaborationRoomService.create()
    const { room, runId } = mkWriterRoom(svc, 'done-run')
    upsertRun({ ...svc.getRunById(runId)!, status: 'done' })
    const res = svc.roomPublishArtifact({
      roomId: room.id,
      fromRunId: runId,
      relativePath: 'x.txt',
      content: 'x',
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/非 running\/awaiting_peer/)
  })

  test('拒绝：发起成员不属于本房间（run.memberId 指向别房间成员）', () => {
    const svc = CollaborationRoomService.create()
    const a = mkWriterRoom(svc, 'roomA')
    const b = mkWriterRoom(svc, 'roomB')
    // 用 B 的成员造一个 run，但冒充在 A 的 roomId 下调用 → roomId 来自调用方上下文
    const crossRun = mkRunningRun(a.room.id, b.writerId)
    const res = svc.roomPublishArtifact({
      roomId: a.room.id,
      fromRunId: crossRun,
      relativePath: 'x.txt',
      content: 'x',
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/不属于本房间/)
  })

  test('拒绝：read-only 权限成员不能发布产物', () => {
    const svc = CollaborationRoomService.create()
    const { room, runId } = mkWriterRoom(svc, 'readonly', { permissionProfile: 'read-only' })
    const res = svc.roomPublishArtifact({
      roomId: room.id,
      fromRunId: runId,
      relativePath: 'x.txt',
      content: 'x',
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/workspace-write/)
  })

  test('拒绝：房间未绑定工作区', () => {
    const svc = CollaborationRoomService.create()
    const room = svc.createRoom({
      title: 'no-ws',
      members: [{ displayName: '开发', isCoordinator: true, permissionProfile: 'workspace-write' }],
    })
    upsertRoom({ ...room, roomWorkspace: undefined })
    const writerId = svc.listMembers(room.id)[0]!.id
    const runId = mkRunningRun(room.id, writerId)
    const res = svc.roomPublishArtifact({
      roomId: room.id,
      fromRunId: runId,
      relativePath: 'x.txt',
      content: 'x',
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/未绑定工作区|房间服务工作区不存在/)
  })

  test('拒绝：绑定的工作区 meta 不存在（workspaceId 指向已删除工作区）', () => {
    const svc = CollaborationRoomService.create()
    const room = svc.createRoom({
      title: 'ghost-ws',
      workspaceId: 'F--nonexistent-workspace',
      members: [{ displayName: '开发', isCoordinator: true, permissionProfile: 'workspace-write' }],
    })
    upsertRoom({ ...room, roomWorkspace: undefined })
    const writerId = svc.listMembers(room.id)[0]!.id
    const runId = mkRunningRun(room.id, writerId)
    const res = svc.roomPublishArtifact({
      roomId: room.id,
      fromRunId: runId,
      relativePath: 'x.txt',
      content: 'x',
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/工作区不存在|无项目目录/)
  })
})

describe('CollaborationRoomService.roomPublishArtifact 路径/内容/任务守卫', () => {
  test('拒绝：绝对路径', () => {
    const svc = CollaborationRoomService.create()
    const { room, runId } = mkWriterRoom(svc, 'abs')
    const res = svc.roomPublishArtifact({
      roomId: room.id,
      fromRunId: runId,
      relativePath: '/etc/passwd',
      content: 'x',
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/绝对路径/)
  })

  test('拒绝：.. 越界', () => {
    const svc = CollaborationRoomService.create()
    const { room, runId, wsProjectDir } = mkWriterRoom(svc, 'dotdot')
    const res = svc.roomPublishArtifact({
      roomId: room.id,
      fromRunId: runId,
      relativePath: '../escape.txt',
      content: 'x',
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/\.\./)
    // 未写入工作区外
    expect(existsSync(join(wsProjectDir, '..', 'escape.txt'))).toBe(false)
  })

  test('拒绝：反斜杠路径', () => {
    const svc = CollaborationRoomService.create()
    const { room, runId } = mkWriterRoom(svc, 'backslash')
    const res = svc.roomPublishArtifact({
      roomId: room.id,
      fromRunId: runId,
      relativePath: 'docs\\evil.md',
      content: 'x',
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/正斜杠/)
  })

  test('拒绝：符号链接逃逸（路径组件是符号链接）', (t) => {
    const svc = CollaborationRoomService.create()
    const { room, runId, wsProjectDir } = mkWriterRoom(svc, 'symlink')
    const linkPath = join(wsProjectDir, 'evil-link')
    const outside = mkdtempSync(join(tmpdir(), 'tagent-artifact-outside2-'))
    wsDirs.push(outside)
    try {
      symlinkSync(outside, linkPath, 'dir')
    } catch {
      t.skip()
      return
    }
    const res = svc.roomPublishArtifact({
      roomId: room.id,
      fromRunId: runId,
      relativePath: 'evil-link/x.txt',
      content: 'x',
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/符号链接/)
    // 未在 outside 写入
    expect(existsSync(join(outside, 'x.txt'))).toBe(false)
  })

  test('拒绝：目标已存在且是目录（不能覆盖为文件）', () => {
    const svc = CollaborationRoomService.create()
    const { room, runId, wsProjectDir } = mkWriterRoom(svc, 'isdir')
    // 预先建一个同名目录
    mkdirSync(join(wsProjectDir, 'adir'), { recursive: true })
    const res = svc.roomPublishArtifact({
      roomId: room.id,
      fromRunId: runId,
      relativePath: 'adir',
      content: 'x',
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/目录/)
    // 目录仍在、未被覆盖成文件
    expect(statSync(join(wsProjectDir, 'adir')).isDirectory()).toBe(true)
  })

  test('拒绝：内容为空', () => {
    const svc = CollaborationRoomService.create()
    const { room, runId } = mkWriterRoom(svc, 'empty')
    const res = svc.roomPublishArtifact({
      roomId: room.id,
      fromRunId: runId,
      relativePath: 'x.txt',
      content: '',
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/不能为空/)
  })

  test('拒绝：内容超尺寸上限（fail-closed，不写盘）', () => {
    const svc = CollaborationRoomService.create()
    const { room, runId, wsProjectDir } = mkWriterRoom(svc, 'oversize')
    const tooBig = 'x'.repeat(COLLABORATION_ARTIFACT_MAX_CONTENT_BYTES + 1)
    const res = svc.roomPublishArtifact({
      roomId: room.id,
      fromRunId: runId,
      relativePath: 'big.txt',
      content: tooBig,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/过大/)
    expect(existsSync(join(wsProjectDir, 'big.txt'))).toBe(false)
  })

  test('拒绝：summary 超长', () => {
    const svc = CollaborationRoomService.create()
    const { room, runId } = mkWriterRoom(svc, 'longsummary')
    const res = svc.roomPublishArtifact({
      roomId: room.id,
      fromRunId: runId,
      relativePath: 'x.txt',
      content: 'x',
      summary: 's'.repeat(COLLABORATION_ARTIFACT_SUMMARY_MAX_LENGTH + 1),
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/说明过长/)
  })

  test('拒绝：taskId 不存在', () => {
    const svc = CollaborationRoomService.create()
    const { room, runId } = mkWriterRoom(svc, 'badtask')
    const res = svc.roomPublishArtifact({
      roomId: room.id,
      fromRunId: runId,
      relativePath: 'x.txt',
      content: 'x',
      taskId: 'crt_no',
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/关联任务不存在/)
  })

  test('拒绝：taskId 跨房间（别房间任务）', () => {
    const svc = CollaborationRoomService.create()
    const a = mkWriterRoom(svc, 'taskA')
    const b = mkWriterRoom(svc, 'taskB')
    const taskB = svc.createRoomTask({
      roomId: b.room.id,
      title: 'B 的任务',
      assigneeMemberId: b.writerId,
    })
    const res = svc.roomPublishArtifact({
      roomId: a.room.id,
      fromRunId: a.runId,
      relativePath: 'x.txt',
      content: 'x',
      taskId: taskB.id,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/不属于该房间/)
  })
})

describe('CollaborationRoomService 产物重启读取', () => {
  test('新 service 实例读到已落盘 artifact（字段保留）', () => {
    const svc1 = CollaborationRoomService.create()
    const { room, writerId, runId } = mkWriterRoom(svc1, 'restart')
    const content = 'persist me\n'
    const res = svc1.roomPublishArtifact({
      roomId: room.id,
      fromRunId: runId,
      relativePath: 'persist/out.txt',
      content,
      summary: '重启验证',
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return

    // 模拟重启：新 service 实例（无内存状态，纯读盘）
    const svc2 = CollaborationRoomService.create()
    const loaded = svc2.getArtifactById(res.artifactId) as CollaborationArtifact
    expect(loaded).toBeDefined()
    expect(loaded.roomId).toBe(room.id)
    expect(loaded.memberId).toBe(writerId)
    expect(loaded.runId).toBe(runId)
    expect(loaded.relativePath).toBe('persist/out.txt')
    expect(loaded.sha256).toBe(sha256Of(content))
    expect(loaded.byteSize).toBe(Buffer.from(content, 'utf8').byteLength)
    expect(loaded.summary).toBe('重启验证')
    // list 也跨实例可用
    expect(svc2.listArtifacts(room.id).map((a) => a.id)).toContain(res.artifactId)
    // artifact 消息也跨实例可读
    expect(svc2.listMessages(room.id).filter((m) => m.kind === 'artifact')).toHaveLength(1)
  })
})

describe('resolveArtifactTargetPath 与 service 行为一致（不写盘的越界用例）', () => {
  test('service 对 NUL 路径拒绝（与纯解析一致）', () => {
    const svc = CollaborationRoomService.create()
    const { room, runId } = mkWriterRoom(svc, 'nul')
    const res = svc.roomPublishArtifact({
      roomId: room.id,
      fromRunId: runId,
      relativePath: 'a/\0b.txt',
      content: 'x',
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/非法字符|NUL|不能为空/)
  })
})
