import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const testDir = fileURLToPath(new URL('.', import.meta.url))
const electronRoot = join(testDir, '..') // apps/electron
const repoRoot = join(testDir, '..', '..', '..')
const resourcesDir = join(electronRoot, 'resources')
const installerDir = join(resourcesDir, 'installer')

const read = (p: string) => readFileSync(p, 'utf8')

/**
 * 解析 electron-builder.yml 中某个顶层块（如 `nsis:`）为 { key: string | string[] }。
 * 只处理「顶层 key: + 同缩进子项」的扁平结构（nsis 块即此结构）。
 */
function parseTopLevelBlock(text: string, blockName: string): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {}
  let inBlock = false
  let listKey: string | null = null
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === '' || /^\s*#/.test(raw)) continue
    const top = raw.match(/^([A-Za-z0-9_]+):/)
    if (top) {
      inBlock = top[1] === blockName
      listKey = null
      continue
    }
    if (!inBlock || !/^\s+\S/.test(raw)) continue
    const kv = raw.match(/^\s+([A-Za-z0-9_]+):\s*(.*)$/)
    if (kv) {
      const k = kv[1]
      const v = kv[2]
      if (k === undefined || v === undefined) continue
      if (v === '') {
        result[k] = []
        listKey = k
      } else {
        result[k] = v.replace(/^"|"$/g, '')
        listKey = null
      }
    } else if (listKey) {
      const item = raw.match(/^\s+-\s*(.*)$/)
      const val = item?.[1]
      if (val !== undefined) (result[listKey] as string[]).push(val.replace(/^"|"$/g, ''))
    }
  }
  return result
}

function bmpInfo(buf: Buffer) {
  if (buf[0] !== 0x42 || buf[1] !== 0x4d) return { ok: false, reason: 'not BM magic' }
  return {
    ok: true,
    width: buf.readUInt32LE(18),
    height: Math.abs(buf.readInt32LE(22)),
    bpp: buf.readUInt16LE(28),
  }
}

function icoInfo(buf: Buffer) {
  const reserved = buf.readUInt16LE(0)
  const type = buf.readUInt16LE(2)
  const count = buf.readUInt16LE(4)
  if (reserved !== 0 || type !== 1) return { ok: false, reason: 'bad ICO header' }
  const sizes: number[] = []
  for (let i = 0; i < count; i++) {
    const off = 6 + i * 16
    const b = buf[off]
    if (b !== undefined) sizes.push(b === 0 ? 256 : b)
  }
  return { ok: true, count, sizes }
}

/** 去掉 NSIS 注释（; 行）后的代码文本，用于代码级断言。 */
function stripNshComments(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*;.*$/, ''))
    .join('\n')
}

describe('installer branding — config & assets', () => {
  const builderYml = read(join(electronRoot, 'electron-builder.yml'))
  const nsis = parseTopLevelBlock(builderYml, 'nsis')

  it('nsis block references existing brand assets under resources/', () => {
    const keys = [
      'installerIcon',
      'uninstallerIcon',
      'installerHeader',
      'installerSidebar',
      'uninstallerSidebar',
      'include',
    ]
    for (const k of keys) {
      expect(nsis[k], `nsis.${k} must be set`).toBeDefined()
      const rel = String(nsis[k])
      const abs = join(resourcesDir, rel)
      expect(existsSync(abs), `${abs} must exist`).toBe(true)
    }
  })

  it('installerLanguages is zh_CN only (Chinese default)', () => {
    expect(nsis.installerLanguages).toEqual(['zh_CN'])
  })

  it('version-info LCID language is 2052 (zh-CN)', () => {
    expect(nsis.language).toBe('2052')
  })

  it('assisted installer contract preserved (oneClick false, change dir, shortcuts)', () => {
    expect(nsis.oneClick).toBe('false')
    expect(nsis.allowToChangeInstallationDirectory).toBe('true')
    expect(nsis.createDesktopShortcut).toBe('always')
    expect(nsis.createStartMenuShortcut).toBe('true')
    // perMachine must NOT be forced (preserve per-user/per-machine choice)
    expect(nsis.perMachine).toBeUndefined()
  })

  it('ICO assets are valid multi-size (>=256/48/32/16)', () => {
    for (const f of ['installerIcon.ico', 'uninstallerIcon.ico']) {
      const info = icoInfo(readFileSync(join(installerDir, f)))
      expect(info.ok, `${f} valid ICO`).toBe(true)
      expect((info as any).sizes).toEqual(expect.arrayContaining([256, 48, 32, 16]))
    }
  })

  it('sidebar BMPs are 164x314 24-bit', () => {
    for (const f of ['installerSidebar.bmp', 'uninstallerSidebar.bmp']) {
      const info = bmpInfo(readFileSync(join(installerDir, f)))
      expect(info.ok, `${f} valid BMP`).toBe(true)
      expect((info as any).width).toBe(164)
      expect((info as any).height).toBe(314)
      expect((info as any).bpp).toBe(24)
    }
  })

  it('header BMP is 150x57 24-bit', () => {
    const info = bmpInfo(readFileSync(join(installerDir, 'installerHeader.bmp')))
    expect(info.ok, 'header valid BMP').toBe(true)
    expect((info as any).width).toBe(150)
    expect((info as any).height).toBe(57)
    expect((info as any).bpp).toBe(24)
  })

  it('generator script exists (reproducibility)', () => {
    expect(existsSync(join(installerDir, 'generate_installer_assets.py'))).toBe(true)
  })
})

describe('installer branding — external config inheritance', () => {
  const externalYml = read(join(electronRoot, 'electron-builder.external.yml'))

  it('external config extends the base config', () => {
    expect(/^extends:\s*electron-builder\.yml\s*$/m.test(externalYml)).toBe(true)
  })

  it('external config does NOT override nsis (single source of branding)', () => {
    expect(/^nsis:/m.test(externalYml)).toBe(false)
    for (const k of [
      'installerIcon',
      'uninstallerIcon',
      'installerHeader',
      'installerSidebar',
      'uninstallerSidebar',
      'installerLanguages',
    ]) {
      expect(externalYml, `external must not redefine ${k}`).not.toMatch(
            new RegExp(`^\\s+${k}:`, 'm')
          )
    }
  })
})

describe('installer branding — silent/update safety (installer.nsh)', () => {
  const nsh = read(join(installerDir, 'installer.nsh'))
  const code = stripNshComments(nsh)

  it('has a ${Silent} guard (custom page safe in silent mode)', () => {
    expect(code).toContain('${Silent}')
    expect(code).toContain('Abort')
  })

  it('also guards the --updated path (isUpdated)', () => {
    expect(code).toContain('${isUpdated}')
  })

  it('contains NO MessageBox (no blocking dialogs)', () => {
    expect(code).not.toMatch(/MessageBox/)
  })

  it('uses real nsDialogs for the Tier2 custom page (not a stock MUI page)', () => {
    expect(code).toMatch(/nsDialogs::Create 1018/)
    expect(code).toMatch(/\$\{NSD_CreateLabel\}/)
    expect(code).toMatch(/PageEx custom/)
  })

  it('injects a branded welcome page via customWelcomePage', () => {
    expect(code).toMatch(/!macro customWelcomePage/)
    expect(code).toMatch(/MUI_PAGE_WELCOME/)
    expect(code).toMatch(/MUI_WELCOMEPAGE_TITLE/)
  })

  it('brands finish + uninstall pages via MUI text defines', () => {
    expect(code).toMatch(/MUI_FINISHPAGE_TITLE/)
    expect(code).toMatch(/MUI_UNWELCOMEPAGE_TITLE/)
    expect(code).toMatch(/MUI_UNFINISHPAGE_TITLE/)
  })

  it('file is UTF-8 without BOM (makensis -INPUTCHARSET UTF8)', () => {
    const buf = readFileSync(join(installerDir, 'installer.nsh'))
    const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
    expect(hasBom).toBe(false)
    // decodes as UTF-8 with Chinese (welcome + Tier2 ready page titles)
    expect(buf.toString('utf8')).toContain('欢迎安装 TAgent')
    expect(buf.toString('utf8')).toContain('准备安装 TAgent')
  })
})

describe('installer branding — Tier2 custom nsDialogs ready page', () => {
  const nsh = read(join(installerDir, 'installer.nsh'))
  const code = stripNshComments(nsh)

  it('defines the customPageAfterChangeDir hook (documented override point)', () => {
    // 源码级证据：app-builder-lib@26.15.3 templates/nsis/assistedInstaller.nsh 行 42-44
    //   !ifmacrodef customPageAfterChangeDir
    //     !insertmacro customPageAfterChangeDir
    //   !endif
    expect(code).toMatch(/!macro customPageAfterChangeDir/)
  })

  it('is a real PageEx custom page built with nsDialogs (not a stock MUI page)', () => {
    expect(code).toMatch(/PageEx custom/)
    expect(code).toMatch(/PageCallbacks TagentReadyPre TagentReadyLeave/)
    expect(code).toMatch(/Caption " "/)
    expect(code).toMatch(/nsDialogs::Create 1018/)
    expect(code).toMatch(/nsDialogs::Show/)
  })

  it('uses custom label controls with a custom-font brand title (layout + controls)', () => {
    expect(code).toMatch(/\$\{NSD_CreateLabel\}/)
    // 大标题：CreateFont(face/height/weight；italic 为 /ITALIC 标志位非数字，实测 NSIS 3.0.4.1)
    expect(code).toMatch(/CreateFont \$R2 "MS Shell Dlg" 22 700$/m)
    expect(code).toMatch(/SendMessage \$R1 0x0030 \$R2 0/)
    expect(code).toContain('准备安装 TAgent')
  })

  it('reads runtime install state for a genuine summary (path + scope)', () => {
    // 安装位置：与 instFilesPre 规整一致（StrContains 判定是否重复追加 APP_FILENAME）
    expect(code).toMatch(/\$\{StrContains\}/)
    expect(code).toMatch(/\$INSTDIR/)
    expect(code).toMatch(/\$\{APP_FILENAME\}/)
    // 安装范围：读取 multiUser 页设置的 $installMode（all / current）
    expect(code).toMatch(/\$installMode/)
    expect(code).toMatch(/为使用这台电脑的所有用户安装/)
    expect(code).toMatch(/仅为当前用户安装/)
  })

  it('has a dedicated ${Silent}/${isUpdated} guard on the ready page PRE', () => {
    // 两处自定义页 PRE 各有一道守卫（欢迎页 + 准备安装页）
    const silentCount = (code.match(/\$\{Silent\}/g) || []).length
    expect(silentCount).toBeGreaterThanOrEqual(2)
    expect(code).toMatch(/\$\{Silent\}[\s\S]*?Abort/)
    expect(code).toContain('${isUpdated}')
  })

  it('does NOT use MessageBox (no blocking dialogs)', () => {
    expect(code).not.toMatch(/MessageBox/)
  })

  it('does NOT perform install actions (read-only display; safe to skip)', () => {
    // 自定义页只读展示，不触碰安装状态/注册表/快捷方式/文件
    expect(code).not.toMatch(/CreateShortCut/)
    expect(code).not.toMatch(/WriteReg(Str|DWORD)/)
    expect(code).not.toMatch(/SetOutPath/)
    expect(code).not.toMatch(/(^|\n)\s*File\s/)
    expect(code).not.toMatch(/RMDir/)
    expect(code).not.toMatch(/(^|\n)\s*Section\b/)
  })

  it('preserves per-user/per-machine choice (no forced perMachine in nsh)', () => {
    expect(code).not.toMatch(/setInstallModePerAllUsers|INSTALL_MODE_PER_ALL_PAGES/)
  })
})

describe('installer branding — include-order contract (sharedHeader before MUI2)', () => {
  const nsh = read(join(installerDir, 'installer.nsh'))

  it('top-level (before first !macro) uses only !define — no LogicLib/nsDialogs/PageEx', () => {
    // 顶层（首个 !macro 之前）只允许 !define：installer.nsh 经 sharedHeader 先于
    // MUI2.nsh 引入，此时 LogicLib / nsDialogs 尚未可用。
    const firstMacro = nsh.search(/^!macro /m)
    expect(firstMacro).toBeGreaterThan(0)
    const preamble = nsh.slice(0, firstMacro)
    const preambleCode = stripNshComments(preamble)
    // 去注释后的顶层不应出现运行期指令 / LogicLib / nsDialogs
    expect(preambleCode).not.toMatch(/\$\{If\}/)
    expect(preambleCode).not.toMatch(/nsDialogs/)
    expect(preambleCode).not.toMatch(/^Function/m)
    expect(preambleCode).not.toMatch(/PageEx/)
    // 顶层应有品牌 MUI 文案 !define（在宏展开前预定义）
    expect(preambleCode).toMatch(/!define MUI_FINISHPAGE_TITLE/)
    expect(preambleCode).toMatch(/!define MUI_DIRECTORYPAGE_TEXT_TOP/)
  })
})
