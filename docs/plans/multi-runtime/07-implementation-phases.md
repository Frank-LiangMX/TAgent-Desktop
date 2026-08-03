# 07 — 实现阶段、验收与风险

> 所属：[multi-runtime](./README.md)  
> 依赖：01–06 宪章稳定后再大开编码  

---

## 1. 原则

- **先硬边界，后炫交互**（Chat 工具拦截 > 花哨 @ UI）  
- **用户切换主权**必须有服务端/主进程校验  
- 每阶段可独立演示；文档与 PR 互链  
- 看板大部可移植 General；Desktop 补 Chat/Work 与 MoA 产品化  

---

## 2. 阶段

### Phase A — 宪章落地（数据 + 硬拦）

| 项 | 说明 | DoD | 状态（2026-08-02） |
| --- | --- | --- | --- |
| A1 | `executionMode` 入 session meta | 读写持久化；默认值明确 | ✅ 新建默认 chat；旧会话 migrate→work |
| A2 | 切换 IPC 仅 `user` / `user-confirm-suggestion` | 拒绝 agent 源 | ✅ `UPDATE_SESSION_EXECUTION_MODE` |
| A3 | Chat 工具策略服务端拦截 | Write/kanban 派工在 Chat 必失败 | ✅ `isChatModeBlockedTool` + PermissionService 优先于 bypass |
| A4 | Work 下 permissionMode 行为表 | 与现网权限对齐 | ✅ Chat UI 灰掉权限档；Work 仍走原 plan/auto/bypass |
| A5 | 主会话 prompt 按模式分叉注入 | Chat/Work 两套调度段落 | ✅ kscc append + Pi systemPromptAppend |

### Phase B — Chat 协作

| 项 | DoD | 状态（2026-08-03） |
| --- | --- | --- |
| B1 可 @ 的 pin 角色列表 | 非全库 | ✅ `AgentRoleProfile.pinned` + RolesPage 📌 开关；`MentionPicker` 无 query 显 pin 子集（无 pin 回退全量）、有 query 全库过滤 pin 优先；`parseMentions` 仍用全库 |
| B2 铭牌气泡 + 顺序发言 | | ⚠️ 本轮 chip `@A → @B` + system 注入角色投影顺序发言；非真多进程 |
| B3 followMode（可选） | | ✅ activeSpeaker 对话跟随：`@` 设置/切换，续聊无 `@` 仍由该角色接（`pendingMentionRoleIds` 持久、turn_end 不清空）；输入框顶部「正在与 @角色 对话 ✕」指示，✕ 走 `CLEAR_MENTION_FOLLOW` |
| B4 建议切 Work 确认条 | 点确认才变 mode | ✅ Chat 硬拦推建议条；确认 `user-confirm-suggestion` |

### Phase C — 角色库服务 + SubAgent 收敛

| 项 | DoD | 状态（2026-08-02） |
| --- | --- | --- |
| C1 role-store 读写 seed DEFAULT_ROLES | ✅ | `agent-role-service` + `~/.tagent/agent-roles.json` |
| C2 resolve 单点 | ✅ `resolveRole`；`composeRoleSystemPrompt` 已做；看板 dispatcher 待接线 | 部分 |
| C3 SubAgent 从角色投影 | ✅ `roleToSubagentDef`；code-reviewer→reviewer；目录含岗位短列表；Pi/kscc 共用 | 完成 |
| C4 设置页角色 CRUD / 商店安装 | ✅ 列表+重置+导入+商店安装 | 编辑表单可后置 |

### Phase D — 看板 Work 路径

| 项 | DoD | 状态（2026-08-03） |
| --- | --- | --- |
| D1 对齐 General dispatcher/worker 核心 | 仅 Work 可派 | ✅ 调度 + headless + 主会话工具 + **blocks 依赖图** |
| D2 roleId 解析 modelPool | | ✅ |
| D3 右栏班组 | | ✅ **`KanbanCrewPanel` 全高右栏**（进行中/历史/详情/工人输出）；底栏窄条废弃主路径 |
| D4 worker 防死锁 approval | | ✅ 交互/Browser/建板 deny + `blockedApprovals` 审计 |
| D5 Chat 下调用派工 API 拒绝 | | ✅ |
| 桌面通知 | 任务/板完成 | ✅ `kanban-notify` + 顶栏 ticker |
| goal 轻量闸门 | 防空摘要假完成 | ✅ 规则 judge；LLM 路径 stub fail-open |
| 完成回流 | 主会话 panel 注入 | ✅ `kanban-reflux`：**班组通知 IR**（非 user 气泡） |
| Work→Chat 后台提示 | 不杀工人 | ✅ `backgroundCrew` + Chat banner |
| 工人结果摘要 | 可读交付 | ✅ 流式合并 + 面板回读 + 工具轨迹兜底 + progressLogs |
| 工人会话污染列表 | 不进侧栏 | ✅ `hidden` + `isHiddenSessionMeta` 过滤 |
| 窄输入栏 | 右栏开不叠字 | ✅ `is-composer-compact` |

### Phase E — MoA 产品化

| 项 | DoD |
| --- | --- |
| E1 kscc 默认班底 + 参与池 | |
| E2 主会话圆桌卡 + 席位详情 | |
| E3 与 ChildRun 组件统一 | |
| E4 结论 → 切 Work（若需）→ 建板 CTA | |

### Phase F — 布局

| 项 | DoD | 状态（2026-08-03） |
| --- | --- | --- |
| F1 右栏 + 可拖分栏 | | ✅ `KanbanCrewPanel` 左缘拖拽手柄（pointer capture），宽度 `localStorage` 持久化、clamp 280–560；轻量 split，未做 mosaic |
| F2（可选）mosaic 工作台模式 | 不拆 AppShell | 未做（等功能稳态） |

---

## 3. 验收场景（BDD 风格摘要）

```gherkin
Scenario: Chat 不能写文件
  Given executionMode=chat
  When agent 调用 Write
  Then 工具被拒绝且用户可见原因

Scenario: 仅用户可切 Work
  Given executionMode=chat
  When agent 建议切换且用户未确认
  Then executionMode 仍为 chat
  When 用户点击确认
  Then executionMode=work

Scenario: Work 回 Chat 不杀 worker
  Given work 下有 running 看板任务
  When 用户切到 chat
  Then 任务仍 running
  And UI 提示后台执行中

Scenario: @ 不建看板
  Given chat 模式
  When 用户 @架构师 提问
  Then 仅消息时间线出现架构师回复
  And 无新 kanban task

Scenario: kscc MoA 组班
  Given kscc 且至少 2 模型 enabled
  When 用户确认默认会诊
  Then 参考席使用不同 modelId 并行
  And 主会话显示进度卡与结论
```

---

## 4. 风险登记

| ID | 风险 | 缓解 |
| --- | --- | --- |
| R1 | 只靠 prompt 拦 Chat 写 | 工具层硬拦 |
| R2 | 模式与权限 UI 并列导致误触 | 双轴布局 |
| R3 | MoA 多席爆上下文 | compact 角色 prompt；限席数 |
| R4 | kscc 同模并发降智 | 模板互异模型；并发上限 |
| R5 | 角色商店污染 @/SubAgent | pin + runtimeModes |
| R6 | 文档与代码漂移 | PR 链文档；改行为先改 multi-runtime/* |
| R7 | 与记忆/压缩模块交叉 | 边界：本模块不管 L5 写入策略 |
| R8 | General 看板移植范围膨胀 | Phase D 只收 Work 路径 P0 |

---

## 5. 关键文件（预期触点）

| 区域 | 路径 |
| --- | --- |
| 会话 meta | `packages/shared/src/types/agent.ts` |
| 角色 | `packages/shared/src/types/agent-role.ts` |
| 角色服务 | `apps/electron/src/main/lib/role/*`（新建） |
| 会话 IPC | `session-service.ts` |
| 工具/权限 | permission + adapter beforeToolCall |
| SubAgent | `subagent-definitions.ts`, `subagent-task-tool.ts` |
| MoA | `packages/pi-core/src/moa-orchestrator.ts` + UI |
| 看板 | 移植自 General kanban-*（路径实现时定） |
| 渲染 | Chat 气泡、ChildRun、右栏 |

---

## 6. 修订

| 日期 | 说明 |
| --- | --- |
| 2026-08-02 | 初版阶段划分 |
| 2026-08-03 | D 右栏面板 + 工人结果/回流修边；B1/B2 基础；交接见 [09-handoff-2026-08-03](./09-handoff-2026-08-03.md) |
| 2026-08-03 | P1 补完：B1 pin 子集 ✅、B3 activeSpeaker followMode ✅、F1 右栏可拖宽 ✅、删 KanbanCrewStrip。已实现待运行验收，typecheck + 86 项单测通过 |
