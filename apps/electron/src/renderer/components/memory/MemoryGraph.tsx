/**
 * MemoryGraph — d3-force 轻量图谱（增强）
 */
import * as React from 'react'
import { forceCenter, forceLink, forceManyBody, forceSimulation, type SimulationNodeDatum } from 'd3-force'
import { GitBranch, Loader2 } from 'lucide-react'
import type { GraphEdge, GraphNode, GraphPayload } from '@tagent/shared'
import { cn } from '../../lib/utils'

interface MemoryGraphProps {
  mode: 'general' | 'ta'
}

interface SimNode extends SimulationNodeDatum {
  id: string
  title: string
  kind: GraphNode['kind']
  source?: GraphNode['source']
  r: number
}

export function MemoryGraph({ mode }: MemoryGraphProps): React.ReactElement {
  const [payload, setPayload] = React.useState<GraphPayload | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [positions, setPositions] = React.useState<SimNode[]>([])
  const svgRef = React.useRef<SVGSVGElement>(null)

  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    void window.electronAPI
      .getGraphData(mode)
      .then((data) => {
        if (!cancelled) setPayload(data as GraphPayload)
      })
      .catch(() => {
        if (!cancelled) {
          setPayload({ nodes: [], edges: [], stats: { memoryNodes: 0, skillNodes: 0, edges: 0 } })
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [mode])

  React.useEffect(() => {
    if (!payload?.nodes.length) {
      setPositions([])
      return
    }
    const width = 640
    const height = 360
    const nodes: SimNode[] = payload.nodes.map((n) => ({
      id: n.id,
      title: n.title,
      kind: n.kind,
      source: n.source,
      r: n.kind === 'memory' ? 10 : 8,
    }))
    const idSet = new Set(nodes.map((n) => n.id))
    const links = payload.edges
      .filter((e) => idSet.has(e.source) && idSet.has(e.target))
      .map((e) => ({ source: e.source, target: e.target }))

    const sim = forceSimulation(nodes)
      .force(
        'link',
        forceLink(links)
          .id((d) => (d as SimNode).id)
          .distance(48)
          .strength(0.4),
      )
      .force('charge', forceManyBody().strength(-120))
      .force('center', forceCenter(width / 2, height / 2))
      .stop()

    for (let i = 0; i < 120; i++) sim.tick()
    setPositions([...nodes])
    return () => {
      sim.stop()
    }
  }, [payload])

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        加载图谱…
      </div>
    )
  }

  if (!payload?.nodes.length) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2 text-muted-foreground">
        <GitBranch className="size-8 opacity-40" strokeWidth={1.5} />
        <p className="text-sm">暂无图谱节点</p>
        <p className="text-xs opacity-70">写入 L0/L2/L5 或产生 L4 会话后刷新</p>
      </div>
    )
  }

  const width = 640
  const height = 360
  const byId = new Map(positions.map((n) => [n.id, n]))
  const edges: GraphEdge[] = payload.edges

  return (
    <div className="overflow-hidden rounded-xl border border-border/40 bg-background/20">
      <div className="flex items-center justify-between px-3 py-2 text-[11px] text-muted-foreground">
        <span>
          记忆 {payload.stats.memoryNodes} · 会话 {payload.stats.skillNodes} · 边 {payload.stats.edges}
        </span>
      </div>
      <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} className="h-[360px] w-full">
        {edges.map((e, i) => {
          const s = byId.get(e.source)
          const t = byId.get(e.target)
          if (!s || !t || s.x == null || s.y == null || t.x == null || t.y == null) return null
          return (
            <line
              key={`${e.source}-${e.target}-${i}`}
              x1={s.x}
              y1={s.y}
              x2={t.x}
              y2={t.y}
              className="stroke-border/60"
              strokeWidth={1}
            />
          )
        })}
        {positions.map((n) => {
          if (n.x == null || n.y == null) return null
          const fill =
            n.source === 'L0'
              ? 'fill-sky-500/80'
              : n.source === 'L2'
                ? 'fill-emerald-500/80'
                : n.source === 'L5'
                  ? 'fill-violet-500/80'
                  : 'fill-amber-500/70'
          return (
            <g key={n.id} transform={`translate(${n.x},${n.y})`}>
              <circle r={n.r} className={cn(fill, 'stroke-background stroke-2')} />
              <title>{n.title}</title>
              <text
                y={n.r + 10}
                textAnchor="middle"
                className="fill-muted-foreground text-[9px]"
              >
                {n.title.slice(0, 12)}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}
