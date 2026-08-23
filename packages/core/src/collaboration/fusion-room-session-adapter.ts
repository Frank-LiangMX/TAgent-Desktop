import type { FusionRoomAuthoritySnapshot } from './fusion-room-authority'
import type { FusionRoomGatewayAction } from './fusion-room-gateway'
import {
  FusionRoomHttpClient,
  type FusionRoomActionResponse,
  type FusionRoomEventSubscription,
  type FusionRoomHttpStreamEvent,
} from './fusion-room-http-client'

export interface FusionRoomSessionAdapterOptions {
  client: FusionRoomHttpClient
  roomId: string
  onSnapshot?: (snapshot: FusionRoomAuthoritySnapshot) => void
  onError?: (error: unknown) => void
}

export type FusionRoomSnapshotListener = (snapshot: FusionRoomAuthoritySnapshot) => void

/**
 * Stateful renderer/service adapter for one RoomSession.
 *
 * The adapter owns the event cursor and keeps HTTP/SSE details out of the UI.
 * It deliberately does not invent reconnect retries for mutating actions; a
 * caller can close/recreate it and reload the authoritative snapshot instead.
 */
export class FusionRoomSessionAdapter {
  private snapshot?: FusionRoomAuthoritySnapshot
  private cursor = 0
  private subscription?: FusionRoomEventSubscription
  private connecting?: Promise<void>
  private closed = false
  private refreshPromise?: Promise<FusionRoomAuthoritySnapshot>
  private readonly snapshotListeners = new Set<FusionRoomSnapshotListener>()

  constructor(private readonly options: FusionRoomSessionAdapterOptions) {}

  get roomId(): string {
    return this.options.roomId
  }

  get eventCursor(): number {
    return this.cursor
  }

  get currentSnapshot(): FusionRoomAuthoritySnapshot | undefined {
    return this.snapshot ? structuredClone(this.snapshot) : undefined
  }

  /**
   * 订阅快照更新。返回取消订阅函数。
   *
   * - 若当前已有快照，订阅时立即以 structuredClone 的副本同步通知，避免暴露内部可变对象。
   * - 每次 applySnapshot 后会以独立副本通知全部订阅者，订阅者之间互不影响。
   */
  subscribeSnapshot(listener: FusionRoomSnapshotListener): () => void {
    this.snapshotListeners.add(listener)
    if (this.snapshot) listener(structuredClone(this.snapshot))
    return () => {
      this.snapshotListeners.delete(listener)
    }
  }

  async load(): Promise<FusionRoomAuthoritySnapshot> {
    this.assertOpen()
    if (this.refreshPromise) return this.refreshPromise
    this.refreshPromise = this.options.client.getSnapshot(this.roomId)
      .then((snapshot) => {
        this.applySnapshot(snapshot)
        return this.currentSnapshot!
      })
      .finally(() => {
        this.refreshPromise = undefined
      })
    return this.refreshPromise
  }

  async dispatch(action: FusionRoomGatewayAction): Promise<FusionRoomActionResponse> {
    this.assertOpen()
    const response = await this.options.client.dispatch(this.roomId, action)
    this.applySnapshot(response.snapshot)
    return { ...response, snapshot: this.currentSnapshot! }
  }

  async connect(): Promise<void> {
    this.assertOpen()
    if (this.subscription) return
    if (this.connecting) return this.connecting
    const pending = (async (): Promise<void> => {
      if (!this.snapshot) await this.load()
      if (this.closed) return
      const subscription = await this.options.client.subscribe(this.roomId, {
        afterSequence: this.cursor,
        onEvent: (event) => this.handleEvent(event),
        onError: (error) => this.options.onError?.(error),
      })
      if (this.closed) {
        subscription.close()
        await subscription.done
        return
      }
      this.subscription = subscription
    })().finally(() => {
      if (this.connecting === pending) this.connecting = undefined
    })
    this.connecting = pending
    return pending
  }

  async refresh(): Promise<FusionRoomAuthoritySnapshot> {
    return this.load()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.connecting
    const subscription = this.subscription
    this.subscription = undefined
    subscription?.close()
    await subscription?.done
  }

  private handleEvent(event: FusionRoomHttpStreamEvent): void {
    if (this.closed || event.roomId !== this.roomId) return
    if (event.cursor !== undefined) this.cursor = Math.max(this.cursor, event.cursor)
    if (event.kind === 'snapshot' || event.kind === 'notification') {
      this.applySnapshot(event.snapshot)
      return
    }
    // Replay carries events but intentionally no full snapshot. Reload once so
    // consumers always observe the same authoritative state as the server.
    void this.refresh().catch((error) => this.options.onError?.(error))
  }

  private applySnapshot(snapshot: FusionRoomAuthoritySnapshot): void {
    if (snapshot.roomId !== this.roomId) throw new Error('RoomSession 快照 roomId 不匹配')
    this.snapshot = structuredClone(snapshot)
    this.cursor = Math.max(this.cursor, this.snapshot.events.at(-1)?.sequence ?? 0)
    this.options.onSnapshot?.(structuredClone(this.snapshot))
    this.notifySnapshotListeners(this.snapshot)
  }

  private notifySnapshotListeners(snapshot: FusionRoomAuthoritySnapshot): void {
    if (this.snapshotListeners.size === 0) return
    for (const listener of this.snapshotListeners) {
      // 每个订阅者拿到独立副本，无法触及内部可变对象，也互不影响。
      listener(structuredClone(snapshot))
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('RoomSession adapter 已关闭')
  }
}