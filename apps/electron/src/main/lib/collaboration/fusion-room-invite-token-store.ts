import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { existsSync, mkdirSync, rmdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import type { FusionRoomPrincipal } from '@tagent/core'
import { readJsonSafe, writeJsonAtomic } from '../atomic-json'
import { getFusionRoomInviteTokensPath } from '../config/config-paths'

interface PersistedInviteToken {
  tokenId: string
  tokenHash: string
  roomId: string
  userId: string
  displayName: string
  createdAt: number
  expiresAt?: number
  revokedAt?: number
}

interface InviteTokenConfig {
  version: 1
  tokens: Record<string, PersistedInviteToken>
}

export interface FusionRoomInviteTokenIssueInput {
  roomId: string
  userId: string
  displayName: string
  expiresAt?: number
  now?: number
}

export interface FusionRoomIssuedInvite {
  token: string
  tokenId: string
  roomId: string
  userId: string
  displayName: string
  createdAt: number
  expiresAt?: number
}

const WRITE_LOCK_STALE_MS = 60_000

const EMPTY_CONFIG: InviteTokenConfig = {
  version: 1,
  tokens: {},
}

export class FileFusionRoomInviteTokenStore {
  private readonly path: string

  constructor(path = getFusionRoomInviteTokensPath()) {
    this.path = path
    const parent = dirname(path)
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true })
  }

  issue(input: FusionRoomInviteTokenIssueInput): FusionRoomIssuedInvite {
    return this.withWriteLock(() => {
      const roomId = input.roomId.trim()
      const userId = input.userId.trim()
      const displayName = input.displayName.trim()
      const now = input.now ?? Date.now()
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(roomId)) {
        throw new Error('RoomSession ID 格式非法')
      }
      if (!/^[A-Za-z0-9_.:@-]{1,128}$/.test(userId)) {
        throw new Error('邀请用户 ID 格式非法')
      }
      if (!displayName || displayName.length > 128) {
        throw new Error('邀请用户显示名非法')
      }
      if (input.expiresAt !== undefined && input.expiresAt <= now) {
        throw new Error('邀请令牌过期时间必须晚于当前时间')
      }

      const tokenId = randomBytes(12).toString('hex')
      const secret = randomBytes(32).toString('base64url')
      const token = 'frt1.' + tokenId + '.' + secret
      const record: PersistedInviteToken = {
        tokenId,
        tokenHash: hash(secret),
        roomId,
        userId,
        displayName,
        createdAt: now,
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      }
      const config = this.read()
      config.tokens[tokenId] = record
      this.write(config)
      return {
        token,
        tokenId,
        roomId,
        userId,
        displayName,
        createdAt: now,
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      }
    })
  }
  authenticate(rawToken: string | undefined, now = Date.now()): FusionRoomPrincipal | undefined {
    const parsed = parseToken(rawToken)
    if (!parsed) return undefined
    const record = this.read().tokens[parsed.tokenId]
    if (!record || record.revokedAt !== undefined) return undefined
    if (record.expiresAt !== undefined && record.expiresAt <= now) return undefined
    const expected = Buffer.from(record.tokenHash, 'hex')
    const actual = Buffer.from(hash(parsed.secret), 'hex')
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined
    return {
      userId: record.userId,
      kind: 'user',
      roomId: record.roomId,
    }
  }

  revoke(tokenId: string, now = Date.now()): boolean {
    return this.withWriteLock(() => {
      const config = this.read()
      const record = config.tokens[tokenId]
      if (!record || record.revokedAt !== undefined) return false
      record.revokedAt = now
      this.write(config)
      return true
    })
  }
  revokeRoom(roomId: string, now = Date.now()): number {
    return this.withWriteLock(() => {
      const config = this.read()
      let revoked = 0
      for (const record of Object.values(config.tokens)) {
        if (record.roomId !== roomId || record.revokedAt !== undefined) continue
        record.revokedAt = now
        revoked += 1
      }
      if (revoked > 0) this.write(config)
      return revoked
    })
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
          /* another writer is creating/releasing the lock */
        }
        throw new Error('邀请令牌存储正被其他进程更新，请稍后重试')
      }
    }
    if (!acquired) throw new Error('邀请令牌存储锁定失败')
    try {
      return operation()
    } finally {
      try { rmdirSync(lockPath) } catch { /* stale cleanup remains safe */ }
    }
  }
  private read(): InviteTokenConfig {
    const parsed = readJsonSafe<Partial<InviteTokenConfig> | null>(this.path, null)
    if (!parsed || parsed.version !== 1 || !parsed.tokens) {
      return { version: 1, tokens: {} }
    }
    return {
      version: 1,
      tokens: parsed.tokens,
    }
  }

  private write(config: InviteTokenConfig): void {
    writeJsonAtomic(this.path, config)
  }
}

export function createFusionRoomInviteAuthenticator(options: {
  store: FileFusionRoomInviteTokenStore
  fallback?: (request: IncomingMessage) => FusionRoomPrincipal | undefined
}): (request: IncomingMessage) => FusionRoomPrincipal | undefined {
  return (request) => {
    const rawHeader = request.headers['x-fusion-invite-token']
    const authorization = request.headers.authorization
    const rawToken =
      typeof rawHeader === 'string'
        ? rawHeader
        : typeof authorization === 'string' && authorization.startsWith('Bearer ')
          ? authorization.slice('Bearer '.length).trim()
          : undefined
    if (rawToken !== undefined) return options.store.authenticate(rawToken)
    return options.fallback?.(request)
  }
}
function parseToken(value: string | undefined): { tokenId: string; secret: string } | undefined {
  if (!value || value.length > 512) return undefined
  const parts = value.split('.')
  if (parts.length !== 3 || parts[0] !== 'frt1' || !parts[1] || !parts[2]) return undefined
  if (!/^[a-f0-9]{24}$/.test(parts[1])) return undefined
  return { tokenId: parts[1], secret: parts[2] }
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
