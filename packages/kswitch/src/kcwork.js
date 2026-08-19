/**
 * kswitch — KCwork 凭证探测器
 *
 * 读取 ~/AppData/Roaming/kcwork/kscc-credential.json，
 * 解码 b64: 前缀的 sk，返回标准 sk- token。
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const homedir = require('node:os').homedir()
const CRED_PATH = path.join(homedir, 'AppData', 'Roaming', 'kcwork', 'kscc-credential.json')

/** 解码 b64: 前缀包装的 token */
function decodeB64Token(raw) {
  if (!raw || typeof raw !== 'string') return null

  // 只有 b64: 前缀才解码；无前缀视为直通
  if (raw.startsWith('b64:')) {
    const b64data = raw.slice(4)
    try {
      // base64 decode，补 padding
      const padded = b64data + '='.repeat((4 - (b64data.length % 4)) % 4)
      const decoded = Buffer.from(padded, 'base64').toString('utf-8')
      return decoded
    } catch (err) {
      return null
    }
  }

  // 无 b64: 前缀，当明文 sk- 返回
  return raw.startsWith('sk-') ? raw : null
}

/** 探测 KCwork 凭证文件是否存在 */
function exists() {
  try {
    return fs.existsSync(CRED_PATH)
  } catch {
    return false
  }
}

/**
 * 读取并解码 KCwork 凭证。
 * @returns {{ ok: boolean, token?: string, name?: string, error?: string }}
 */
function detect() {
  if (!exists()) {
    return { ok: false, error: `KCwork 凭证文件不存在 (${CRED_PATH})` }
  }

  try {
    const raw = fs.readFileSync(CRED_PATH, 'utf-8')
    const cred = JSON.parse(raw)

    if (!cred.sk) {
      return { ok: false, error: 'KCwork 凭证文件缺少 sk 字段' }
    }

    const token = decodeB64Token(cred.sk)
    if (!token) {
      return {
        ok: false,
        error: `KCwork sk 解码失败（格式不识别: ${cred.sk.slice(0, 10)}…）。可能 KCwork 升级改了凭证格式。`,
      }
    }

    if (!token.startsWith('sk-')) {
      return { ok: false, error: '解码后的 token 不符合 sk- 格式' }
    }

    return {
      ok: true,
      token,
      name: 'KCwork 备选',
      baseApi: cred.baseApi || null,
    }
  } catch (err) {
    return { ok: false, error: `读取 KCwork 凭证失败: ${err.message}` }
  }
}

module.exports = {
  CRED_PATH,
  decodeB64Token,
  exists,
  detect,
}