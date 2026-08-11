# Brief：Agent 行为 · 圆桌 & 班组设置页

> 日期：2026-08-11  
> 执行：本地 `kscc / glm-5.2`  
> 替换：`SettingsPage` 里 `agent-discuss` / `agent-crew` 的 `AgentComingSoonPage`

## 目标

把「即将推出」换成可用设置页，视觉对齐 `AgentBehaviorSettings` / `CliWorkersSettingsSection`（`agent-behavior-*` 样式，勿抄 ChannelsSettings）。

## 圆桌（`agent-discuss`）

可配置项（落盘 `~/.tagent[-dev]/agent-discuss-prefs.json` 或合入既有 prefs；自定结构需校验）：

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `defaultRoundLimit` | 1–6 | 3 | 研讨默认轮数（会诊班底 `roundLimit` 仍可覆盖） |
| `maxAgentMentionDepth` | 1–10 | 4 | @ 链式深度上限（**本期只落盘+UI**；运行时闸可 stub/TODO，在 FINDINGS 标明） |
| `routeComposerWhileDiscussing` | bool | false | 讨论进行中主会话输入是否路由到圆桌（默认仍进讨论室） |

文案：说明与「会诊」班底的关系（轮数可在班底覆盖）。

## 班组（`agent-crew`）

落盘 `agent-crew-prefs.json`：

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `autoOpenPanelOnDispatch` | bool | true | Work 派工后自动打开班组面板 |
| `maxParallelWorkers` | 1–8 | 3 | 并行 worker 上限（**本期落盘+UI**；调度未接则 FINDINGS 标明） |
| `showFlowAsGraph` | bool | false | 偏好：依赖用图（阶段3；本期开关预留，无图时仅文案提示） |

## 实现要求

1. 新组件：`AgentDiscussSettings.tsx`、`AgentCrewSettings.tsx`（或同目录合理命名）。  
2. IPC：get/set prefs（可仿 `no-progress-guard` 或 CLI workers）；preload + App 类型同步。  
3. `SettingsPage` 接上真页面，删 ComingSoon。  
4. 最小单测：读写校验 / 非法值拒绝。  
5. `docs/dev/moa-roundtable/IMPLEMENT-AGENT-DISCUSS-CREW-SETTINGS-FINDINGS.md`。  
6. **禁止 commit/push**。不改 Guard / 会诊班底 CRUD / CLI 工人逻辑。

## 验收

- 设置 → 圆桌 / 班组：表单可改、重启后仍在。  
- typecheck 无新增错；相关 vitest 绿；`git diff --check`。
