# FINDINGS · 原生 `title` 悬停气泡 → AppTooltip

> 对应 brief：`docs/dev/moa-roundtable/FIX-native-tooltip-to-apptooltip-brief.md`
> 范围：`apps/electron/src/renderer/**/*.tsx` + `packages/ui/src/**/*.tsx`（会进桌面壳的交互面）
> 主题组件：`@tagent/ui` 的 `AppTooltip`（玻璃胶囊 `.session-glass-tooltip`，App 根已有 `TooltipProvider`）

## 结论

全量扫描 renderer + packages/ui 的 `title=`，把**用作 hover 提示的 DOM `title`** 全部换成 `AppTooltip`；保留组件 **prop** `title` 与 **iframe** `title`（无障碍名）。改完后 `rg "title="` 只剩 prop / iframe / 测试 / 注释，无残留 hover-`title`。

---

## 1. 已改文件（renderer，20 个）

| 文件 | 改动点 | 备注 |
|---|---|---|
| `chat/AskUserQuestionBanner.tsx` | 队列数 `+N` chip span | `AppTooltip` |
| `roles/RolesPage.tsx` | 置顶 pin 按钮 | 保留 `aria-label`；`disabled={busy}` 为瞬时态，直包 |
| `chat/AssistantTurnView.tsx` | 句尾时间 span | 与可见文同文（truncation 兜底） |
| `dock/FilePreviewPane.tsx` | 工具条绝对路径 span | `multiline`；**iframe `title`（行 205）保留** |
| `permission/PermissionBanner.tsx` | 队列 `(+N)` span + 倒计时 div | 2 处 |
| `chat/Chat.tsx` | 「结束跟随」clear 按钮 | 保留 `aria-label` |
| `updater/UpdateBanner.tsx` | 「更新检查失败」label span | `label={state.error}` `multiline`（error 可空 → 不挂提示） |
| `memory/StageQueueCard.tsx` | pattern `<p>` + 接受/拒绝按钮 | `<p>` 用 `multiline`；按钮保留 `aria-label` |
| `shell/StatusTicker.tsx` | 整条 ticker div | `side="bottom"`（标题栏 → 向下）；重排了内层缩进 |
| `chat/MessageView.tsx` | 用户头像 span | 保留 `aria-label={userName}` |
| `chat/MentionText.tsx` | mention chip span + `MentionChip` span | 2 处；`.map` 内 `key` 移到 `AppTooltip` |
| `chat/SessionErrorBanner.tsx` | 重试按钮 | **`<span className="inline-flex">` 包一层**（见 §3） |
| `settings/SettingsPage.tsx` | `settings-env-value` span | `multiline`（env 值可长） |
| `settings/McpSettings.tsx` | MCP 摘要 `<p>` | `multiline` |
| `settings/ChannelsSettings.tsx` | 渠道 baseUrl `<p>` | `multiline` |
| `chat/SubagentEntryCard.tsx` | timeline + card 两个入口按钮 | 2 处 |
| `chat/SubagentDetailView.tsx` | 复制全部文本按钮 | |
| `chat/TurnFilesChangedCard.tsx` | Review 按钮 + 文件行按钮 | 行按钮**`<span className="block">` 包一层**（见 §3） |
| `chat/SpeakerHeader.tsx` | 名字 span（模型 id）+ handoff span | 2 处；移除外层 div `title`（见 §3） |
| `chat/TokenStatsBar.tsx` | `StatItem` div | `label={compact ? ... : undefined}`（非 compact 不挂） |

## 2. 已改文件（packages/ui，5 个）

| 文件 | 改动点 | 备注 |
|---|---|---|
| `rich-content/RichFrame.tsx` | 复制 / 关闭 / 分屏 / 全屏 4 个工具钮 | `RichFrame` **prop** `title` 与 `RichFullscreen` **prop** `title` 不动 |
| `rich-content/DataTableView.tsx` | `<td>` 截断 + 筛选 / 导出 CSV / 导出 XLSX 按钮 | `<td>` 用 `multiline`；`<td>` 作 trigger 仍是 `<tr>` 直接子节点（asChild 不加 DOM） |
| `mermaid-block/MermaidBlock.tsx` | 缩放(3+3) / 分屏 / 全屏 共 8 个工具钮 | `RichFullscreen` **prop** `title` 不动 |
| `components/attachment-preview-item/index.tsx` | 目录附件 chip div | `multiline`（文件名截断） |
| `components/scroll-minimap/index.tsx` | peek 附件 chip span | `multiline`；import 在已有 `../tooltip` 上加 `AppTooltip` |

> 共约 50 处原生 `title` → `AppTooltip`。`multiline` 用于路径 / 错误全文 / 摘要 / 表格长单元等可能截断的长文案。

---

## 3. 关键决策与边界处理

### 3.1 disabled 按钮的 tooltip（Radix 限制）
Radix `TooltipTrigger` 挂在原生 `disabled` 按钮上时**不会显示**（浏览器不向 disabled 表单控件派发指针事件）。两种 `title` 恰在 disabled 时最有用的情况，按 Radix 推荐做法**包一层 `<span>` 作 trigger**（span 接收指针事件，按钮仍 disabled）：

- **`SessionErrorBanner` 重试按钮**：`!canRetry` 时 disabled 且 `title='无可重发的用户消息'` → 包 `<span className="inline-flex">`，悬停仍可读「无可重发的用户消息」。
- **`TurnFilesChangedCard` 文件行按钮**：`!canOpen` 时 disabled 且 `title={f.path}`（全路径）→ 包 `<span className="block">`，保留行宽 `width: calc(100% + 12px); margin-inline: -6px` 的满 bleed 布局。

瞬时 disabled（`RolesPage` pin `disabled={busy}`、`StageQueueCard` 接受/拒绝 `disabled={acting}`）**直包**——disabled 窗口极短，瞬时丢提示可忽略。

### 3.2 嵌套 trigger（避免双气泡）
Radix Tooltip **不会**在子 trigger 打开时自动收起父 trigger，嵌套会同时弹出两个气泡。`SpeakerHeader` 原本外层 `agent-speaker` div 与内层 handoff span 各有 `title`（嵌套）。为避免在圆桌模式下悬停 handoff 出现双气泡：

- 移除外层 div 的 `title`；
- 把「`displayName · modelId`」提示**改挂到名字 `<span>`**（与 handoff span 同为 `agent-speaker__line` 的兄弟节点，不再嵌套）；
- handoff span 单独 `AppTooltip label="本轮点名顺序"`。

代价：头像 / 计时区不再悬停显示模型 id（轻微；名字是主悬停目标，仍可读到 `displayName · modelId`）。注释同步从「仅放 title 悬停可见」改为「仅 AppTooltip 悬停可见」。

### 3.3 `<td>` 作 trigger
`DataTableView` 长单元 `<td>` 包 `AppTooltip`：`TooltipTrigger asChild` clone `<td>`，不插入 wrapper DOM，`<td>` 仍是 `<tr>` 的直接子节点，表格结构合法。`label={text.length > 80 ? text : undefined}`，短单元不挂提示。

### 3.4 保留项
- `aria-label` 全部保留（`RolesPage` pin、`StageQueueCard` 接受/拒绝、`MessageView` 头像、`Chat` clear-mention）；`AppTooltip` `label` 与之同文。
- `<iframe title>` 保留（无障碍名）：`FilePreviewPane:205`、`PreviewViews:129`。

---

## 4. 跳过清单（含理由）

### 4.1 组件 **prop** `title`（非 DOM 属性，保留）
- `DestructiveConfirmDialog` `title`：`SessionSidebar:699,713`、`ChannelsSettings:258`、`McpSettings:303`、`AgentBehaviorSettings:219`、`PluginStoreSettings:300`
- `SettingsSection` `title`：`SettingsPage`（545/565/594/827/1011/1025/1040）、`AgentBehaviorSettings`（147/207）
- `SettingsPageIntro` `title`：`SettingsPage`（543/825/976）
- `NotificationPrefCard` `title`：`SettingsPage`（571/578/585）
- `ChannelGroup` `title`：`ChannelsSettings`（213/226）
- `EditorSection` `title`：`ChannelsSettings`（533/565/598）、`McpSettings`（493/526）、`AgentBehaviorSettings`（448/470/511）
- `BundleSubItem` `title`：`PluginStoreSettings`（717/735）
- `RichFrame` `title`：`DiffView:42`、`JsonTree:133`、`PreviewViews`（117/148/251/294）、`DataTableView:313`、`MathView:23`
- `RichFullscreen` `title`：`MermaidBlock:497`、`RichFrame:304`
- `SettingsSection` `title="会诊"`（`AgentBehaviorSettings:157`）等亦为 prop

### 4.2 iframe `title`（无障碍名，保留）
- `FilePreviewPane.tsx:205` `<iframe title={fileName}>`
- `PreviewViews.tsx:129` `<iframe title={spec.title || 'HTML preview'}>`

### 4.3 测试 / 注释
- `components/conversation/__tests__/index.test.tsx:13` `ConversationEmptyState title="..."`（测试用 prop）
- `components/tooltip.tsx:68` 注释文案「…不要写 title=」

---

## 5. 残留原生 `title` 清单（应为空 / 仅 prop / iframe）

改完后 `rg "title=" apps/electron/src/renderer packages/ui/src` 命中全部落在：
- 组件 prop `title`（§4.1）
- `<iframe title>`（§4.2）
- 测试文件（§4.3）
- 注释（§4.3）

**renderer 交互按钮无残留 hover-`title`。**（无白名单豁免）

---

## 6. 验收

1. **typecheck**：
   - `bun run --filter='@tagent/ui' typecheck` → exit 0（干净）。
   - `bun run --filter='@tagent/electron' typecheck` → 仅 1 个错误：
     `Chat.tsx(658,62) TS2353: 'modelId' does not exist in updateSessionMeta payload`。
     **此为既有 WIP（moa 会诊 / session-meta 在途改动），与本 tooltip 改造无关**：committed HEAD 的 `Chat.tsx` 无此调用，是并发 WIP 新增 `updateSessionMeta(sessionId, { modelId })`，而 WIP 改过的 preload `updateSessionMeta` payload 类型未含 `modelId`。我的 `Chat.tsx` 改动仅在 ~行 1108（`AppTooltip` 包「结束跟随」按钮），不涉 `updateSessionMeta` / `modelId`。**本次改动零新增 typecheck 错误**，所改文件均未出现在错误清单。
2. **抽样 `rg`**：见 §5，无残留 hover-`title`。
3. **未改 Tooltip 视觉 token / preload / 主进程**；现有 `AppTooltip` 用法未破坏。
4. **未跑全量 vitest**：既有 WIP moa 测试在途中，且本次为纯渲染层 tooltip 替换、不碰模型逻辑；按 brief「可跑窄测」未强制。
5. **禁止 commit**：已遵守，未提交。

## 7. 不做（按 brief）

未大改布局、未换 Tooltip 实现、未动 preload / 主进程。
