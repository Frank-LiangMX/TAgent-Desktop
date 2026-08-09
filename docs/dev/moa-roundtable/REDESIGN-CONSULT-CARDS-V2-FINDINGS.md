# 会诊卡片重设计 V2 · FINDINGS（去「汇」流程图 → 名册行）

> 交卷者：`kscc -p --model glm-5.2 --dangerously-skip-permissions`
> 依据：`docs/dev/moa-roundtable/REDESIGN-CONSULT-CARDS-V2-brief.md`
> 范围：仅 `AgentBehaviorSettings.tsx` 信息架构/视觉 + `agent-behavior-settings.css`。**功能 CRUD / channelId / IPC / 校验零回归。**
> 约束：禁止 `commit`；typecheck 无新增错。

---

## 1. 改了啥

| 件 | 路径 | 说明 |
|---|---|---|
| 重写展示壳 | `apps/electron/src/renderer/components/settings/AgentBehaviorSettings.tsx` | 渠道宽 Select+标签 → 横滑 pill 段；座位「参考 chip → 汇圆 → 箭头 → 汇总 chip」流程图 → 单行 `名·模型 · … → 汇总 模型`；班底大圆角灰卡 → 名册行（薄分隔 + 左 2px 竖条）；班组/圆桌两个大虚线占位轨 → 页底两行小字「即将推出」；「添加预置」由紫底 default → outline。CRUD/toggle/校验/中文报错/channelId 过滤逐行保留 |
| 重写样式 | `apps/electron/src/renderer/styles/agent-behavior-settings.css` | 删 `agent-behavior-track*` / `-card*` / `-seat-strip` / `-seat-flow` / `-seat-converge` / `-channel-select*`；新增 `-channel-pills` / `-roster` / `-row*` / `-seat-line` / `-upcoming*`。编辑器/表单/参考席位列表样式原样保留。仅消费 `settings-shell` 既有变量，无新霓虹/emoji/多层阴影 |

**未动**：`ChannelsSettings.tsx`、`settings-shell.css` 的 `channel-*` 规则（渠道页仍用）、IPC / `moa-preset-service` 校验、`@tagent/ui` 原子组件、Settings 侧栏、`PresetEditor` / `ModelSelect` / `Field` 及全部 helper（`generatePresetId` / `createDraft` / `presetToDraft` / `draftToMoAPreset` / `validateDraft`）。

### 1.1 结构对照（V1 → V2）

| V1（去渠道化，但有「汇」流程图） | V2（名册行） |
|---|---|
| `agent-behavior-channel-select`：`适用渠道` 标签 + 宽 `SelectTrigger`（200–320px） | `agent-behavior-channel-pills`：横滑 pill 段（kscc 置顶；选中实心 `hsl(var(--foreground))` 中性色，非紫底）；无渠道时显 `agent-behavior-channel-empty` 一行提示 |
| `agent-behavior-cards` 散列卡 + `agent-behavior-card`（大圆角灰卡 + 渐变 + 多层阴影 + 悬停 translateY） | `agent-behavior-roster` 单容器 + `agent-behavior-row`（薄底分隔 + 左 2px 竖条；启用=primary 竖条，停用=透明竖条+opacity 0.6；悬停轻 hover-fill，无抬升） |
| `agent-behavior-seat-strip`：参考 chip → `ArrowRight` → `seat-converge`「汇」圆 → `ArrowRight` → 汇总 chip（多元素流程图） | `agent-behavior-seat-line`：`名 模型 · 名 模型 → 汇总 模型`（纯文字 + 间隔点 + `→`，单行；汇总 token 用强调色区分） |
| `agent-behavior-card-meta`（`N 席 · 超时 Xs`）+ `agent-behavior-card-actions`（编辑/删除）各占一行 | 超时并入标题行右侧（`row-meta`）；编辑/删除挂到座位行右侧（`row-actions`）→ 整行只 2 行 |
| 班组 / 圆桌：两个 `SettingsSection` + `agent-behavior-track` 大虚线淡底盒（占视觉重心） | `agent-behavior-upcoming`：页底两行小字「圆桌 · 即将推出」「班组 · 即将推出」（无盒、无图标） |
| 「添加预置」`Button`（default = 紫底） | `variant="outline"`（少用大面积紫底） |

---

## 2. 密度取舍（硬规则 5：单条 ≤ ~72px）

brief wireframe 画了 3 行（标题/座位/超时+操作）。但 3 行 + 最小可交互控件高度（`Switch sm` 20px + `Button sm` 32px / `icon-sm` 28px）+ padding/gap 下限 ≈ **79px**，压不到 72。

为达标，将 wireframe 的 3 行合并为 **2 行**（信息无损）：

```
┃ 默认会诊  内置                    超时 120s  [开关]
  架构师 glm-5.2 · 实战派 kimi-k2.5 → 汇总 glm-5.2     编辑  🗑
```

- 第 1 行（`row-head`）：名 + 内置标签 … 超时 + 启用开关 → 高度 = `Switch sm` 20px
- 第 2 行（`row-body`）：座位单行 … 编辑 + 删除 → 高度 = `Button sm` 32px
- padding `8px×2` + gap `4px` → **≈ 72px**，达标

座位仍为单行（硬规则 1 ✓）。超时从独立行并入标题行、编辑/删除从独立行并入座位行右侧——信息零丢失，仅不再各占一行。3 行方案被否的理由：3 行下限 ~79px > 72px，且会让「编辑/删除」独占一行造成纵向浪费。

> 旧 V1 大卡（header + 多行 seat-strip 易换行 + meta + actions + 13px×2 padding + 渐变阴影）≈ 140px+，「每条班底像海报」；V2 ≈ 72px，密度近翻倍。

---

## 3. 逻辑保留清单（逐项核对，语义未改）

- **channelId 过滤**：`channelPresets` 仍按 `isKscc ? !p.channelId || ===id : Boolean(p.channelId) && ===id`（兼容旧无字段视为 kscc；外部仅认 channelId 命中，不混席）。pill 仅替换 UI，`setSelectedChannelId` / `selectedChannel` 回落首个可选的逻辑不变。
- **CRUD**：`reload`→`listMoaPresets()`；`submit`→读最新列表合并后 `saveMoaPresets(merged)`（add 追加 / edit 替换）；`togglePreset` / `handleDelete` 走整份 `saveMoaPresets`（仅切/删本条，不跨渠混动）。`handleGenerateDraft` + `buildChannelBasedDraftPreset` 不变。
- **编辑器**：`PresetEditor` / `ModelSelect` / `Field` / `createDraft` / `presetToDraft` / `draftToMoAPreset` / `validateDraft` 原样保留；同页 inline 面板、侧滑入动画、右上启用开关、参考席位增删、汇总与超时分组、内置 ID 只读全部不变。
- **中文报错**：`请填写预置名称` / `参考席至少需要 2 个` / `参考席名称不能为空` / `参考席模型不能为空` / `请选择汇总模型` / `超时须为正数（毫秒）`；保存失败 `保存失败` 或后端中文错。`DestructiveConfirmDialog` 删除文案不变。
- **a11y**：pill 用 `role="tablist"`/`role="tab"`/`aria-selected`；座位 `→` 与间隔点 `aria-hidden`，汇总用文字「汇总」表达（非「汇」图形）；开关 `aria-label` 保留。

---

## 4. 文字线框（V2）

```
┌─ 设置 · Agent 行为 ──────────────────────────────────────┐
│ 协作策略                                                 │
│ Agent 行为                                               │
│ 配置会诊班底等协作策略；班组与圆桌即将推出。             │
│                                                          │
│ 会诊 ─────────────────────────────── [＋ 添加预置] ─── │  ← outline，非紫底
│ 班底用于 kscc 内网会诊。席位无工具…                      │
│ ( kscc 内网 )( DeepSeek )( … )                          │  ← 渠道 pill 段（选中实心中性色）
│ 2 个预置 · 2 个已启用                                    │
│ ┌──────────────────────────────────────────────────────┐ │  ← roster 容器（薄边）
│ ┃ 默认会诊  内置                  超时 120s  [开关]      │ │  ← 2 行；左 2px 竖条
│   架构师 glm-5.2 · 实战派 kimi-k2.5 → 汇总 glm-5.2  编辑 🗑 │ │
│ ┃ 省并发  内置                    超时 120s  [开关]      │ │
│   省并发·甲 glm-5.1 · 省并发·乙 mimo-v2.5 → 汇总 glm-5.2 编辑 🗑│ │
│ └──────────────────────────────────────────────────────┘ │
│ 圆桌 · 即将推出                                          │  ← 页底两行小字（无虚线盒）
│ 班组 · 即将推出                                          │
└──────────────────────────────────────────────────────────┘
```

---

## 5. 验收核对（对齐 brief「验收」+ 硬规则）

- [x] 截图级：无「汇」圆、无箭头流程图（`seat-converge` / `seat-flow` / `ArrowRight` DOM 与 CSS 全删；座位为单行文字 + `→`）
- [x] 渠道为 pill 段，非宽 Select+标签（`channel-select*` 删；`channel-pills` 横滑，选中实心 foreground 中性色）
- [x] 圆桌非大虚线框（`track*` 删；`upcoming` 页底两行小字）
- [x] 名册行密度：单条 ≈ 72px（2 行；非大圆角灰卡堆叠；左 2px primary 竖条区分启用态）
- [x] 「添加预置」用 outline，少用大面积紫底
- [x] CRUD / channelId 行为不变（§3 逐项）
- [x] typecheck 无新增错（§6）
- [x] 未 `commit`

## 6. 校验命令与结果

```bash
# 无旧类残留（应仅 channel-atoms 引入 + 新 channel-pill 类）
grep -n "channel-" apps/electron/src/renderer/components/settings/AgentBehaviorSettings.tsx
grep -nE "seat-flow|seat-converge|agent-behavior-track|ArrowRight" \
  apps/electron/src/renderer/components/settings/AgentBehaviorSettings.tsx   # 仅注释命中
grep -nE "agent-behavior-track|agent-behavior-card|seat-strip|seat-flow|seat-converge|channel-select" \
  apps/electron/src/renderer/styles/agent-behavior-settings.css              # 无输出

# typecheck（electron 包）
bun run --filter='@tagent/electron' typecheck
```

**typecheck 结果**：`error TS2353` × 1，全部位于 `apps/electron/src/renderer/components/chat/Chat.tsx:658`（`updateSessionMeta({ modelId })` 与 session meta 类型不符）。该文件为本会话开始前已修改的 WIP（`git status` 显示 `M`），**与 Agent 行为无导入/类型依赖**（Chat.tsx 不引用 `AgentBehaviorSettings` / `agent-behavior-*`），属**既有错、非本次新增**。本次改动文件 0 错。

**git 状态**：HEAD 仍为 `078be44`（未变），无暂存。两个目标文件在 V1 重设计时即未入库（`git ls-files` 为空，`git status` 显 `??`），本次 V2 改动仅在工作区，未 `commit`。

## 7. 手测清单（开设置 → Agent 行为）

- [ ] 渠道 pill：kscc 置顶；点切换 → 列表按 channelId 重滤；选中 pill 实心中性色，其余描边。
- [ ] 编辑中点 pill 不响应（`disabled={!!editor}`）。
- [ ] 名册行：启用行左侧 2px primary 竖条；停用行无竖条 + 整行 opacity 0.6；悬停轻 hover-fill。
- [ ] 座位单行：`名 模型 · 名 模型 → 汇总 模型`；汇总 token 强调色；窄宽时参考席 model 省略，汇总 token 保持可见。
- [ ] 开关/编辑/删除/添加/校验/取消/删除确认：行为与 V1 一致（见 §3）。
- [ ] 页底「圆桌 · 即将推出」「班组 · 即将推出」两行小字，无虚线盒。
- [ ] 浅/深主题：pill/roster/row/seat-line/upcoming 随 shell 变量切换，无紫霓虹、无大阴影。
