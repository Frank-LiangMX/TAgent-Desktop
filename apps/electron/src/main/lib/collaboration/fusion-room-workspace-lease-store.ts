import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getCollaborationRoomWorkspaceDir } from "../config/config-paths";

const LEASE_DIR = ".tagent-leases";
const MUTEX_DIR = ".registry-mutex";
const DEFAULT_LEASE_MS = 60_000;
const MUTEX_STALE_MS = 60_000;
const MAX_LEASE_MS = 24 * 60 * 60 * 1000;

export type WorkspaceLeaseScope = "workspace" | string;

export interface WorkspaceLease {
  token: string;
  roomId: string;
  scopes: string[];
  expiresAt: number;
  release(): void;
}

export interface WorkspaceLeaseStoreOptions {
  rootForRoom?: (roomId: string) => string;
  now?: () => number;
  leaseMs?: number;
}

/**
 * Small persistent lease registry for local RoomWorkspace mutations.
 *
 * The registry is deliberately independent from the room JSON projection. A
 * crashed process can leave a lease behind, so leases expire and are removed
 * only while holding the atomic registry mutex. `workspace` is a coarse lease
 * used for shell commands; file operations use canonical relative paths.
 */
export class FileFusionRoomWorkspaceLeaseStore {
  private readonly rootForRoom: (roomId: string) => string;
  private readonly now: () => number;
  private readonly leaseMs: number;

  constructor(options: WorkspaceLeaseStoreOptions = {}) {
    this.rootForRoom = options.rootForRoom ?? getCollaborationRoomWorkspaceDir;
    this.now = options.now ?? Date.now;
    this.leaseMs = Math.max(1_000, options.leaseMs ?? DEFAULT_LEASE_MS);
  }

  acquire(
    roomId: string,
    scopes: WorkspaceLeaseScope[],
    owner: string,
    options: { leaseMs?: number } = {},
  ): WorkspaceLease | undefined {
    const normalized = [
      ...new Set(
        scopes
          .map((scope) => (scope === "workspace" ? "workspace" : scope.trim()))
          .filter(Boolean),
      ),
    ].sort();
    if (normalized.length === 0) return undefined;
    const root = this.rootForRoom(roomId);
    const leaseDir = join(root, "audit", LEASE_DIR);
    const mutexDir = join(leaseDir, MUTEX_DIR);
    mkdirSync(leaseDir, { recursive: true });
    if (!this.acquireMutex(mutexDir)) return undefined;
    try {
      const now = this.now();
      for (const name of this.listLeaseFiles(leaseDir)) {
        const path = join(leaseDir, name);
        const existing = this.readLease(path);
        if (!existing) {
          try {
            unlinkSync(path);
          } catch {
            /* stale/corrupt entry */
          }
          continue;
        }
        if (existing.expiresAt <= now) {
          try {
            unlinkSync(path);
          } catch {
            /* another process reclaimed it */
          }
          continue;
        }
        if (scopesConflict(normalized, existing.scopes)) return undefined;
      }
      const token = `wlease_${randomUUID()}`;
      const leaseMs = Math.min(
        MAX_LEASE_MS,
        Math.max(1_000, options.leaseMs ?? this.leaseMs),
      );
      const expiresAt = now + leaseMs;
      const file = join(leaseDir, `${hashLeaseToken(token)}.json`);
      writeFileSync(
        file,
        JSON.stringify({
          token,
          roomId,
          scopes: normalized,
          owner: owner.slice(0, 160),
          acquiredAt: now,
          expiresAt,
        }),
        { encoding: "utf8", flag: "wx" },
      );
      let released = false;
      return {
        token,
        roomId,
        scopes: normalized,
        expiresAt,
        release: () => {
          if (released) return;
          released = true;
          try {
            if (this.readLease(file)?.token === token) unlinkSync(file);
          } catch {
            /* best effort cleanup; expiry remains the recovery boundary */
          }
        },
      };
    } finally {
      this.releaseMutex(mutexDir);
    }
  }

  private listLeaseFiles(dir: string): string[] {
    try {
      return readdirSync(dir).filter((name: string) => name.endsWith(".json"));
    } catch {
      return [];
    }
  }

  private readLease(
    path: string,
  ):
    | { token: string; roomId: string; scopes: string[]; expiresAt: number }
    | undefined {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as {
        token?: unknown;
        roomId?: unknown;
        scopes?: unknown;
        expiresAt?: unknown;
      };
      if (
        typeof parsed.token !== "string" ||
        typeof parsed.roomId !== "string" ||
        !Array.isArray(parsed.scopes) ||
        typeof parsed.expiresAt !== "number"
      )
        return undefined;
      return {
        token: parsed.token,
        roomId: parsed.roomId,
        scopes: parsed.scopes.filter(
          (item): item is string => typeof item === "string",
        ),
        expiresAt: parsed.expiresAt,
      };
    } catch {
      return undefined;
    }
  }

  private acquireMutex(path: string): boolean {
    try {
      mkdirSync(path);
      writeFileSync(join(path, "owner"), `${process.pid}:${this.now()}`, {
        encoding: "utf8",
        flag: "wx",
      });
      return true;
    } catch {
      let reclaimed = false;
      try {
        if (
          existsSync(path) &&
          this.now() - statSync(path).mtimeMs > MUTEX_STALE_MS
        ) {
          try {
            unlinkSync(join(path, "owner"));
          } catch {
            /* stale mutex may have no owner marker */
          }
          rmdirSync(path);
          reclaimed = true;
        }
      } catch {
        /* active owner or another process won the race */
      }
      if (reclaimed) {
        try {
          mkdirSync(path);
          writeFileSync(join(path, "owner"), `${process.pid}:${this.now()}`, {
            encoding: "utf8",
            flag: "wx",
          });
          return true;
        } catch {
          /* another process won the reclaimed mutex */
        }
      }
      return false;
    }
  }

  private releaseMutex(path: string): void {
    try {
      unlinkSync(join(path, "owner"));
    } catch {
      /* noop */
    }
    try {
      rmdirSync(path);
    } catch {
      /* another process reclaimed it */
    }
  }
}

function hashLeaseToken(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 32);
}

function scopesConflict(left: string[], right: string[]): boolean {
  if (left.includes("workspace") || right.includes("workspace")) return true;
  return left.some((scope) => right.includes(scope));
}
