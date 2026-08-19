#!/usr/bin/env node

/**
 * kswitch — kscc 账号切换 CLI 工具入口
 *
 * 解析 argv，分发子命令到 commands.js。
 * 用法: kwitch <command> [args...]
 */

'use strict'

const commands = require('../src/commands')

const argv = process.argv.slice(2)
const cmd = argv[0]

if (!cmd) {
  console.log('kswitch — kscc 账号切换工具')
  console.log('用法: kswitch <命令> [参数...]')
  console.log('')
  console.log('常用命令:')
  console.log('  kswitch list             列出账号')
  console.log('  kswitch use <名称>       切换到指定账号')
  console.log('  kswitch add <名称> <token>  添加账号')
  console.log('  kswitch current          查看当前账号')
  console.log('  kswitch help             显示完整帮助')
  console.log('')
  console.log('试试: kswitch help')
  process.exit(0)
}

if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
  commands.help()
  process.exit(0)
}

const commandMap = {
  list:         commands.list,
  ls:           commands.list,
  use:          commands.use,
  switch:       commands.use,
  current:      commands.current,
  cur:          commands.current,
  add:          commands.add,
  remove:       commands.remove,
  rm:           commands.remove,
  delete:       commands.remove,
  rename:       commands.rename,
  mv:           commands.rename,
  'import-kcwork': commands.importKcwork,
  import:       commands.importKcwork,
  completions:  commands.completions,
  comp:         commands.completions,
}

const handler = commandMap[cmd]
if (!handler) {
  console.error(`未知命令: ${cmd}`)
  console.error('用 kswitch help 查看可用命令。')
  process.exit(1)
}

// 传给子命令处理函数的 args（去掉 cmd 后的剩下参数）
handler(argv.slice(1))