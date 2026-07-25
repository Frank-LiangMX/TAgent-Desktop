import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

import { MaterialProvider, useMaterial, useMaterialMode } from '../MaterialProvider.tsx'
import type { MaterialMode } from '../material-types.ts'

/** 测试辅助组件：暴露 context 值到 DOM */
function ModeDisplay() {
  const { mode } = useMaterial()
  return <span data-testid="mode">{mode}</span>
}

/** 测试辅助组件：仅显示 useMaterialMode 的值 */
function ModeOnlyDisplay() {
  const mode = useMaterialMode()
  return <span data-testid="mode-only">{mode}</span>
}

describe('MaterialProvider', () => {
  test.each(['frosted', 'glass', 'soft'] as const)('provides %j mode', (mode) => {
    render(
      <MaterialProvider value={mode}>
        <ModeDisplay />
      </MaterialProvider>
    )
    expect(screen.getByTestId('mode')).toHaveTextContent(mode)
  })

  test('falls back to default for invalid mode', () => {
    render(
      <MaterialProvider value={'invalid' as unknown as MaterialMode}>
        <ModeDisplay />
      </MaterialProvider>
    )
    expect(screen.getByTestId('mode')).toHaveTextContent('frosted')
  })

  test('nested provider overrides parent', () => {
    render(
      <MaterialProvider value="glass">
        <MaterialProvider value="soft">
          <ModeDisplay />
        </MaterialProvider>
      </MaterialProvider>
    )
    expect(screen.getByTestId('mode')).toHaveTextContent('soft')
  })

  test('renders children', () => {
    render(
      <MaterialProvider value="glass">
        <div data-testid="child">hello</div>
      </MaterialProvider>
    )
    expect(screen.getByTestId('child')).toHaveTextContent('hello')
  })
})

describe('useMaterialMode', () => {
  test('returns the current mode string', () => {
    render(
      <MaterialProvider value="glass">
        <ModeOnlyDisplay />
      </MaterialProvider>
    )
    expect(screen.getByTestId('mode-only')).toHaveTextContent('glass')
  })

  test('returns default when outside provider', () => {
    render(<ModeOnlyDisplay />)
    expect(screen.getByTestId('mode-only')).toHaveTextContent('frosted')
  })
})
