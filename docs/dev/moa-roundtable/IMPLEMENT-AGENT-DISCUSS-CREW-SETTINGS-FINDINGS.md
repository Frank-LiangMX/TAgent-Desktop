# FINDINGS：Agent 行为 · 圆桌 & 班组 设置页

> 日期：2026-08-11
> 执行：本地 `kscc / glm-5.2`
> Brief：`docs/dev/moa-roundtable/IMPLEMENT-AGENT-DISCUSS-CREW-SETTINGS-brief.md`

## 概述

把 `SettingsPage` 里 `agent-discuss` / `agent-crew` 两个 tab 的 `AgentComingSoonPage`
（「即将推出」）替换为可用设置页。视觉对齐 `AgentBehaviorSettings` /
`NoProgressGuardSettings`（`agent-behavior-*` 样式 + `@tagent/ui` 的
`SettingsSection` / `SettingsCard` / `SettingsSelect` / `SettingsToggle`），未抄
`ChannelsSettings`。

偏好独立落盘（两个 JSON 文件），主进程整单校验、非法 reject 中文错、原子写 +
损坏自愈。**本期仅落盘 + UI + 校验**；部分字段的运行时闸尚未接（见 §5 TODO）。

## 改动文件清单

### 新增
- `packages/shared/src/types/agent-discuss-crew-prefs.ts` — 圆桌 / 班组 偏好公共
  契约：类型、默认值、范围常量、`validateXxx` / `isValidXxx` / `sanitizeXxx` 纯函数。
- `apps/electron/src/main/lib/agent/agent-discuss-prefs.ts` — 圆桌偏好读写服务
 （`readAgentDiscussPrefs` / `writeAgentDiscussPrefs`，经 `atomic-json`）。
- `apps/electron/src/main/lib/agent/agent-crew-prefs.ts` — 班组偏好读写服务
  （`readAgentCrewPrefs` / `writeAgentCrewPrefs`，经 `atomic-json`）。
- `apps/electron/src/renderer/components/settings/AgentDiscussSettings.tsx` — 圆桌
  设置页组件。
- `apps/electron/src/renderer/components/settings/AgentCrewSettings.tsx` — 班组设置
  页组件。
- `apps/electron/src/main/lib/agent/agent-discuss-prefs.test.ts` — 圆桌偏好单测
  （14 例）。
- `apps/electron/src/main/lib/agent/agent-crew-prefs.test.ts` — 班组偏好单测
  （13 例）。
- `docs/dev/moa-roundtable/IMPLEMENT-AGENT-DISCUSS-CREW-SETTINGS-FINDINGS.md` — 本文件。

### 修改
- `packages/shared/src/types/index.ts` — 导出新契约
  `export * from './agent-discuss-crew-prefs'`。
- `packages/shared/src/types/agent.ts` — `AGENT_IPC_CHANNELS` 新增 4 个通道
  （`GET/SET_DISCUSS_PREFS`、`GET/SET_CREW_PREFS`）。
- `apps/electron/src/main/lib/config/config-paths.ts` — 新增
  `getAgentDiscussPrefsPath()` / `getAgentCrewPrefsPath()`。
- `apps/electron/src/main/lib/ipc/session-service.ts` — 注册 4 个 IPC handler
  （读返回默认 / 写整单校验拒绝），导入两个 prefs 服务。
- `apps/electron/src/preload/index.ts` — 暴露 4 个方法 + 类型导入。
- `apps/electron/src/renderer/App.tsx` — `Window.electronAPI` 全局类型声明补 4 个方法
  + 类型导入。
- `apps/electron/src/renderer/components/settings/SettingsPage.tsx` — 接入两个新
  组件、删除 `AgentComingSoonPage`（已无引用）、班组 tab 描述去「（即将推出）」。

## 数据契约

### 圆桌（`agent-discuss`）— `~/.tagent[-dev]/agent-discuss-prefs.json`

| 字段 | 类型 | 默认 | 范围 | 说明 |
|------|------|------|------|------|
| `defaultRoundLimit` | int | 3 | 1–6 | 研讨默认轮数；会诊班底 `roundLimit` 仍可覆盖 |
| `maxAgentMentionDepth` | int | 4 | 1–10 | @ 链式深度上限（**本期只落盘 + UI**；运行时闸 TODO） |
| `routeComposerWhileDiscussing` | bool | false | — | 讨论进行中主会话输入是否路由到圆桌（默认仍进讨论室） |

### 班组（`agent-crew`）— `~/.tagent[-dev]/agent-crew-prefs.json`

| 字段 | 类型 | 默认 | 范围 | 说明 |
|------|------|------|------|------|
| `autoOpenPanelOnDispatch` | bool | true | — | Work 派工后自动打开班组面板 |
| `maxParallelWorkers` | int | 3 | 1–8 | 并行 worker 上限（**本期落盘 + UI**；调度未接） |
| `showFlowAsGraph` | bool | false | — | 偏好：依赖用图（阶段3；本期开关预留，无图时仅文案提示） |

## IPC

| 通道 | 方向 | 入参 / 返回 |
|------|------|------|
| `agent:get-discuss-prefs` | renderer→main | `() => AgentDiscussPrefs`（缺失/损坏→默认） |
| `agent:set-discuss-prefs` | renderer→main | `(prefs) => AgentDiscussPrefs`（非法 reject 中文错） |
| `agent:get-crew-prefs` | renderer→main | `() => AgentCrewPrefs` |
| `agent:set-crew-prefs` | renderer→main | `(prefs) => AgentCrewPrefs` |

写 handler 内部 `writeXxxPrefs` 先 `validateXxx`，非法即 `throw new Error(中文)`
→ `ipcMain.handle` reject → renderer `await` 抛错 → UI `catch` 回显
`agent-behavior-notice--error`，并回滚乐观更新。与 `SAVE_CLI_WORKERS` 同口径。

## 校验与落盘

- 纯函数 `validateAgentDiscussPrefs` / `validateAgentCrewPrefs`：逐字段 `typeof`
  归一后做整数 + 范围 + 布尔校验，返回首个中文错文案或 `null`。
- `readXxxPrefs`：`readJsonSafe`（损坏自愈）→ `isValidXxx` ? `sanitizeXxx`（剥离
  未知字段）: 默认。**纯读不写盘**（首次落盘由首次 `set` 负责）。
- `writeXxxPrefs`：`validate` 失败抛错且**不写盘**；合法则 `sanitizeXxx` 剥离已知
  字段后 `writeJsonAtomic`（临时文件 + fsync + 原子 rename，写一半崩溃可从 `.bak`
  自愈）。

## TODO / 运行时闸未接（本期只落盘 + UI）

> 以下三项 brief 已声明「本期只落盘 + UI」/「调度未接」/「阶段3 预留」，**勿当作
> 已生效功能**。开关可改、值可存、重启仍在，但运行时尚未据此改变行为。

1. **`maxAgentMentionDepth`（圆桌）** — 运行时 @ 链式深度闸未接。当前偏好已落盘 +
   UI 可改，但 `runMoADiscussion` / 提及解析路径尚未读此值拦截越深 @ 链。
   接线点建议：在 `@` 提及解析（`parseMentions` / `buildMentionPromptAppend`）
   或 `runMoADiscussion` 编排处，按深度截断 / 提示。**stub 位置：无**（未植入任何
   占位分支，避免误判已接）。
2. **`maxParallelWorkers`（班组）** — 班组调度器尚未接此上限。当前偏好已落盘 +
   UI 可改，但看板派工 / worker 调度（`kanban-worker-service` 等）尚未读此值限流。
   接线点建议：班组 worker dispatch 处按 `Promise.all` 分批 / 信号量限并发。
3. **`showFlowAsGraph`（班组）** — 阶段3 依赖图未实现。当前仅偏好落盘 + UI 开关
   预留，无图实现，UI 文案已如实提示「本期无图实现，仅作偏好落盘与文案提示」。

## 不改的范围（brief 约束）

- 未改 No-Progress Guard（守卫纯逻辑 / 适配 / 落盘偏好）。
- 未改会诊班底 CRUD（`AgentBehaviorSettings` / `moa-preset-service`）。
- 未改 CLI 工人逻辑（`cli-workers-service` / `CliWorkersSettingsSection`）。
- 未改会诊班底 `roundLimit` 覆盖语义（圆桌 `defaultRoundLimit` 仅作未指定时的默认，
  班底 `roundLimit` 仍可覆盖）。

## 验收对照

| 验收项 | 结果 |
|------|------|
| 设置 → 圆桌 / 班组：表单可改、重启后仍在 | ✅ 偏好经 `atomic-json` 落盘两 JSON；renderer 每次进页 `getXxx` 读盘；改即 `setXxx` 原子写。重启后仍在。 |
| typecheck 无新增错 | ✅ 本人新增/修改文件 0 报错（shared 包 `tsc --noEmit` 0 错；electron 工程 22 个错全在未触碰的基线文件：`pi-agent-adapter.event-ir.test.ts` / `no-progress-guard.ts` / `no-progress-replay.test.ts` / `session-service.ts:1701` NoProgressEvent，均 brief 约束「不改」范围）。 |
| 相关 vitest 绿 | ✅ `agent-discuss-prefs.test.ts` 14 + `agent-crew-prefs.test.ts` 13 = **27/27 通过**。 |
| `git diff --check` | ✅ exit 0（仅 2 条 LF→CRLF 提示，位于本会话未触碰的 `no-progress-guard.test.ts` / `no-progress.ts`，非本人改动；本人新文件无 trailing whitespace / CRLF）。 |
| 禁止 commit/push | ✅ 未 commit / 未 push。 |

## 测试覆盖（最小单测：读写校验 / 非法值拒绝）

- 读：无文件 → 默认且不写盘；合法文件 → 原样剥离未知字段；损坏 / 越界 → 默认。
- 写：合法 → 落盘 + 回读一致；非法（轮数 0/7、深度 0/11、并行 0/9、非布尔、非
  对象）→ 抛中文错且**不写盘**。
- 纯函数边界：`defaultRoundLimit` 1/6 合法、0/7 非法；`maxAgentMentionDepth` 1/10
  合法、0/11 非法；`maxParallelWorkers` 1/8 合法、0/9 非法；非整数 / 缺字段 / 布尔
  类型；`isValidXxx` 与 `validateXxx` 一致。

## 复用与运行命令备忘

- 偏好服务仿 `cli-workers-service`（`readJsonSafe` / `writeJsonAtomic` / 整单校验
  拒写），偏好「单值 + env 覆盖」的 `no-progress-guard-prefs` 不适用多字段场景。
- 测试跑法（本机 Git bash 沙箱下 `bunx` 双 fork，改 `node` 直跑）：
  - vitest：`node node_modules/vitest/vitest.mjs run apps/electron/src/main/lib/agent/agent-discuss-prefs.test.ts apps/electron/src/main/lib/agent/agent-crew-prefs.test.ts`
  - tsc：`node <typescript lib/tsc.js> --noEmit -p apps/electron/tsconfig.json`
    （项目 `typescript ^5.0.0`，用 TS 5.9.x；`typescript@latest` 6.x 会误报
    TS5102 `baseUrl`，勿用。）
