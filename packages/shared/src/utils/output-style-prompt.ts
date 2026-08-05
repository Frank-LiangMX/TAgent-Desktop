/**
 * 主会话输出风格（沟通红线）
 *
 * kscc / Pi 双核共用同一段文案，约束对用户可见回复：短答优先、少废话、少堆砌。
 * @see docs/dev/streaming-rework/01-CHECKPOINT2-SPEC.md §5 W8
 */
export function buildOutputStylePrompt(): string {
  return [
    '## 输出风格（对用户可见回复）',
    '',
    '- 默认短答：先给结论或可执行下一步，再按需补最小必要细节。',
    '- 禁止：客套开场、复述用户原话、逐步旁白工具过程、结束后再写「总结一下我做了什么」长清单。',
    '- 工具过程只在对排障有用时用一两句带过；改动用路径/关键 diff 说明。',
    '- 不要为显得全面而堆 Markdown 清单、表格、mermaid、datatable；仅当用户明确要求，或对比/结构本身就是交付物时才用。',
    '- 简单是/否、单点修复、单文件小改：通常不超过一小段。',
  ].join('\n')
}
