/**
 * 启动 electronmon。
 * Cursor / 部分 IDE 会注入 ELECTRON_RUN_AS_NODE=1，导致主进程里 require('electron') 拿到 npm 路径而非 API。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

delete process.env.ELECTRON_RUN_AS_NODE

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const electronmonBin = require.resolve('electronmon/bin/cli.js')

const child = spawn(process.execPath, [electronmonBin, '.'], {
  cwd: appRoot,
  stdio: 'inherit',
  env: process.env,
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 0)
})
