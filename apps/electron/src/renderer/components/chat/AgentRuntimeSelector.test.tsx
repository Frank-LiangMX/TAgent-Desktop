// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { TooltipProvider } from '@tagent/ui'
import type { Channel } from '@tagent/shared'
import { AgentRuntimeSelector } from './AgentRuntimeSelector'

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

function channel(
  id: string,
  provider: Channel['provider'],
  enabled = true,
  modelEnabled = true,
): Channel {
  return {
    id,
    name: id,
    provider,
    baseUrl: '',
    apiKey: '',
    models: [{ id: `${id}-model`, name: `${id} model`, enabled: modelEnabled }],
    defaultModelId: `${id}-model`,
    enabled,
    createdAt: 1,
    updatedAt: 1,
  }
}

const KSCC = channel('kscc', 'kscc-internal')
const OPENAI = channel('openai', 'openai')
const CODEX = channel('codex', 'codex-internal')
const CODEX_API: Channel = { ...channel('codex-api', 'openai'), apiProtocol: 'openai-responses' }

function mount(
  overrides: Partial<React.ComponentProps<typeof AgentRuntimeSelector>> = {},
): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(
      <TooltipProvider>
        <AgentRuntimeSelector
          runtime="claude-code"
          channels={[KSCC]}
          onSelect={() => undefined}
          {...overrides}
        />
      </TooltipProvider>,
    )
  })
}

describe('Pi runtime indicator', () => {
  test('shows only Pi for new sessions, with no runtime menu or install action', () => {
    mount({ runtime: 'pi', channels: [OPENAI, CODEX, KSCC] })
    expect(document.body.textContent).toContain('Pi')
    expect(document.body.textContent).not.toMatch(/Codex|Claude Code|安装/)
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Pi 内核"]')?.disabled).toBe(true)
  })
  test('a legacy binding can explicitly continue on Pi', () => {
    const onSelect = vi.fn()
    mount({ runtime: 'codex', channels: [OPENAI], onSelect })
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="转为 Pi 内核"]')?.click())
    expect(onSelect).toHaveBeenCalledWith('pi')
  })
  test('cannot migrate while running', () => {
    const onSelect = vi.fn()
    mount({ runtime: 'claude-code', busy: true, onSelect })
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="转为 Pi 内核"]')?.click())
    expect(onSelect).not.toHaveBeenCalled()
  })
})
