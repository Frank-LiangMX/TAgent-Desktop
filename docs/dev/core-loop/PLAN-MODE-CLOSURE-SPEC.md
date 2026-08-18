# Plan Mode 产品闭环规格

> 日期：2026-08-18  
> 证据：`session-1786959659981` @88–89 `EnterPlanMode`，@580–581 `ExitPlanMode`（SDK 自动批准，用户未点）。  
> 对照：`F:\TAgent_General` 已完整实现；Desktop 仅有类型 stub。

## 1. 问题陈述

Desktop 存在 **两套「计划」未接通**：

| 概念 | 用户理解 | 当前 Desktop |
|------|----------|--------------|
| **TAgent 计划模式** | 输入框 `Work · 计划模式`（`permissionMode=plan`）：只规划不执行 | pill 存在，但与 SDK 工具 **无联动** |
| **SDK Plan Mode 工具** | Claude Code 语义：`EnterPlanMode` 探索 → `ExitPlanMode` 交计划等人批 | 在 **完全自动** 下工具直接过；**无审批 UI**；计划写 `.context/*.md`，聊天里几乎看不见 |

用户期望（原话）：Agent 应 **切 TAgent 计划模式**，做好计划 **给用户审核**，用户 **批准** 后才执行——不是气泡里写一句 "plan mode"，也不是 SDK 替用户点批准。

## 2. 目标行为

### 2.1 EnterPlanMode

当 kscc 核在主会话调用 `EnterPlanMode` 且 `canUseTool` **允许**时：

1. 主进程 emit `plan_mode_changed { active: true, source: 'tool' }`（+ 可选 `enter_plan_mode { sessionId }`）。  
2. 渲染层将会话 `permissionMode` **切到 `plan`**（或等价「计划态」），composer pill 显示 **计划模式**。  
3. 运行中 **写操作/破坏性 Bash** 仍被 `permissionMode=plan` 拒绝（现有 `permission-service.ts:264-266`）。  
4. 可选：过程区/顶栏短文案「Agent 正在规划…」（非必须首版）。  
5. **禁止**：仅在 assistant 气泡里出现 tool_use JSON，而 composer 仍显示「完全自动」。

`executionMode=chat` 时：`EnterPlanMode` 仍 **软拒绝**（现有规则不变）。

### 2.2 ExitPlanMode

当调用 `ExitPlanMode` 时：

1. **必须** 走主进程 `exitPlanService.handleExitPlanMode`（搬 General），**阻塞** 直到用户选择。  
2. 渲染层展示 **ExitPlanModeBanner**（搬 General，皮对齐 Desktop / `AskUserQuestionBanner` 玻璃风格）：  
   - 展示 `toolInput.plan` 正文（Markdown）；若有 `planFilePath` 可读文件兜底。  
   - 四选项（与 General 一致）：  
     - 批准并完全自动执行 → `bypassPermissions`  
     - 批准并自动审批 → `auto`  
     - 拒绝计划 → deny  
     - 提供修改意见 → feedback 回灌模型  
3. 用户 **未批准前**：`canUseTool` 对 Write/Edit/Bash **仍 deny**（保持 plan 或当前只读策略）。  
4. 用户批准后：`plan_mode_changed { active: false }`，按所选切换 `permissionMode`，再 allow 本次 ExitPlanMode。  
5. **禁止**：在 `bypassPermissions` 下 SDK 直接返回 `User has approved your plan` 而 **无人点击**。

### 2.3 与 permission pill 的手动切换

- 用户手动把 pill 从 plan 切回 auto/bypass：**不** 等价于批准计划；若仍有 pending ExitPlanMode，Banner 仍显示。  
- 用户手动切到 plan：**不** 替代 EnterPlanMode 事件（可 emit `plan_mode_changed { source: 'permission' }` 对齐 General，首版可只做 tool 方向）。

## 3. 非目标

- 不做 Cursor 式独立 Plan 编辑器全屏页（首版 Banner + Markdown 足够）。  
- 不改 SDK 的 Enter/Exit 工具名或参数 schema。  
- 不在 Chat（只读）模式开放 Plan 工具。

## 4. 架构（对齐 General）

```
canUseTool(EnterPlanMode) → allow → emit plan_mode_changed(true) → renderer 切 permissionMode=plan
canUseTool(ExitPlanMode)  → exitPlanService.handleExitPlanMode
                          → IPC EXIT_PLAN_MODE_REQUEST → ExitPlanModeBanner
                          → user → EXIT_PLAN_MODE_RESPOND → resolve allow/deny + targetMode
                          → emit plan_mode_changed(false) + setPermissionMode
```

### 4.1 必搬/新建文件（参考 General path）

| 层 | General | Desktop 目标 |
|----|---------|--------------|
| 主进程服务 | `agent-exit-plan-service.ts` | `apps/electron/src/main/lib/agent/agent-exit-plan-service.ts` |
| canUseTool | `agent-orchestrator.ts` Enter/Exit 分支 | `permission-service.ts` `createCanUseTool` 顶部 |
| IPC | `ASK_USER` 同款 register/respond | `AGENT_IPC_CHANNELS` + preload + session IPC |
| 渲染 Banner | `ExitPlanModeBanner.tsx` | `apps/electron/src/renderer/components/chat/ExitPlanModeBanner.tsx` |
| 渲染 atoms | `agent-atoms` pending exit plans | 新建或扩展现有 atoms |
| 同步 hook | `useGlobalAgentListeners` plan 分支 | 扩 `useGlobalSessionRunSync` 或专用 hook |
| 工具名辅助 | `renderer/lib/agent-plan-mode.ts` | 同路径搬 |

### 4.2 IPC 通道（补全 stub）

`packages/shared/src/types/agent.ts` 已有 `ExitPlanModeRequest/Response`；需补 **正向**：

- `EXIT_PLAN_MODE_REQUEST`（主→渲染）  
- `EXIT_PLAN_MODE_RESOLVED`（主→渲染，可选）  
- `EXIT_PLAN_MODE_RESPOND`（渲染→主，已有 enum 名需核对）

## 5. 验收

### 自动

- [ ] `permission-service` 单测：`ExitPlanMode` 在 bypass 下 **不** 直接 allow，走 pending。  
- [ ] `EnterPlanMode` allow 后 mock emit 含 `plan_mode_changed active:true`。

### 手测

- [ ] Work + bypass：发「做一个需要规划的小功能」，模型 EnterPlanMode → pill 变 **计划模式**。  
- [ ] 模型 ExitPlanMode → Banner 显示 plan 正文；点 **拒绝** → 不写文件。  
- [ ] 点 **批准并完全自动** → pill 变完全自动，随后 Write 可执行。  
- [ ] 全程 **无** 未点击就出现 "User has approved your plan" 的 tool_result（除非用户真点了批准）。

## 6. 与审计会话的对照

| 落盘 idx | 现象 | 本规格修复点 |
|----------|------|--------------|
| @88–89 | EnterPlanMode，composer 仍 bypass | §2.1 切 plan pill |
| @580–581 | ExitPlanMode 自动批准 | §2.2 阻塞 + Banner |
| @259–473 | Plan 期间多次 AskUser | 不禁止 AskUser，但 Plan 态下写仍拦 |
| 09:57–01:04 长规划 | 产品未告知「在规划」 | §2.1 可选规划态文案 |

实现 brief：[PLAN-MODE-CLOSURE-brief.md](./PLAN-MODE-CLOSURE-brief.md)
