/**
 * 会话生命状态（Jotai）
 *
 * 跨组件共享：SessionSidebar（状态色点）+ onStreamEvent 订阅（写入）。
 * 状态来源：
 *   - error / archived：来自 listSessions 落盘的 meta（重启保留）
 *   - running：主进程 runtimes 内存，挂载/刷新时批量 getSessionStatus 拉取（不落盘）
 *   - done：仅渲染层；turn_end 后绿点，离开会话页 acknowledge → idle（不落盘）
 * 实时更新：onStreamEvent turn_end → done、session_error → error。
 * 用 Jotai 默认 store（无需 Provider），与项目约定一致。
 */
import { atom } from 'jotai'

/** 会话生命状态（侧栏色点用；running/done 是瞬时态，不持久化） */
export type SessionStatus = 'idle' | 'running' | 'error' | 'done'

/** 单会话状态条目 */
export interface SessionStatusEntry {
  status: SessionStatus
  archived: boolean
}

/**
 * 会话状态表：sessionId → { status, archived }。
 * 渲染层据此派生状态色点 + 归档分流。
 */
export const sessionStatusMapAtom = atom<Record<string, SessionStatusEntry>>({})

/** 派生：某会话的状态条目（未设置时 undefined，调用方按 idle 处理） */
export const sessionStatusAtom = (id: string) =>
  atom((get) => get(sessionStatusMapAtom)[id])

/**
 * 初始化会话状态表（write-only）。
 * @param sessions  listSessions 返回的会话（含 archived / status:'error' 落盘值）
 * 流程：先从 meta 填 idle/error + archived（已落盘，免 IPC），再批量 getSessionStatus 补 running。
 */
export const initSessionStatusAtom = atom(
  null,
  async (get, set, sessions: { id: string; archived?: boolean; status?: SessionStatus }[]) => {
    // 先用落盘值填（archived 一定来自 meta；status 仅 error 会落盘，其余按 idle）
    const map: Record<string, SessionStatusEntry> = { ...get(sessionStatusMapAtom) }
    for (const s of sessions) {
      map[s.id] = {
        status: s.status === 'error' ? 'error' : 'idle',
        archived: !!s.archived,
      }
    }
    set(sessionStatusMapAtom, map)

    // 批量补 running（runtimes 内存态，落盘值无）。并行查询，会话量级 ~45 可接受。
    const results = await Promise.all(
      sessions.map((s) =>
        window.electronAPI
          .getSessionStatus(s.id)
          .then((r) => ({ id: s.id, r }))
          .catch(() => ({ id: s.id, r: undefined }))
      )
    )
    const next: Record<string, SessionStatusEntry> = { ...get(sessionStatusMapAtom) }
    for (const { id, r } of results) {
      if (r) next[id] = { status: r.status, archived: r.archived }
    }
    set(sessionStatusMapAtom, next)
  }
)

/**
 * 单点更新会话状态（write-only，来自 onStreamEvent）。
 * turn_end → done、session_error → error。保留原有 archived。
 */
export const setSessionStatusAtom = atom(
  null,
  (get, set, payload: { id: string; status: SessionStatus }) => {
    const map = { ...get(sessionStatusMapAtom) }
    const prev = map[payload.id]
    map[payload.id] = { status: payload.status, archived: prev?.archived ?? false }
    set(sessionStatusMapAtom, map)
  }
)

/**
 * 确认/清除会话绿点（write-only）。
 * 仅 done → idle；running / error 不动（离开会话页时由 App 调用）。
 */
export const acknowledgeSessionStatusAtom = atom(null, (get, set, id: string) => {
  const map = { ...get(sessionStatusMapAtom) }
  const prev = map[id]
  if (!prev || prev.status !== 'done') return
  map[id] = { status: 'idle', archived: prev.archived }
  set(sessionStatusMapAtom, map)
})

/** 单点更新归档态（write-only，归档切换后调）。保留原有 status。 */
export const setSessionArchivedAtom = atom(
  null,
  (get, set, payload: { id: string; archived: boolean }) => {
    const map = { ...get(sessionStatusMapAtom) }
    const prev = map[payload.id]
    map[payload.id] = { status: prev?.status ?? 'idle', archived: payload.archived }
    set(sessionStatusMapAtom, map)
  }
)
