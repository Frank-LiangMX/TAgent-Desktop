# Notes · Files Changed 打开 Codex 式红绿 diff 审阅

> 交卷者：`kscc -p --model glm-5.2 --dangerously-skip-permissions`
> 日期：2026-08-18
> 对应 brief：`docs/dev/ux/FILE-CHANGED-DIFF-REVIEW-brief.md`

句尾 `N Files Changed` 卡片的 **Review / 文件行**点击，分屏从「当前文件预览」升级为
**本轮 unified diff 审阅**（红删绿增、未改行折叠、`审阅 | 当前文件` 切换、多文件条）。
正文文件 chip 仍只预览当前文件（非 diff）。

## 改了哪些文件

### 新增

- `apps/electron/src/renderer/lib/file-review-diff.ts` — 行级 diff 纯函数：
  `reconstructBefore`（倒序还原旧稿）、`computeUnifiedHunks`（Myers O(ND) LCS，无 npm 依赖）、
  `computePatchBlockHunks`（大文件兜底：按本轮补丁块）、`allNewHunks`（Write 全绿）、
  `isLargeDiff`、`countDiffHunks`、`splitLines`、`normalizeFilePath`，及 `DiffLine` / `DiffHunk` 类型。
- `apps/electron/src/renderer/lib/file-review-diff.test.ts` — 27 条单测（Myers 正确性 + 折叠 + 还原 + 兜底）。
- `packages/shared/src/types/file-review.ts` — `FileEditPatch` / `FileReviewContext` 共享类型
  （`packages/ui` 与 electron renderer 共用，避免 `packages/ui` 反向依赖 electron）。

### 修改

- `packages/shared/src/types/index.ts` — 导出 `./file-review`。
- `packages/shared/src/types/agent.ts` — `AGENT_IPC_CHANNELS` 加 `READ_GIT_HEAD_FILE: 'agent:read-git-head-file'`。
- `apps/electron/src/renderer/components/chat/concise-timeline-model.ts` — 新增
  `collectTurnFilePatches(process)`：收 edit 族且有 result 的工具，MultiEdit 拆成多条 replace（按 edits[] 顺序），
  字段别名兼容 pi（oldText/newText/old_str/new_str）与 kscc（old_string/new_string）。
- `apps/electron/src/renderer/atoms/file-preview.ts` — `FilePreviewRequest` 加 `review?: FileReviewContext`。
- `packages/ui/src/components/file-path-chip/index.tsx` — `MessageFilePathContextValue.onOpenFile`
  与 `FilePathChipProps.onOpenFile` 的 options 加 `review?: FileReviewContext`（chip 自身不传 review）。
- `apps/electron/src/renderer/components/chat/Chat.tsx` — `onOpenFile` 加 review 分支：
  有 review 时把原始 path（与 review.files 对齐）+ review 写进 `filePreviewRequestAtom`；无 review 仍走预览。
- `apps/electron/src/renderer/components/chat/TurnFilesChangedCard.tsx` — 接收 `patches` prop，
  Review / 文件行点击 `onOpenFile(path, { basePaths, review: { files, patches } })`。
- `apps/electron/src/renderer/components/chat/AssistantTurnView.tsx` —
  `collectTurnFilePatches(presentation.process)` 传给卡片。
- `apps/electron/src/main/lib/ipc/workspace-service.ts` — 新增 `readGitHeadFile`：
  从文件所在目录向上找 `.git`，`git -C <root> show HEAD:<relposix>`（5s 超时，10MB 上限），
  失败/无 git/未跟踪 → null；注册 `READ_GIT_HEAD_FILE` handler。
- `apps/electron/src/preload/index.ts` — 暴露 `readGitHeadFile`。
- `apps/electron/src/renderer/App.tsx` — `Window.electronAPI` 类型同步 `readGitHeadFile`。
- `apps/electron/src/renderer/components/dock/FilePreviewPane.tsx` — 审阅模式：
  resolveFile + readWorkspaceFile 取 after → `reconstructBefore` → `computeUnifiedHunks`
  （失败走 git HEAD 兜底 → 再失败退回当前文件预览；Write 且 git 无 → 全绿）；
  `审阅 | 当前文件` 切换、多文件条、折叠未改行就地展开；预览模式（chip/附件/图片/PDF/markdown）原样保留。
- `apps/electron/src/renderer/components/dock/WorkspaceDock.tsx` — pane 标题：有 review → `审阅 · 文件名`，无 → `预览 · 文件名`（复用 `file-preview:${sessionId}`，不新建 pane id）。
- `apps/electron/src/renderer/styles/chat.css` — 新增 `.file-diff-*` 段
  （暗 del `rgba(248,81,73,.14)` / add `rgba(63,185,80,.14)`，亮 del `rgba(255,129,130,.16)` / add `rgba(46,160,67,.12)`，
  gutter 旧号|新号、折叠行、分段按钮、多文件条）。
- `docs/dev/core-loop/CURSOR-CONCISE.md` L34 — Review/行点击 → 本轮 unified diff 审阅（chip 仍预览）。

## 数据流

```
TurnFilesChangedCard (files + patches)
  → onOpenFile(path, { review: { files, patches } })      [Chat.tsx 注入]
  → filePreviewRequestAtom { path, review }               [同会话复用 file-preview pane]
  → FilePreviewPane 审阅模式
      resolveFile + readWorkspaceFile → after
      patches.filter(samePath) → reconstructBefore(after, patches)
        ├─ before 非空且非 '' → computeUnifiedHunks(before, after)
        ├─ before null/'' → readGitHeadFile 兜底
        │    ├─ git 有 → computeUnifiedHunks(git, after)（顶栏「对照 HEAD」）
        │    ├─ null 且 before===''(Write) → allNewHunks(after)（全绿）
        │    └─ null 且 before===null(歧义) → 退回当前文件预览
        └─ isLargeDiff → computePatchBlockHunks(patches, after)（顶栏「文件较大，按本轮补丁块显示」）
```

## 怎么测

### 单测（纯函数，优先）

```
node node_modules/vitest/vitest.mjs run --root . \
  apps/electron/src/renderer/lib/file-review-diff.test.ts \
  apps/electron/src/renderer/components/chat/concise-timeline-model.vitest.test.ts
```

结果（本机，禁沙箱 `node` 直跑 vitest）：

```
Test Files  2 passed (2)
Tests  60 passed (60)   # file-review-diff 27 + concise-timeline-model 33
```

覆盖：
- `collectTurnFilePatches`：Edit + StrReplace 字段别名 + MultiEdit.edits + Write；pending / Read 不收；无路径不收。
- `reconstructBefore`：正序两次 replace 倒序还原；newText 0 次 / 2 次 → null；Write → ''；write 后接 replace → ''。
- `computeUnifiedHunks`：替换 / 插入 / 删除；首/尾/中间长未改段折叠；行号单调正确；短未改段（≤6）全显；行首插入无前导上下文。
- `computePatchBlockHunks`：replace → del+add 块；write → 全绿。
- 现有 `collectTurnEditedFiles` 等 33 条测试仍全过。

### typecheck

```
node apps/electron/node_modules/typescript/lib/tsc.js --noEmit -p apps/electron/tsconfig.json
node packages/shared/node_modules/typescript/lib/tsc.js  --noEmit -p packages/shared/tsconfig.json
node packages/ui/node_modules/typescript/lib/tsc.js      --noEmit -p packages/ui/tsconfig.json
```

结果：
- electron：本次改动文件 **0 报错**。（项目基线有 93 个报错，**全部** 在
  `src/main/lib/collaboration/collaboration-room-service.ts`——`feature/collab-room` 分支在途的
  collab room 代码，语法未完成，属预存、非本次改动、且 brief 明令不碰。）
- shared：本次改动文件 0 报错。（5 个预存报错在 `collaboration-a2a.test.ts` /
  `collaboration-timeline.test.ts`，同属 collab room 在途，非本次。）
- ui：0 报错。

### 手测步骤

1. `bun run dev`（或现有启动方式）启动桌面端，开一个会话，让 Agent 用 Edit/Write 改 ≥1 个文件。
2. 回合结束，句尾出现 `N Files Changed` 卡片：
   - 点 **Review** 或某文件行 → 右侧分屏打开，**标题 `审阅 · 文件名`**，正文红绿 unified diff
     （删除行浅红 + `-` + 旧行号；新增行浅绿 + `+` + 新行号；未改行 gutter 旧号|新号）。
   - 长未改段显示 `⋯ N 行未改` 按钮 → 点击就地展开。
   - 顶栏 `+N -M`、`审阅 | 当前文件` 分段按钮 → 切到「当前文件」回到原 BareCodeView 行号高亮预览，切回「审阅」回 diff。
   - 本轮改了多个文件：顶栏下一条可横滑文件条（语言标 + 名 + +/-），点击切换，review 上下文不丢。
3. 对照 HEAD 兜底：人为把磁盘 after 改成无法唯一定位 newText 的内容（或用 Write），
   再打开审阅 → 顶栏小字「无法还原本轮补丁，对照 HEAD」（git 有该文件时）。
4. 正文里点文件 chip → 分屏标题仍是 `预览 · 文件名`，**无红绿**（chip 不传 review）。
5. 附件 / 图片 / PDF 路径不变（预览模式不受影响）。

## 已知限制 / 未做项

- **不做** side-by-side、评论/批准/拒绝、把工作区变 git GUI（brief 明令）。未加 monaco / diff 库。
- **行级 diff 无 shiki 高亮**：审阅行用等宽纯文本渲染（红/绿底 + gutter）。
  brief 允许「del 行纯文本、有余力再给 ctx/add 高亮」；为稳健起见统一纯文本，避免逐行高亮的失败/空白风险。
  「当前文件」视图仍走原 BareCodeView（shiki 高亮）。
- **大文件保护**：任一侧 > 8000 行或 old+new > 400_000 字符，不跑全量 Myers LCS，
  回退「按本轮补丁块显示」（每个 replace 一组 del+add 块，Write 全绿），顶栏提示。
  补丁块的旧行号为 best-effort（按 newText 在 after 中的位置估算），不精确。
- **尾换行差异不可见**：`splitLines` 丢弃末尾 `\n` 产生的空串（与多数行 diff 一致），
  仅尾换行有无的变化会被归一成「无差异」→ 退回当前文件预览。
- **Write 全绿大文件**：新增文件超 8000 行时截断到前 8000 行并提示「仅显示前 N 行」。
- **git 兜底依赖 PATH 上的 `git`**：`execFile('git', …)` 走 CreateProcess 解析 `git.exe`。
  若环境只装了 `git.cmd`（非典型）或无 git → 返回 null → 走再下一级兜底（退回预览或全绿）。
- **reconstructBefore 歧义即弃**：某 replace 的 newText 在 after 里出现 ≠1 次（被后续改动重复/删除）→ null → git 兜底。
  多轮叠加改动同一片段时，单轮还原可能失败（符合 brief 设计：HEAD 只作兜底，卡片语义是「这一轮改了什么」）。
- **未碰** collab room / session-run / AskUser / plan mode / MoA / Pi 核（brief 明令）。
  `preload/index.ts`、`App.tsx`、`chat.css`、`shared/types/agent.ts` 在本分支已有在途改动（collab room），
  本次仅在这些文件做**增量**新增（新 IPC / Window 字段 / CSS 段 / channel），未改动其既有 collab 相关内容。
- 未做端到端自动化（需启动 Electron + 触发 Agent 编辑）；以单测 + typecheck + 手测步骤覆盖。
