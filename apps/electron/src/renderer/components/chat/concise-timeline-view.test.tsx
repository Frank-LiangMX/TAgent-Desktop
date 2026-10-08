// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'

vi.mock('@tagent/ui', () => {
  const Passthrough = ({ children }: { children?: ReactNode }) => <div>{children}</div>
  return {
    Message: Passthrough,
    MessageContent: Passthrough,
    MessageResponse: Passthrough,
    UserMessageContent: Passthrough,
    useSmoothStream: ({ content }: { content: string }) => ({ displayedContent: content }),
  }
})

import { ConciseTimelineView } from './ConciseTimelineView'
import type { ConciseSegment, ToolProcessEntry } from './concise-timeline-model'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
    root = undefined
  }
  container?.remove()
  container = undefined
})

function pendingTool(key: string): ToolProcessEntry {
  return {
    type: 'tool',
    key,
    tool: { type: 'tool_use', id: key, name: 'Read', input: { file_path: `${key}.ts` } },
  }
}

function workStage(key: string): Extract<ConciseSegment, { kind: 'work_stage' }> {
  const tool = pendingTool(`${key}-tool`)
  return {
    kind: 'work_stage',
    key,
    tools: [tool],
    steps: [{ kind: 'tool', key: tool.key, tool }],
    summary: `${key} 阶段`,
  }
}

function mount(segments: ConciseSegment[]): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(<ConciseTimelineView segments={segments} isLive workedMs={1000} />)
  })
}

function update(segments: ConciseSegment[]): void {
  act(() => {
    root?.render(<ConciseTimelineView segments={segments} isLive workedMs={2000} />)
  })
}

function stageStatus(stage: Element): HTMLSpanElement | null {
  return stage.querySelector('.agent-concise-live-status span')
}

describe('ConciseTimelineView stage shimmer ownership', () => {
  test('只有唯一的 live 阶段显示扫光', () => {
    mount([workStage('only')])

    const stages = container?.querySelectorAll('.agent-concise-stage')
    expect(stages).toHaveLength(1)
    expect(stageStatus(stages![0]!)?.classList.contains('agent-concise-shimmer')).toBe(true)
  })

  test('引导后新阶段开始时，旧阶段在折叠和展开态都保持静态', () => {
    const beforeGuidance = workStage('before')
    mount([beforeGuidance])
    expect(
      stageStatus(container!.querySelector('.agent-concise-stage')!)?.classList.contains(
        'agent-concise-shimmer',
      ),
    ).toBe(true)

    const afterGuidance = workStage('after')
    update([
      beforeGuidance,
      { kind: 'guidance', key: 'guidance', text: '请继续处理。' },
      afterGuidance,
    ])

    const stages = container!.querySelectorAll('.agent-concise-stage')
    expect(stages).toHaveLength(2)
    expect(stageStatus(stages[0]!)?.classList.contains('agent-concise-shimmer')).toBe(false)
    expect(stageStatus(stages[1]!)?.classList.contains('agent-concise-shimmer')).toBe(true)

    const heads = container!.querySelectorAll<HTMLButtonElement>(
      '.agent-concise-stage > .agent-concise-fold__head',
    )
    act(() => heads[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    act(() => heads[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    const expandedStages = container!.querySelectorAll('.agent-concise-stage')
    expect(
      expandedStages[0]!.querySelector('.agent-concise-stage__panel')?.classList.contains(
        'is-open',
      ),
    ).toBe(true)
    expect(
      expandedStages[1]!.querySelector('.agent-concise-stage__panel')?.classList.contains(
        'is-open',
      ),
    ).toBe(true)
    expect(expandedStages[0]!.querySelectorAll('.agent-concise-shimmer')).toHaveLength(0)
    expect(expandedStages[1]!.querySelectorAll('.agent-concise-shimmer')).toHaveLength(1)
  })
})
