/**
 * MemoryGraph - Memory Graph 可视化（P3-MG.2，借鉴 hermes star-map.tsx）
 *
 * d3-force + Canvas radial timeline 渲染。
 * 节点：memory=菱形(diamond)，session=圆形(circle)。
 * ring 按 day/week/month 桶分组（旧=内核，新=外环）。
 *
 * 详见 docs/plans/2026-07-06-silent-memory-research/TAgent_Memory_Master_Design.md §8.5
 */

import * as React from 'react'
import { forceSimulation, forceRadial, forceCollide, forceLink } from 'd3-force'
import { scaleLinear } from 'd3-scale'

import type { GraphNode, GraphEdge, GraphPayload } from '@tagent/shared'

// ===== 类型 =====

interface MemoryGraphProps {
  mode: 'general' | 'ta'
  workspaceSlug?: string
  onNodeClick?: (node: GraphNode) => void
}

/** d3 simulation 节点（扩展 GraphNode 加 d3 布局属性） */
interface SimNode extends GraphNode {
  x?: number
  y?: number
  vx?: number
  vy?: number
  fx?: number | null
  fy?: number | null
}

/** d3 simulation 边 */
interface SimEdge {
  source: string | SimNode
  target: string | SimNode
  type: 'memory-memory' | 'memory-session'
  weight?: number
}

// ===== 颜色常量 =====

const COLORS = {
  memory: {
    L0: '#f472b6', // pink-400
    L2: '#60a5fa', // blue-400
    L5: '#a78bfa', // violet-400
  },
  session: '#34d399', // emerald-400
  edge: 'rgba(148, 163, 184, 0.3)', // slate-400/30
  edgeHover: 'rgba(148, 163, 184, 0.7)', // slate-400/70
  background: 'transparent',
  text: '#94a3b8', // slate-400
  highlight: '#fbbf24', // amber-400
}

// ===== 组件 =====

export function MemoryGraph({
  mode,
  workspaceSlug,
  onNodeClick,
}: MemoryGraphProps): React.ReactElement {
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const containerRef = React.useRef<HTMLDivElement>(null)
  const [payload, setPayload] = React.useState<GraphPayload | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [hoveredNode, setHoveredNode] = React.useState<SimNode | null>(null)
  const [selectedNode, setSelectedNode] = React.useState<SimNode | null>(null)

  // simulation ref（跨 render 保持）
  const simRef = React.useRef<ReturnType<typeof forceSimulation<SimNode>> | null>(null)
  const nodesRef = React.useRef<SimNode[]>([])
  const edgesRef = React.useRef<SimEdge[]>([])

  // 变换状态（缩放 + 平移）
  const transformRef = React.useRef({ x: 0, y: 0, scale: 1 })
  const isDragging = React.useRef(false)
  const dragStart = React.useRef({ x: 0, y: 0 })
  /** 空白按下后是否发生过有效拖移；无拖移则 mouseup 清空选中 */
  const dragMoved = React.useRef(false)

  // 响应式 canvas 尺寸（初始 null，等 ResizeObserver 返回实际尺寸后再渲染）
  const [canvasSize, setCanvasSize] = React.useState<{ width: number; height: number } | null>(null)

  React.useEffect(() => {
    if (!containerRef.current) return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        if (width > 0 && height > 0) {
          setCanvasSize({ width: Math.floor(width), height: Math.floor(height) })
        }
      }
    })
    observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [])

  // 加载数据
  React.useEffect(() => {
    setLoading(true)
    setError(null)
    window.electronAPI
      .getGraphData(mode, workspaceSlug)
      .then((data) => {
        setPayload(data)
        setLoading(false)
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      })
  }, [mode, workspaceSlug])

  // 构建 simulation（payload 和 canvasSize 都就绪后才启动）
  React.useEffect(() => {
    if (!payload || !canvasSize) return
    if (!canvasRef.current) return
    const canvas = canvasRef.current
    const width = canvasSize.width
    const height = canvasSize.height
    const centerX = width / 2
    const centerY = height / 2

    // 计算时间轴 ring 位置
    const timestamps = payload.nodes.map((n) => n.timestamp)
    const minTime = Math.min(...timestamps)
    const maxTime = Math.max(...timestamps)
    const timeScale = scaleLinear()
      .domain([minTime, maxTime])
      .range([50, Math.min(width, height) * 0.4])

    // 初始化节点位置（按时间轴 ring）
    const simNodes: SimNode[] = payload.nodes.map((node) => ({
      ...node,
      x: centerX + (Math.random() - 0.5) * 100,
      y: centerY + (Math.random() - 0.5) * 100,
    }))

    const simEdges: SimEdge[] = payload.edges.map((e) => ({
      source: e.source,
      target: e.target,
      type: e.type,
      weight: e.weight,
    }))

    nodesRef.current = simNodes
    edgesRef.current = simEdges

    // d3-force simulation
    const simulation = forceSimulation<SimNode>(simNodes)
      .force(
        'radial',
        forceRadial((d) => timeScale((d as SimNode).timestamp), centerX, centerY).strength(0.8)
      )
      .force('collide', forceCollide<SimNode>(20).strength(0.5))
      .force(
        'link',
        forceLink<SimNode, SimEdge>(simEdges)
          .id((d) => d.id)
          .distance(80)
          .strength(0.3)
      )
      .alphaDecay(0.02)
      .on('tick', () => {
        drawCanvas(canvas, simNodes, simEdges, hoveredNode, selectedNode, transformRef.current)
      })

    simRef.current = simulation

    return () => {
      simulation.stop()
    }
  }, [payload, canvasSize])

  // 重绘（hover/selection 变化时）
  React.useEffect(() => {
    if (!canvasRef.current) return
    drawCanvas(
      canvasRef.current,
      nodesRef.current,
      edgesRef.current,
      hoveredNode,
      selectedNode,
      transformRef.current
    )
  }, [hoveredNode, selectedNode])

  // 事件处理
  const getNodeAtPoint = React.useCallback((clientX: number, clientY: number): SimNode | null => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    const t = transformRef.current

    // CSS 尺寸 → canvas 像素坐标（考虑 CSS 尺寸和 canvas.width/height 不一致）
    const canvasX = ((clientX - rect.left) / rect.width) * canvas.width
    const canvasY = ((clientY - rect.top) / rect.height) * canvas.height

    // 逆 transform：canvas 像素 → 逻辑坐标
    const x = (canvasX - t.x) / t.scale
    const y = (canvasY - t.y) / t.scale

    for (const node of nodesRef.current) {
      const nx = node.x ?? 0
      const ny = node.y ?? 0
      const dist = Math.sqrt((x - nx) ** 2 + (y - ny) ** 2)
      if (dist < 15 / t.scale) return node // hit test 半径随缩放调整
    }
    return null
  }, [])

  const handleMouseMove = React.useCallback(
    (e: React.MouseEvent) => {
      if (isDragging.current) {
        const dx = e.clientX - dragStart.current.x
        const dy = e.clientY - dragStart.current.y
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
          dragMoved.current = true
        }
        transformRef.current.x += dx
        transformRef.current.y += dy
        dragStart.current = { x: e.clientX, y: e.clientY }
        if (canvasRef.current) {
          drawCanvas(
            canvasRef.current,
            nodesRef.current,
            edgesRef.current,
            hoveredNode,
            selectedNode,
            transformRef.current
          )
        }
        return
      }
      const node = getNodeAtPoint(e.clientX, e.clientY)
      setHoveredNode(node)
    },
    [getNodeAtPoint, hoveredNode, selectedNode]
  )

  const handleMouseDown = React.useCallback(
    (e: React.MouseEvent) => {
      const node = getNodeAtPoint(e.clientX, e.clientY)
      if (node) {
        setSelectedNode(node)
        onNodeClick?.(node)
        isDragging.current = false
        dragMoved.current = false
      } else {
        // 空白：准备拖动画布；若未拖移则在 mouseup 清空选择
        isDragging.current = true
        dragMoved.current = false
        dragStart.current = { x: e.clientX, y: e.clientY }
      }
    },
    [getNodeAtPoint, onNodeClick]
  )

  const handleMouseUp = React.useCallback(() => {
    if (isDragging.current && !dragMoved.current) {
      setSelectedNode(null)
    }
    isDragging.current = false
    dragMoved.current = false
  }, [])

  const handleWheel = React.useCallback(
    (e: React.WheelEvent) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const t = transformRef.current

      const oldScale = t.scale
      const newScale = Math.max(0.3, Math.min(3, oldScale * (e.deltaY > 0 ? 0.9 : 1.1)))

      // 鼠标相对于 canvas 的位置（CSS 像素）
      const mouseX = e.clientX - rect.left
      const mouseY = e.clientY - rect.top

      // 调整 x/y，使鼠标所指的逻辑坐标点保持不动
      t.x = mouseX - (mouseX - t.x) * (newScale / oldScale)
      t.y = mouseY - (mouseY - t.y) * (newScale / oldScale)
      t.scale = newScale

      drawCanvas(canvas, nodesRef.current, edgesRef.current, hoveredNode, selectedNode, t)
    },
    [hoveredNode, selectedNode]
  )

  if (!canvasSize) {
    return (
      <div
        ref={containerRef}
        className="flex h-full w-full items-center justify-center text-xs text-muted-foreground"
      >
        初始化图表...
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        加载 Memory Graph...
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-red-500">{error}</div>
    )
  }

  if (!payload || payload.nodes.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
        <p>暂无记忆数据</p>
        <p className="text-[10px]">等待记忆积累后，Graph 将自动显示</p>
      </div>
    )
  }

  return (
    <div ref={containerRef} className="relative h-full w-full">
      <canvas
        ref={canvasRef}
        width={canvasSize.width}
        height={canvasSize.height}
        className="h-full w-full cursor-grab active:cursor-grabbing"
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
      />

      {/* 节点详情面板（选中时显示；内容限高 + 主题细滚动条） */}
      {selectedNode && (
        <div
          className="absolute bottom-4 right-4 w-72 max-w-[min(18rem,calc(100%-2rem))] rounded-glass-popover border border-border/40 bg-background/90 p-3 text-xs shadow-lg backdrop-blur-sm"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="mb-1 flex items-center gap-1.5">
            <span
              className="size-2 shrink-0 rounded-full"
              style={{
                backgroundColor:
                  selectedNode.kind === 'memory'
                    ? COLORS.memory[selectedNode.source ?? 'L2']
                    : COLORS.session,
              }}
            />
            <span className="md-text min-w-0 truncate font-medium">{selectedNode.title}</span>
          </div>
          <div className="md-text-faint text-[10px]">
            {selectedNode.kind === 'memory' ? selectedNode.source : '会话'}
          </div>
          <div className="md-text-variant mt-1.5 max-h-[min(160px,28vh)] overflow-y-auto overflow-x-hidden scrollbar-thin pr-1 text-[11px] leading-relaxed break-words">
            {selectedNode.content}
          </div>
          <div className="md-text-faint mt-1.5 text-[10px] tabular-nums">
            {new Date(selectedNode.timestamp).toLocaleDateString('zh-CN')}
          </div>
        </div>
      )}

      {/* 图例 */}
      <div className="absolute left-3 top-3 flex flex-col gap-1 rounded-md bg-background/70 px-2 py-1.5 text-[10px] text-muted-foreground backdrop-blur-sm">
        <div className="flex items-center gap-1.5">
          <span className="size-2 rotate-45" style={{ backgroundColor: COLORS.memory.L0 }} />
          <span>L0 用户画像</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="size-2 rotate-45" style={{ backgroundColor: COLORS.memory.L2 }} />
          <span>L2 稳定事实</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="size-2 rotate-45" style={{ backgroundColor: COLORS.memory.L5 }} />
          <span>L5 洞察</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="size-2 rounded-full" style={{ backgroundColor: COLORS.session }} />
          <span>会话</span>
        </div>
      </div>

      {/* 统计 */}
      <div className="absolute right-3 top-3 rounded-md bg-background/70 px-2 py-1.5 text-[10px] text-muted-foreground backdrop-blur-sm">
        {payload.stats.memoryNodes} 记忆 · {payload.stats.sessionNodes} 会话 · {payload.stats.edges}{' '}
        连接
      </div>
    </div>
  )
}

// ===== Canvas 绘制 =====

function drawCanvas(
  canvas: HTMLCanvasElement,
  nodes: SimNode[],
  edges: SimEdge[],
  hovered: SimNode | null,
  selected: SimNode | null,
  transform: { x: number; y: number; scale: number } = { x: 0, y: 0, scale: 1 }
): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const width = canvas.width
  const height = canvas.height

  ctx.clearRect(0, 0, width, height)

  // 应用 transform（缩放 + 平移）
  ctx.save()
  ctx.translate(transform.x, transform.y)
  ctx.scale(transform.scale, transform.scale)

  // 绘制边
  ctx.strokeStyle = COLORS.edge
  ctx.lineWidth = 1
  for (const edge of edges) {
    const src = typeof edge.source === 'object' ? edge.source : null
    const tgt = typeof edge.target === 'object' ? edge.target : null
    if (!src || !tgt) continue

    ctx.beginPath()
    ctx.moveTo(src.x ?? 0, src.y ?? 0)
    ctx.lineTo(tgt.x ?? 0, tgt.y ?? 0)
    ctx.stroke()
  }

  // 绘制节点
  for (const node of nodes) {
    const x = node.x ?? 0
    const y = node.y ?? 0
    const isHovered = hovered?.id === node.id
    const isSelected = selected?.id === node.id

    const color = node.kind === 'memory' ? COLORS.memory[node.source ?? 'L2'] : COLORS.session

    if (node.shape === 'diamond') {
      // 菱形（memory 节点）
      const size = isHovered || isSelected ? 10 : 8
      ctx.save()
      ctx.translate(x, y)
      ctx.rotate(Math.PI / 4)
      ctx.fillStyle = color
      ctx.fillRect(-size / 2, -size / 2, size, size)
      ctx.restore()

      if (isSelected) {
        ctx.strokeStyle = COLORS.highlight
        ctx.lineWidth = 2
        ctx.save()
        ctx.translate(x, y)
        ctx.rotate(Math.PI / 4)
        ctx.strokeRect(-size / 2 - 2, -size / 2 - 2, size + 4, size + 4)
        ctx.restore()
      }
    } else {
      // 圆形（skill 节点）
      const radius = isHovered || isSelected ? 8 : 6
      ctx.beginPath()
      ctx.arc(x, y, radius, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()

      if (isSelected) {
        ctx.strokeStyle = COLORS.highlight
        ctx.lineWidth = 2
        ctx.stroke()
      }
    }

    // hover 时显示标题
    if (isHovered) {
      ctx.fillStyle = COLORS.text
      ctx.font = '10px system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(node.title.slice(0, 20), x, y - 15)
    }
  }

  // 恢复 transform
  ctx.restore()
}
