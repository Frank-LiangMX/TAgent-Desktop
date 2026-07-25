/**
 * 会话列表侧栏（最小自写，不搬 TAgent LeftSidebar 体系）
 *
 * 功能：列会话 + 点开加载历史 + 新建会话 + 删除。
 * 后续可替换为 TAgent 外壳（原样），但当前最小够用。
 */
import { useState, useEffect } from 'react'

interface SessionMeta {
  id: string
  title: string
  modelId?: string
  createdAt?: number
  updatedAt?: number
}

export function SessionSidebar({
  activeSessionId,
  onSelect,
  onNew,
}: {
  activeSessionId: string | null
  onSelect: (session: SessionMeta) => void
  onNew: () => void
}): JSX.Element {
  const [sessions, setSessions] = useState<SessionMeta[]>([])

  const refresh = async (): Promise<void> => {
    const list = (await window.electronAPI.listSessions()) as SessionMeta[] | undefined
    const arr = Array.isArray(list) ? list : []
    setSessions(arr.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)))
  }

  useEffect(() => {
    void refresh()
  }, [activeSessionId])

  const onDelete = async (id: string, e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
    if (!confirm('删除该会话？历史消息将一并清除。')) return
    await window.electronAPI.deleteSession(id)
    void refresh()
  }

  return (
    <div
      style={{
        width: 220,
        borderRight: '1px solid #eee',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
      }}
    >
      <div style={{ padding: 12, borderBottom: '1px solid #eee' }}>
        <button onClick={onNew} style={{ width: '100%', padding: 8 }}>
          + 新建会话
        </button>
      </div>
      <div style={{ flex: 1, overflow: 'auto' }}>
        {sessions.length === 0 && (
          <div style={{ padding: 12, color: '#999', fontSize: 12 }}>暂无会话</div>
        )}
        {sessions.map((s) => (
          <div
            key={s.id}
            onClick={() => onSelect(s)}
            style={{
              padding: '8px 12px',
              cursor: 'pointer',
              background: s.id === activeSessionId ? '#e6f0ff' : 'transparent',
              borderBottom: '1px solid #f0f0f0',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <div style={{ flex: 1, overflow: 'hidden' }}>
              <div style={{ fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {s.title}
              </div>
              <div style={{ fontSize: 11, color: '#999' }}>{s.modelId ?? ''}</div>
            </div>
            <button
              onClick={(e) => void onDelete(s.id, e)}
              style={{ marginLeft: 8, fontSize: 11, color: '#c00', background: 'none', border: 'none', cursor: 'pointer' }}
            >
              删
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
