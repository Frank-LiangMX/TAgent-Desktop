import { describe, expect, it } from 'vitest'

import {
  isWindowsBatchFile,
  quoteCmdArg,
  resolveKsccSpawnInvocation,
} from './kscc-spawn'

describe('isWindowsBatchFile', () => {
  it('detects .cmd and .bat case-insensitively', () => {
    expect(isWindowsBatchFile('C:\\npm\\kscc.cmd')).toBe(true)
    expect(isWindowsBatchFile('C:\\npm\\kscc.CMD')).toBe(true)
    expect(isWindowsBatchFile('/tmp/run.bat')).toBe(true)
    expect(isWindowsBatchFile('kscc.exe')).toBe(false)
    expect(isWindowsBatchFile('kscc')).toBe(false)
  })
})

describe('quoteCmdArg', () => {
  it('quotes empty string so --tools "" survives', () => {
    expect(quoteCmdArg('')).toBe('""')
  })

  it('leaves simple tokens unquoted', () => {
    expect(quoteCmdArg('-p')).toBe('-p')
    expect(quoteCmdArg('--bare')).toBe('--bare')
  })

  it('quotes paths with spaces and doubles internal quotes', () => {
    expect(quoteCmdArg('C:\\Program Files\\kscc.cmd')).toBe('"C:\\Program Files\\kscc.cmd"')
    expect(quoteCmdArg('say "hi"')).toBe('"say ""hi"""')
  })
})

describe('resolveKsccSpawnInvocation', () => {
  const sampleArgs = [
    '-p',
    '--bare',
    '--tools',
    '',
    '--system-prompt-file',
    'C:\\Users\\LIANGM~1\\AppData\\Local\\Temp\\pi-cli-sp-xxx\\prompt.txt',
    '--model',
    'glm-5',
  ]

  it('on win32 + .cmd uses cmd.exe /d /s /c with windowsVerbatimArguments', () => {
    const inv = resolveKsccSpawnInvocation(
      'C:\\Users\\me\\AppData\\Roaming\\npm\\kscc.cmd',
      sampleArgs,
      'win32',
    )

    expect(inv.command.toLowerCase()).toMatch(/cmd\.exe$/)
    expect(inv.args[0]).toBe('/d')
    expect(inv.args[1]).toBe('/s')
    expect(inv.args[2]).toBe('/c')
    expect(inv.args).toHaveLength(4)

    const cmdline = inv.args[3]!
    // 外层引号供 /s 剥离；内部保留 .cmd 路径与 8.3 临时路径原样
    expect(cmdline.startsWith('"')).toBe(true)
    expect(cmdline.endsWith('"')).toBe(true)
    expect(cmdline).toContain('kscc.cmd')
    expect(cmdline).toContain('--system-prompt-file')
    expect(cmdline).toContain('LIANGM~1')
    // 空 --tools 值保留为 ""
    expect(cmdline).toMatch(/--tools\s+""/)
    expect(inv.options.windowsVerbatimArguments).toBe(true)
  })

  it('on win32 + .bat also routes through cmd.exe', () => {
    const inv = resolveKsccSpawnInvocation('D:\\bin\\kscc.bat', ['-p'], 'win32')
    expect(inv.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
    expect(inv.options.windowsVerbatimArguments).toBe(true)
  })

  it('on win32 + plain exe/binary spawns directly (no cmd wrapper)', () => {
    const inv = resolveKsccSpawnInvocation('C:\\bin\\kscc.exe', sampleArgs, 'win32')
    expect(inv.command).toBe('C:\\bin\\kscc.exe')
    expect(inv.args).toEqual(sampleArgs)
    expect(inv.options.windowsVerbatimArguments).toBeUndefined()
  })

  it('on linux/darwin never wraps with cmd.exe even for .cmd path', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const inv = resolveKsccSpawnInvocation('/usr/bin/kscc.cmd', sampleArgs, platform)
      expect(inv.command).toBe('/usr/bin/kscc.cmd')
      expect(inv.args).toEqual(sampleArgs)
      expect(inv.options).toEqual({})
    }
  })

  it('quotes kscc path with spaces on win32', () => {
    const inv = resolveKsccSpawnInvocation(
      'C:\\Program Files\\npm\\kscc.cmd',
      ['-p', '--bare'],
      'win32',
    )
    const cmdline = inv.args[3]!
    expect(cmdline).toContain('"C:\\Program Files\\npm\\kscc.cmd"')
  })
})
