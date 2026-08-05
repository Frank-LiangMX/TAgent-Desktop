/**
 * 对外版 Windows 打包入口（跨 shell 可靠设置 TAGENT_EXTERNAL=1）。
 *
 * 流程与 package:win 对齐：rebuild:native → build(with TAGENT_EXTERNAL) → electron-builder.external.yml
 * 勿在 dev 默认路径调用；内网双核请用 package:win。
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const env = { ...process.env, TAGENT_EXTERNAL: '1' }

function run(cmd, args) {
  console.log(`[package:win:external] $ ${cmd} ${args.join(' ')}`)
  const r = spawnSync(cmd, args, { cwd: root, env, stdio: 'inherit', shell: true })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

// bun 在 PATH 上；与 package.json 其它 script 一致
run('bun', ['run', 'rebuild:native'])
run('bun', ['run', 'build'])
run('bunx', [
  'electron-builder',
  '--win',
  '--x64',
  '--publish',
  'never',
  '--config',
  'electron-builder.external.yml',
])
console.log('[package:win:external] done')
