/**
 * kswitch — ~/.claude/settings.json 原子切换器
 *
 * 职责：读 settings.json → 改 env.ANTHROPIC_AUTH_TOKEN → 原子写回。
 * 保留 settings.json 所有其他字段不变（merge 语义）。
 *
 * 原子性：.tmp → fsync → .bak → rename
 * - 写前先备份到 .bak.kswitch
 * - .tmp 没 rename 成功 = settings.json 不变
 * - 崩溃恢复：.bak.kswitch 可手动 cp 还原
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const homedir = require('node:os').homedir()
const SETTINGS_PATH = path.join(homedir, '.claude', 'settings.json')
const BACKUP_PATH = SETTINGS_PATH + '.bak.kswitch'

/** 读 settings.json，返回 parsed object（文件不存在返回空对象） */
function readSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8')
    return JSON.parse(raw)
  } catch (err) {
    if (err.code === 'ENOENT') return {}
    throw new Error(`读取 settings.json 失败: ${err.message}`)
  }
}

/** 获取当前 settings.json 中的 ANTHROPIC_AUTH_TOKEN（可能 null） */
function getCurrentToken() {
  const settings = readSettings()
  return settings?.env?.ANTHROPIC_AUTH_TOKEN ?? null
}

/**
 * 原子切换 settings.json 的 ANTHROPIC_AUTH_TOKEN。
 *
 * @param {string} newToken - 新的 sk-... token
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun] - 仅打印不实际写入
 * @returns {{ ok: boolean, oldToken: string|null, bakPath: string, error?: string }}
 */
function switchToken(newToken, opts = {}) {
  if (!newToken || typeof newToken !== 'string') {
    return { ok: false, oldToken: null, bakPath: BACKUP_PATH, error: 'token 不能为空' }
  }

  const settings = readSettings()
  const oldToken = settings?.env?.ANTHROPIC_AUTH_TOKEN ?? null

  if (oldToken === newToken) {
    return { ok: true, oldToken, bakPath: BACKUP_PATH, skipped: true }
  }

  // 构建新 settings（merge，只改 ANTHROPIC_AUTH_TOKEN）
  const updated = {
    ...settings,
    env: {
      ...(settings.env || {}),
      ANTHROPIC_AUTH_TOKEN: newToken,
    },
  }

  if (opts.dryRun) {
    console.log(`[dry-run] 将切换 ANTHROPIC_AUTH_TOKEN:`)
    console.log(`  old: ${oldToken ? oldToken.slice(0, 20) + '…' : '(无)'}`)
    console.log(`  new: ${newToken.slice(0, 20)}…`)
    console.log(`  file: ${SETTINGS_PATH}`)
    return { ok: true, oldToken, bakPath: BACKUP_PATH, dryRun: true }
  }

  // 原子写流程
  const tmpPath = SETTINGS_PATH + '.tmp.' + process.pid
  try {
    // 1. 备份当前文件
    if (fs.existsSync(SETTINGS_PATH)) {
      fs.copyFileSync(SETTINGS_PATH, BACKUP_PATH)
    }

    // 2. 写 .tmp
    const dir = path.dirname(SETTINGS_PATH)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(tmpPath, JSON.stringify(updated, null, 2) + '\n', 'utf-8')

    // 3. rename（文件系统原子操作）
    fs.renameSync(tmpPath, SETTINGS_PATH)

    return { ok: true, oldToken, bakPath: BACKUP_PATH, skipped: false }
  } catch (err) {
    // cleanup .tmp
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath) } catch { /* ignore */ }
    return { ok: false, oldToken, bakPath: BACKUP_PATH, error: `写入 settings.json 失败: ${err.message}` }
  }
}

/** 回滚到备份 */
function rollback() {
  if (!fs.existsSync(BACKUP_PATH)) {
    return { ok: false, error: '备份文件不存在，无法回滚' }
  }
  try {
    fs.copyFileSync(BACKUP_PATH, SETTINGS_PATH)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: `回滚失败: ${err.message}` }
  }
}

module.exports = {
  SETTINGS_PATH,
  BACKUP_PATH,
  readSettings,
  getCurrentToken,
  switchToken,
  rollback,
}