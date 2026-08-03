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

/** @ 选择器使用的角色引用（含 pin 标记） */
export interface MentionRoleRef {
  id: string
  displayName: string
  description?: string
  /** 是否置顶到 @ 快捷列表（B1 pin 子集） */
  pinned?: boolean
}

/**
 * @ 角色过滤：MentionPicker 下拉与 ChatInput 键盘选择共用，保证选中项一致。
 *
 * - 无 query：默认只显示**已 pin 子集**（B1：非全库）；无任何 pin 时回退全量，避免空列表。
 * - 有 query：在全库里按 id/displayName/description 过滤，pin 项排前。
 * - 结果截断到 limit（默认 12）。
 *
 * 注意：parseMentions 仍用全库解析，未 pin 的角色手动 @ 仍可命中。
 */
export function filterMentionRoles<R extends MentionRoleRef>(
  roles: R[],
  query: string,
  limit = 12,
): R[] {
  const q = query.trim().toLowerCase()
  if (!q) {
    const pinned = roles.filter((r) => r.pinned)
    const base = pinned.length > 0 ? pinned : roles
    return base.slice(0, limit)
  }
  const matched = roles.filter(
    (r) =>
      r.id.toLowerCase().includes(q) ||
      r.displayName.toLowerCase().includes(q) ||
      (r.description ?? '').toLowerCase().includes(q),
  )
  matched.sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true))
  return matched.slice(0, limit)
}
