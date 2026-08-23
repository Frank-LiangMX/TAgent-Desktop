import { describe, expect, it } from 'vitest'
import {
  canEnableNetworkListen,
  certStatusLabel,
  formatCertExpiry,
  networkListenDisabledReason,
  shortFingerprint,
  summarizeGateStatus,
  type FusionRoomCertRecordView,
  type FusionRoomGateStatusView,
  type FusionRoomNetworkPrefsView,
} from './fusion-room-network-settings-model'

const OFF: FusionRoomNetworkPrefsView = { enableCollaboration: false, enableNetworkListen: false }

function gate(
  over: Partial<FusionRoomGateStatusView> & { decision?: Partial<FusionRoomGateStatusView['decision']> },
): FusionRoomGateStatusView {
  const decision = {
    registerIpc: false,
    allowNonLoopbackListen: false,
    reasons: [],
    ...over.decision,
  }
  return {
    decision,
    applied: { ...decision },
    needsRestart: false,
    isPackaged: true,
    ...over,
  }
}

describe('fusion-room-network-settings model', () => {
  it('shortFingerprint trims long colon-hex to head…tail uppercased', () => {
    // sha256 fingerprint256 → 32 段；用固定段构造，避免十六进制溢出 2 位。
    const fp = [
      ...['11', '22', '33'],
      ...Array.from({ length: 26 }, () => 'ab'),
      ...['ee', 'ff', 'aa'],
    ].join(':')
    expect(shortFingerprint(fp)).toBe('11:22:33…EE:FF:AA')
  })

  it('shortFingerprint leaves short fingerprints and empty unchanged (uppercased)', () => {
    expect(shortFingerprint('')).toBe('')
    expect(shortFingerprint('aa:bb:cc')).toBe('AA:BB:CC')
  })

  it('formatCertExpiry is deterministic UTC', () => {
    // 2027-08-23T12:34:56.000Z
    const ts = Date.UTC(2027, 7, 23, 12, 34, 56)
    expect(formatCertExpiry(ts)).toBe('2027-08-23 12:34 UTC')
  })

  it('certStatusLabel maps statuses', () => {
    expect(certStatusLabel('active')).toBe('有效')
    expect(certStatusLabel('revoked')).toBe('已撤销')
    expect(certStatusLabel('expired')).toBe('已过期')
  })

  it('canEnableNetworkListen requires collaboration and an active cert', () => {
    expect(canEnableNetworkListen(OFF, false)).toBe(false)
    expect(canEnableNetworkListen({ enableCollaboration: true, enableNetworkListen: false }, false)).toBe(false)
    expect(canEnableNetworkListen({ enableCollaboration: false, enableNetworkListen: true }, true)).toBe(false)
    expect(canEnableNetworkListen({ enableCollaboration: true, enableNetworkListen: true }, true)).toBe(true)
  })

  it('networkListenDisabledReason explains why the switch is disabled', () => {
    expect(networkListenDisabledReason(OFF, false)).toBe('需先开启「启用协作室 IPC」')
    expect(
      networkListenDisabledReason({ enableCollaboration: true, enableNetworkListen: false }, false),
    ).toBe('需先生成并保留一张有效证书')
    expect(
      networkListenDisabledReason({ enableCollaboration: true, enableNetworkListen: true }, true),
    ).toBeNull()
  })

  it('summarizeGateStatus labels IPC / listen and picks tone', () => {
    expect(summarizeGateStatus(gate({}))).toEqual({
      ipc: '协作室 IPC 关闭',
      listen: '非 loopback 监听关闭',
      tone: 'off',
    })
    expect(
      summarizeGateStatus(
        gate({ decision: { registerIpc: true, allowNonLoopbackListen: true, reasons: [] } }),
      ),
    ).toEqual({ ipc: '协作室 IPC 放行', listen: '非 loopback 监听放行', tone: 'ok' })
    // 双开但需重启 → warn
    const warnCase = gate({
      decision: { registerIpc: true, allowNonLoopbackListen: true, reasons: [] },
      needsRestart: true,
    })
    expect(summarizeGateStatus(warnCase).tone).toBe('warn')
    // 仅 IPC 开（非 loopback 仍关）且无需重启 → off
    const ipcOnly = gate({ decision: { registerIpc: true, allowNonLoopbackListen: false, reasons: [] } })
    expect(summarizeGateStatus(ipcOnly).tone).toBe('off')
    expect(summarizeGateStatus(ipcOnly).ipc).toBe('协作室 IPC 放行')
  })

  it('cert record view shape is usable for display (no private key field)', () => {
    const rec: FusionRoomCertRecordView = {
      certId: 'c1',
      cert: '-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n',
      fingerprint: 'aa:bb:cc',
      createdAt: 1,
      expiresAt: 2,
      status: 'active',
      commonName: 'tagent-fusion-room',
    }
    expect(rec.certId).toBe('c1')
    // 渲染层记录不含 key 字段
    expect((rec as { key?: string }).key).toBeUndefined()
  })
})
