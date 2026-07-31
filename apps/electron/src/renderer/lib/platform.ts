/**
 * 平台检测（对齐 TAgent_General lib/platform）
 * 记忆页拖拽安全区 / Windows 窗控避让用。
 */

export function detectIsWindows(): boolean {
  const platform =
    typeof navigator !== 'undefined' &&
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform
  if (typeof platform === 'string' && platform.toLowerCase().includes('win')) {
    return true
  }
  return typeof navigator !== 'undefined' && /win/i.test(navigator.platform || '')
}

export function detectIsMac(): boolean {
  const platform =
    typeof navigator !== 'undefined' &&
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform
  if (typeof platform === 'string' && platform.toLowerCase().includes('mac')) {
    return true
  }
  return typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || '')
}

export function detectIsLinux(): boolean {
  const platform =
    typeof navigator !== 'undefined' &&
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform
  if (typeof platform === 'string' && platform.toLowerCase().includes('linux')) {
    return true
  }
  return typeof navigator !== 'undefined' && /linux/i.test(navigator.platform || '')
}

export function getPlatform(): 'mac' | 'windows' | 'linux' {
  if (detectIsMac()) return 'mac'
  if (detectIsWindows()) return 'windows'
  if (detectIsLinux()) return 'linux'
  return 'windows'
}
