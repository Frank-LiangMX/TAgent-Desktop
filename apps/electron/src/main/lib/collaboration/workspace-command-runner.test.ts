/**
 * workspace-command-runner 纯函数聚焦测试
 *
 * 覆盖：
 * - validateWorkspaceCommand：白名单/路径/空/非法字符/args JSON 校验/元素上限
 * - runWorkspaceCommand：成功执行/退出码/超时/输出截断/命令不存在/取消
 * - 白名单约束：git/bun/npm/pnpm/yarn/node/python/pytest/cargo/go/dotnet 等
 * - shell 控制字符拒绝：分号/管道/重定向/反引号/换行
 */
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { COLLABORATION_WORKSPACE_COMMAND_ALLOWLIST } from '@tagent/shared'
import {
  validateWorkspaceCommand,
  runWorkspaceCommand,
} from './workspace-command-runner'

// ===== validateWorkspaceCommand 纯函数 =====

describe('validateWorkspaceCommand — 白名单校验', () => {
  test('accepts all allowed commands', () => {
    for (const cmd of COLLABORATION_WORKSPACE_COMMAND_ALLOWLIST) {
      const r = validateWorkspaceCommand(cmd)
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.command).toBe(cmd)
    }
  })

  test('rejects empty command', () => {
    const r = validateWorkspaceCommand('')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('不能为空')
  })

  test('rejects whitespace-only command', () => {
    const r = validateWorkspaceCommand('  ')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('不能为空')
  })

  test('rejects command with path separator', () => {
    expect(validateWorkspaceCommand('/usr/bin/git').ok).toBe(false)
    expect(validateWorkspaceCommand('./git').ok).toBe(false)
    expect(validateWorkspaceCommand('dir\\git').ok).toBe(false)
  })

  test('rejects command not in allowlist', () => {
    const r = validateWorkspaceCommand('rm')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('不在白名单内')
  })

  test('rejects command with shell control characters', () => {
    const rejection = (cmd: string) => {
      const r = validateWorkspaceCommand(cmd)
      expect(r.ok).toBe(false)
    }
    rejection('git;rm')
    rejection('git|rm')
    rejection('git&rm')
    rejection('git>out')
    rejection('git<in')
    rejection('git`cmd`')
    rejection('git\nrm')
  })

  describe('args validation', () => {
    test('empty args → ok', () => {
      const r = validateWorkspaceCommand('git', '')
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.args).toEqual([])
    })

    test('valid JSON array of strings', () => {
      const r = validateWorkspaceCommand('git', '["status","--short"]')
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.args).toEqual(['status', '--short'])
    })

    test('rejects non-array JSON', () => {
      expect(validateWorkspaceCommand('git', '"hello"').ok).toBe(false)
      expect(validateWorkspaceCommand('git', '42').ok).toBe(false)
      expect(validateWorkspaceCommand('git', '{}').ok).toBe(false)
    })

    test('rejects invalid JSON', () => {
      const r = validateWorkspaceCommand('git', 'not-json')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toContain('JSON')
    })

    test('rejects non-string array elements', () => {
      expect(validateWorkspaceCommand('git', '["ok", 42]').ok).toBe(false)
      expect(validateWorkspaceCommand('git', '[true]').ok).toBe(false)
    })

    test('rejects args with shell metacharacters', () => {
      expect(validateWorkspaceCommand('git', '[";rm -rf /"]').ok).toBe(false)
      expect(validateWorkspaceCommand('git', '["|ls"]').ok).toBe(false)
      expect(validateWorkspaceCommand('git', '["<file"]').ok).toBe(false)
      expect(validateWorkspaceCommand('git', '["`id`"]').ok).toBe(false)
    })

    test('rejects args exceeding max', () => {
      const manyArgs = Array.from({ length: 65 }, (_, i) => `a${i}`)
      const r = validateWorkspaceCommand('git', JSON.stringify(manyArgs))
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toContain('上限')
    })

    test('allows args at max boundary', () => {
      const manyArgs = Array.from({ length: 64 }, (_, i) => `a${i}`)
      const r = validateWorkspaceCommand('git', JSON.stringify(manyArgs))
      expect(r.ok).toBe(true)
    })
  })
})

// ===== runWorkspaceCommand 集成 =====

describe('runWorkspaceCommand — 执行', () => {
  let tmpDir: string

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tagent-ws-cmd-test-'))
  })

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('successfully runs "node -e 1+1"', async () => {
    const r = await runWorkspaceCommand('node', JSON.stringify(['-e', 'process.stdout.write("ok")']), {
      cwd: tmpDir,
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.stdout).toContain('ok')
      expect(r.exitCode).toBe(0)
      expect(r.timedOut).toBe(false)
      expect(r.truncated).toBe(false)
    }
  })

  test('captures nonzero exit code', async () => {
    const r = await runWorkspaceCommand('node', JSON.stringify(['-e', 'process.exit(42)']), {
      cwd: tmpDir,
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.exitCode).toBe(42)
  })

  test('rejects a command outside the allowlist before spawn', async () => {
    const r = await runWorkspaceCommand('does-not-exist-12345', undefined, {
      cwd: tmpDir,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('白名单')
  })

  test('timeout kills process (via auto-timeout)', async () => {
    const r = await runWorkspaceCommand(
      'node',
      JSON.stringify(['-e', 'setTimeout(function(){},10000)']),
      { cwd: tmpDir, timeoutMs: 500 },
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.timedOut).toBe(true)
    }
  })

  test('truncates output at maxOutputBytes', async () => {
    const r = await runWorkspaceCommand(
      'node',
      JSON.stringify(['-e', 'process.stdout.write("x".repeat(1000))']),
      { cwd: tmpDir, maxOutputBytes: 50 },
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.stdout.length).toBeLessThanOrEqual(50)
      expect(r.truncated).toBe(true)
    }
  })

  test('abort signal cancels process', async () => {
    const ac = new AbortController()
    const r = runWorkspaceCommand('node', JSON.stringify(['-e', 'setTimeout(function(){},30000)']), {
      cwd: tmpDir,
      signal: ac.signal,
      timeoutMs: 5000,
    })
    ac.abort()
    const result = await r
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.timedOut).toBe(false)
  })

  test('rejects command not in allowlist', async () => {
    const r = await runWorkspaceCommand('rm', JSON.stringify(['-rf', '/']), {
      cwd: tmpDir,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('不在白名单内')
  })

  test('rejects shell metachar in args', async () => {
    const r = await runWorkspaceCommand('git', JSON.stringify([';rm -rf /']), {
      cwd: tmpDir,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('shell 控制字符')
  })

  test('captures stderr', async () => {
    const r = await runWorkspaceCommand('node', JSON.stringify(['-e', 'process.stderr.write("err-msg")']), {
      cwd: tmpDir,
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.stderr).toContain('err-msg')
  })
})
