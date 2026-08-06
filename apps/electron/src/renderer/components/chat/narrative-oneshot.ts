/** kscc 整段落盘：空/短 → 大段跳变，需先 seed='' 再喂全文以驱动打字机 */
export function isOneShotTextJump(prevLen: number, nextLen: number): boolean {
  if (nextLen <= 40) return false
  const jump = nextLen - prevLen
  return prevLen === 0 || jump > Math.max(80, prevLen * 0.5)
}
