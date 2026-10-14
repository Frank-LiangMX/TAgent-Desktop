import { createDecipheriv } from 'node:crypto'

/** WPS 应用凭据只在主进程使用；APPKEY 不进入 renderer、IPC 返回值或模型上下文。 */
const BUILTIN_APP_ID = 'AK20260708DASRKI'
const BUILTIN_SECRET_ENC = 'edb8d30e135ba0eab88b0274dac1d23b9ac790b1dad375f7f51a74b5b53f40fe'
const BUILTIN_SECRET_KEY = 'tagent-wps-2024'

function decodeBuiltinSecret(): string {
  try {
    const key = Buffer.from(BUILTIN_SECRET_KEY.padEnd(16).slice(0, 16))
    const decipher = createDecipheriv('aes-128-ecb', key, null)
    // 旧项目把密钥明文作为 ASCII 十六进制字符串加密，解密时需要保留字符串本身。
    return decipher.update(BUILTIN_SECRET_ENC, 'hex', 'hex') + decipher.final('hex')
  } catch {
    return ''
  }
}

export function getWpsAppCredentials(): { appId: string; secretKey: string } {
  return {
    appId: process.env.TAGENT_WPS_APP_ID?.trim() || BUILTIN_APP_ID,
    secretKey: process.env.TAGENT_WPS_SECRET_KEY || decodeBuiltinSecret(),
  }
}
