/**
 * Chat @ 提及（Phase B）
 *
 * 用户在 Chat 输入 `@角色` 点名；主会话时间线内顺序发言，不建看板。
 * @see docs/plans/multi-runtime/03-mechanisms-subagent-kanban-moa.md §6
 */

/** 单次 @ 命中 */
export interface MentionHit {
  /** 角色 id */
  roleId: string
  /** 展示名 */
  displayName: string
  /** 原文中的匹配串，如 `@软件架构师` 或 `@analyst` */
  raw: string
  /** 在原文中的起始下标 */
  index: number
}

/** 从用户输入解析 @（按出现顺序） */
export function parseMentions(
  text: string,
  roles: Array<{ id: string; displayName: string }>,
): MentionHit[] {
  if (!text || roles.length === 0) return []
  // 长名优先，避免短 id 抢匹配
  const sorted = [...roles].sort(
    (a, b) =>
      Math.max(b.displayName.length, b.id.length) - Math.max(a.displayName.length, a.id.length),
  )
  const hits: MentionHit[] = []
  const usedRanges: Array<{ start: number; end: number }> = []

  const overlaps = (start: number, end: number): boolean =>
    usedRanges.some((r) => !(end <= r.start || start >= r.end))

  for (const role of sorted) {
    const candidates = [`@${role.displayName}`, `@${role.id}`]
    for (const raw of candidates) {
      let from = 0
      while (from < text.length) {
        const index = text.indexOf(raw, from)
        if (index < 0) break
        const end = index + raw.length
        // 后接标识符字符则跳过（避免 @code 命中 @coder 的前缀歧义用长名优先已处理）
        const next = text[end]
        if (next && /[\w\u4e00-\u9fff]/.test(next) && raw === `@${role.id}`) {
          from = end
          continue
        }
        if (!overlaps(index, end)) {
          hits.push({
            roleId: role.id,
            displayName: role.displayName,
            raw,
            index,
          })
          usedRanges.push({ start: index, end })
        }
        from = end
      }
    }
  }

  return hits.sort((a, b) => a.index - b.index)
}
