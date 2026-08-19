/**
 * 会话消息挂载窗口（尾部切片）。
 *
 * 旧实现会在打开后 idle 拉满 → Infinity，60+ 轮流式时整棵历史树常驻，
 * 每个 delta 都拖着 Markdown/过程树重渲。这里把默认挂载钉在尾部窗口，
 * 上滑再扩；开流时若在底部则收回窗口。
 */
export const CHAT_MOUNT_WINDOW = 48
export const CHAT_MOUNT_BATCH = 40
export const CHAT_MOUNT_TOP_LOAD_PX = 140
