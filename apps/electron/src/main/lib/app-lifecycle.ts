/**
 * 应用生命周期共享状态
 *
 * 区分「关窗隐藏到托盘」与「真正退出应用」。
 * close 事件里读 getIsQuitting()：false → preventDefault + hide；true → 允许销毁。
 */

let _isQuitting = false

export function getIsQuitting(): boolean {
  return _isQuitting
}

export function setQuitting(value = true): void {
  _isQuitting = value
}
