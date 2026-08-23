import type {
  FusionRoomAction,
  FusionRoomAuthoritySnapshot,
  FusionRoomHost,
  FusionRoomRun,
  FusionRoomWorkspaceStore,
} from '@tagent/core'
import type {
  CollaborationHostToolCall,
  CollaborationHostToolHandler,
  CollaborationHostToolResult,
  CollaborationMessage,
  RoomBotSeat,
} from '@tagent/shared'

export interface FusionRoomHostToolFactoryInput {
  snapshot: FusionRoomAuthoritySnapshot
  message: CollaborationMessage
  seat: RoomBotSeat
  run: FusionRoomRun
  signal: AbortSignal
  notifyAction: (action: { type: string }, result: unknown) => void
}

export interface FusionRoomHostToolFactoryOptions {
  host: FusionRoomHost
  workspaceStore: FusionRoomWorkspaceStore
}

/**
 * Creates the default host-authorized tool bridge for an explicit fusion-room
 * runtime. The model only supplies tool arguments; room identity, member
 * identity, run identity and the actor are always taken from this closure.
 */
export function createFusionRoomHostToolHandlerFactory(
  options: FusionRoomHostToolFactoryOptions,
): (input: FusionRoomHostToolFactoryInput) => CollaborationHostToolHandler {
  return (input) => {
    const actorUserId = input.snapshot.ownerUserId
    const roomId = input.snapshot.roomId
    const dispatch = (action: FusionRoomAction): unknown =>
      options.host.dispatch(roomId, action)
    const arg = (call: CollaborationHostToolCall, name: string): string =>
      call.arguments[name] ?? ''

    const currentSnapshot = (): FusionRoomAuthoritySnapshot =>
      options.host.getSnapshot(roomId)

    const guardRun = (needsWrite = false): CollaborationHostToolResult | undefined => {
      const snapshot = currentSnapshot()
      const seat = snapshot.botSeats.find((item) => item.id === input.seat.id && item.status !== 'removed')
      const run = snapshot.runs.find((item) => item.id === input.run.id)
      if (snapshot.status !== 'active' || !seat || !run || run.seatId !== seat.id || run.status !== 'running') {
        return errorResult('当前 Bot run 已不再处于可调用工具的 running 状态')
      }
      if (seat.ownerUserId !== snapshot.ownerUserId && snapshot.botOwnerConsents[seat.id] !== true) {
        return errorResult('Bot 所有人尚未授权该房间使用此 Bot')
      }
      if (needsWrite && seat.permissionProfile !== 'workspace-write') {
        return errorResult('当前 Bot 只有 read-only 工作区权限')
      }
      return undefined
    }

    return async (call): Promise<CollaborationHostToolResult> => {
      try {
        const denied = guardRun(isWriteTool(call.name))
        if (denied) return denied
        switch (call.name) {
          case 'room_send': {
            const envelope = dispatch({
              type: 'send-mailbox',
              input: {
                actorUserId,
                roomId,
                fromMemberId: input.seat.id,
                toMemberId: arg(call, 'toMemberId'),
                runId: input.run.id,
                type: 'message',
                payload: arg(call, 'message'),
                rootMessageId: input.message.rootMessageId,
                idempotencyKey: 'fusion-tool-send:' + input.run.id + ':' + stableToolKey(call),
              },
            })
            input.notifyAction({ type: 'send-mailbox' }, envelope)
            return { output: '通知已发送。' }
          }
          case 'room_ask': {
            const question = arg(call, 'question')
            const expected = arg(call, 'expected')
            const envelope = dispatch({
              type: 'send-mailbox',
              input: {
                actorUserId,
                roomId,
                fromMemberId: input.seat.id,
                toMemberId: arg(call, 'toMemberId'),
                runId: input.run.id,
                type: 'question',
                payload: expected ? question + '\n预期回复：' + expected : question,
                rootMessageId: input.message.rootMessageId,
                idempotencyKey: 'fusion-tool-ask:' + input.run.id + ':' + stableToolKey(call),
              },
            })
            const waited = dispatch({
              type: 'await-run',
              input: {
                actorUserId,
                runId: input.run.id,
                fence: input.run.fence,
                status: 'awaiting_peer',
                summary: '等待 Bot 回复',
                idempotencyKey: 'fusion-tool-await-peer:' + input.run.id,
              },
            })
            input.notifyAction({ type: 'send-mailbox' }, envelope)
            return {
              output: '提问已发送，当前 turn 已暂停等待对方回复。',
              awaitPeer: Boolean(waited),
            }
          }
          case 'room_reply': {
            const envelope = dispatch({
              type: 'reply-mailbox',
              input: {
                actorUserId,
                roomId,
                requestId: arg(call, 'requestId'),
                runId: input.run.id,
                answer: arg(call, 'answer'),
                idempotencyKey: 'fusion-tool-reply:' + input.run.id + ':' + stableToolKey(call),
              },
            })
            input.notifyAction({ type: 'reply-mailbox' }, envelope)
            return { output: '回复已发送。' }
          }
          case 'room_task_assign': {
            if (!input.seat.isCoordinator) return errorResult('只有协调者 Bot 可以分派任务')
            const snapshot = currentSnapshot()
            const task = snapshot.tasks.find((item) => item.id === arg(call, 'taskId'))
            if (!task) return errorResult('任务不存在')
            const updated = dispatch({
              type: 'update-task',
              input: {
                actorUserId,
                roomId,
                taskId: task.id,
                assigneeMemberId: arg(call, 'assigneeMemberId'),
                expectedVersion: task.version,
                runId: input.run.id,
                idempotencyKey: 'fusion-tool-assign:' + input.run.id + ':' + stableToolKey(call),
              },
            })
            const assignment = dispatch({
              type: 'member-message',
              input: {
                actorUserId,
                seatId: input.seat.id,
                content: '已分派任务「' + task.title + '」给成员 ' + arg(call, 'assigneeMemberId') + '。',
                targetSeatIds: [arg(call, 'assigneeMemberId')],
                rootMessageId: input.message.rootMessageId,
                runId: input.run.id,
                depth: 0,
                idempotencyKey: 'fusion-tool-assignment-message:' + input.run.id + ':' + stableToolKey(call),
              },
            })
            input.notifyAction({ type: 'member-message' }, assignment)
            return { output: '任务已分派。' + formatJsonResult(updated) }
          }
          case 'room_task_update': {
            const snapshot = currentSnapshot()
            const task = snapshot.tasks.find((item) => item.id === arg(call, 'taskId'))
            if (!task) return errorResult('任务不存在')
            const updated = dispatch({
              type: 'update-task',
              input: {
                actorUserId,
                roomId,
                taskId: task.id,
                status: arg(call, 'status') as never,
                summary: arg(call, 'summary') || undefined,
                expectedVersion: task.version,
                runId: input.run.id,
                idempotencyKey: 'fusion-tool-task-update:' + input.run.id + ':' + stableToolKey(call),
              },
            })
            return { output: '任务已更新。' + formatJsonResult(updated) }
          }
          case 'room_publish_artifact': {
            const artifact = dispatch({
              type: 'publish-artifact',
              input: {
                actorUserId,
                roomId,
                memberId: input.seat.id,
                relativePath: arg(call, 'relativePath'),
                content: arg(call, 'content'),
                summary: arg(call, 'summary') || undefined,
                taskId: arg(call, 'taskId') || undefined,
                runId: input.run.id,
                idempotencyKey: 'fusion-tool-artifact:' + input.run.id + ':' + stableToolKey(call),
              },
            })
            return { output: '产物已发布并写入房间工作区。' + formatJsonResult(artifact) }
          }
          case 'room_request_user': {
            const approval = dispatch({
              type: 'request-approval',
              input: {
                actorUserId,
                roomId,
                memberId: input.seat.id,
                runId: input.run.id,
                question: arg(call, 'question'),
                reason: arg(call, 'reason') || undefined,
                options: parseOptions(arg(call, 'options')),
                idempotencyKey: 'fusion-tool-approval:' + input.run.id + ':' + stableToolKey(call),
              },
            })
            dispatch({
              type: 'await-run',
              input: {
                actorUserId,
                runId: input.run.id,
                fence: input.run.fence,
                status: 'awaiting_user',
                summary: '等待用户审批',
                idempotencyKey: 'fusion-tool-await-user:' + input.run.id,
              },
            })
            return { output: '已提交用户审批，当前 turn 已暂停等待决定。', awaitPeer: true }
          }
          case 'workspace_read_file': {
            const store = options.workspaceStore
            if (!store.readFile) return errorResult('当前房间工作区未提供读取能力')
            const path = arg(call, 'path')
            const authorityFile = currentSnapshot().files.find((file) => file.relativePath === path)
            if (authorityFile?.deleted) return errorResult('文件已删除')
            const content = store.readFile(roomId, path)
            if (content === undefined) return errorResult('文件不存在')
            const requested = Number(arg(call, 'maxBytes') || '262144')
            const maxBytes = Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), 4 * 1024 * 1024) : 262144
            const bytes = Buffer.byteLength(content, 'utf8')
            const clipped = bytes > maxBytes ? clipUtf8(content, maxBytes) : content
            return { output: '文件读取成功（' + path + '，' + bytes + 'B' + (bytes > maxBytes ? '，已截断' : '') + '）：' + String.fromCharCode(10) + clipped }
          }
          case 'workspace_search': {
            if (!options.workspaceStore.searchFiles) return errorResult('当前房间工作区未提供搜索能力')
            const requested = Number(arg(call, 'maxResults') || '200')
            const result = options.workspaceStore.searchFiles(roomId, arg(call, 'path'), arg(call, 'pattern') || undefined, Number.isFinite(requested) ? requested : 200)
            return { output: '搜索结果：' + String.fromCharCode(10) + result.paths.join(String.fromCharCode(10)) + (result.truncated ? String.fromCharCode(10) + '（结果已截断）' : '') }
          }
          case 'workspace_apply_patch': {
            const store = options.workspaceStore
            if (!store.readFile) return errorResult('当前房间工作区未提供读取能力')
            const path = arg(call, 'path')
            const oldText = arg(call, 'oldText')
            const newText = arg(call, 'newText')
            if (!oldText) return errorResult('oldText 不能为空')
            const currentContent = store.readFile(roomId, path)
            if (currentContent === undefined) return errorResult('文件不存在')
            const occurrences = currentContent.split(oldText).length - 1
            if (occurrences !== 1) return errorResult('oldText 必须在文件中恰好出现一次')
            const nextContent = currentContent.replace(oldText, newText)
            const snapshot = currentSnapshot()
            const current = snapshot.files.find((file) => file.relativePath === path)
            const lock = dispatch({
              type: 'lock',
              input: {
                actorUserId,
                relativePath: path,
                expectedSha256: current?.sha256,
                leaseMs: 60_000,
                idempotencyKey: 'fusion-tool-patch-lock:' + input.run.id + ':' + stableToolKey(call),
              },
            }) as { id: string }
            const committed = dispatch({
              type: 'commit-file',
              input: {
                actorUserId,
                lockId: lock.id,
                relativePath: path,
                content: nextContent,
                expectedSha256: current?.sha256,
                summary: 'Bot 工作区精确补丁',
                idempotencyKey: 'fusion-tool-patch:' + input.run.id + ':' + stableToolKey(call),
              },
            })
            return { output: '精确补丁已应用并完成版本提交。' + formatJsonResult(committed) }
          }
          case 'workspace_delete_file': {
            const path = arg(call, 'path')
            const snapshot = currentSnapshot()
            const current = snapshot.files.find((file) => file.relativePath === path)
            if (!current || current.deleted) return errorResult('文件不存在')
            const lock = dispatch({
              type: 'lock',
              input: {
                actorUserId,
                relativePath: path,
                expectedSha256: current.sha256,
                leaseMs: 60_000,
                idempotencyKey: 'fusion-tool-delete-lock:' + input.run.id + ':' + stableToolKey(call),
              },
            }) as { id: string }
            const deleted = dispatch({
              type: 'delete-file',
              input: {
                actorUserId,
                lockId: lock.id,
                relativePath: path,
                expectedSha256: current.sha256,
                idempotencyKey: 'fusion-tool-delete:' + input.run.id + ':' + stableToolKey(call),
              },
            })
            return { output: '文件已删除。' + formatJsonResult(deleted) }
          }
          case 'workspace_move_file': {
            const fromPath = arg(call, 'fromPath')
            const toPath = arg(call, 'toPath')
            const snapshot = currentSnapshot()
            const source = snapshot.files.find((file) => file.relativePath === fromPath)
            const target = snapshot.files.find((file) => file.relativePath === toPath)
            if (!source || source.deleted) return errorResult('源文件不存在')
            if (target && !target.deleted) return errorResult('目标路径已存在，拒绝覆盖')
            const sourceLock = dispatch({
              type: 'lock',
              input: {
                actorUserId,
                relativePath: fromPath,
                expectedSha256: source.sha256,
                leaseMs: 60_000,
                idempotencyKey: 'fusion-tool-move-source-lock:' + input.run.id + ':' + stableToolKey(call),
              },
            }) as { id: string }
            const targetLock = dispatch({
              type: 'lock',
              input: {
                actorUserId,
                relativePath: toPath,
                ...(target?.sha256 ? { expectedSha256: target.sha256 } : {}),
                leaseMs: 60_000,
                idempotencyKey: 'fusion-tool-move-target-lock:' + input.run.id + ':' + stableToolKey(call),
              },
            }) as { id: string }
            const moved = dispatch({
              type: 'move-file',
              input: {
                actorUserId,
                fromLockId: sourceLock.id,
                toLockId: targetLock.id,
                fromPath,
                toPath,
                expectedSha256: source.sha256,
                idempotencyKey: 'fusion-tool-move:' + input.run.id + ':' + stableToolKey(call),
              },
            })
            return { output: '文件已移动。' + formatJsonResult(moved) }
          }          case 'workspace_run_command': {
            if (!options.workspaceStore.runCommand) return errorResult('当前房间工作区未提供命令执行能力')
            const timeout = arg(call, 'timeoutMs')
            const result = await options.workspaceStore.runCommand({
              roomId,
              command: arg(call, 'command'),
              args: arg(call, 'args') || undefined,
              cwd: arg(call, 'cwd') || undefined,
              ...(timeout ? { timeoutMs: Number(timeout) } : {}),
              signal: input.signal,
            })
            if (!result.ok) return errorResult(result.reason)
            return {
              output: '命令已执行（exitCode=' + String(result.exitCode) + (result.timedOut ? '，已超时' : '') + (result.truncated ? '，输出已截断' : '') + '）：' +
                String.fromCharCode(10) + result.stdout + (result.stderr ? String.fromCharCode(10) + '[stderr]' + String.fromCharCode(10) + result.stderr : ''),
            }
          }
          case 'workspace_write_file': {
            const path = arg(call, 'path')
            const content = arg(call, 'content')
            const snapshot = currentSnapshot()
            const current = snapshot.files.find((file) => file.relativePath === path)
            const lock = dispatch({
              type: 'lock',
              input: {
                actorUserId,
                relativePath: path,
                expectedSha256: current?.sha256,
                leaseMs: 60_000,
                idempotencyKey: 'fusion-tool-lock:' + input.run.id + ':' + stableToolKey(call),
              },
            }) as { id: string }
            const committed = dispatch({
              type: 'commit-file',
              input: {
                actorUserId,
                lockId: lock.id,
                relativePath: path,
                content,
                expectedSha256: current?.sha256,
                summary: 'Bot 工作区写入',
                idempotencyKey: 'fusion-tool-write:' + input.run.id + ':' + stableToolKey(call),
              },
            })
            return { output: '文件已写入并完成版本提交。' + formatJsonResult(committed) }
          }
          default:
            return errorResult('当前远程 runtime 尚未装配工具：' + call.name)
        }
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error))
      }
    }
  }
}

function isWriteTool(name: CollaborationHostToolCall['name']): boolean {
  return name === 'workspace_write_file' ||
    name === 'workspace_run_command' ||
    name === 'workspace_apply_patch' ||
    name === 'workspace_delete_file' ||
    name === 'workspace_move_file' ||
    name === 'room_publish_artifact'
}

function parseOptions(raw: string): string[] | undefined {
  if (!raw.trim()) return undefined
  const value: unknown = JSON.parse(raw)
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error('options 必须是 JSON 字符串数组')
  }
  return value
}

function stableToolKey(call: CollaborationHostToolCall): string {
  return call.name + ':' + Object.keys(call.arguments).sort().map((key) => key + '=' + call.arguments[key]).join('&').slice(0, 512)
}

function formatJsonResult(value: unknown): string {
  return value ? ' ' + JSON.stringify(value) : ''
}

function clipUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  let end = Math.min(value.length, maxBytes)
  while (end > 0 && Buffer.byteLength(value.slice(0, end), 'utf8') > maxBytes) end -= 1
  return value.slice(0, end)
}

function errorResult(output: string): CollaborationHostToolResult {
  return { output, isError: true }
}