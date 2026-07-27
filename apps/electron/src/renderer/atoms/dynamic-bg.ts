import { atom } from 'jotai'

const DYNAMIC_BG_KEY = 'tagent-dynamic-bg'

function getCached(): boolean {
  try {
    return localStorage.getItem(DYNAMIC_BG_KEY) === 'true'
  } catch {
    return false
  }
}

function cache(val: boolean): void {
  try {
    localStorage.setItem(DYNAMIC_BG_KEY, val ? 'true' : 'false')
  } catch {
    /* ignore */
  }
}

export const dynamicBgEnabledAtom = atom<boolean>(getCached())
