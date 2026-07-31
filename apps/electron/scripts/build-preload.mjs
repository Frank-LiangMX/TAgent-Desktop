/**
 * Bundle Electron preload → dist/preload.cjs (CJS).
 */
import * as esbuild from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const watch = process.argv.includes('--watch')

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [join(root, 'src/preload/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: join(root, 'dist/preload.cjs'),
  external: ['electron'],
  logLevel: 'info',
}

if (watch) {
  const ctx = await esbuild.context(options)
  await ctx.watch()
  console.log('[build-preload] watching…')
} else {
  await esbuild.build(options)
  console.log('[build-preload] ok → dist/preload.cjs')
}
