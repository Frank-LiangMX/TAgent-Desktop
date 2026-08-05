/**
 * Bundle Electron main process → dist/main.cjs (CJS).
 *
 * Pi stack (@tagent/pi-core, @earendil-works/pi-ai, pi-agent-core) is ESM-only
 * (package.json exports often lack "require"). Must be bundled into main.cjs —
 * do NOT mark them external or Electron dies on startup with
 * ERR_PACKAGE_PATH_NOT_EXPORTED before any window opens.
 *
 * Keep external (内网 / 默认): electron, claude-agent-sdk (native/SDK), better-sqlite3, node-pty.
 * --ignore-annotations: respect pi-ai provider side-effect bare imports.
 *
 * ── 对外版开关 TAGENT_EXTERNAL=1 ──
 * 当 process.env.TAGENT_EXTERNAL 为 '1' / 'true' 时：
 * - 不再 external @anthropic-ai/claude-agent-sdk（避免产物里 require 缺失包）
 * - 用 esbuild plugin 把 adapters/claude/* 与 claude-agent-sdk 指到
 *   scripts/stubs/kscc-external-stub.ts（构建期排除，源码不删）
 * - 配合 electron-builder.external.yml 从安装包排除 claude-agent-sdk* 原生包
 * 本地：bun run package:win:external
 * 内网双核：bun run package:win（默认，不设 TAGENT_EXTERNAL）
 */
import * as esbuild from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const watch = process.argv.includes('--watch')

const isExternalBuild =
  process.env.TAGENT_EXTERNAL === '1' || process.env.TAGENT_EXTERNAL === 'true'

const stubPath = join(root, 'scripts/stubs/kscc-external-stub.ts')

/**
 * 对外构建：把 kscc 核入口与 Claude Agent SDK 解析到 stub。
 * 不删源码，仅构建图上替换。
 *
 * 匹配的是 import 源串（如 `./claude/xxx`、`@anthropic-ai/claude-agent-sdk`），
 * 不是最终绝对路径。用简单 includes，避免 RE2/路径分隔符边角。
 */
function createExternalKsccPlugin() {
  const stubbed = []
  const shouldStub = (importPath) => {
    const p = importPath.replace(/\\/g, '/')
    if (p === '@anthropic-ai/claude-agent-sdk' || p.startsWith('@anthropic-ai/claude-agent-sdk/')) {
      return true
    }
    // adapters/claude 下的入口模块（相对路径写法不一）
    if (
      /(?:^|\/)claude\/(?:claude-agent-adapter|kscc-path|spawn-kscc|kscc-message-adapter)(?:\.[cm]?[jt]sx?)?$/.test(
        p,
      )
    ) {
      return true
    }
    return false
  }

  return {
    name: 'tagent-external-kscc-stub',
    setup(build) {
      build.onResolve({ filter: /claude/ }, (args) => {
        if (!shouldStub(args.path)) return
        stubbed.push(`${args.kind}:${args.path}`)
        return { path: stubPath }
      })
      build.onEnd(() => {
        console.log(
          `[build-main] external stub redirected ${stubbed.length} import(s):`,
          stubbed.join(', ') || '(none)',
        )
      })
    },
  }
}

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [join(root, 'src/main/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: join(root, 'dist/main.cjs'),
  // 内网：SDK 运行时 require（electron-builder 会打进 node_modules）
  // 对外：SDK 走 stub 打进 main.cjs，不再 external
  external: [
    'electron',
    ...(isExternalBuild
      ? []
      : ['@anthropic-ai/claude-agent-sdk', '@anthropic-ai/claude-agent-sdk/*']),
    'better-sqlite3',
    'node-pty',
  ],
  plugins: isExternalBuild ? [createExternalKsccPlugin()] : [],
  // Keep bare side-effect imports like `@earendil-works/pi-ai/providers/deepseek`
  ignoreAnnotations: true,
  logLevel: 'info',
  define: {
    // 便于运行时探测（与构建开关一致；dev 默认 '0'）
    'process.env.TAGENT_EXTERNAL': JSON.stringify(isExternalBuild ? '1' : '0'),
  },
}

if (watch) {
  if (isExternalBuild) {
    console.log('[build-main] TAGENT_EXTERNAL=1 — kscc/claude-agent-sdk → stub')
  }
  const ctx = await esbuild.context(options)
  await ctx.watch()
  console.log('[build-main] watching…')
} else {
  if (isExternalBuild) {
    console.log('[build-main] TAGENT_EXTERNAL=1 — kscc 核与 claude-agent-sdk 使用 stub，不进对外 bundle')
  }
  await esbuild.build(options)
  console.log(
    isExternalBuild
      ? '[build-main] ok → dist/main.cjs (external / Pi-only)'
      : '[build-main] ok → dist/main.cjs (dual-core)',
  )
}
