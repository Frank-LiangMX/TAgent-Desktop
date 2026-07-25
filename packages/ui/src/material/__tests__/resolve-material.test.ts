import { describe, expect, test } from 'vitest'

import { DEFAULT_MATERIAL_MODE, isMaterialMode, resolveMaterialMode } from '../resolve-material.ts'

describe('DEFAULT_MATERIAL_MODE', () => {
  test('defaults to frosted', () => {
    expect(DEFAULT_MATERIAL_MODE).toBe('frosted')
  })
})

describe('isMaterialMode', () => {
  test.each(['frosted', 'glass', 'soft'] as const)('returns true for %j', (mode) => {
    expect(isMaterialMode(mode)).toBe(true)
  })

  test.each([null, undefined, 42, true, '', 'Frosted', 'Glass', 'ICE', 'neumorphism', {}, []])(
    'returns false for %j',
    (value) => {
      expect(isMaterialMode(value)).toBe(false)
    }
  )
})

describe('resolveMaterialMode', () => {
  test.each(['frosted', 'glass', 'soft'] as const)('returns %j when given %j', (mode) => {
    expect(resolveMaterialMode(mode)).toBe(mode)
  })

  test('returns default fallback for undefined', () => {
    expect(resolveMaterialMode(undefined)).toBe('frosted')
  })

  test('returns default fallback for null', () => {
    expect(resolveMaterialMode(null)).toBe('frosted')
  })

  test('returns default fallback for invalid string', () => {
    expect(resolveMaterialMode('liquid')).toBe('frosted')
  })

  test('returns default fallback for number', () => {
    expect(resolveMaterialMode(0)).toBe('frosted')
  })

  test('respects custom fallback', () => {
    expect(resolveMaterialMode('bad', 'soft')).toBe('soft')
  })

  test('valid value ignores fallback', () => {
    expect(resolveMaterialMode('glass', 'soft')).toBe('glass')
  })
})
