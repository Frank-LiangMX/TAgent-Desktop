/**
 * MOA 班底预置刷新信号。
 *
 * 设置页保存后递增，所有已挂载的会话发送菜单据此重新读取主进程预置，
 * 避免会话不重挂载时仍展示保存前的席位数量。
 */
import { atom } from 'jotai'

export const moaPresetsRevisionAtom = atom(0)

export const bumpMoaPresetsRevisionAtom = atom(null, (get, set) => {
  set(moaPresetsRevisionAtom, get(moaPresetsRevisionAtom) + 1)
})
