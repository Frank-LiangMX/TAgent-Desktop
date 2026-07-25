import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

import { isSurfaceRole, surfaceRoles, surfaceRoleZIndex } from './surface-role'

describe('surface roles', () => {
  test('keeps every role unique and assigned to a z-index', () => {
    expect(new Set(surfaceRoles).size).toBe(surfaceRoles.length)
    expect(Object.keys(surfaceRoleZIndex).sort()).toEqual([...surfaceRoles].sort())
  })

  test.each(surfaceRoles)('recognizes %s', (role) => {
    expect(isSurfaceRole(role)).toBe(true)
  })

  test.each([undefined, null, '', 'sidebar', 'tooltip', 10])('rejects %j', (value) => {
    expect(isSurfaceRole(value)).toBe(false)
  })

  test('keeps overlays above interactive surfaces and modals above overlays', () => {
    expect(surfaceRoleZIndex.overlay).toBeGreaterThan(surfaceRoleZIndex['interactive-elevated'])
    expect(surfaceRoleZIndex.modal).toBeGreaterThan(surfaceRoleZIndex.overlay)
  })

  test('maps the scene and long-conversation chrome through semantic role tokens', () => {
    const currentDir = dirname(fileURLToPath(import.meta.url))
    const css = readFileSync(resolve(currentDir, '../../styles/surface-roles.css'), 'utf8')

    expect(css).toContain('--surface-role-scene-fill:')
    expect(css).toContain('var(--scene-a-pos')
    expect(css).toContain('var(--scene-base-rgb)')
    expect(css).toContain('--surface-role-workspace-fill: transparent')
    expect(css).toContain('--surface-role-turn-locator-fill:')
    expect(css).toContain('--surface-role-message-user-fill:')
    expect(css).toContain('--surface-role-message-minimap-fill:')
    expect(css).toContain('--surface-role-tooltip-fill:')
    expect(css).toContain('--surface-role-session-status-fill:')
  })
})
