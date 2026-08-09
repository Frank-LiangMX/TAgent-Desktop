# 重设计「Agent 行为」UI · FINDINGS（去渠道化）

> 交卷者：`kscc -p --model glm-5.2 --dangerously-skip-permissions`
> 依据：`docs/dev/moa-roundtable/REDESIGN-AGENT-BEHAVIOR-UI-brief.md`
> 范围：仅 UI 信息架构 + 视觉 + 编辑交互外壳。**CRUD / IPC / 校验逻辑不变。**
> 约束：禁止 `commit`；typecheck 无新增错。

---

## 1. 改了啥

| 件 | 路径 | 说明 |
|---|---|---|
| 重写组件 | `apps/electron/src/renderer/components/settings/AgentBehaviorSettings.tsx` | 去掉全部 `channel-*` 类名与渠道页结构；改为协作策略板 + 座位芯片剧本卡 + 同页 inline 编辑面板；班组/圆桌改低调占位轨。CRUD/toggle/校验/中文报错逐行保留 |
| 新增样式 | `apps/electron/src/renderer/styles/agent-behavior-settings.css` | 新建前缀 `agent-behavior-*`；仅消费 `settings-shell` 既有 CSS 变量（`--spatial-*` / `--settings-*-fill` / `--glass-rgb`），浅/深随 shell 切换，不引新色板 |
| 引入样式 | `apps/electron/src/renderer/styles/globals.css` | `@import './agent-behavior-settings.css';`（紧跟 `settings-shell.css` 之后，保证变量已就绪） |

**未动**：`ChannelsSettings.tsx`、`settings-shell.css` 里的 `channel-*` 规则（渠道页仍用）、IPC / `moa-preset-service` 校验、Settings 侧栏其它 tab、`@tagent/ui` 原子组件。

### 1.1 结构对照（旧 → 新）

| 旧（渠道化） | 新（策略板） |
|---|---|
| `settings-page channel-settings-page` 容器 | `settings-page agent-behavior-page` |
| `channel-settings-heading` + 标题 + 说明 | `settings-page-intro` + `agent-behavior-kicker`（「协作策略」）+ 标题 + 一句说明 |
| 班组 / 圆桌：`SettingsSection` + `SettingsCard divided={false}` 空壳 `<p>` | `SettingsSection` + `agent-behavior-track`（虚线淡底轨 + 「即将推出」+ 一行说明） |
| 会诊列表：`channel-list` 带描边容器 + `channel-row` 行 + `channel-test-result--idle` 空位 | `agent-behavior-cards` 散列卡 + `agent-behavior-card`（座位芯片剧本卡），无「测试连通」空位 |
| 行内信息：`seatSummary` 文本 + `channel-row-details` | `agent-behavior-seat-strip`：参考席 chip（名·模型）→ 箭头 →「汇」→ 箭头 → 汇总 chip（强调色） |
| 编辑：整页 `channel-editor`（返回箭头 `channel-editor-back` + `channel-editor-section` 堆栈） | 同页 `agent-behavior-editor` inline 面板（无返回箭头、无 EditorSection 堆栈，轻量分组标签 + 右上启用开关 + 侧滑入动画） |
| `channel-notice` / `channel-empty` / `channel-list-loading` | `agent-behavior-notice` / `agent-behavior-empty` / `agent-behavior-loading` |

### 1.2 逻辑保留清单（逐项核对，未改语义）

- `generatePresetId` / `createDraft` / `presetToDraft` / `draftToMoAPreset` / `validateDraft`：原样保留。
- `reload` → `window.electronAPI.listMoaPresets()`；`submit` → 读最新列表合并后 `saveMoaPresets(merged)`（add 追加 / edit 替换）。
- `togglePreset` / `handleDelete`：原样（删除走整份 `saveMoaPresets` 过滤）。
- `ModelSelect`：kscc enabled 下拉 + 当前值兜底项；无 kscc 模型时退化为手动 `modelId` 输入。
- 客户端校验中文报错：`请填写预置名称` / `参考席至少需要 2 个` / `参考席名称不能为空` / `参考席模型不能为空` / `请选择汇总模型` / `超时须为正数（毫秒）`；保存失败仍 `保存失败` 或后端中文错。
- `DestructiveConfirmDialog` 删除确认文案不变。

---

## 2. 文字线框（与渠道页并排打开时应「一眼不像」）

```
┌─ 设置 · Agent 行为（策略板）─────────────────────────────┐
│ 协作策略                                                 │  ← 短 kicker（灰，全大写小号）
│ Agent 行为                                               │  ← 标题
│ 配置会诊班底等协作策略；班组与圆桌即将推出。             │  ← 一句说明
│                                                          │
│ 班组 ─────────────────────────────────────────────────── │
│ ┄┄ [👥] 即将推出                                         │  ← 低调占位轨：虚线淡底
│      角色班组与派工偏好将在此配置。                      │
│                                                          │
│ 会诊 ────────────────────────────────── [＋ 添加预置] ─ │
│ 班底仅用于 kscc 内网会诊；外部渠道按当前模型自动合成…    │
│ 2 个预置 · 2 个已启用                                    │  ← summary
│                                                          │
│ ┌─ 默认会诊 ──[内置]── 已启用 ──────────────────── (●)─┐ │  ← 剧本卡（轻微表面）
│ │ [架构师·glm-5.2] [实战派·kimi-k2.5] →(汇)→[汇总·glm-5.2] │ │  ← 座位条
│ │ 2 席 · 超时 120s                                  编辑 🗑 │ │  ← meta + 操作
│ └──────────────────────────────────────────────────────┘ │
│ ┌─ 省并发 ──[内置]── 已启用 ─────────────────────── (●)─┐ │
│ │ [省并发·甲·glm-5.1] [省并发·乙·mimo-v2.5] →(汇)→[汇总·glm-5.2] │
│ │ 2 席 · 超时 120s                                  编辑 🗑 │
│ └──────────────────────────────────────────────────────┘ │
│                                                          │
│ 圆桌 ────────────────────────────────────────────────── │
│ ┄┄ [◉] 即将推出                                          │  ← 低调占位轨
│      @ 圆桌深度、共享记忆等将在此配置。                  │
└──────────────────────────────────────────────────────────┘

点「编辑」/「添加预置」→ 会诊节内就地展开同页编辑面板（无返回箭头）：
┌─ 编辑预置 ─── 新建预置 ────────────── 已停用/已启用 (●)─┐
│ 添加会诊预置                                            │
│ ⚠ 请填写预置名称  （错误时显中文红条）                  │
│ 基本信息                                                 │
│  预置名称 [        ]   预置 ID [custom-xx (只读)]       │
│ 参考席位 ────────────────────────────── [＋ 添加席位] │
│  [席位名称] [模型下拉 ▾] 🗑  …（≥2，可增删）            │
│ 汇总与超时                                               │
│  汇总模型 [下拉 ▾]   单席超时(ms) [120000]             │
│                                       [取消] [保存更改] │
└─────────────────────────────────────────────────────────┘
```

与渠道页差异点（验收 §「一眼不像」）：
1. 渠道页是「带描边大列表 + 行间分隔线 + 测试连通槽」；本页是「散列剧本卡 + 卡间留白」，无测试连通槽。
2. 渠道页用 `channel-row` 表格行式信息；本页用座位芯片条 + 「汇」汇聚节点。
3. 渠道编辑器是「整页 + 返回箭头 + EditorSection 堆栈」；本页是「会诊节内 inline 面板 + 右上开关 + 轻量分组」。
4. 班组/圆桌不再是 `SettingsCard` 空壳连排，而是虚线淡底「即将推出」轨。

---

## 3. 手测清单（开设置 → Agent 行为）

- [ ] 列表正常加载：seed `default` / `cheap` 两张剧本卡，各显示座位芯片条（参考席 → 汇 → 汇总）。
- [ ] 卡片悬停轻抬（`translateY(-1px)` + 描边转强调色）；停用卡整体 `opacity:0.72`。
- [ ] 启用开关：点卡内 switch → 立即落盘并刷新；状态点 + 「已启用/已停用」文案随之变。
- [ ] 添加预置：点「添加预置」→ 会诊节内 inline 展开 `agent-behavior-editor`（侧滑入动画），列表暂隐；班组/圆桌/intro 仍在（同页感）。
- [ ] 添加校验：空名保存 → 红条「请填写预置名称」；删到 <2 席保存 → 「参考席至少需要 2 个」；空席位名/模型 → 对应中文错；未选汇总 → 「请选择汇总模型」；超时 0 → 「超时须为正数（毫秒）」。
- [ ] 保存成功：列表回归，新卡就位，summary 计数 +1。
- [ ] 编辑预置：点「编辑」→ inline 面板带原值；改名/换模型/调超时 → 保存生效；内置预置 ID 只读不可改。
- [ ] 取消：点「取消」→ 面板收起，列表回归，未保存改动丢弃。
- [ ] 删除：点 🗑 → `DestructiveConfirmDialog`「删除预置「X」？」→ 确认后移除，计数 -1。
- [ ] 模型下拉：kscc 有启用模型时为下拉（含当前值兜底项）；无启用模型时退化为手动 `modelId` 输入并带 hint。
- [ ] 渠道页与 Agent 行为页并排切换：视觉一眼可辨（卡 vs 行、芯片条 vs 文本、inline 面板 vs 整页编辑器）。
- [ ] 浅/深主题：卡 / 轨 / 编辑器 / 输入随 shell 变量切换，无发灰、无紫霓虹、无大阴影。
- [ ] 窄宽（<760px）：表单两列折单列；席位行折单列；座位条 `flex-wrap` 换行不溢出。

---

## 4. 验收核对（对齐 brief「验收」）

- [x] 源码中无 `channel-` 类名残留于 `AgentBehaviorSettings.tsx`（见 §5 校验命令）。
- [x] 列表为座位芯片剧本卡，非 `channel-row`。
- [x] 编辑非「整页渠道编辑器」复刻（同页 inline 面板，无返回箭头 + EditorSection 堆栈）。
- [x] CRUD 仍可用；非法保存仍中文错。
- [x] typecheck 无新增错。
- [x] 未 `commit`。

## 5. 校验命令

```bash
# 无 channel- 残留（应无输出）
grep -n "channel-" apps/electron/src/renderer/components/settings/AgentBehaviorSettings.tsx

# typecheck（electron 包）
bun run --filter='@tagent/electron' typecheck
```
