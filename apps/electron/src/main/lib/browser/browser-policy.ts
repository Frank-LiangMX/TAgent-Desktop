const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])
const ALLOWED_SPECIAL_URLS = new Set(['about:blank'])

export function normalizeBrowserUrl(input: string): string {
  const value = String(input ?? '').trim()
  if (ALLOWED_SPECIAL_URLS.has(value)) return value
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('浏览器只允许打开完整的 http(s) URL')
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error('浏览器只允许访问 http(s) 网页')
  }
  return parsed.toString()
}

export function isAllowedBrowserUrl(input: string): boolean {
  try {
    normalizeBrowserUrl(input)
    return true
  } catch {
    return false
  }
}
