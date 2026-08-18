/**
 * 「本轮 Files Changed」审阅上下文类型。
 *
 * 由句尾 TurnFilesChangedCard 收集、经 MessageFilePathContext.onOpenFile 的 options 透传、
 * 最终写入 filePreviewRequestAtom，供 FilePreviewPane 还原本轮 unified diff。
 *
 * 放在 @tagent/shared 以便 packages/ui（FilePathChip / MessageFilePathContext）与
 * electron renderer 共用同一类型，避免 packages/ui 反向依赖 electron。
 */

/**
 * 本轮对单个文件的一次补丁。
 *
 * - replace：Edit / StrReplace / search_replace（含 MultiEdit 的单条）。
 *   oldText = 旧片段，newText = 新片段。reconstructBefore 据 newText 在 after 中恰好
 *   出现 1 次时替换回 oldText 以还原旧稿。
 * - write：Write（整文件重写）。oldText 不可得，reconstructBefore 直接返回 ''，
 *   旧稿只能走 git HEAD 兜底；都没有则整文件按新增（全绿）展示。
 */
export type FileEditPatch =
  | { path: string; kind: 'replace'; oldText: string; newText: string }
  | { path: string; kind: 'write'; newText: string }

/**
 * 审阅分屏所需的「本轮改动」上下文。
 *
 * - files：本轮全部改动文件（与句尾卡片同源，含 +N -M 统计），用于顶栏文件条切换。
 * - patches：本轮全部补丁（跨文件）。FilePreviewPane 按 activePath 过滤后用于还原旧稿。
 *
 * chip 打开预览时不传 review（正文文件 chip 仍只预览当前文件）。
 */
export interface FileReviewContext {
  files: Array<{ path: string; name: string; add: number; del: number }>
  patches: FileEditPatch[]
}
