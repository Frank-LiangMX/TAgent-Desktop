/**
 * kswitch — 子命令实现
 *
 * 串联 store.js（账号管理） + settings.js（原子切换） + kcwork.js（KCwork 探测）。
 */

'use strict'

const store = require('./store')
const settings = require('./settings')
const kcwork = require('./kcwork')

/** kswitch list — 列出所有账号 */
function list() {
  const result = store.listAccounts()
  if (!result.ok) {
    console.error(result.error)
    process.exit(1)
  }

  if (result.accounts.length === 0) {
    console.log('没有已保存的 kscc 账号。使用 kswitch add <名称> <token> 添加。')
    return
  }

  console.log('已保存的 kscc 账号:')
  console.log('')
  for (const { name, token } of result.accounts) {
    const marker = name === result.active ? '*' : ' '
    const masked = token.length > 12 ? token.slice(0, 8) + '…' + token.slice(-4) : token
    console.log(`  ${marker} ${name}  (${masked})`)
  }
  console.log('')
  console.log('标记 * 的为当前活跃账号。')
  console.log(`当前 settings.json 中: ${settings.getCurrentToken() ? '有 token' : '无 token'}`)
}

/** kswitch use <name> — 切换到指定账号 */
function use(name) {
  if (!name) {
    console.error('用法: kswitch use <账号名>')
    process.exit(1)
  }

  const token = store.getToken(name)
  if (!token) {
    console.error(`账号「${name}」不存在。先用 kswitch add 添加，或用 kswitch list 查看已有账号。`)
    process.exit(1)
  }

  const result = settings.switchToken(token)
  if (!result.ok) {
    console.error(result.error)
    process.exit(1)
  }

  if (result.skipped) {
    // token 没变，但也更新活跃标记
    store.setActive(name)
    console.log(`已在「${name}」，无需切换。`)
    return
  }

  // 更新 store 中的活跃标记
  store.setActive(name)

  console.log(`✓ 已切换到「${name}」`)
  if (result.oldToken) {
    console.log(`旧 token: ${result.oldToken.slice(0, 12)}…${result.oldToken.slice(-4)}`)
  }
  console.log(`新 token: ${token.slice(0, 12)}…${token.slice(-4)}`)
  console.log(`备份: ${result.bakPath}`)
  console.log('')
  console.log('下次执行 kscc 命令将使用新账号。已在运行中的 kscc 进程不受影响。')
}

/** kwitch current — 显示当前账号 */
function current() {
  const active = store.getActive()
  const currentToken = settings.getCurrentToken()

  if (!active && !currentToken) {
    console.log('当前未使用任何已保存的 kscc 账号。')
    console.log('用 kswitch list 查看已保存账号，或用 kswitch add 添加。')
    return
  }

  if (active) {
    const token = store.getToken(active)
    const masked = token ? token.slice(0, 12) + '…' + token.slice(-4) : '(未知)'
    console.log(`当前活跃: ${active}  (${masked})`)
  } else {
    console.log('当前活跃: (未设置)')
  }

  if (currentToken) {
    console.log(`settings.json: ${currentToken.slice(0, 12)}…${currentToken.slice(-4)}`)
  }
}

/** kswitch add <name> <token> — 添加账号 */
function add(name, token) {
  if (!name || !token) {
    console.error('用法: kswitch add <账号名> <sk-… token>')
    process.exit(1)
  }

  const result = store.addAccount(name.trim(), token)
  if (!result.ok) {
    console.error(result.error)
    process.exit(1)
  }

  console.log(`✓ 已添加账号「${name.trim()}」`)
  if (result.active === name.trim()) {
    console.log('（已自动设为当前活跃账号）')
  }
}

/** kswitch remove <name> — 删除账号 */
function remove(name) {
  if (!name) {
    console.error('用法: kswitch remove <账号名>')
    process.exit(1)
  }

  const result = store.removeAccount(name.trim())
  if (!result.ok) {
    console.error(result.error)
    process.exit(1)
  }

  console.log(`✓ 已删除账号「${name.trim()}」`)
}

/** kswitch rename <old> <new> — 重命名账号 */
function rename(oldName, newName) {
  if (!oldName || !newName) {
    console.error('用法: kswitch rename <旧名> <新名>')
    process.exit(1)
  }

  const result = store.renameAccount(oldName.trim(), newName.trim())
  if (!result.ok) {
    console.error(result.error)
    process.exit(1)
  }

  console.log(`✓ 已重命名「${oldName.trim()}」→「${newName.trim()}」`)
}

/** kswitch import-kcwork — 导入 KCwork 账号 */
function importKcwork() {
  if (!kcwork.exists()) {
    console.error('未检测到 KCwork 凭证文件。')
    console.log(`路径: ${kcwork.CRED_PATH}`)
    process.exit(1)
  }

  const detected = kcwork.detect()
  if (!detected.ok) {
    console.error(detected.error)
    process.exit(1)
  }

  // 检查是否已存在
  const existing = store.listAccounts()
  if (existing.ok && existing.accounts.some(a => a.token === detected.token)) {
    console.log('KCwork 账号已导入过，无需重复导入。')
    console.log(`用 kswitch use "${detected.name}" 切换到该账号。`)
    return
  }

  const result = store.addAccount(detected.name, detected.token)
  if (!result.ok) {
    console.error(`导入 KCwork 账号失败: ${result.error}`)
    process.exit(1)
  }

  console.log(`✓ 已从 KCwork 导入账号「${detected.name}」`)
  console.log(`  token: ${detected.token.slice(0, 12)}…${detected.token.slice(-4)}`)
  if (detected.baseApi) {
    console.log(`  baseApi: ${detected.baseApi}`)
  }
  console.log('')
  console.log(`用 kswitch use "${detected.name}" 切换到该账号。`)
}

/** kswitch help — 显示帮助 */
function help() {
  console.log(`
kswitch — kscc 账号切换工具

用法:
  kswitch list                  列出所有保存的 kscc 账号
  kswitch use <账号名>          切换到指定账号
  kswitch current               显示当前使用的账号
  kswitch add <账号名> <token>   添加新账号
  kswitch remove <账号名>        删除账号
  kswitch rename <旧名> <新名>   重命名账号
  kswitch import-kcwork          从 KCwork 导入凭证
  kswitch completions [shell]    生成命令补全脚本 (bash/zsh)
  kswitch help                   显示此帮助

示例:
  kswitch add main sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
  kswitch add kcwork sk-yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy
  kswitch use kcwork
  kswitch list
  kswitch current

工作原理:
  kswitch 通过修改 ~/.claude/settings.json 的 env.ANTHROPIC_AUTH_TOKEN
  来切换 kscc CLI 使用的账号。切换原子安全，留有备份。
  备份位于 ~/.claude/settings.json.bak.kswitch。

  kscc 费用页面: https://kscc.ksyun.com/#/usage?cc=seasun
`.trim())
}

/** kswitch completions — 生成 shell 自动补全脚本 */
function completions(shell) {
  const s = (shell && shell[0]) || 'bash'
  const cmds = ['list', 'use', 'current', 'add', 'remove', 'rename', 'import-kcwork', 'completions', 'help']
  const cmdsText = cmds.join(' ')
  const storeModule = require.resolve('./store')

  if (s === 'zsh') {
    console.log(`# kswitch zsh completion
# 添加到 ~/.zshrc:  source <(kswitch completions zsh)
_kswitch() {
  local -a subcmds
  subcmds=(
    'list:列出账号'
    'use:切换到指定账号'
    'current:显示当前账号'
    'add:添加新账号'
    'remove:删除账号'
    'rename:重命名账号'
    'import-kcwork:从 KCwork 导入凭证'
    'completions:生成补全脚本'
    'help:显示帮助'
  )
  _describe 'kswitch' subcmds
}
compdef _kswitch kswitch
`)
  } else {
    console.log(`# kswitch bash completion
# 添加到 ~/.bashrc:  source <(kswitch completions bash)
_kswitch_completions() {
  local cur=\${COMP_WORDS[COMP_CWORD]}
  local opts="${cmdsText}"

  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=($(compgen -W "\${opts}" -- "\${cur}"))
  elif [[ "\${COMP_WORDS[1]}" == "use" || "\${COMP_WORDS[1]}" == "remove" || "\${COMP_WORDS[1]}" == "rename" ]]; then
    local accounts=$(node -e "try{const s=require('${storeModule}');const r=s.listAccounts();if(r.ok)console.log(r.accounts.map(a=>a.name).join(' '))}catch(e){}")
    COMPREPLY=($(compgen -W "\${accounts}" -- "\${cur}"))
  fi
}
complete -F _kswitch_completions kswitch
`)
  }
}

module.exports = {
  list:  () => list(),
  use:   (args) => use(args[0]),
  current: () => current(),
  add:   (args) => add(args[0], args[1]),
  remove: (args) => remove(args[0]),
  rename: (args) => rename(args[0], args[1]),
  importKcwork: () => importKcwork(),
  completions: (args) => completions(args),
  help:  () => help(),
}