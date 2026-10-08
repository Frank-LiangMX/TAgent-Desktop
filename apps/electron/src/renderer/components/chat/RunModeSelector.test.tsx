// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { TooltipProvider } from '@tagent/ui'
import { RunModeSelector } from './RunModeSelector'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
    root = undefined
  }
  container?.remove()
  container = undefined
  document.body.innerHTML = ''
})

function mount(
  overrides: Partial<React.ComponentProps<typeof RunModeSelector>> = {},
): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(
      <TooltipProvider>
        <RunModeSelector
          executionMode="work"
          onExecutionModeChange={() => undefined}
          permissionMode="auto"
          onPermissionModeChange={() => undefined}
          subagentEagerness="conservative"
          onSubagentEagernessChange={() => undefined}
          {...overrides}
        />
      </TooltipProvider>,
    )
  })
}

function openMenu(): void {
  const trigger = document.querySelector<HTMLButtonElement>(
    '[aria-label^="运行模式："]',
  )
  expect(trigger).not.toBeNull()
  act(() => trigger?.click())
}

function clickItem(label: string): void {
  const button = Array.from(
    document.querySelectorAll<HTMLButtonElement>('button'),
  ).find((item) => item.textContent?.includes(label))
  expect(button).toBeDefined()
  act(() => button?.click())
}

describe('RunModeSelector', () => {
  test('主 Agent 不再出现在运行模式弹层（已迁到 AgentRuntimeSelector）', () => {
    mount()
    openMenu()

    expect(document.body.textContent).not.toContain('主 Agent')
    expect(document.body.textContent).not.toContain('Codex')
  })

  test('选权限档即进 Work 并回调权限模式', () => {
    const onExecutionModeChange = vi.fn()
    const onPermissionModeChange = vi.fn()
    mount({
      executionMode: 'chat',
      onExecutionModeChange,
      onPermissionModeChange,
    })
    openMenu()
    clickItem('计划')

    expect(onExecutionModeChange).toHaveBeenCalledWith('work')
    expect(onPermissionModeChange).toHaveBeenCalledWith('plan')
  })
})
