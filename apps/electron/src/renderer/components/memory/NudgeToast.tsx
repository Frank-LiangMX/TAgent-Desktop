/**
 * NudgeToast - Nudge 机制的用户通知组件
 *
 * 根据设计文档 §6.5.4：
 * - 不打断对话，5s 自动消失
 * - 用户点"记" / "不记" / "稍后"
 * - 使用 sonner toast 实现
 *
 * 历史 bug：2026-07-05 之前 correction 类型只显示 3s 提示就 return，
 * 注释说"自动记录"但代码没自动 accept → 即使字段名 bug 修了，L3 仍不会被写。
 * 现已对 correction 类型显式调 respondNudge('accept') 完成自动记录。
 */

import { toast } from 'sonner'

import type { NudgeCandidate } from '@tagent/shared'

/**
 * 显示 Nudge 通知
 *
 * @param nudge Nudge 候选项
 * @param sessionId 会话 ID
 * @param mode 记忆模式
 * @returns toast ID
 */
export function showNudgeToast(
  nudge: NudgeCandidate,
  sessionId: string,
  mode: 'general' | 'ta'
): string | number {
  // 纠正类型：自动记录（设计文档要求 L3 自动写），但仍调 respondNudge('accept')
  // 触发主进程落盘。历史 bug：之前只显示 3s 提示没调 accept，导致 L3 永不写入。
  if (nudge.type === 'correction') {
    void window.electronAPI.respondNudge(sessionId, nudge.id, 'accept', mode).catch(console.error)
    return toast(nudge.userMessage, {
      duration: 3000,
    })
  }

  // 交互型：仍用 toast，但更扁、更短，减少挡内容
  return toast(nudge.userMessage, {
    duration: 4500,
    position: 'top-center',
    className: 'status-nudge-toast',
    action: {
      label: '记住',
      onClick: async () => {
        await window.electronAPI.respondNudge(sessionId, nudge.id, 'accept', mode)
        toast.success('已记录', { duration: 1500, position: 'top-center' })
      },
    },
    cancel: {
      label: '不记',
      onClick: async () => {
        await window.electronAPI.respondNudge(sessionId, nudge.id, 'reject', mode)
      },
    },
  })
}

/**
 * 显示批量 Nudge 通知
 *
 * @param nudges Nudge 候选项列表
 * @param sessionId 会话 ID
 * @param mode 记忆模式
 */
export function showNudgeToasts(
  nudges: NudgeCandidate[],
  sessionId: string,
  mode: 'general' | 'ta'
): void {
  // 串行显示，避免重叠
  for (let i = 0; i < nudges.length; i++) {
    const nudge = nudges[i]
    if (!nudge) continue
    // 间隔 1 秒显示下一个
    setTimeout(() => {
      showNudgeToast(nudge, sessionId, mode)
    }, i * 1000)
  }
}
