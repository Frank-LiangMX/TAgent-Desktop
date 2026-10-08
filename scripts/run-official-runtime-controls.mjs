/** Build/run the local-only native-runtime smoke with Node HTTP semantics.
 * Bun's node:http compatibility does not reliably emit response/socket close
 * in the abort scenario, so it must not be used as the cancellation observer.
 * Uses the already-installed Electron workspace esbuild/SDK; no downloads.
 */
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

if (process.versions.bun) throw new Error('Run this smoke launcher with Node, not Bun')
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const electronRoot = join(repo, 'apps', 'electron')
const require = createRequire(join(electronRoot, 'package.json'))
const { build } = require('esbuild')
// Keep the bundle below apps/electron so the official SDK resolves from that
// workspace. A bundle in OS TEMP/scripts cannot resolve this dependency.
const buildDir = mkdtempSync(join(electronRoot, '.controls-smoke-'))
let timer
try {
  const outfile = join(buildDir, 'smoke.cjs')
  await build({
    entryPoints: [join(repo, 'scripts', 'official-runtime-controls-smoke.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile,
    external: ['@anthropic-ai/claude-agent-sdk', 'electron'], logLevel: 'silent',
  })
  const child = spawn(process.execPath, [outfile], { cwd: repo, windowsHide: true, stdio: 'inherit' })
  let timedOut = false
  timer = setTimeout(() => {
    timedOut = true
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } else child.kill('SIGKILL')
  }, 90_000)
  const code = await new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', resolveExit)
  })
  process.exitCode = timedOut || code === null ? 1 : code
} finally {
  clearTimeout(timer)
  rmSync(buildDir, { recursive: true, force: true })
}
