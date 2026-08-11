import { describe, expect, test } from 'vitest'
import { createStore } from 'jotai/vanilla'
import { createJSONStorage } from 'jotai/utils'
import {
  CHAT_PROCESS_DISPLAY_MODES,
  CHAT_PROCESS_DISPLAY_MODE_STORAGE_KEY,
  CHAT_PROCESS_DISPLAY_MODE_STORAGE_KEY_V1,
  chatProcessDisplayModeAtom,
  DEFAULT_CHAT_PROCESS_DISPLAY_MODE,
} from './chat-display-prefs'

/**
 * 过程展示偏好默认值 / 持久化 / 切换的最小回归守卫。
 *
 * node 环境无 window/localStorage：生产 atom 用 jotai 默认 storage（getStringStorage
 * 退化为 undefined → getItem 回退默认、setItem no-op），不订阅则不触发 onMount 读取，
 * 故 store.get(atom) 直接拿到 baseAtom 初始值＝默认值。存储契约另用 createJSONStorage
 * + 内存存储验证（与生产 atom 同 key 同默认，仅 storage 后端不同＝对 localStorage 的常规 mock）。
 */

describe('chatProcessDisplayModeAtom 默认与持久化', () => {
  test('无显式选择 / 旧配置缺失 → 默认简洁', () => {
    const store = createStore()
    expect(store.get(chatProcessDisplayModeAtom)).toBe('concise')
    expect(DEFAULT_CHAT_PROCESS_DISPLAY_MODE).toBe('concise')
  })

  test('v1 残留的完整不影响 v2：仍回退默认简洁', () => {
    const mem = makeMemStorage()
    const storage = createJSONStorage(() => mem)
    // 模拟升级前写在 v1 key 的 full
    mem.setItem(CHAT_PROCESS_DISPLAY_MODE_STORAGE_KEY_V1, JSON.stringify('full'))
    expect(
      storage.getItem(CHAT_PROCESS_DISPLAY_MODE_STORAGE_KEY, DEFAULT_CHAT_PROCESS_DISPLAY_MODE),
    ).toBe('concise')
  })

  test('v2 显式保存为完整 → 仍为完整，默认不强制覆盖', () => {
    const mem = makeMemStorage()
    const storage = createJSONStorage(() => mem)
    expect(
      storage.getItem(CHAT_PROCESS_DISPLAY_MODE_STORAGE_KEY, DEFAULT_CHAT_PROCESS_DISPLAY_MODE),
    ).toBe('concise')
    mem.setItem(CHAT_PROCESS_DISPLAY_MODE_STORAGE_KEY, JSON.stringify('full'))
    expect(
      storage.getItem(CHAT_PROCESS_DISPLAY_MODE_STORAGE_KEY, DEFAULT_CHAT_PROCESS_DISPLAY_MODE),
    ).toBe('full')
  })

  test('切换行为正常：写入持久化，可在完整/简洁间互切', () => {
    const mem = makeMemStorage()
    const storage = createJSONStorage(() => mem)
    storage.setItem(CHAT_PROCESS_DISPLAY_MODE_STORAGE_KEY, 'concise')
    expect(mem.getItem(CHAT_PROCESS_DISPLAY_MODE_STORAGE_KEY)).toBe(JSON.stringify('concise'))
    storage.setItem(CHAT_PROCESS_DISPLAY_MODE_STORAGE_KEY, 'full')
    expect(mem.getItem(CHAT_PROCESS_DISPLAY_MODE_STORAGE_KEY)).toBe(JSON.stringify('full'))
    expect(
      storage.getItem(CHAT_PROCESS_DISPLAY_MODE_STORAGE_KEY, DEFAULT_CHAT_PROCESS_DISPLAY_MODE),
    ).toBe('full')
  })

  test('持久化 key 为 v2，刻意不读 v1（避免旧默认 full 残留）', () => {
    expect(CHAT_PROCESS_DISPLAY_MODE_STORAGE_KEY).toBe('tagent:chatProcessDisplayMode:v2')
    expect(CHAT_PROCESS_DISPLAY_MODE_STORAGE_KEY_V1).toBe('tagent:chatProcessDisplayMode')
  })

  test('完整模式仍可手动选择，未隐藏/删除', () => {
    expect(CHAT_PROCESS_DISPLAY_MODES).toEqual(['concise', 'full'])
    expect(CHAT_PROCESS_DISPLAY_MODES).toContain('full')
    expect(CHAT_PROCESS_DISPLAY_MODES).toContain('concise')
  })
})

/** 轻量同步内存存储，模拟 localStorage 的 getItem/setItem/removeItem */
function makeMemStorage(): {
  getItem: (k: string) => string | null
  setItem: (k: string, v: string) => void
  removeItem: (k: string) => void
} {
  const map = new Map<string, string>()
  return {
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => {
      map.set(k, v)
    },
    removeItem: (k) => {
      map.delete(k)
    },
  }
}
