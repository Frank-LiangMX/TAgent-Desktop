import type {
  FusionContinuationItem,
  FusionRoomActionResponse,
  FusionRoomAuthoritySnapshot,
  FusionRoomGatewayAction,
  FusionRoomSnapshotListener,
} from '@tagent/core'
import { listFusionContinuations } from '@tagent/core'
import type {
  CollaborationHumanMember,
  CollaborationRoomTask,
  CollaborationArtifact,
  CollaborationUserApprovalRequest, CollaborationMailboxEnvelope,
  CollaborationMessage,
} from '@tagent/shared'

export interface FusionBotViewModel {
  id: string
  botProfileId: string
  ownerUserId: string
  displayName: string
  modelId?: string
  backend: string
  permissionProfile: string
  status: string
  isCoordinator: boolean
  ownerConsent: boolean
}

export interface FusionRoomViewModel {
  roomId: string
  title: string
  goal: string
  ownerUserId: string
  status: FusionRoomAuthoritySnapshot['status']
  humanMembers: CollaborationHumanMember[]
  bots: FusionBotViewModel[]
  messages: CollaborationMessage[]
  coordinatorSeatId?: string
  workspace: FusionRoomAuthoritySnapshot['workspace']
  files: FusionRoomAuthoritySnapshot['files']
  locks: FusionRoomAuthoritySnapshot['locks']
  runs: FusionRoomAuthoritySnapshot['runs']
  tasks: CollaborationRoomTask[]
  artifacts: CollaborationArtifact[]
  approvals: CollaborationUserApprovalRequest[]
  mailbox: CollaborationMailboxEnvelope[]
  continuations: FusionContinuationItem[]
  lastSequence: number
}

export function createFusionRoomViewModel(
  snapshot: FusionRoomAuthoritySnapshot,
): FusionRoomViewModel {
  return {
    roomId: snapshot.roomId,
    title: snapshot.title?.trim() || snapshot.roomId,
    goal: snapshot.goal?.trim() ?? "",
    ownerUserId: snapshot.ownerUserId,
    status: snapshot.status,
    humanMembers: snapshot.humanMembers.map((member) => ({ ...member })),
    bots: snapshot.botSeats.map((seat) => ({
      id: seat.id,
      botProfileId: seat.botProfileId,
      ownerUserId: seat.ownerUserId,
      displayName: seat.displayNameSnapshot,
      ...(seat.modelId === undefined ? {} : { modelId: seat.modelId }),
      backend: seat.backend,
      permissionProfile: seat.permissionProfile,
      status: seat.status,
      isCoordinator: seat.isCoordinator,
      ownerConsent: snapshot.botOwnerConsents[seat.id] === true,
    })),
    messages: snapshot.messages.map((message) => ({ ...message })),
    ...(snapshot.coordinatorSeatId === undefined
      ? {}
      : { coordinatorSeatId: snapshot.coordinatorSeatId }),
    workspace: { ...snapshot.workspace },
    files: snapshot.files.filter((file) => file.deleted !== true).map((file) => ({ ...file })),
    locks: snapshot.locks.map((lock) => ({ ...lock })),
    runs: snapshot.runs.map((run) => ({ ...run })),
    tasks: snapshot.tasks.map((task) => ({ ...task, ...(task.dependsOnTaskIds ? { dependsOnTaskIds: [...task.dependsOnTaskIds] } : {}) })),
    artifacts: snapshot.artifacts.map((artifact) => ({ ...artifact })),
    approvals: snapshot.approvals.map((approval) => ({ ...approval, ...(approval.options ? { options: [...approval.options] } : {}) })),
    mailbox: snapshot.mailbox.map((envelope) => ({ ...envelope })),
    continuations: listFusionContinuations(snapshot).map((item) => ({
      ...item,
      ...(item.refs ? { refs: { ...item.refs } } : {}),
    })),
    lastSequence: snapshot.events.reduce(
      (max, event) => Math.max(max, event.sequence),
      0,
    ),
  }
}

export function canActorDispatch(
  view: FusionRoomViewModel,
  actorUserId: string,
): boolean {
  return (
    view.status === 'active' &&
    view.humanMembers.some(
      (member) => member.userId === actorUserId && member.status === 'active',
    )
  )
}

export function canActorAuthorizeBot(
  view: FusionRoomViewModel,
  actorUserId: string,
  seatId: string,
): boolean {
  return (
    canActorDispatch(view, actorUserId) &&
    view.bots.some((bot) => bot.id === seatId && bot.ownerUserId === actorUserId)
  )
}

export type FusionRoomViewListener = (view: FusionRoomViewModel) => void

/**
 * Structural contract for the session-adapter surface that
 * {@link FusionRoomViewModelController} depends on.
 *
 * The concrete {@link FusionRoomSessionAdapter} from `@tagent/core` satisfies
 * this interface implicitly via TypeScript's structural typing, so callers may
 * keep passing it directly; tests and alternate backends only need to
 * implement the five methods below.
 */
export interface FusionRoomSessionAdapterLike {
  subscribeSnapshot(listener: FusionRoomSnapshotListener): () => void
  load(): Promise<FusionRoomAuthoritySnapshot>
  dispatch(action: FusionRoomGatewayAction): Promise<FusionRoomActionResponse>
  connect(): Promise<void>
  close(): Promise<void>
}

/**
 * Coordinates a {@link FusionRoomSessionAdapterLike} with the renderer-side view
 * model. The controller subscribes to the adapter's snapshot stream in its
 * constructor and projects every authoritative snapshot through
 * {@link createFusionRoomViewModel}. Mutating operations (`load`/`dispatch`)
 * verify that the adapter actually delivered a fresh snapshot before
 * resolving; `close` tears down the subscription and listeners.
 *
 * The view is never cast back to a snapshot — the projection is one-way.
 */
export class FusionRoomViewModelController {
  private view?: FusionRoomViewModel
  private readonly listeners = new Set<FusionRoomViewListener>()
  private unsubscribeAdapter?: () => void
  private closed = false

  constructor(private readonly adapter: FusionRoomSessionAdapterLike) {
    this.unsubscribeAdapter = adapter.subscribeSnapshot((snapshot) => {
      this.applySnapshot(snapshot)
    })
  }

  get currentView(): FusionRoomViewModel | undefined {
    return this.view ? structuredClone(this.view) : undefined
  }

  subscribe(listener: FusionRoomViewListener): () => void {
    this.listeners.add(listener)
    if (this.view) listener(structuredClone(this.view))
    return () => {
      this.listeners.delete(listener)
    }
  }

  async load(): Promise<void> {
    this.assertNotClosed()
    const before = this.view
    await this.adapter.load()
    if (this.view === before) {
      throw new Error(
        'FusionRoomViewModelController.load 未收到快照更新，adapter 回调未投影 view',
      )
    }
  }

  async dispatch(action: FusionRoomGatewayAction): Promise<void> {
    this.assertNotClosed()
    const before = this.view
    await this.adapter.dispatch(action)
    if (this.view === before) {
      throw new Error(
        'FusionRoomViewModelController.dispatch 未收到快照更新，adapter 回调未投影 view',
      )
    }
  }

  async connect(): Promise<void> {
    this.assertNotClosed()
    await this.adapter.connect()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.unsubscribeAdapter?.()
    this.unsubscribeAdapter = undefined
    this.listeners.clear()
    await this.adapter.close()
  }

  private applySnapshot(snapshot: FusionRoomAuthoritySnapshot): void {
    this.view = createFusionRoomViewModel(snapshot)
    this.notifyListeners()
  }

  private notifyListeners(): void {
    if (!this.view || this.listeners.size === 0) return
    for (const listener of [...this.listeners]) {
      listener(structuredClone(this.view))
    }
  }

  private assertNotClosed(): void {
    if (this.closed) {
      throw new Error('FusionRoomViewModelController 已关闭')
    }
  }
}
