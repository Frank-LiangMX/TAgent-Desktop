import { describe, expect, it } from 'vitest'
import {
  buildCodexPermissionsRequestApprovalResponse,
  parseCodexPermissionsRequestApprovalParams,
  summarizeCodexPermissionRequest,
} from './codex-permission-request'

const rawParams = {
  threadId: 'thr_1',
  turnId: 'turn_1',
  itemId: 'item_1',
  environmentId: null,
  startedAtMs: 1_725_000_000_000,
  cwd: 'F:\\repo',
  reason: '需要安装依赖并写入缓存',
  permissions: {
    network: { enabled: true },
    fileSystem: {
      read: ['C:\\shared'],
      write: ['F:\\repo\\.cache'],
      entries: [
        {
          path: { type: 'glob_pattern', pattern: 'F:\\repo\\dist\\**' },
          access: 'write',
        },
      ],
    },
  },
}

describe('Codex permissions requestApproval', () => {
  it('解析并归纳网络、读目录和写目录扩权', () => {
    const parsed = parseCodexPermissionsRequestApprovalParams(rawParams)
    expect(parsed).toBeDefined()
    const summary = summarizeCodexPermissionRequest(parsed!)
    expect(summary).toEqual({
      hasNetwork: true,
      hasFileRead: true,
      hasFileWrite: true,
      input: {
        reason: '需要安装依赖并写入缓存',
        cwd: 'F:\\repo',
        network: '允许访问网络',
        readPaths: ['C:\\shared'],
        writePaths: ['F:\\repo\\.cache', 'F:\\repo\\dist\\**'],
      },
    })
  })

  it('允许时原样授予请求权限，但只覆盖当前 turn', () => {
    const parsed = parseCodexPermissionsRequestApprovalParams(rawParams)!
    expect(buildCodexPermissionsRequestApprovalResponse(parsed, true)).toEqual({
      permissions: parsed.permissions,
      scope: 'turn',
    })
  })

  it('拒绝返回空权限集', () => {
    const parsed = parseCodexPermissionsRequestApprovalParams(rawParams)!
    expect(buildCodexPermissionsRequestApprovalResponse(parsed, false)).toEqual({
      permissions: {},
      scope: 'turn',
    })
  })

  it('拒绝缺少协议必填字段或非法权限值', () => {
    expect(
      parseCodexPermissionsRequestApprovalParams({
        ...rawParams,
        permissions: {
          ...rawParams.permissions,
          network: { enabled: 'yes' },
        },
      }),
    ).toBeUndefined()
    expect(
      parseCodexPermissionsRequestApprovalParams({
        ...rawParams,
        turnId: undefined,
      }),
    ).toBeUndefined()
  })
})
