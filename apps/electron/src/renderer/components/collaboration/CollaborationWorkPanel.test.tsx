// @vitest-environment jsdom
/**
 * 协作室工作面板组件单测（S5 室级任务/产物面板）。
 *
 * 遵循「不引入 @testing-library」约定：根级 react-dom/client + react act 自测。
 * 通过 vi.mock 把重型外部依赖（phosphor 图标 / @tagent/ui Tooltip / sonner toast）替换为
 * 轻桩，聚焦验证面板的渲染分组、关联展示、只读态、预览调用与「无关联」空态。
 *
 * 不触真实 IPC：window.electronAPI 用桩对象替换，断言调用入参与返回渲染。
 */
import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

// 桩：phosphor 图标 → 空组件（显式列出面板用到的图标，避免 Proxy 命名空间导致模块加载卡死）
vi.mock('@phosphor-icons/react', () => {
  const Stub = (): null => null
  return {
    ArrowClockwise: Stub,
    CaretDown: Stub,
    CaretRight: Stub,
    Eye: Stub,
    FileText: Stub,
    PencilSimple: Stub,
    Plus: Stub,
    WarningCircle: Stub,
    X: Stub,
  }
})
// 桩：@tagent/ui 的 AppTooltip → 直接渲染 children
vi.mock('@tagent/ui', () => ({
  AppTooltip: ({ children }: { children: React.ReactNode }): React.ReactNode => children,
}))
// 桩：sonner toast → 不触 UI
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import type {
  CollaborationArtifact,
  CollaborationMember,
  CollaborationRoom,
  CollaborationRoomTask,
  CollaborationRun,
} from '@tagent/shared'
import { CollaborationWorkPanel } from './CollaborationWorkPanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function mkRoom(over: Partial<CollaborationRoom> = {}): CollaborationRoom {
  return {
    id: 'cr_1',
    title: '房间',
    status: 'active',
    maxConcurrentRuns: 3,
    maxA2ADepth: 4,
    summaryEveryUtterances: 8,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  } as CollaborationRoom
}
function mkMember(over: Partial<CollaborationMember> = {}): CollaborationMember {
  return {
    id: 'cm_1',
    roomId: 'cr_1',
    displayName: '开发',
    backend: 'kscc-internal',
    isCoordinator: true,
    status: 'idle',
    permissionProfile: 'workspace-write',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  } as CollaborationMember
}
function mkTask(over: Partial<CollaborationRoomTask> = {}): CollaborationRoomTask {
  return {
    id: 'crt_1',
    roomId: 'cr_1',
    title: '写文档',
    status: 'todo',
    version: 1,
    createdAt: 100,
    updatedAt: 100,
    ...over,
  }
}
function mkArtifact(over: Partial<CollaborationArtifact> = {}): CollaborationArtifact {
  return {
    id: 'cart_1',
    roomId: 'cr_1',
    memberId: 'cm_1',
    relativePath: 'docs/api.md',
    sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    byteSize: 5,
    createdAt: 200,
    ...over,
  }
}
function mkRun(over: Partial<CollaborationRun> = {}): CollaborationRun {
  return {
    id: 'run_1',
    roomId: 'cr_1',
    memberId: 'cm_1',
    triggerMessageId: 'msg_1',
    idempotencyKey: 'k',
    status: 'done',
    attempt: 0,
    ...over,
  } as CollaborationRun
}

interface Mount {
  container: HTMLDivElement
  root: Root
  unmount(): void
}
function mount(jsx: React.ReactElement): Mount {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(jsx)
  })
  return {
    container,
    root,
    unmount() {
      act(() => {
        root.unmount()
      })
      document.body.removeChild(container)
    },
  }
}

interface ElectronApiStub {
  createCollaborationRoomTask: ReturnType<typeof vi.fn>
  updateCollaborationRoomTask: ReturnType<typeof vi.fn>
  readCollaborationArtifact: ReturnType<typeof vi.fn>
}

function installElectronApi(): ElectronApiStub {
  const stub: ElectronApiStub = {
    createCollaborationRoomTask: vi.fn(),
    updateCollaborationRoomTask: vi.fn(),
    readCollaborationArtifact: vi.fn(),
  }
  ;(window as unknown as { electronAPI: unknown }).electronAPI = stub
  return stub
}

let original: unknown
beforeEach(() => {
  original = (window as unknown as { electronAPI?: unknown }).electronAPI
})
afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
  if (original !== undefined) {
    ;(window as unknown as { electronAPI: unknown }).electronAPI = original
  }
})

describe('CollaborationWorkPanel 渲染与分组', () => {
  test('头部展示任务/产物计数', () => {
    installElectronApi()
    const m = mount(
      <CollaborationWorkPanel
        room={mkRoom()}
        tasks={[mkTask()]}
        artifacts={[mkArtifact()]}
        members={[mkMember()]}
        runs={[mkRun()]}
        onLocateRun={vi.fn()}
        onLocateMessage={vi.fn()}
        onChanged={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(m.container.textContent).toContain('工作面板')
    expect(m.container.textContent).toContain('任务 1')
    expect(m.container.textContent).toContain('产物 1')
    m.unmount()
  })

  test('任务按状态分组并展示组标题与计数', () => {
    installElectronApi()
    const tasks = [
      mkTask({ id: 'crt_a', status: 'todo', title: '待办A' }),
      mkTask({ id: 'crt_b', status: 'in_progress', title: '进行B', assigneeMemberId: 'cm_1', runId: 'run_1' }),
      mkTask({ id: 'crt_c', status: 'failed', title: '失败C' }),
    ]
    const m = mount(
      <CollaborationWorkPanel
        room={mkRoom()}
        tasks={tasks}
        artifacts={[]}
        members={[mkMember()]}
        runs={[mkRun()]}
        onLocateRun={vi.fn()}
        onLocateMessage={vi.fn()}
        onChanged={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    const text = m.container.textContent ?? ''
    expect(text).toContain('待办')
    expect(text).toContain('进行中')
    expect(text).toContain('失败')
    expect(text).toContain('待办A')
    expect(text).toContain('进行B')
    expect(text).toContain('失败C')
    // 未指派任务显示「未指派」
    expect(text).toContain('未指派')
    m.unmount()
  })

  test('空态：无任务/无产物明确提示', () => {
    installElectronApi()
    const m = mount(
      <CollaborationWorkPanel
        room={mkRoom()}
        tasks={[]}
        artifacts={[]}
        members={[mkMember()]}
        runs={[]}
        onLocateRun={vi.fn()}
        onLocateMessage={vi.fn()}
        onChanged={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    const text = m.container.textContent ?? ''
    expect(text).toContain('暂无任务')
    expect(text).toContain('暂无产物')
    m.unmount()
  })

  test('挂载看板时展示只读横幅且不显示新建按钮', () => {
    installElectronApi()
    const m = mount(
      <CollaborationWorkPanel
        room={mkRoom({ attachedBoardId: 'kb_1' })}
        tasks={[mkTask()]}
        artifacts={[]}
        members={[mkMember()]}
        runs={[]}
        onLocateRun={vi.fn()}
        onLocateMessage={vi.fn()}
        onChanged={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    const text = m.container.textContent ?? ''
    expect(text).toContain('已挂载看板')
    expect(text).not.toContain('新建任务')
    m.unmount()
  })
})

describe('CollaborationWorkPanel 关联展示', () => {
  test('产物展示 sha 短码 / 作者 / 关联任务标题；无关联 run 明确显示', () => {
    installElectronApi()
    const tasks = [mkTask({ id: 'crt_1', title: '写文档' })]
    const art = mkArtifact({ id: 'cart_1', taskId: 'crt_1' }) // 有任务、无 run
    const m = mount(
      <CollaborationWorkPanel
        room={mkRoom()}
        tasks={tasks}
        artifacts={[art]}
        members={[mkMember()]}
        runs={[]}
        onLocateRun={vi.fn()}
        onLocateMessage={vi.fn()}
        onChanged={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    const text = m.container.textContent ?? ''
    expect(text).toContain('docs/api.md')
    expect(text).toContain('0123456789ab') // sha 短码前 12
    expect(text).toContain('写文档') // 关联任务标题
    expect(text).toContain('无关联 run') // 无关联明确显示
    m.unmount()
  })

  test('产物无 taskId → 显示「无关联任务」', () => {
    installElectronApi()
    const m = mount(
      <CollaborationWorkPanel
        room={mkRoom()}
        tasks={[]}
        artifacts={[mkArtifact({ id: 'cart_1', taskId: undefined })]}
        members={[mkMember()]}
        runs={[]}
        onLocateRun={vi.fn()}
        onLocateMessage={vi.fn()}
        onChanged={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(m.container.textContent).toContain('无关联任务')
    m.unmount()
  })

  test('任务展开后显示关联追溯与「无关联消息/run」', () => {
    installElectronApi()
    const m = mount(
      <CollaborationWorkPanel
        room={mkRoom()}
        tasks={[mkTask({ id: 'crt_1', title: 'T', description: '说明内容', status: 'todo' })]}
        artifacts={[]}
        members={[mkMember()]}
        runs={[]}
        onLocateRun={vi.fn()}
        onLocateMessage={vi.fn()}
        onChanged={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    // 点击展开按钮（第一个 button 即 caret）
    const btns = m.container.querySelectorAll('button')
    const expandBtn = Array.from(btns).find((b) => b.getAttribute('aria-label')?.includes('展开任务详情'))
    expect(expandBtn).toBeTruthy()
    act(() => {
      expandBtn!.click()
    })
    const text = m.container.textContent ?? ''
    expect(text).toContain('说明内容')
    expect(text).toContain('无关联消息')
    expect(text).toContain('无关联 run')
    m.unmount()
  })
})

describe('CollaborationWorkPanel 交互', () => {
  test('点击预览调用 readCollaborationArtifact 并展示返回内容', async () => {
    const api = installElectronApi()
    api.readCollaborationArtifact.mockResolvedValue({
      ok: true,
      artifactId: 'cart_1',
      relativePath: 'docs/api.md',
      content: '# 标题\n正文行',
      byteSize: 12,
      sha256: '0123456789abcdef',
      truncated: false,
    })
    const m = mount(
      <CollaborationWorkPanel
        room={mkRoom()}
        tasks={[]}
        artifacts={[mkArtifact({ id: 'cart_1' })]}
        members={[mkMember()]}
        runs={[]}
        onLocateRun={vi.fn()}
        onLocateMessage={vi.fn()}
        onChanged={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    const btn = Array.from(m.container.querySelectorAll('button')).find(
      (b) => (b.textContent ?? '').includes('预览文本'),
    )
    expect(btn).toBeTruthy()
    await act(async () => {
      btn!.click()
    })
    expect(api.readCollaborationArtifact).toHaveBeenCalledWith({
      roomId: 'cr_1',
      artifactId: 'cart_1',
    })
    expect(m.container.textContent).toContain('标题')
    m.unmount()
  })

  test('关闭按钮触发 onClose', () => {
    installElectronApi()
    const onClose = vi.fn()
    const m = mount(
      <CollaborationWorkPanel
        room={mkRoom()}
        tasks={[]}
        artifacts={[]}
        members={[]}
        runs={[]}
        onLocateRun={vi.fn()}
        onLocateMessage={vi.fn()}
        onChanged={vi.fn()}
        onClose={onClose}
      />,
    )
    const closeBtn = m.container.querySelector(
      'button[aria-label="收起工作面板"]',
    ) as HTMLButtonElement | null
    expect(closeBtn).toBeTruthy()
    act(() => {
      closeBtn!.click()
    })
    expect(onClose).toHaveBeenCalled()
    m.unmount()
  })
})
