import { describe, expect, test, vi } from 'vitest'
import type { FusionRoomAuthoritySnapshot, FusionRoomGatewayAction } from '@tagent/core'
import type { FusionRoomSessionAdapter } from '@tagent/core'
import {
  canActorAuthorizeBot,
  canActorDispatch,
  createFusionRoomViewModel,
  FusionRoomViewModelController,
  type FusionRoomViewModel,
  type FusionRoomViewListener,
} from './fusion-room-view-model'

const makeSnapshot = (overrides: Partial<FusionRoomAuthoritySnapshot> = {}): FusionRoomAuthoritySnapshot => ({
  roomId: 'room-view',
  ownerUserId: 'owner',
  status: 'active',
  humanMembers: [
    { id: 'human-owner', roomId: 'room-view', userId: 'owner', displayName: 'Owner', status: 'active', joinedAt: 1, updatedAt: 1 },
    { id: 'human-b', roomId: 'room-view', userId: 'user-b', displayName: 'B', status: 'active', joinedAt: 1, updatedAt: 1 },
  ],
  botSeats: [],
  botOwnerConsents: {},
  workspace: { id: 'workspace', roomId: 'room-view', kind: 'server', status: 'active', createdAt: 1, updatedAt: 1 },
  messages: [],
  events: [],
  usage: [],
  files: [],
  locks: [],
  runs: [],
  ...overrides,
  tasks: overrides.tasks ?? [],
  artifacts: overrides.artifacts ?? [],
  approvals: overrides.approvals ?? [],
  mailbox: overrides.mailbox ?? [],
})

const botSeat = (overrides: Record<string, unknown> = {}) => ({
  id: 'seat-b', roomId: 'room-view', botProfileId: 'bot-b', ownerUserId: 'user-b', configRevisionId: 'rev-1',
  displayNameSnapshot: 'Developer', roleSnapshot: {}, backend: 'pi', modelId: 'glm-5.2', permissionProfile: 'read-only',
  capabilities: {}, status: 'accepted', logicalSessionId: 'session-b', isCoordinator: true, createdAt: 1, updatedAt: 1,
  ...overrides,
}) as FusionRoomAuthoritySnapshot['botSeats'][number]

describe('fusion room view model', () => {
  test('projects an empty room without inventing legacy fields', () => {
    const view = createFusionRoomViewModel(makeSnapshot())
    expect(view.roomId).toBe('room-view')
    expect(view.bots).toEqual([])
    expect(view.messages).toEqual([])
    expect(view.workspace.id).toBe('workspace')
  })

  test('preserves coordinator and latest event sequence', () => {
    const view = createFusionRoomViewModel(makeSnapshot({
      coordinatorSeatId: 'seat-b',
      events: [{ sequence: 3 }, { sequence: 8 }] as FusionRoomAuthoritySnapshot['events'],
      botSeats: [botSeat()],
      botOwnerConsents: { 'seat-b': true },
    }))
    expect(view.coordinatorSeatId).toBe('seat-b')
    expect(view.lastSequence).toBe(8)
    expect(view.bots[0]?.isCoordinator).toBe(true)
    expect(view.bots[0]?.ownerConsent).toBe(true)
  })

  test('enforces active human and bot-owner authorization boundaries', () => {
    const view = createFusionRoomViewModel(makeSnapshot({ botSeats: [botSeat()] }))
    expect(canActorDispatch(view, 'owner')).toBe(true)
    expect(canActorDispatch(view, 'unknown')).toBe(false)
    expect(canActorAuthorizeBot(view, 'user-b', 'seat-b')).toBe(true)
    expect(canActorAuthorizeBot(view, 'owner', 'seat-b')).toBe(false)
  })

  test('rejects dispatch in a non-active room', () => {
    const view = createFusionRoomViewModel(makeSnapshot({ status: 'paused' }))
    expect(canActorDispatch(view, 'owner')).toBe(false)
  })

  test('keeps removed bots as historical projection', () => {
    const view = createFusionRoomViewModel(makeSnapshot({ botSeats: [botSeat({ status: 'removed', isCoordinator: false })] }))
    expect(view.bots).toHaveLength(1)
    expect(view.bots[0]?.status).toBe('removed')
  })

  test('does not expose mutable snapshot arrays', () => {
    const snapshot = makeSnapshot({ messages: [{ id: 'm1', content: 'hello' }] as FusionRoomAuthoritySnapshot['messages'] })
    const view = createFusionRoomViewModel(snapshot)
    view.messages.push({ id: 'm2' } as FusionRoomAuthoritySnapshot['messages'][number])
    expect(snapshot.messages).toHaveLength(1)
  })

  test('projects workspace files, locks, and runs without leaking back into the authority snapshot', () => {
    const snapshot = makeSnapshot({
      files: [
        { relativePath: 'draft.md', sha256: 'sha-a', byteSize: 10, version: 1, updatedByUserId: 'owner', updatedAt: 1 },
        { relativePath: 'release.md', sha256: 'sha-b', byteSize: 20, version: 2, updatedByUserId: 'owner', updatedAt: 2, downloadable: true },
      ] as FusionRoomAuthoritySnapshot['files'],
      locks: [
        { id: 'lock-1', roomId: 'room-view', relativePath: 'draft.md', ownerUserId: 'owner', acquiredAt: 3, expiresAt: 30 },
      ] as FusionRoomAuthoritySnapshot['locks'],
      runs: [
        { id: 'run-1', roomId: 'room-view', seatId: 'seat-b', initiatedByUserId: 'owner', backend: 'pi', fence: 1, status: 'running', createdAt: 4, updatedAt: 4 },
      ] as FusionRoomAuthoritySnapshot['runs'],
    })
    const view = createFusionRoomViewModel(snapshot)

    // Projection reflects the authority arrays and preserves the publish flag
    expect(view.files).toHaveLength(2)
    expect(view.files[0]?.relativePath).toBe('draft.md')
    expect(view.files[0]?.downloadable).toBeUndefined()
    expect(view.files[1]?.relativePath).toBe('release.md')
    expect(view.files[1]?.downloadable).toBe(true)
    expect(view.locks).toHaveLength(1)
    expect(view.locks[0]?.id).toBe('lock-1')
    expect(view.runs).toHaveLength(1)
    expect(view.runs[0]?.id).toBe('run-1')
    expect(view.runs[0]?.status).toBe('running')

    // Mutating the projected view must not leak back into the authority snapshot
    view.files[0]!.version = 99
    view.files[0]!.downloadable = true
    view.locks[0]!.ownerUserId = 'intruder'
    view.runs[0]!.status = 'completed'
    view.runs[0]!.summary = 'tampered'

    expect(snapshot.files[0]?.version).toBe(1)
    expect(snapshot.files[0]?.downloadable).toBeUndefined()
    expect(snapshot.locks[0]?.ownerUserId).toBe('owner')
    expect(snapshot.runs[0]?.status).toBe('running')
    expect(snapshot.runs[0]?.summary).toBeUndefined()
  })
})

/**
 * Minimal stand-in for {@link FusionRoomSessionAdapter}. Only the surface
 * the controller touches is implemented; `deliver` simulates the adapter
 * calling its `subscribeSnapshot` listeners after an internal state change.
 */
class MockSessionAdapter {
  private current?: FusionRoomAuthoritySnapshot
  private readonly listeners = new Set<(snapshot: FusionRoomAuthoritySnapshot) => void>()

  constructor(initial?: FusionRoomAuthoritySnapshot) {
    if (initial) this.current = structuredClone(initial)
  }

  readonly subscribeSnapshot = vi.fn((listener: (snapshot: FusionRoomAuthoritySnapshot) => void) => {
    this.listeners.add(listener)
    if (this.current) listener(structuredClone(this.current))
    return () => { this.listeners.delete(listener) }
  })

  readonly load = vi.fn(async (): Promise<FusionRoomAuthoritySnapshot> => this.current!)
  readonly dispatch = vi.fn(async (_action: FusionRoomGatewayAction): Promise<{ result: unknown; snapshot: FusionRoomAuthoritySnapshot }> => ({ result: undefined, snapshot: this.current! }))
  readonly connect = vi.fn(async (): Promise<void> => {})
  readonly close = vi.fn(async (): Promise<void> => {})

  /** Simulate the adapter applying a new authoritative snapshot. */
  deliver(snapshot: FusionRoomAuthoritySnapshot): void {
    this.current = structuredClone(snapshot)
    for (const listener of [...this.listeners]) {
      listener(structuredClone(this.current))
    }
  }

  get listenerCount(): number {
    return this.listeners.size
  }
}

const adapterSnapshot = (sequence: number): FusionRoomAuthoritySnapshot =>
  makeSnapshot({ events: [{ sequence }] as FusionRoomAuthoritySnapshot['events'] })

describe('FusionRoomViewModelController', () => {
  function createController(adapter: MockSessionAdapter): FusionRoomViewModelController {
    return new FusionRoomViewModelController(adapter as unknown as FusionRoomSessionAdapter)
  }

  test('constructor subscribes to adapter and projects initial snapshot', () => {
    const adapter = new MockSessionAdapter(adapterSnapshot(3))
    const controller = createController(adapter)

    expect(adapter.subscribeSnapshot).toHaveBeenCalledOnce()
    expect(controller.currentView?.roomId).toBe('room-view')
    expect(controller.currentView?.lastSequence).toBe(3)
  })

  test('currentView returns a structuredClone that does not expose internal state', () => {
    const adapter = new MockSessionAdapter(adapterSnapshot(1))
    const controller = createController(adapter)

    const view = controller.currentView!
    view.messages.push({ id: 'mutated' } as FusionRoomAuthoritySnapshot['messages'][number])
    view.status = 'paused'

    expect(controller.currentView?.messages).toHaveLength(0)
    expect(controller.currentView?.status).toBe('active')
  })

  test('subscribe immediately notifies with a clone of the current view and returns unsubscribe', () => {
    const adapter = new MockSessionAdapter(adapterSnapshot(5))
    const controller = createController(adapter)

    const received: number[] = []
    const unsubscribe = controller.subscribe((view) => received.push(view.lastSequence))

    expect(received).toEqual([5])

    // Each listener gets an independent clone
    const view = controller.currentView!
    expect(view).not.toBe(controller.currentView)

    unsubscribe()
    adapter.deliver(adapterSnapshot(7))
    expect(received).toEqual([5])
  })

  test('load projects the fresh snapshot delivered by the adapter', async () => {
    const adapter = new MockSessionAdapter()
    adapter.load.mockImplementation(async () => {
      adapter.deliver(adapterSnapshot(2))
      return adapterSnapshot(2)
    })
    const controller = createController(adapter)

    const received: number[] = []
    controller.subscribe((view) => received.push(view.lastSequence))

    expect(controller.currentView).toBeUndefined()
    await controller.load()
    expect(controller.currentView?.lastSequence).toBe(2)
    expect(received).toEqual([2])
  })

  test('load throws when the adapter callback does not update the view', async () => {
    const adapter = new MockSessionAdapter()
    adapter.load.mockResolvedValue(adapterSnapshot(1)) // no deliver → no listener call
    const controller = createController(adapter)

    await expect(controller.load()).rejects.toThrow(/未收到快照更新/)
    expect(controller.currentView).toBeUndefined()
  })

  test('dispatch projects the fresh snapshot delivered by the adapter', async () => {
    const adapter = new MockSessionAdapter(adapterSnapshot(1))
    const action: FusionRoomGatewayAction = { type: 'presence', status: 'active' }
    adapter.dispatch.mockImplementation(async () => {
      adapter.deliver(adapterSnapshot(4))
      return { result: undefined, snapshot: adapterSnapshot(4) }
    })
    const controller = createController(adapter)

    const received: number[] = []
    controller.subscribe((view) => received.push(view.lastSequence))

    await controller.dispatch(action)
    expect(adapter.dispatch).toHaveBeenCalledWith(action)
    expect(controller.currentView?.lastSequence).toBe(4)
    expect(received).toEqual([1, 4])
  })

  test('dispatch throws when the adapter callback does not update the view', async () => {
    const adapter = new MockSessionAdapter(adapterSnapshot(1))
    adapter.dispatch.mockResolvedValue({ result: undefined, snapshot: adapterSnapshot(1) })
    const controller = createController(adapter)

    await expect(
      controller.dispatch({ type: 'presence', status: 'active' }),
    ).rejects.toThrow(/未收到快照更新/)
    // The original projection is preserved
    expect(controller.currentView?.lastSequence).toBe(1)
  })

  test('connect delegates to adapter.connect', async () => {
    const adapter = new MockSessionAdapter(adapterSnapshot(1))
    const controller = createController(adapter)

    await controller.connect()
    expect(adapter.connect).toHaveBeenCalledOnce()
  })

  test('close unsubscribes, clears listeners, and awaits adapter.close', async () => {
    const adapter = new MockSessionAdapter(adapterSnapshot(1))
    const controller = createController(adapter)

    const received: number[] = []
    controller.subscribe((view) => received.push(view.lastSequence))
    expect(received).toEqual([1])
    expect(adapter.listenerCount).toBe(1)

    await controller.close()

    expect(adapter.close).toHaveBeenCalledOnce()
    expect(adapter.listenerCount).toBe(0)

    // After close, delivering a snapshot must not notify listeners
    adapter.deliver(adapterSnapshot(9))
    expect(received).toEqual([1])
  })

  test('close is idempotent', async () => {
    const adapter = new MockSessionAdapter(adapterSnapshot(1))
    const controller = createController(adapter)

    await controller.close()
    await controller.close() // should not throw or call adapter.close again
    expect(adapter.close).toHaveBeenCalledOnce()
  })

  test('load, dispatch, and connect throw after close', async () => {
    const adapter = new MockSessionAdapter(adapterSnapshot(1))
    const controller = createController(adapter)
    await controller.close()

    await expect(controller.load()).rejects.toThrow(/已关闭/)
    await expect(
      controller.dispatch({ type: 'presence', status: 'active' }),
    ).rejects.toThrow(/已关闭/)
    await expect(controller.connect()).rejects.toThrow(/已关闭/)
  })

  test('snapshot deliveries after construction project to listeners with independent clones', () => {
    const adapter = new MockSessionAdapter()
    const controller = createController(adapter)

    const views: FusionRoomViewModel[] = []
    controller.subscribe((view) => {
      views.push(view)
    })

    // No initial snapshot → no immediate notification
    expect(views).toHaveLength(0)

    adapter.deliver(adapterSnapshot(3))
    expect(views).toHaveLength(1)
    expect(views[0]?.lastSequence).toBe(3)

    // Mutating the received view must not affect the next delivery or currentView
    views[0]!.status = 'paused'

    adapter.deliver(adapterSnapshot(6))
    expect(views).toHaveLength(2)
    expect(views[1]?.lastSequence).toBe(6)
    expect(views[1]?.status).toBe('active')
    expect(controller.currentView?.lastSequence).toBe(6)
  })
})
