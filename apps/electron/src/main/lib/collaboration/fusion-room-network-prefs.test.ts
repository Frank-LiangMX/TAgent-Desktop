import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  decidePackagedCollaborationGate,
  DEFAULT_FUSION_ROOM_NETWORK_PREFS,
  loadFusionRoomNetworkPrefs,
  normalizeFusionRoomNetworkPrefs,
  saveFusionRoomNetworkPrefs,
  validateFusionRoomNetworkPrefs,
  type FusionRoomNetworkPrefs,
} from './fusion-room-network-prefs'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const OFF: FusionRoomNetworkPrefs = { enableCollaboration: false, enableNetworkListen: false }

describe('decidePackagedCollaborationGate', () => {
  test('开发环境恒开 IPC（与证书无关）', () => {
    const gate = decidePackagedCollaborationGate({
      isPackaged: false,
      prefs: OFF,
      hasActiveCert: false,
    })
    expect(gate.registerIpc).toBe(true)
    // dev 下 allowNonLoopbackListen 仅反映证书可用性（信息性；实际由 runtime 校验 tls）。
    expect(gate.allowNonLoopbackListen).toBe(false)
    expect(gate.reasons).toEqual([])
  })

  test('打包版默认全关（行为与今天 !app.isPackaged 一致）', () => {
    const gate = decidePackagedCollaborationGate({
      isPackaged: true,
      prefs: OFF,
      hasActiveCert: false,
    })
    expect(gate.registerIpc).toBe(false)
    expect(gate.allowNonLoopbackListen).toBe(false)
    expect(gate.reasons.length).toBeGreaterThan(0)
    expect(gate.reasons.join(' ')).toContain('enableCollaboration')
  })

  test('仅 enableCollaboration → IPC 开但非 loopback 仍关', () => {
    const gate = decidePackagedCollaborationGate({
      isPackaged: true,
      prefs: { enableCollaboration: true, enableNetworkListen: false },
      hasActiveCert: true,
    })
    expect(gate.registerIpc).toBe(true)
    expect(gate.allowNonLoopbackListen).toBe(false)
    expect(gate.reasons.join(' ')).toContain('enableNetworkListen')
  })

  test('enableNetworkListen 无证书 → 仍关', () => {
    const gate = decidePackagedCollaborationGate({
      isPackaged: true,
      prefs: { enableCollaboration: true, enableNetworkListen: true },
      hasActiveCert: false,
    })
    expect(gate.registerIpc).toBe(true)
    expect(gate.allowNonLoopbackListen).toBe(false)
    expect(gate.reasons.join(' ')).toContain('证书')
  })

  test('有 active 证书 + 双开关 → allowNonLoopbackListen true', () => {
    const gate = decidePackagedCollaborationGate({
      isPackaged: true,
      prefs: { enableCollaboration: true, enableNetworkListen: true },
      hasActiveCert: true,
    })
    expect(gate.registerIpc).toBe(true)
    expect(gate.allowNonLoopbackListen).toBe(true)
    expect(gate.reasons).toEqual([])
  })

  test('revoked/expired 证书（hasActiveCert=false）→ allowNonLoopbackListen false', () => {
    const gate = decidePackagedCollaborationGate({
      isPackaged: true,
      prefs: { enableCollaboration: true, enableNetworkListen: true },
      hasActiveCert: false,
    })
    expect(gate.allowNonLoopbackListen).toBe(false)
    expect(gate.registerIpc).toBe(true)
  })
})

describe('validateFusionRoomNetworkPrefs', () => {
  test('拒绝禁用的明文公网 / 不安全开关', () => {
    for (const key of [
      'allowInsecureNetwork',
      'allowInsecure',
      'allowPlaintext',
      'insecure',
    ]) {
      const bad = { ...OFF, [key]: true } as unknown as FusionRoomNetworkPrefs
      expect(() => validateFusionRoomNetworkPrefs(bad as FusionRoomNetworkPrefs)).toThrow(
        /明文公网|不安全|不支持/,
      )
    }
  })

  test('拒绝 enableNetworkListen=true 但 enableCollaboration=false', () => {
    expect(() =>
      validateFusionRoomNetworkPrefs({ enableCollaboration: false, enableNetworkListen: true }),
    ).toThrow(/enableNetworkListen 需要 enableCollaboration/)
  })

  test('合法组合通过', () => {
    expect(() => validateFusionRoomNetworkPrefs(OFF)).not.toThrow()
    expect(() =>
      validateFusionRoomNetworkPrefs({ enableCollaboration: true, enableNetworkListen: false }),
    ).not.toThrow()
    expect(() =>
      validateFusionRoomNetworkPrefs({ enableCollaboration: true, enableNetworkListen: true }),
    ).not.toThrow()
  })
})

describe('FusionRoomNetworkPrefs 持久化', () => {
  test('normalize 缺失/非法字段取默认', () => {
    expect(normalizeFusionRoomNetworkPrefs(null)).toEqual(DEFAULT_FUSION_ROOM_NETWORK_PREFS)
    expect(normalizeFusionRoomNetworkPrefs({})).toEqual(DEFAULT_FUSION_ROOM_NETWORK_PREFS)
    expect(normalizeFusionRoomNetworkPrefs({ enableCollaboration: 'yes' })).toEqual(OFF)
    expect(normalizeFusionRoomNetworkPrefs({ enableCollaboration: 1 } as never)).toEqual(OFF)
    expect(
      normalizeFusionRoomNetworkPrefs({ enableCollaboration: true, enableNetworkListen: 'x' }),
    ).toEqual({ enableCollaboration: true, enableNetworkListen: false })
  })

  test('load 缺失文件 → 默认全关；save → 原子落盘 + 校验', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tagent-net-prefs-'))
    tempDirs.push(dir)
    const path = join(dir, 'fusion-room-network-prefs.json')

    expect(loadFusionRoomNetworkPrefs(path)).toEqual(DEFAULT_FUSION_ROOM_NETWORK_PREFS)

    const saved = saveFusionRoomNetworkPrefs(path, {
      enableCollaboration: true,
      enableNetworkListen: false,
    })
    expect(saved).toEqual({ enableCollaboration: true, enableNetworkListen: false })
    expect(readFileSync(path, 'utf-8')).toContain('"enableCollaboration": true')

    // 新进程读取同一文件可看到落盘值。
    expect(loadFusionRoomNetworkPrefs(path)).toEqual(saved)
  })

  test('save 拒绝禁用开关，不落盘', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tagent-net-prefs-forbid-'))
    tempDirs.push(dir)
    const path = join(dir, 'fusion-room-network-prefs.json')
    const bad = { ...OFF, allowInsecureNetwork: true } as unknown as FusionRoomNetworkPrefs
    expect(() => saveFusionRoomNetworkPrefs(path, bad)).toThrow()
    expect(loadFusionRoomNetworkPrefs(path)).toEqual(DEFAULT_FUSION_ROOM_NETWORK_PREFS)
  })
})
