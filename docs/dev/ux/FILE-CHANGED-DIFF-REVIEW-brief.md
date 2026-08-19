# Brief · Files Changed 打开 Codex 式红绿 diff 审阅

> 交卷者：`kscc -p --model glm-5.2 --dangerously-skip-permissions`  
> 日期：2026-08-18  
> 范围：句尾 Files Changed → 分屏打开后，从「当前文件预览」升级为 **本轮 unified diff 审阅**（红删绿增，可折叠未改行）。  
> **禁止**改 collab room、session-run、AskUser、plan mode、MoA、Pi 核。  
> **禁止** git commit / push。不要加 npm 依赖。

## 现象

`TurnFilesChangedCard`（消息底部 `N Files Changed`）点 **Review** 或点某一行，经 `MessageFilePathContext.onOpenFile` → `filePreviewRequestAtom` → `FilePreviewPane`。

`FilePreviewPane` 现在只读磁盘当前内容，用 `BareCodeView` 做行号 + shiki。没有旧/新对比，没有红绿，不像 Codex / GitHub review。

规格旧句（`docs/dev/core-loop/CURSOR-CONCISE.md` L34）写的就是「Review/行点击 → 文件预览（非 git diff）」——这次就是要改掉。

## 目标

从 Files Changed 打开的分屏，默认是 **审阅**：

- 统一 diff：删除行浅红底 + 左侧 `-` / 旧行号；新增行浅绿底 + 左侧 `+` / 新行号
- 未改行可折叠（「N unmodified lines」可展开）
- 顶栏：路径、`+N -M`、`审阅 | 当前文件` 切换、外部打开
- 本轮改了多个文件：顶栏下一条文件条，可切换，不必回消息卡片
- 消息正文里的文件 chip **仍只预览当前文件**，不要变成 diff

参考：GitHub PR 单文件 unified view / Codex review（用户截图那种红绿块，不是 side-by-side）。

## 数据从哪来

本轮编辑工具的 input 已在 `presentation.process` 里：

| 工具 | 字段（兼容两套） |
|------|------------------|
| Edit / StrReplace / search_replace | `old_string`/`oldText`/`old_str` → `new_string`/`newText`/`new_str` |
| MultiEdit | `edits[]` 同上字段；按数组顺序 |
| Write | `content`（或 new_*）视为整文件新内容；无 old |

`computeDiffFromInput` / `extractToolDiff` 只估 +N -M，**没有**行级 hunk。要新写纯函数。

**不要**把 Files Changed 做成「相对 git HEAD 的工作区 diff」当主路径。卡片语义是「这一轮 agent 改了什么」。HEAD 只作兜底。

## 必做

### 1. 纯函数（优先单测）

新建例如：

- `apps/electron/src/renderer/lib/file-review-diff.ts`
- `apps/electron/src/renderer/lib/file-review-diff.test.ts`

或把收集补丁放进 `concise-timeline-model.ts`（已有 `collectTurnEditedFiles` / `toolFilePath` / `computeDiffFromInput`），行级 diff 单独放 `lib/`。

需要：

```ts
type FileEditPatch =
  | { path: string; kind: 'replace'; oldText: string; newText: string }
  | { path: string; kind: 'write'; newText: string }

collectTurnFilePatches(process: ProcessEntry[]): FileEditPatch[]
// 只收 family===edit 且已有 result 的工具；路径用 toolFilePath
// MultiEdit 拆成多条 replace，顺序保持

reconstructBefore(after: string, patches: FileEditPatch[]): string | null
// 只对同一 path 的补丁、按时间倒序：
//   replace：after 里 newText 必须恰好出现 1 次，替换回 oldText；否则 null
//   write：返回 ''（整文件重写，旧稿只能走 git 兜底）

computeUnifiedHunks(oldText: string, newText: string, opts?: { context?: number }): DiffHunk[]
// 行级 LCS / Myers，不要加 npm 包
// context 默认 3
// 未改连续段 > 6 行收成 collapsed 行（或 hunk 里 kind:'collapsed'）

type DiffLine =
  | { type: 'ctx'; oldNo: number; newNo: number; text: string }
  | { type: 'del'; oldNo: number; text: string }
  | { type: 'add'; newNo: number; text: string }
  | { type: 'collapsed'; count: number; lines?: DiffLine[] } // 展开后可就地替换
```

大文件保护：任一侧 > 8000 行或 old+new > 400_000 字符，不要跑全量 LCS。回退为「按补丁块展示」：每个 replace 当一个 hunk（del 块 + add 块），Write 当全绿。UI 顶栏提示「文件较大，按本轮补丁块显示」。

路径比较：与 `collectTurnEditedFiles` 一样 `replace(/\\/g,'/').toLowerCase()`。

### 2. 打开链路带上审阅上下文

`TurnFilesChangedCard` 现在只 `onOpenFile(path)`。chip 共用这个回调，所以：

- **扩展** `onOpenFile` 的 options（`packages/ui` `MessageFilePathContext` / `FilePathChip` 类型），加可选：

```ts
review?: {
  files: Array<{ path: string; name: string; add: number; del: number }>
  patches: FileEditPatch[]
}
```

- chip **不要**传 `review`
- Files Changed 的 Review / 行点击 **要**传：`files` = 本卡片全部，`patches` = 本轮全部（或至少该文件）

`AssistantTurnView`：`collectTurnFilePatches(presentation.process)` 传给卡片。

`Chat.tsx` `onOpenFile`：有 `review` 就写进 `filePreviewRequestAtom`。

`file-preview.ts`：

```ts
export interface FilePreviewRequest {
  // 现有字段保留
  review?: {
    files: Array<{ path: string; name: string; add: number; del: number }>
    patches: FileEditPatch[]
  }
}
```

`WorkspaceDock` 开 pane 时标题：

- 有 `review` → `审阅 · ${fileName}`
- 无 → 继续 `预览 · ${fileName}`

不要新建第二种 pane id，仍复用 `file-preview:${sessionId}`。

### 3. FilePreviewPane 审阅 UI

当 `target.review` 存在且不是附件 / 待发附件 / 图片 / PDF：

1. 仍 `resolveFile` + `readWorkspaceFile` 拿 **after**（当前磁盘）
2. `patches.filter(same path)` + `reconstructBefore(after, patches)`
3. before 得到 → `computeUnifiedHunks`
4. before 为 null：
   - **git 兜底**（见 §4）：`git show HEAD:rel` 当 before，再算 hunks（顶栏小字「无法还原本轮补丁，对照 HEAD」）
   - git 也没有：退回当前文件预览，顶栏提示「无法还原 diff」
5. Write 且 reconstruct 得到 `''`、git 也没有：整文件当新增（全绿）

工具条（现有路径 + 外部打开 旁边加）：

- `+N -M`（优先卡片统计；没有则用 hunk 计数）
- 分段按钮 `审阅` / `当前文件`（默认审阅）
- 多文件时一条可横滑的文件条：语言标可复用 `fileLangBadgeForName`，点了只改 `path`，保留同一 `review`

Diff 行视觉（对齐现有 Files Changed 绿/红，兼容亮暗）：

```
暗：del bg rgba(248,81,73,.14)  add bg rgba(63,185,80,.14)
亮：del bg rgba(255,129,130,.16) add bg rgba(46,160,67,.12)
gutter 旧号 | 新号，del/add 号用对应色
折叠行：灰字「N unmodified lines」，点击展开
```

样式放到 `apps/electron/src/renderer/styles/chat.css` 新段 `.file-diff-*`，或 `dock.css`。不要引入新 UI 库。

shiki：有余力给 ctx/add 行高亮；del 行保持纯文本即可。高亮失败不得空白。

### 4. git HEAD 兜底（小 IPC）

只在 reconstruct 失败时用。

- `AGENT_IPC_CHANNELS` 加例如 `READ_GIT_HEAD_FILE: 'agent:read-git-head-file'`
- `workspace-service.ts`：从文件所在目录向上找 `.git`，`git -C <root> show HEAD:<relposix>`，超时 ~5s，失败返回 `null`
- 走现有 `collectAllowedReadRoots` 的诊断风格即可，不要因工作区外拒读（和 `readWorkspaceFile` 同一产品原则）
- preload + `App.tsx` Window 类型同步

无 git / 未跟踪 / 超时 → `null`，走 §3 的再下一级兜底。

### 5. 测试

最少：

- `collectTurnFilePatches`：Edit + StrReplace 字段别名 + MultiEdit.edits + Write；pending / Read 不收
- `reconstructBefore`：正序两次 replace 倒序还原；newText 0 次或 2 次 → null；Write → `''`
- `computeUnifiedHunks`：替换 / 插入 / 删除；中间大段未改被折叠
- 现有 `collectTurnEditedFiles` 测试必须仍过

再跑：

```
bun run typecheck
bunx vitest run apps/electron/src/renderer/components/chat/concise-timeline-model.vitest.test.ts apps/electron/src/renderer/lib/file-review-diff.test.ts
```

（若测试路径不同，按你实际文件跑，并在 NOTES 写命令。）

### 6. 文档

- 改 `docs/dev/core-loop/CURSOR-CONCISE.md` L34：Review/行点击 → **本轮 unified diff 审阅**（红绿 + 折叠未改行；chip 仍预览）
- 写 `docs/dev/ux/FILE-CHANGED-DIFF-REVIEW-NOTES.md`：改了哪些文件、怎么测、已知限制

## 不做

- 不 side-by-side、不评论/批准/拒绝、不把工作区变成 git GUI
- 不改消息内 FilePathChip 默认行为
- 不把图片/PDF/附件走 diff
- 不加 monaco / diff 库
- 不 commit / push
- 不碰 `collaboration-room-*`、`session-run-*`、AskUser、plan mode

## 验收

- [ ] Files Changed 点 Review / 文件行 → 分屏标题 `审阅 · 文件名`，正文红绿 unified diff
- [ ] 未改行折叠，点击展开
- [ ] `审阅 | 当前文件` 可切回现有 BareCodeView
- [ ] 多文件可在 pane 内切换，review 上下文不丢
- [ ] 正文里点文件 chip 仍是「预览 · …」，无红绿
- [ ] 附件 / 图片 / PDF 路径不变
- [ ] typecheck + 相关 vitest 过

## 返回 stdout

改动文件列表 + 测试命令与结果 + 手测步骤 + 已知未做项。
