// @vitest-environment jsdom
import { describe, expect, test, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { CollaborationUserApprovalRequest } from '@tagent/shared'
import { CollaborationApprovalCard } from './CollaborationApprovalCard'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function mkRequest(over: Partial<CollaborationUserApprovalRequest> = {}): CollaborationUserApprovalRequest {
  return {
    id: 'approval_1',
    roomId: 'cr_1',
    memberId: 'cm_1',
    runId: 'run_1',
    question: '是否继续？',
    status: 'pending',
    createdAt: 1,
    ...over,
  }
}

function mount(node: React.ReactNode): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(node))
  return { container, root }
}

describe('CollaborationApprovalCard', () => {
  test('展示问题、选项，并将批准结果回调给宿主', () => {
    const onResolve = vi.fn()
    const { container, root } = mount(
      <CollaborationApprovalCard
        request={mkRequest({ reason: '需要发布', options: ['继续', '停止'] })}
        memberName="开发"
        onResolve={onResolve}
      />,
    )
    expect(container.textContent).toContain('是否继续？')
    expect(container.textContent).toContain('需要发布')
    const option = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '继续')!
    act(() => option.click())
    const approve = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '批准并继续')!
    act(() => approve.click())
    expect(onResolve).toHaveBeenCalledWith('approved', '继续')
    act(() => root.unmount())
    container.remove()
  })
})
