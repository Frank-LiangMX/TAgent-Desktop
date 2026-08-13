/**
 * Memory Graph 装配（增强）
 *
 * 从 L0/L2/L5 md 行 + L4 近期会话标题构造轻量图（无需 d3 布局数据外的依赖）。
 * 节点：记忆条目 / 会话；边：共现弱关联（同层相邻 + 会话→提及关键词）。
 */
import type { GraphEdge, GraphNode, GraphPayload } from '@tagent/shared'
import { memoryLayerService, type MemoryMode } from './memory-layer-service'

function parseBulletLines(md: string | null): string[] {
  if (!md) return []
  return md
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- ') || l.startsWith('* '))
    .map((l) => l.replace(/^[-*]\s+/, '').replace(/<!--.*?-->/g, '').trim())
    .filter((l) => l.length > 2)
    .slice(0, 40)
}

function nodeId(prefix: string, i: number, text: string): string {
  const slug = text.slice(0, 24).replace(/\s+/g, '_')
  return `${prefix}-${i}-${slug}`
}

export function buildGraphPayload(mode: MemoryMode, _workspaceSlug?: string): GraphPayload {
  const l0 = parseBulletLines(memoryLayerService.getMdContent(mode, 'L0'))
  const l2 = parseBulletLines(memoryLayerService.getMdContent(mode, 'L2'))
  const l5 = parseBulletLines(memoryLayerService.getMdContent(mode, 'L5'))
  const sessions = memoryLayerService.listRecentSessions(mode, 12)

  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []

  const addMem = (source: 'L0' | 'L2' | 'L5', lines: string[]): void => {
    lines.forEach((text, i) => {
      nodes.push({
        id: nodeId(source, i, text),
        kind: 'memory',
        shape: source === 'L5' ? 'diamond' : 'circle',
        source,
        title: text.slice(0, 40),
        content: text,
        timestamp: Date.now() - i * 1000,
      })
    })
  }
  addMem('L0', l0)
  addMem('L2', l2)
  addMem('L5', l5)

  for (const s of sessions) {
    const id = `sess-${s.id}`
    nodes.push({
      id,
      kind: 'session',
      shape: 'circle',
      title: (s.title || `会话 ${s.id}`).slice(0, 40),
      content: s.summary || '',
      timestamp: s.created_at ?? Date.now(),
    })
    // 弱关联：摘要命中记忆关键词则连边
    const hay = `${s.title}\n${s.summary}`.toLowerCase()
    for (const n of nodes) {
      if (n.kind !== 'memory') continue
      const key = n.title.slice(0, 8).toLowerCase()
      if (key.length >= 2 && hay.includes(key)) {
        edges.push({ source: id, target: n.id, type: 'memory-session', weight: 1 })
      }
    }
  }

  // 同层相邻边（串成链，便于可视化）
  const bySource = (src: string): GraphNode[] => nodes.filter((n) => n.source === src)
  for (const layer of ['L0', 'L2', 'L5'] as const) {
    const list = bySource(layer)
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i]
      const b = list[i + 1]
      if (a && b) edges.push({ source: a.id, target: b.id, type: 'memory-memory', weight: 0.5 })
    }
  }

  return {
    nodes,
    edges,
    stats: {
      memoryNodes: nodes.filter((n) => n.kind === 'memory').length,
      sessionNodes: nodes.filter((n) => n.kind === 'session').length,
      edges: edges.length,
    },
  }
}
