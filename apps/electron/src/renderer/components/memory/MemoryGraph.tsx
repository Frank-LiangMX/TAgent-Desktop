/**
 * MemoryGraph — 记忆图谱占位（Phase 2.3）
 * learning-graph-service 未移植前 GET_GRAPH_DATA 返回空图，展示友好空态。
 */
import * as React from 'react'
import { GitBranch } from 'lucide-react'
import type { GraphPayload } from '@tagent/shared'

interface MemoryGraphProps {
  mode: 'general' | 'ta'
}

export function MemoryGraph({ mode }: MemoryGraphProps): React.ReactElement {
  const [payload, setPayload] = React.useState<GraphPayload | null>(null)
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    void window.electronAPI
      .getGraphData(mode)
      .then((data) => {
        if (!cancelled) setPayload(data as GraphPayload)
      })
      .catch(() => {
        if (!cancelled) setPayload({ nodes: [], edges: [], stats: { memoryNodes: 0, skillNodes: 0, edges: 0 } })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [mode])

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
        加载图谱…
      </div>
    )
  }

  const n = payload?.nodes?.length ?? 0
  if (n === 0) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2 text-muted-foreground">
        <GitBranch className="size-8 opacity-40" strokeWidth={1.5} />
        <p className="text-sm">图谱数据尚未接入</p>
        <p className="text-xs opacity-70">learning-graph 移植后将显示 L0/L2/L5 关联</p>
      </div>
    )
  }

  return (
    <div className="p-4 text-sm text-muted-foreground">
      节点 {payload?.stats.memoryNodes ?? 0} · 边 {payload?.stats.edges ?? 0}
    </div>
  )
}
