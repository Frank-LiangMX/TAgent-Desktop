# FINDINGS · 设置页视觉对齐：渠道 + Agent 行为 → 通用/外观同壳

> 对照 `docs/dev/ux/ALIGN-SETTINGS-SHELL-brief.md`。真理源 = `SettingsPage.tsx` 通用 / 外观的信息架构与组件。
> 目标：渠道页与 Agent 行为页读起来像通用 / 外观的延伸；功能零回归；**未 commit**。

## 1. 共用原语落地

| 原语 | 来源 | 渠道页 | Agent 行为页 |
|---|---|---|---|
| `SettingsPageIntro`（title / description / action） | 新增 `packages/ui/src/components/settings/SettingsPageIntro.tsx`（从 `SettingsPage.tsx` 内联函数提取为共享原语，加可选 `action`；通用 / 外观 / 关于无 action 时渲染与原先逐字一致） | 用作页头，「添加渠道」落在 intro 右侧 action | 用作页头（无 action） |
| `SettingsSection`（title / description / action） | `@tagent/ui` | 内置服务 / 外部服务；编辑器基本信息 / 连接配置 / 可用模型 | 会诊 / 班组 / 圆桌 |
| `SettingsCard`（divided 分行） | `@tagent/ui` | 卡内多行渠道；编辑器表单块 | 档行 / 预置名册（divided）/ loading / empty / 编辑器表单 |
| `settings-row` 节奏（左主文 13px + 右 Switch / 按钮） | `settings-shell.css` | 渠道行 `.channel-shell-row` 对齐 | 预置行 `.agent-behavior-row` 对齐 |
| `SegmentedTabs` / `SegmentedTabsItem` | `@tagent/ui`（与插件页 `PluginStoreSettings` 同族） | — | 会诊档切换（kscc 内网 / 外部渠道） |

页头一律 `SettingsPageIntro`：**已删 Agent 行为的 uppercase kicker「协作策略」**，通用 / 外观 / 关于行为不变。

## 2. 渠道页 `ChannelsSettings.tsx` + `settings-shell.css`

| 维度 | 前 | 后 |
|---|---|---|
| 页头 | 自建 `channel-settings-heading` | `SettingsPageIntro`（title + desc + action「添加渠道」） |
| 分组 | `channel-group` + `channel-group-heading` | `SettingsSection`（内置服务 / 外部服务） |
| 列表表面 | 自画 `channel-list` 玻璃框（独立边框 / 渐变 / inset 高光） | `SettingsCard`（`divided` 分行，瓷白玻璃卡来自 `settings-dialog-shell .settings-card`） |
| 行布局 | `channel-row-topline`（accent `channel-provider-mark` 方块 + `channel-row-identity`）+ `channel-row-details` + `channel-row-footer` | `channel-shell-row`：左 `channel-shell-main`（名 13px + 中性 `channel-shell-tag` + 纯文字状态 + URL / 明细 / 测试结果）/ 右 `channel-shell-control`（Switch + 测试 / 编辑 / 删除） |
| 内置标签 | `channel-tag`（accent 描边 + accent fill） | `channel-shell-tag`（中性：`spatial-line-strong` 描边 + `chip-fill` + muted 字） |
| 状态 | `channel-status-text` + `::before` 绿点 | `channel-shell-status` 纯文字「已启用 / 已停用」，无绿点 |
| provider 方块 | `channel-provider-mark`（accent 圆角方块 + Server 图标） | **删除**（供应商信息已在 URL 行 `Provider · URL`） |
| 测试结果 | 常驻「尚未测试连接」+ idle 行 | 仅在有 `operation`（testing / success / error）时渲染一行 muted 反馈 |
| 空态 | `channel-empty` 三列网格 + 大 Server 图标 | `channel-shell-empty`：muted 文案 + outline 按钮，无大图标 |
| 编辑器 | `EditorSection` 自画堆栈（`channel-editor-section` 边框 + head + body） | `SettingsSection` + `SettingsCard.channel-form-card`（14px 内距）包表单块；intro 带启用开关 action；保留返回按钮 |
| 编辑器表单 | `channel-input` / `channel-field` 全宽 | 保留 `channel-input` / `channel-field` / `channel-form-grid` / `channel-provider-select` / `channel-model-*`（见 §5 偏差） |

行内保留：名称、内置标签、URL 一行、模型数 / 默认 / 凭据、测试结果、测试 / 编辑 / 删除、Switch。

## 3. Agent 行为页 `AgentBehaviorSettings.tsx` + `agent-behavior-settings.css`

| 维度 | 前 | 后 |
|---|---|---|
| 页头 | `settings-page-intro` 内塞 `agent-behavior-kicker`「协作策略」 | `SettingsPageIntro`（无 kicker，文案对齐通用简洁度） |
| 会诊档切换 | 自绘 `agent-behavior-channel-pills` + `agent-behavior-channel-pill`（圆角 pill，选中 chip-fill） | `SegmentedTabs` + `SegmentedTabsItem`（`settings-segmented`，与插件页同族），进 `SettingsCard` 顶行 `agent-behavior-tier-row`（含预置计数） |
| 预置列表 | `agent-behavior-roster`（自画 hairline 容器） | `SettingsCard divided`：每个 `PresetRow` 是卡片分行（`settings-card-sep` 分隔） |
| 会诊区正文间距 | — | `.agent-behavior-stack`（flex column gap 10px）包通知 / 档行卡 / 名册卡 / 编辑器卡（`settings-block-body` 本身无 gap） |
| 预置行 | `row-head`（名 + 标签 … 超时 + Switch）+ `row-body`（座位行 + 操作） | `agent-behavior-row`：左 `row-main`（名 + 内置标签 + 座位摘要 `seat-line`）/ 右 `row-control`（超时 + Switch + 编辑 / 删）。继续无左竖条 |
| 编辑器 | `agent-behavior-editor` 自画边框 + chip-fill 底 + 侧滑入动画 + kicker | `SettingsCard` 包 `agent-behavior-editor`（仅留 16px 内距 + flex 节奏，表面由 `settings-card` 提供）；删 kicker |
| 班组 / 圆桌 | `agent-behavior-upcoming` 两行小字（自画 label / dot） | 各一 `SettingsSection`，正文一句「即将推出」（`text-xs text-muted-foreground`），无大虚线轨 |
| notice / loading / empty | 既有 | 保留；`agent-behavior-empty` 去掉自画 dashed 边框（卡面已提供表面） |

## 4. 关键架构决策：为何渠道行用 `channel-shell-*` 而非改 `channel-*`

`channel-*` 类（`channel-row` / `channel-list` / `channel-provider-mark` / `channel-tag` / `channel-status-text` / `channel-empty` / `channel-editor-section` …）被 **`McpSettings.tsx` 与 `PluginStoreSettings.tsx` 共享**。brief 明确「不做：重做 MCP / 插件页」「功能零回归」。

若直接改共享 `channel-*`（如把 `.channel-row` 改 `display:flex`、删 `.channel-provider-mark`、`channel-tag` 去 accent、`channel-status-text` 去绿点），会同时改坏 MCP / 插件页（它们的行依赖 `.channel-row` 为块容器 + topline / footer，且用 accent tag + 绿点）。

因此：
- **保留 `channel-*` CSS 逐字不动**（`git diff HEAD -- settings-shell.css` 仅含本次新增 `channel-shell-*` / `channel-form-card` 与一处渠道专属 `channel-settings-summary` margin 微调，无任何共享 `channel-*` 规则改动）→ MCP / 插件页零视觉影响。
- **渠道页行 / 空态 / 编辑器表单卡用新前缀 `channel-shell-*`**（与 `settings-row` 同节奏，非第三套 chrome），与 MCP / 插件无碰撞。
- Agent 行为页的 `agent-behavior-*` 仅 Agent 使用，故可直接精简重写。

## 5. 偏差与取舍

- **编辑器表单未改用 `SettingsInput` / `SettingsSecretInput`**：二者输入框硬编码 `w-[200px]`，对服务地址 / API Key 等长值会截断，是可用性回归。故保留全宽 `channel-input`（已消费 `--spatial-*` 变量，与 shell 同族），仅把外层换成 `SettingsSection` + `SettingsCard`。`SettingsPageIntro` 的 `action` 用于承载编辑器启用开关。
- **渠道页保留 `channel-settings-summary`**（N 个渠道 · M 个已启用）：`aria-live` 计数有益，渲染为 muted 小字，不另起自画块。
- **测试结果不再常驻「尚未测试连接」**：仅 testing / success / error 时显示一行 muted 反馈，减少噪声（纯文案，非功能）。
- **`SegmentedTabs` 选中态**：`value={scope}`（派生值，kscc 不可用回落 external）；编辑期 `disabled` 防切档，与原 pill 行为一致。

## 6. 验收（对照 brief）

- [x] 侧栏切 通用 → 外观 → 渠道 → Agent 行为：页头 / 区块标题 / 卡片表面 / 字号节奏一致（同 `SettingsPageIntro` + `SettingsSection` + `SettingsCard` + `settings-row` 节奏）
- [x] 无 kicker、无渠道独立大玻璃 list 框（渠道改 `SettingsCard`）、无 Agent 自绘 pill 条（改 `SegmentedTabs`）
- [x] 渠道：启用 / 测试 / 编辑 / 删除 / 添加仍可用（CRUD / 测试连接 / IPC 处理器逐字未动，仅壳层 JSX / CSS）
- [x] Agent：双档（`SegmentedTabs` kscc / external）、CRUD、toggle、外部合并模型仍可用（scope / 预置 / 合并逻辑未动）
- [x] typecheck 相关文件无新增错；有测则跑

## 7. 验证记录

- `packages/ui` `tsc --noEmit`：通过（新增 `SettingsPageIntro.tsx` + 导出）。
- `apps/electron` `tsc --noEmit`：唯一报错在 `src/renderer/components/chat/Chat.tsx`（`modelId` 不在 session update 类型上）——该文件为**进入会话前已存在的未提交改动**（`git status` 起始即 `M Chat.tsx`），与本次设置壳对齐无关；本次改动文件（`SettingsPage.tsx` / `ChannelsSettings.tsx` / `AgentBehaviorSettings.tsx` / `SettingsPageIntro.tsx`）零报错。
- `vitest run apps/electron/src/renderer/components/settings/`：`channel-settings-model.test.ts`（4）+ `mcp-settings-model.test.ts`（10）= **14/14 通过**（模型逻辑未动）。
- `git diff HEAD -- settings-shell.css`：仅新增 `channel-shell-*` / `channel-form-card` + 渠道专属 `channel-settings-summary` margin，**共享 `channel-*` 规则逐字未改** → MCP / 插件页零影响。

## 8. 改动文件清单

新增：
- `packages/ui/src/components/settings/SettingsPageIntro.tsx`
- （导出）`packages/ui/src/components/settings/index.ts`

修改：
- `apps/electron/src/renderer/components/settings/SettingsPage.tsx`（移除内联 `SettingsPageIntro`，改用共享原语）
- `apps/electron/src/renderer/components/settings/ChannelsSettings.tsx`（壳层对齐 + `channel-shell-*` 行 / 空态 / 编辑器）
- `apps/electron/src/renderer/components/settings/AgentBehaviorSettings.tsx`（去 kicker、`SegmentedTabs`、`SettingsCard` 名册 / 编辑器、班组 / 圆桌拆 `SettingsSection`）
- `apps/electron/src/renderer/styles/settings-shell.css`（新增 `channel-shell-*` + `channel-form-card`；`channel-settings-summary` margin；共享 `channel-*` 不动）
- `apps/electron/src/renderer/styles/agent-behavior-settings.css`（精简：删 kicker / pill / upcoming / editor 自画框；行改左主文 / 右控件；加 `agent-behavior-tier-row`）

未改动（刻意）：`McpSettings.tsx` / `PluginStoreSettings.tsx` 及其依赖的共享 `channel-*` CSS。
