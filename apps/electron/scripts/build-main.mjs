/**
 * Bundle Electron main process → dist/main.cjs (CJS).
 *
 * Pi stack (@tagent/pi-core, @earendil-works/pi-ai, pi-agent-core) is ESM-only
 * (package.json exports often lack "require"). Must be bundled into main.cjs —
 * do NOT mark them external or Electron dies on startup with
 * ERR_PACKAGE_PATH_NOT_EXPORTED before any window opens.
 *
 * Keep external: electron, claude-agent-sdk (native/SDK), better-sqlite3, node-pty.
 * --ignore-annotations: respect pi-ai provider side-effect bare imports.
 */
import * as esbuild from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const watch = process.argv.includes('--watch')

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [join(root, 'src/main/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: join(root, 'dist/main.cjs'),
  external: [
    'electron',
    '@anthropic-ai/claude-agent-sdk',
    '@anthropic-ai/claude-agent-sdk/*',
    'better-sqlite3',
    'node-pty',
  ],
  // Keep bare side-effect imports like `@earendil-works/pi-ai/providers/deepseek`
  ignoreAnnotations: true,
  logLevel: 'info',
}

if (watch) {
  const ctx = await esbuild.context(options)
  await ctx.watch()
  console.log('[build-main] watching…')
} else {
  await esbuild.build(options)
  console.log('[build-main] ok → dist/main.cjs')
}
