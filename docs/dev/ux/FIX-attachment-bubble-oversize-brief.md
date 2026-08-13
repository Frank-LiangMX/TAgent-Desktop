# FIX — Chat 用户消息：发送图片附件后气泡被撑成超高块

## 现象

在 Chat 主区里**只发送一张图片附件（不带文字）**后，那条 user 消息气泡渲染成**约 760px 高的巨大矩形**，远远超过 `MessageAttachmentImage` 预期的 `max-w-[500px] / max-h-[min(500px,50vh)]`。截图见用户提供的 `assets/c__Users_liangmingxuan_AppData_Roaming_Cursor_User_workspaceStorage_empty-window_images_image-e6a52871-dbbf-425a-a04e-1d5cab642451.png`：

- 左侧会话列表 / 中间对话流是正常的；
- 单条 user 消息**纵向高度异常**，把后面的 ai_jay / agent-message-toolbar / AI: Analysis / AI: Chat list time format / j3_statics 等多行挤压到屏幕底部；
- 气泡内部看起来是**大块灰色填充**，未显示正常 280×200 或 500×281 尺寸的图。

带文字 + 附件的"组合气泡"（走 `agent-user-bubble--combo` 分支）看上去正常；**只有"纯附件"分支**（`MessageView.tsx:134-135` 的 `hasAttachments && !hasText`）出问题。

## 契约

### A. 渲染尺寸

- **单张图片**（`isSingleImage === true`）：img 上限 `maxWidth: 360px / maxHeight: 200px`（紧凑卡片型，对齐用户参照图），等比缩放；气泡 box ≤ 220px（`max-height: 220px` 给 padding 余量），**禁止**高度 ≥ 220px 的单条 user 消息撑爆整屏
- **多张图片**（`isSingleImage === false`）：每张缩略图固定 280×280（`size-[280px] + object-cover`），多张 wrap 排列
- **气泡容器**：`width: fit-content; max-width: 100%`，高度由内容自适应
- **占位态**（`imageSrc` 还没读到 base64）：矩形不超过 `280×200`（单图）或 `280×280`（多图），不要让占位变成"等比 → 50vh 高"的超大块

### B. 不可破坏的现有行为

- 组合气泡（`agent-user-bubble--combo`，附件 + 文字 + tool_result）正常
- `ImageLightbox` 弹窗点击打开、保存图片
- 文件附件（非图片）的 chip 列表不受影响
- 用户铭牌 / 时间 / 复制工具条布局不变

### C. 根因（初步假设，待 kscc 验证）

最可能的链条：

1. `MessageView.tsx:134-135` 在 `hasAttachments && !hasText` 走 `<div className="agent-user-bubble relative inline-block max-w-full">` —— 单层 `inline-block`，没有像 `agent-user-bubble--combo` 那样的 `MessageContent` 包壳
2. `chat.css` 里 `.tagent-thread .agent-user-block__bubble { display: block; width: fit-content; max-width: 100%; min-width: 0; }` —— 高度没限
3. `MessageContent` 自身（`packages/ui/src/components/message/index.tsx`）有 `max-w-full min-w-0 overflow-hidden`，但 `inline-block` 路径下这些可能被绕过
4. `<img>` 自身 `max-w-[500px] max-h-[min(500px,50vh)]` —— **关键**：当 `<img>` 在 `inline-block` 父容器内，且父容器未显式 `max-height`，CSS 的 `min-height: auto` 可能让 `<img>` 按 aspect-ratio 自然撑开父级（CSS aspect-ratio / replaced element intrinsic sizing 在 chrome 里对 base64 data URL 的 img 行为有时会绕过 max-h，特别是当父级 `display: inline-block` 时）
5. 或者：`MessageAttachments` 内部 `<div className="flex flex-wrap gap-2.5">` 在只有 1 张图时，flex-wrap 容器拿到 `<img>` 的 intrinsic height 时，被父 `inline-block` 的尺寸规则放飞

也可能不是图片本身，而是：

- **`onReadAttachment` 返回 base64 失败 / 返回的是文件路径或 mime 错的字符串**，导致 `<img>` 的 `src` 无效 → 但 `<img>` 无效时高度不应是 760px
- **`ImageLightbox` 的 portal 撑到了消息流里**（不太可能，但 portal 错配偶有发生）

**结论需要 kscc 实地跑 + 截图确认是哪个路径。**

### D. 本轮不做

- 不重做 `MessageAttachments` 的视觉风格
- 不动 `ImageLightbox` 弹窗逻辑
- 不动 assistant 侧的内容块
- 不动 `saveAttachment` / 附件持久化

## 主要文件

- `apps/electron/src/renderer/components/chat/MessageView.tsx`（user 渲染分支 120-143）
- `packages/ui/src/components/message/index.tsx`（`MessageAttachmentImage` 651-729）
- `apps/electron/src/renderer/styles/chat.css`（`.agent-user-block__bubble` 374-381 及相关）
- 必要时 `apps/electron/src/renderer/styles/sidebar.css` / `tailwind` 全局配置

## 验收

1. 只发 1 张图（任意分辨率，从 500×500 到 4000×3000）→ img ≤ 360×200 等比，气泡高度 ≤ 220px（满足 ≥60% 高度缩减验收：760→220 ≈ 71%）
2. 发 2 张图 → 每张 280×280 缩略图并排，气泡高度 ≤ 280+padding
3. 发 1 张图 + 文字 → 组合气泡保持现有视觉
4. 发 1 个非图片文件 → 文件 chip 紧凑
5. 占位态（base64 还没加载完）→ 不超过 280×200 / 280×280
6. 截图前后对照：相同输入下气泡纵向高度差 ≥ 60%（760→220 ≈ 71%）