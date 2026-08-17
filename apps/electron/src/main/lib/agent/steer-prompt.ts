/**
 * 运行中引导：给模型的包装文案 + 回声去重。
 * 面板仍存用户原文；注入 channel / 下一轮 prompt 时加上标记，避免被当成新开一轮。
 */

export function wrapSteerPromptForModel(text: string): string {
  const t = text.trim()
  return (
    '【用户引导】当前任务仍在进行。请立刻按下面这条补充调整后续行动，' +
    '不要当成全新问题重开一轮。\n\n' +
    t
  )
}

export function isSteerPromptEcho(incoming: string, original: string): boolean {
  const a = incoming.trim()
  const b = original.trim()
  if (!a || !b) return false
  if (a === b) return true
  return a.includes('【用户引导】') && a.includes(b)
}

export function extractSdkUserText(msg: {
  message?: { content?: unknown }
  content?: unknown
}): string {
  const content = msg.message?.content ?? msg.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return ''
      const rec = block as { type?: string; text?: string }
      return rec.type === 'text' && typeof rec.text === 'string' ? rec.text : ''
    })
    .filter(Boolean)
    .join('\n')
}
