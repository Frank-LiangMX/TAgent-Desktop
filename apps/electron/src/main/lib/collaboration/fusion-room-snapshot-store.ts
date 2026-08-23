import { existsSync, mkdirSync, rmdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  FusionRoomSnapshotConflictError,
  type FusionRoomAuthoritySnapshot,
  type FusionRoomSnapshotStore,
} from '@tagent/core'
import { readJsonSafe, writeJsonAtomic } from '../atomic-json'
import { getFusionRoomSnapshotsPath } from '../config/config-paths'

interface FusionRoomSnapshotConfig {
  version: 1
  snapshots: Record<string, FusionRoomAuthoritySnapshot>
}

const EMPTY_CONFIG: FusionRoomSnapshotConfig = {
  version: 1,
  snapshots: {},
}
const WRITE_LOCK_STALE_MS = 60_000

export class FileFusionRoomSnapshotStore implements FusionRoomSnapshotStore {
  private readonly path: string

  constructor(path = getFusionRoomSnapshotsPath()) {
    this.path = path
    const parent = dirname(path)
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true })
  }

  load(roomId: string): FusionRoomAuthoritySnapshot | undefined {
    const config = this.read()
    const snapshot = config.snapshots[roomId]
    return snapshot ? clone(snapshot) : undefined
  }

  save(
    snapshot: FusionRoomAuthoritySnapshot,
    options: { expectedEventCount?: number } = {},
  ): void {
    this.withWriteLock(() => {
      const config = this.read()
      const current = config.snapshots[snapshot.roomId]
      const currentEventCount = current?.events.length ?? 0
      if (
        options.expectedEventCount !== undefined &&
        currentEventCount !== options.expectedEventCount
      ) {
        throw new FusionRoomSnapshotConflictError()
      }
      config.snapshots[snapshot.roomId] = clone(snapshot)
      writeJsonAtomic(this.path, config)
    })
  }

  listRoomIds(): string[] {
    return Object.keys(this.read().snapshots).sort()
  }

  private withWriteLock<T>(operation: () => T): T {
    const lockPath = this.path + '.lock'
    let acquired = false
    for (let attempt = 0; attempt < 3 && !acquired; attempt += 1) {
      try {
        mkdirSync(lockPath)
        acquired = true
      } catch {
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > WRITE_LOCK_STALE_MS) {
            rmdirSync(lockPath)
            continue
          }
        } catch {
          /* another writer is creating or releasing the lock */
        }
        throw new Error('RoomSession 快照存储正被其他进程更新，请稍后重试')
      }
    }
    if (!acquired) throw new Error('RoomSession 快照存储锁定失败')
    try {
      return operation()
    } finally {
      try {
        rmdirSync(lockPath)
      } catch {
        /* stale cleanup remains safe */
      }
    }
  }

  private read(): FusionRoomSnapshotConfig {
    const parsed = readJsonSafe<Partial<FusionRoomSnapshotConfig> | null>(
      this.path,
      null,
    )
    if (!parsed || parsed.version !== 1 || !parsed.snapshots) {
      return {
        version: EMPTY_CONFIG.version,
        snapshots: {},
      }
    }
    return {
      version: 1,
      snapshots: parsed.snapshots,
    }
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
