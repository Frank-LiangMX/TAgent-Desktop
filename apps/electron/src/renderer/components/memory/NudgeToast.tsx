/**
 * NudgeToast — 记忆 Nudge 用户通知（Phase 2.3）
 * 源：TAgent_General NudgeToast.tsx，适配 Desktop electronAPI。
 */
import { toast } from 'sonner'
import type { NudgeCandidate } from '@tagent/shared'

export function showNudgeToast(
  nudge: NudgeCandidate,
  sessionId: string,
  mode: 'general' | 'ta',
): string | number {
  if (nudge.type === 'correction') {
    void window.electronAPI.respondNudge(sessionId, nudge.id, 'accept', mode).catch(console.error)
    return toast(nudge.userMessage, { duration: 3000 })
  }

  return toast(nudge.userMessage, {
    duration: 5000,
    action: {
      label: '记住',
      onClick: async () => {
        await window.electronAPI.respondNudge(sessionId, nudge.id, 'accept', mode)
        toast.success('已记录', { duration: 2000 })
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

export function showNudgeToasts(
  nudges: NudgeCandidate[],
  sessionId: string,
  mode: 'general' | 'ta',
): void {
  for (let i = 0; i < nudges.length; i++) {
    const nudge = nudges[i]
    if (!nudge) continue
    setTimeout(() => {
      showNudgeToast(nudge, sessionId, mode)
    }, i * 1000)
  }
}
