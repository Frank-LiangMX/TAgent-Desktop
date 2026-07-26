/**
 * 工作区路径工具
 *
 * sanitizePath：项目路径 → 目录名（对齐 kscc 的 sanitized-cwd 算法）
 * - 非字母数字替换为 `-`
 * - 超过 200 字符截断并加 DJB2 hash 后缀
 *
 * 例：F:\TAgent-General → F--TAgent-General
 */

/** DJB2 字符串哈希（与 kscc 一致） */
function djb2Hash(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
  }
  return hash
}

/**
 * 项目路径 → sanitize 后的目录名
 *
 * 算法对齐 kscc 的 AP() 函数：
 * 1. 非字母数字替换为 `-`
 * 2. ≤200 字符直接返回
 * 3. >200 字符截断前 200 + `-` + DJB2 hash（36 进制）
 */
export function sanitizePath(projectPath: string): string {
  const sanitized = projectPath.replace(/[^a-zA-Z0-9]/g, '-')
  if (sanitized.length <= 200) return sanitized
  const hash = Math.abs(djb2Hash(projectPath)).toString(36)
  return `${sanitized.slice(0, 200)}-${hash}`
}
