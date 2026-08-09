# Brief · 设置页视觉对齐：渠道 + Agent 行为 → 通用/外观同壳

> `kscc -p --model glm-5.2 --dangerously-skip-permissions`  
> 用户：通用页、外观页风格对；渠道页、Agent 行为页是另一套，不满意。  
> **真理源**：`SettingsPage.tsx` 里 General / Appearance 的信息架构与组件。  
> Skill：Flat / Minimal + **consistency**（同产品同设置壳，禁止第三套 chrome）。

## 问题

| 页 | 现状 |
|---|---|
| 通用 / 外观 | `settings-page` → `SettingsPageIntro` → `SettingsSection` → `SettingsCard` → `settings-row` / `settings-field-label`；瓷白玻璃卡来自 `settings-dialog-shell .settings-card` |
| 渠道 | 自建 `channel-settings-heading` / `channel-group` / `channel-list` / `channel-row` + accent `channel-provider-mark` + 状态绿点 —— **平行设计系统** |
| Agent 行为 | 又自建 `agent-behavior-kicker` / pills / roster hairline —— **第三套**（且故意「去渠道化」反而更分裂） |

## 目标

渠道页与 Agent 行为页**读起来像通用/外观的延伸**，不是两个插件面板。功能零回归（CRUD / 测试连接 / 双档会诊 / IPC）。

## 改法（强制）

### 共用原语（只许用这些做壳）

1. 页头：与通用相同的 `settings-page-intro` 结构（**禁止** uppercase kicker「协作策略」）。渠道「添加渠道」可放 intro 右侧（intro 已是 `space-between`）或首个 `SettingsSection` 的 `action`。
2. 分组：一律 `SettingsSection`（title / description / action）。
3. 列表表面：一律 `SettingsCard`（`divided` 分行）。**不要**再画独立 `channel-list` / `agent-behavior-roster` 外框渐变。
4. 行：对齐 `settings-row` 节奏（左主文 13px `settings-field-label` 量级 + 右 Switch/按钮）；次要说明用 `text-xs text-muted-foreground` / `spatial-faint`。
5. 分段：Agent 会诊档用现成 `SettingsSegmentedControl` 或 `SegmentedTabs`（与设置其它分段同族），**删**自绘 pill 条。
6. 削减装饰：去掉或中性化 `channel-provider-mark` accent 方块、状态绿点可改为纯文字「已启用/已停用」；Agent 行继续无左竖条。

### 渠道 `ChannelsSettings.tsx` + `settings-shell.css` 渠道段

- 列表页：`SettingsPageIntro` + `SettingsSection`「内置服务」「外部服务」各包一张 `SettingsCard`，卡内多行。
- 行内保留：名称、内置标签（用现有中性 tag 或 muted 小字）、URL 一行、模型数/默认/凭据、测试结果、测试/编辑/删除、Switch。
- 空态 / 加载 / 错误：语气贴近通用，少大图标堆叠；可用 muted 文案 + outline 按钮。
- 编辑器页：同样 `SettingsSection` + `SettingsCard` 包表单块；能复用 `SettingsInput` / `SettingsSecretInput` 处优先复用。
- CSS：能删则删与 `settings-card` 重复的 list 边框/渐变；保留 row 内部布局必要规则，类名可渐进改成 `channel-row` 仍挂在 card 内。

### Agent 行为 `AgentBehaviorSettings.tsx` + `agent-behavior-settings.css`

- 去掉 kicker；intro 文案对齐通用简洁度。
- 「会诊」一节：`SettingsSection`；档切换进 `SettingsCard` 顶行（Segmented）；预置列表同卡或下一张 `SettingsCard` 分行。
- 预置行：左名+座位摘要，右 Switch + 编辑/删；编辑态仍同页，表单放 `SettingsCard`。
- 班组/圆桌：各一 `SettingsSection`，正文一句「即将推出」（已有则保留），**不要**大虚线轨。
- 尽量删薄 `agent-behavior-settings.css`：能靠 shell 变量 / settings-row 的删掉；自绘 pill 样式删除。

### 文档

- 写 `docs/dev/ux/ALIGN-SETTINGS-SHELL-FINDINGS.md`（对照表 + 验收）。  
- **禁止 commit**。

## 验收

- [ ] 侧栏切 通用 → 外观 → 渠道 → Agent 行为：页头/区块标题/卡片表面/字号节奏一致  
- [ ] 无 kicker、无渠道独立大玻璃 list 框、无 Agent 自绘 pill 条  
- [ ] 渠道：启用/测试/编辑/删除/添加仍可用  
- [ ] Agent：双档、CRUD、toggle、外部合并模型仍可用  
- [ ] typecheck 相关文件无新增错；有测则跑  

## 不做

重做 MCP/插件页（可顺手同壳但非必须）；改会诊运行时逻辑；改主题色。
