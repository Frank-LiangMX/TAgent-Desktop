# 会话渲染与权限体验硬化（2026-08-04）

> **状态**：已落地（2026-08-04 多轮修复）
> **范围**：流式渲染、工具与权限判定、Windows 兼容、文件预览、模式切换体验
> **验证**：shared 162 测 / pi-core 31 测 / ui 23 测 / electron 62+ 测全绿，四包 typecheck 通过

---

## 1. 流式渲染硬化

用户反馈「流式输出乱、思考链一顿一顿、markdown 最后才渲染」。对照 1.0（TAgent_General / Proma 同源实现）逐项收敛：

| 问题 | 根因 | 修复 |
| --- | --- | --- |
| 流式中显示原始 markdown 源码 | 纯文本过渡（流式中渲染 raw text，完成后才切 markdown） | 回退：流式中直接 `<MessageResponse>` 渲染 markdown（与 1.0 一致） |
| 思考链一顿一顿 | thinking 走 rAF 节流整块 delta 直接上屏，非逐字 | `ThinkingActivityRow` 内套 `useSmoothStream` 逐字挤出（对齐 1.0 的 thinking 独立逐字） |
| 富内容围栏流式中露原始 ``` | 流式 `MessageResponse` 未传 `streaming` prop | 传 `streaming`，未闭合围栏显示占位，闭合后切换富组件 |
| 流式结束高度切换跳动 | 流式占位→落盘消息切换仍走 smooth resize | `beginStreamTransition`：result/turn_end 瞬间切 instant resize，150ms 回 smooth |
| inline code 带反引号 | tailwind typography 默认给 `code` 加 `` ` `` 伪元素 | globals.css 关闭 `code::before/::after` + 行内 code 补显式样式 |
| DataTableView 崩溃（Rendered more hooks） | `if (!normalized) return null` 在 hooks 中间提前返回，流式半截 JSON 时 hook 数量变化 | 提前 return 移到所有 hooks 之后 + 解析失败显示提示 |
| 富块解析失败空白 | JsonTree/DiffView/PreviewViews 解析失败 return null（Boundary 只捕 throw） | 统一改为错误提示 DOM |
| 回答文字被误删 | `dedupeAnswerTexts`/`answerOverlay` 用 `includes` 去重误杀语义独立文段 | 改为 `startsWith` 前缀去重 |
| 工具循环中过程区反复展开/收起 | turn_end 立即 stopRun + 2.5s 时间驱动自动收起 | turn_end 改 3s 延迟停止（`RUN_STOP_GRACE_MS`）+ 流式事件 adopt 恢复 running；thinking 完成后内容驱动折叠（超 4 行） |
| 用户点停止后停止键卡死 | 飞行中 stray delta 用旧时间戳复活 running | `userStopRun`：本地清 running + 计时起点（三处停止入口统一） |
| live 标题渐变流动动画 | `agent-process-shine` 持续动画造成视觉干扰 | 改静态高亮 |

## 2. 工具与权限判定

### 2.1 危险命令绕过与误伤（permission-rules.ts）

- **shell 前缀绕过**：`cmd /c del`、`powershell -Command "Remove-Item"` 等包裹绕过 token 前缀匹配 → `isDangerousCommand` 递归剥离 shell 前缀（cmd/powershell/bash -c/wsl）+ 补 PowerShell/cmd 危险别名（remove-item/set-content/stop-process/invoke-webrequest 等）。
- **`hasWriteStructure` 误伤修复**（分析项目被拦的直接原因）：
  - `$(...)`/反引号：内部是危险命令才算写结构（`$(find ...)` 只读放行，`$(rm -rf /)` 拦）
  - `>/dev/null`、`2>/dev/null`、`2>&1`、`/nul` 无害重定向不算写文件（修复 `&1` fd 标记被误删）
  - `isPathOutsideCwd` 识别 Git Bash 盘符路径 `/c/Users/...` ≡ `C:\Users\...`
- **Read 无条件放行**：回退此前加的 cwd 边界检查（1.0/Proma 同款，只读无破坏性，项目外读取也放行）。

### 2.2 参数校验与错误分类

- 工具必需参数校验（对齐 Proma `agent-tool-input-validator` 思路，自研实现）：缺参直接 deny + 引导模型补全重试，不弹窗。
- 会话错误分类表 `classifyUserFacingError`：上下文过长/认证/余额/限流/模型不可用/渠道停用/kscc 未装/网络/权限拒绝 9 类，session_error 携带友好标题 + 可重试标记，渲染层友好显示。

### 2.3 Windows 兼容（pi-core tools.ts）

- 命令尾部 `| more` 分页净化（cmd more.com 会把 UTF-8 重编码成 GBK 且满屏挂起）。
- 子进程输出解码：累积 Buffer，UTF-8 严格解码失败回退 GBK（`dir`/`git log` 中文不乱码）。
- 超时杀进程树（Windows `taskkill /T /F`，防孤儿进程）。
- 输出截断保留头尾（70% 头 + 30% 尾），尾部错误信息不再被整段丢掉。

### 2.4 文件系统韧性（fs-robust.ts，新文件）

- Windows fs.watch 句柄释放延迟导致 rmSync 抛 EBUSY/EPERM/ENOTEMPTY → `rmSyncRobust` 指数退避重试（50→100→200→400ms）。
- 替换 4 处敏感点：会话删除、原子 JSON 写清理、附件目录删除、skill 目录删除。

## 3. 文件预览（FileChip → dock 分屏）

- FileChip 点击 → `filePreviewRequestAtom` → WorkspaceDock 在 chat 面板右侧分屏开预览 pane（同会话复用，内容由 atom 驱动）。
- `FilePreviewPane`：代码 → `BareCodeView`（行号 + shiki 高亮，无 CodeBlock 外壳）；图片 → img；PDF → iframe；markdown → MessageResponse；顶部工具条显示完整路径 +「外部打开」（系统默认程序）。
- `resolveFile`/`openPath` 增加裸文件名项目内递归查找兜底（排除 node_modules/.git 等，限深度/文件数，结果缓存 60s）——`Chat.tsx` 这类裸文件名也能定位。
- 修复预览 pane 激活污染 activeTabId 导致跳引导页（非会话 pane 前缀统一排除）。

## 4. Chat/Work 模式切换体验

- **模式建议 dismiss 抑制**：用户点「留在 Chat」后本会话不再自动推建议（防工具循环反复弹）；用户主动切换模式时解除抑制。
- **Chat 拦截写操作即终止 run**：`chatModeBlockHandler` → `rt.interrupt()` + 发 turn_end 清渲染层运行态——不再「还在运行还问切 Work」。
- **运行中切换先停**：`UPDATE_SESSION_EXECUTION_MODE` 切换前 `rt.interrupt()` 软中断当前 turn，再丢进程重建。

## 5. 遗留与后续

- `validateRichOutput` 自动重试未接（模型坏 datatable JSON 目前靠渲染层容错 + 提示词预防；自动重试有循环风险，待产品决策）。
- `session-store.test.ts` 7 例在 bun test 下失败（`vi.resetModules` 不兼容，预存问题，非本次引入）。
- ItemView 流式分支死代码（约 50 行）待清理。
- 引号感知的 shell 解析（`splitShellSegments` 在引号内错误分割）仍是 S3 级已知项。
