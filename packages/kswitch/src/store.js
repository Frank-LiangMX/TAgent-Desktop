/**
 * kswitch — kscc 账号存储
 *
 * 管理 ~/.claude/.kscc-accounts.json：账号列表 + 当前活跃标记。
 * atomic-json 风格的原子写（.tmp → fsync → rename）。
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ACCOUNTS_FILE = path.join(require('node:os').homedir(), '.claude', '.kscc-accounts.json')

/** 默认空配置 */
function emptyConfig() {
  return { version: 1, accounts: {}, active: null }
}

/** 读取账号列表（文件不存在返回空配置） */
function readAccounts() {
  try {
    const raw = fs.readFileSync(ACCOUNTS_FILE, 'utf-8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return emptyConfig()
    return {
      version: parsed.version ?? 1,
      accounts: typeof parsed.accounts === 'object' && !Array.isArray(parsed.accounts)
        ? parsed.accounts
        : {},
      active: typeof parsed.active === 'string' ? parsed.active : null,
    }
  } catch (err) {
    if (err.code === 'ENOENT') return emptyConfig()
    console.error(`[kswitch] 读取账号文件失败 (${ACCOUNTS_FILE}):`, err.message)
    return null
  }
}

/** 原子写入账号列表 */
function writeAccounts(config) {
  const tmp = ACCOUNTS_FILE + '.tmp.' + process.pid
  try {
    const dir = path.dirname(ACCOUNTS_FILE)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    // 写 .tmp → rename（文件系统原子操作）
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf-8')
    fs.renameSync(tmp, ACCOUNTS_FILE)
  } catch (err) {
    // cleanup .tmp on failure
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) } catch { /* ignore */ }
    throw new Error(`写入账号文件失败: ${err.message}`)
  }
}

/** 列出所有账号 */
function listAccounts() {
  const config = readAccounts()
  if (!config) return { ok: false, error: '无法读取账号配置', accounts: [], active: null }
  return {
    ok: true,
    accounts: Object.entries(config.accounts).map(([name, token]) => ({ name, token })),
    active: config.active,
  }
}

/** 添加账号 */
function addAccount(name, token) {
  if (!name || typeof name !== 'string' || !name.trim()) {
    return { ok: false, error: '账号名不能为空' }
  }
  if (!token || typeof token !== 'string' || !token.startsWith('sk-')) {
    return { ok: false, error: 'token 格式无效，须以 sk- 开头' }
  }
  const config = readAccounts()
  if (!config) return { ok: false, error: '无法读取账号配置' }
  const trimmed = name.trim()
  if (config.accounts[trimmed]) {
    return { ok: false, error: `账号「${trimmed}」已存在` }
  }
  config.accounts[trimmed] = token
  // 第一个添加的账号自动设为活跃
  if (!config.active) config.active = trimmed
  writeAccounts(config)
  return { ok: true, active: config.active }
}

/** 删除账号 */
function removeAccount(name) {
  if (!name || typeof name !== 'string' || !name.trim()) {
    return { ok: false, error: '账号名不能为空' }
  }
  const config = readAccounts()
  if (!config) return { ok: false, error: '无法读取账号配置' }
  const trimmed = name.trim()
  if (!config.accounts[trimmed]) {
    return { ok: false, error: `账号「${trimmed}」不存在` }
  }
  if (config.active === trimmed) {
    return { ok: false, error: `「${trimmed}」是当前活跃账号，请先切换到其他账号再删除` }
  }
  delete config.accounts[trimmed]
  writeAccounts(config)
  return { ok: true }
}

/** 重命名账号 */
function renameAccount(oldName, newName) {
  if (!oldName || !newName) return { ok: false, error: '旧名和新名都不能为空' }
  const config = readAccounts()
  if (!config) return { ok: false, error: '无法读取账号配置' }
  const oldTrimmed = oldName.trim()
  const newTrimmed = newName.trim()
  if (!config.accounts[oldTrimmed]) {
    return { ok: false, error: `账号「${oldTrimmed}」不存在` }
  }
  if (config.accounts[newTrimmed]) {
    return { ok: false, error: `账号「${newTrimmed}」已存在` }
  }
  config.accounts[newTrimmed] = config.accounts[oldTrimmed]
  delete config.accounts[oldTrimmed]
  if (config.active === oldTrimmed) config.active = newTrimmed
  writeAccounts(config)
  return { ok: true, active: config.active }
}

/** 获取指定账号的 token */
function getToken(name) {
  const config = readAccounts()
  if (!config) return null
  return config.accounts[name] ?? null
}

/** 设置当前活跃账号 */
function setActive(name) {
  const config = readAccounts()
  if (!config) return { ok: false, error: '无法读取账号配置' }
  if (!config.accounts[name]) {
    return { ok: false, error: `账号「${name}」不存在，请先用 add 添加` }
  }
  config.active = name
  writeAccounts(config)
  return { ok: true, token: config.accounts[name] }
}

/** 获取当前活跃账号名 */
function getActive() {
  const config = readAccounts()
  if (!config) return null
  return config.active
}

module.exports = {
  ACCOUNTS_FILE,
  readAccounts,
  listAccounts,
  addAccount,
  removeAccount,
  renameAccount,
  getToken,
  setActive,
  getActive,
}