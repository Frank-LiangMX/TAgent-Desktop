import type {
  CollaborationHumanMemberStatus,
  CollaborationRoomEvent,
  FusionHumanMember,
  RoomBotSeat,
} from '@tagent/shared'
import {
  FusionRoomAuthorityError,
  type AddFusionBotSeatInput,
  type AppendFusionMessageInput,
  type AcquireFusionWorkspaceLockInput,
  type CommitFusionWorkspaceFileInput,
  type CommitFusionWorkspaceFilesInput,
  type DeleteFusionWorkspaceFileInput, type MoveFusionWorkspaceFileInput,
  type RecordFusionUsageInput,
  type StartFusionRunInput,
  type RetryFusionRunInput,
  type FinishFusionRunInput,
  type FusionAuthorityRoomStatus,
  type FusionRoomAuthoritySnapshot,
  type CreateFusionRoomAuthorityInput,
  type CreateFusionRoomTaskInput,
  type UpdateFusionRoomTaskInput,
  type UpdateFusionRoomMetadataInput,
  type PublishFusionArtifactInput,
  type RequestFusionUserApprovalInput, type ResolveFusionUserApprovalInput, type SendFusionMailboxInput, type ReplyFusionMailboxInput, type AwaitFusionRunInput,
} from './fusion-room-authority'
import type { ConfirmFusionResumeContinuationInput } from './fusion-room-continuation'
import {
  FusionRoomHost,
  type FusionRoomAction,
  type FusionRoomActionResult,
  type FusionRoomEventListener,
} from './fusion-room-host'
import { decideRoomAccess } from './fusion-room-acl'

export interface FusionRoomPrincipal {
  userId: string
  kind?: 'user' | 'worker'
  connectionId?: string
  /** Bearer invite tokens may be scoped to exactly one RoomSession. */
  roomId?: string
}

export type FusionRoomGatewayAction =
  | { type: 'invite-human'; userId: string; displayName: string }
  | { type: 'accept-invitation' }
  | { type: 'leave-human' }
  | { type: 'remove-human'; userId: string }
  | { type: 'presence'; status: Extract<CollaborationHumanMemberStatus, 'active' | 'offline'> }
  | {
      type: 'add-bot'
      input: Omit<AddFusionBotSeatInput, 'actorUserId'>
    }
  | { type: 'bot-consent'; seatId: string; consent: boolean }
  | { type: 'remove-bot'; seatId: string }
  | {
      type: 'message'
      input: Omit<AppendFusionMessageInput, 'actorUserId'>
    }
  | {
      type: 'lock'
      input: Omit<AcquireFusionWorkspaceLockInput, 'actorUserId'>
    }
  | {
      type: 'commit-file'
      input: Omit<CommitFusionWorkspaceFileInput, 'actorUserId'>
    }
  | {
      type: 'commit-files'
      input: Omit<CommitFusionWorkspaceFilesInput, 'actorUserId'>
    }
  | { type: 'delete-file'; input: Omit<DeleteFusionWorkspaceFileInput, 'actorUserId'> }
  | { type: 'move-file'; input: Omit<MoveFusionWorkspaceFileInput, 'actorUserId'> }
  | {
      type: 'usage'
      input: Omit<RecordFusionUsageInput, 'actorUserId'>
    }
  | {
      type: 'start-run'
      input: Omit<StartFusionRunInput, 'actorUserId'>
    }
  | {
      type: 'retry-run'
      input: Omit<RetryFusionRunInput, 'actorUserId'>
    }
  | {
      type: 'finish-run'
      input: Omit<FinishFusionRunInput, 'actorUserId'>
    }
  | { type: 'status'; status: FusionAuthorityRoomStatus }
  | { type: 'await-run'; input: Omit<AwaitFusionRunInput, 'actorUserId'> }
  | { type: 'update-metadata'; input: Omit<UpdateFusionRoomMetadataInput, 'actorUserId'> }
  | { type: 'create-task'; input: Omit<CreateFusionRoomTaskInput, 'actorUserId'> }
  | { type: 'update-task'; input: Omit<UpdateFusionRoomTaskInput, 'actorUserId'> }
  | { type: 'publish-artifact'; input: Omit<PublishFusionArtifactInput, 'actorUserId'> }
  | { type: 'request-approval'; input: Omit<RequestFusionUserApprovalInput, 'actorUserId'> }
  | { type: 'resolve-approval'; input: Omit<ResolveFusionUserApprovalInput, 'actorUserId'> }
  | { type: 'send-mailbox'; input: Omit<SendFusionMailboxInput, 'actorUserId'> }
  | { type: 'reply-mailbox'; input: Omit<ReplyFusionMailboxInput, 'actorUserId'> }
  | { type: 'confirm-resume-continuation'; input: Omit<ConfirmFusionResumeContinuationInput, 'actorUserId'> }

export interface FusionRoomGatewayNotification {
  connectionId: string
  roomId: string
  events: CollaborationRoomEvent[]
  snapshot: FusionRoomAuthoritySnapshot
}

export type FusionRoomGatewayListener = (
  notification: FusionRoomGatewayNotification,
) => void

export interface FusionRoomGatewayOptions {
  /**
   * Optional server authentication/ACL hook. Returning false denies the request
   * before the authority sees it. The default permits the room owner and invited,
   * active, or offline members (removed/left members are denied).
   */
  authorize?: (
    principal: FusionRoomPrincipal,
    snapshot: FusionRoomAuthoritySnapshot,
  ) => boolean
}

interface GatewayConnection {
  principal: FusionRoomPrincipal
  listeners: Map<string, Set<FusionRoomGatewayListener>>
  hostUnsubscribers: Map<string, () => void>
}

/**
 * Authenticated, transport-neutral RoomSession gateway.
 *
 * HTTP/WebSocket/SSE adapters should authenticate a request, call connect/dispatch,
 * and forward notifications. They must not pass actorUserId from the wire payload:
 * this gateway injects the authenticated principal into every authority action.
 */
export class FusionRoomGateway {
  private readonly connections = new Map<string, GatewayConnection>()
  private connectionCounter = 0
  private readonly authorize: (
    principal: FusionRoomPrincipal,
    snapshot: FusionRoomAuthoritySnapshot,
  ) => boolean

  constructor(
    private readonly host: FusionRoomHost,
    options: FusionRoomGatewayOptions = {},
  ) {
    this.authorize = options.authorize ?? defaultAuthorize
  }

  createRoom(
    principal: FusionRoomPrincipal,
    input: Omit<CreateFusionRoomAuthorityInput, 'ownerUserId'>,
  ): FusionRoomAuthoritySnapshot {
    const userId = principal.userId.trim()
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.roomId)) {
      throw new FusionRoomAuthorityError('INVALID_STATE', 'RoomSession ID 格式非法')
    }
    if (!userId) {
      throw new FusionRoomAuthorityError('FORBIDDEN', '认证用户 ID 不能为空')
    }
    return this.host.createRoom({ ...input, ownerUserId: userId })
  }

  connect(principal: FusionRoomPrincipal): string {
    const userId = principal.userId.trim()
    if (!userId) {
      throw new FusionRoomAuthorityError('FORBIDDEN', '认证用户 ID 不能为空')
    }
    const connectionId =
      principal.connectionId?.trim() ||
      'conn_' + Date.now().toString(36) + '_' + (this.connectionCounter++).toString(36)
    if (this.connections.has(connectionId)) {
      throw new FusionRoomAuthorityError('CONFLICT', '连接 ID 已存在')
    }
    this.connections.set(connectionId, {
      principal: { ...principal, userId, connectionId },
      listeners: new Map(),
      hostUnsubscribers: new Map(),
    })
    return connectionId
  }

  disconnect(connectionId: string): void {
    const connection = this.connection(connectionId)
    for (const unsubscribe of connection.hostUnsubscribers.values()) unsubscribe()
    this.connections.delete(connectionId)
  }

  listAccessibleRoomIds(connectionId: string): string[] {
    const connection = this.connection(connectionId)
    return this.host
      .listRoomIds()
      .filter((roomId) => this.isAuthorized(connection.principal, roomId))
  }

  getSnapshot(connectionId: string, roomId: string): FusionRoomAuthoritySnapshot {
    const connection = this.connection(connectionId)
    this.assertAuthorized(connection.principal, roomId)
    return this.host.getSnapshot(roomId)
  }

  /**
   * Return the authoritative event suffix after a client cursor.
   *
   * Transport adapters use this during reconnect before subscribing to live
   * notifications. Authorization is checked against the current snapshot so a
   * member that was removed cannot replay room history.
   */
  listEvents(
    connectionId: string,
    roomId: string,
    afterSequence = 0,
  ): CollaborationRoomEvent[] {
    const connection = this.connection(connectionId)
    const snapshot = this.assertAuthorized(connection.principal, roomId)
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new FusionRoomAuthorityError('INVALID_STATE', 'RoomEvent cursor 非法')
    }
    return snapshot.events
      .filter((event) => event.sequence > afterSequence)
      .map((event) => JSON.parse(JSON.stringify(event)) as CollaborationRoomEvent)
  }

  dispatch(
    connectionId: string,
    roomId: string,
    action: FusionRoomGatewayAction,
  ): FusionRoomActionResult {
    const connection = this.connection(connectionId)
    this.assertAuthorized(connection.principal, roomId)
    return this.host.dispatch(roomId, this.toAuthorityAction(connection.principal, action))
  }

  subscribe(
    connectionId: string,
    roomId: string,
    listener: FusionRoomGatewayListener,
  ): () => void {
    const connection = this.connection(connectionId)
    this.assertAuthorized(connection.principal, roomId)
    const listeners =
      connection.listeners.get(roomId) ?? new Set<FusionRoomGatewayListener>()
    listeners.add(listener)
    connection.listeners.set(roomId, listeners)

    if (!connection.hostUnsubscribers.has(roomId)) {
      const hostListener: FusionRoomEventListener = (notification) => {
        const current = this.connections.get(connectionId)
        if (!current) return
        const currentSnapshot = this.host.getSnapshot(roomId)
        if (!this.authorize(current.principal, currentSnapshot)) {
          this.unsubscribeRoom(connectionId, roomId)
          return
        }
        const currentListeners = current.listeners.get(roomId)
        if (!currentListeners || currentListeners.size === 0) return
        for (const currentListener of [...currentListeners]) {
          currentListener({
            connectionId,
            roomId,
            events: notification.events,
            snapshot: notification.snapshot,
          })
        }
      }
      connection.hostUnsubscribers.set(roomId, this.host.subscribe(roomId, hostListener))
    }

    return () => {
      const current = this.connections.get(connectionId)
      if (!current) return
      const currentListeners = current.listeners.get(roomId)
      currentListeners?.delete(listener)
      if (currentListeners && currentListeners.size === 0) {
        current.listeners.delete(roomId)
        this.unsubscribeRoom(connectionId, roomId)
      }
    }
  }

  private unsubscribeRoom(connectionId: string, roomId: string): void {
    const connection = this.connections.get(connectionId)
    if (!connection) return
    connection.hostUnsubscribers.get(roomId)?.()
    connection.hostUnsubscribers.delete(roomId)
    connection.listeners.delete(roomId)
  }

  private connection(connectionId: string): GatewayConnection {
    const connection = this.connections.get(connectionId)
    if (!connection) {
      throw new FusionRoomAuthorityError('FORBIDDEN', '连接不存在或已经断开')
    }
    return connection
  }

  private isAuthorized(principal: FusionRoomPrincipal, roomId: string): boolean {
    try {
      const snapshot = this.host.getSnapshot(roomId)
      return this.authorize(principal, snapshot)
    } catch {
      return false
    }
  }

  private assertAuthorized(
    principal: FusionRoomPrincipal,
    roomId: string,
  ): FusionRoomAuthoritySnapshot {
    const snapshot = this.host.getSnapshot(roomId)
    if (!this.authorize(principal, snapshot)) {
      throw new FusionRoomAuthorityError('FORBIDDEN', '当前用户无权访问该 RoomSession')
    }
    return snapshot
  }

  private toAuthorityAction(
    principal: FusionRoomPrincipal,
    action: FusionRoomGatewayAction,
  ): FusionRoomAction {
    const actorUserId = principal.userId
    switch (action.type) {
      case 'invite-human':
        return { ...action, type: 'invite-human', actorUserId }
      case 'accept-invitation':
        return { type: 'accept-invitation', userId: actorUserId }
      case 'leave-human':
        return { type: 'leave-human', actorUserId }
      case 'remove-human':
        return { ...action, type: 'remove-human', actorUserId }
      case 'presence':
        return { ...action, type: 'presence', actorUserId }
      case 'add-bot':
        return {
          type: 'add-bot',
          input: withScopedIdempotency(action.type, actorUserId, { ...action.input, actorUserId }),
        }
      case 'bot-consent':
        return { ...action, type: 'bot-consent', actorUserId }
      case 'remove-bot':
        return { ...action, type: 'remove-bot', actorUserId }
      case 'message':
        return {
          type: 'message',
          input: withScopedIdempotency(action.type, actorUserId, { ...action.input, actorUserId }),
        }
      case 'lock':
        return {
          type: 'lock',
          input: withScopedIdempotency(action.type, actorUserId, { ...action.input, actorUserId }),
        }
      case 'commit-file':
        return {
          type: 'commit-file',
          input: withScopedIdempotency(action.type, actorUserId, { ...action.input, actorUserId }),
        }
      case 'commit-files':
        return {
          type: 'commit-files',
          input: withScopedIdempotency(action.type, actorUserId, { ...action.input, actorUserId }),
        }
      case 'delete-file':
        return { type: 'delete-file', input: withScopedIdempotency(action.type, actorUserId, { ...action.input, actorUserId }) }
      case 'move-file':
        return { type: 'move-file', input: withScopedIdempotency(action.type, actorUserId, { ...action.input, actorUserId }) }
      case 'usage':
        return {
          type: 'usage',
          input: withScopedIdempotency(action.type, actorUserId, { ...action.input, actorUserId }),
        }
      case 'start-run':
        return {
          type: 'start-run',
          input: withScopedIdempotency(action.type, actorUserId, { ...action.input, actorUserId }),
        }
      case 'retry-run':
        return {
          type: 'retry-run',
          input: withScopedIdempotency(action.type, actorUserId, { ...action.input, actorUserId }),
        }
      case 'finish-run':
        return {
          type: 'finish-run',
          input: withScopedIdempotency(action.type, actorUserId, { ...action.input, actorUserId }),
        }
      case 'create-task':
        return { type: 'create-task', input: withScopedIdempotency(action.type, actorUserId, { ...action.input, actorUserId, roomId: (action.input as { roomId: string }).roomId }) }
      case 'update-task':
        return { type: 'update-task', input: withScopedIdempotency(action.type, actorUserId, { ...action.input, actorUserId, roomId: (action.input as { roomId: string }).roomId }) }
      case 'publish-artifact':
        return { type: 'publish-artifact', input: withScopedIdempotency(action.type, actorUserId, { ...action.input, actorUserId }) }
      case 'request-approval':
        return { type: 'request-approval', input: withScopedIdempotency(action.type, actorUserId, { ...action.input, actorUserId }) }
      case 'resolve-approval':
        return { type: 'resolve-approval', input: withScopedIdempotency(action.type, actorUserId, { ...action.input, actorUserId }) }
      case 'send-mailbox':
        return { type: 'send-mailbox', input: withScopedIdempotency(action.type, actorUserId, { ...action.input, actorUserId }) }
      case 'reply-mailbox':
        return { type: 'reply-mailbox', input: withScopedIdempotency(action.type, actorUserId, { ...action.input, actorUserId }) }
      case 'confirm-resume-continuation':
        return { type: 'confirm-resume-continuation', input: withScopedIdempotency(action.type, actorUserId, { ...action.input, actorUserId }) }
      case 'await-run':
        return { type: 'await-run', input: withScopedIdempotency(action.type, actorUserId, { ...action.input, actorUserId }) }
      case 'update-metadata':
        return {
          type: 'update-metadata',
          input: withScopedIdempotency(action.type, actorUserId, {
            ...action.input,
            actorUserId: principal.userId,
          }),
        }
      case 'status':
        return { ...action, type: 'status', actorUserId }
      default:
        return assertNever(action)
    }
  }
}

function withScopedIdempotency<T extends { idempotencyKey?: string }>(actionType: string, actorUserId: string, input: T): T {
  if (!input.idempotencyKey) return input
  return {
    ...input,
    idempotencyKey: actorUserId + ':' + actionType + ':' + input.idempotencyKey,
  }
}

/**
 * 默认房间入口授权：委托 ACL 协议层 `decideRoomAccess`，行为与历史实现保持兼容。
 *
 * - `principal.roomId` 绑定 A 时访问 B → 拒绝（`SCOPE_MISMATCH`）；
 * - `kind==='worker'` 仅当 `principal.userId === ownerUserId` 才放行；
 * - 房主始终可进；
 * - 人类成员 `invited` / `active` / `offline` 可进，`left` / `removed` 拒绝。
 *
 * 真实账户认证、邀请 token 与账户身份绑定仍待 P0 后续切片；此处只复用协议判定。
 */
function defaultAuthorize(
  principal: FusionRoomPrincipal,
  snapshot: FusionRoomAuthoritySnapshot,
): boolean {
  return decideRoomAccess({
    principal,
    roomId: snapshot.roomId,
    ownerUserId: snapshot.ownerUserId,
    humanMembers: snapshot.humanMembers,
  }).allowed
}

function assertNever(value: never): never {
  throw new FusionRoomAuthorityError(
    'INVALID_STATE',
    '未知 RoomSession gateway 动作: ' + String(value),
  )
}
