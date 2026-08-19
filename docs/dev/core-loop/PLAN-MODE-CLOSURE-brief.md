# Brief · Plan Mode 闭环（搬 General → Desktop）

> 交卷者：`kscc -p --model glm-5.2 --dangerously-skip-permissions`  
> 规格：[PLAN-MODE-CLOSURE-SPEC.md](./PLAN-MODE-CLOSURE-SPEC.md)  
> 对照仓：`F:\TAgent_General`（必读 `--add-dir`）  
> **禁止**改 collab room 业务、MoA、Pi 核。

## 目标

Desktop 接上 **EnterPlanMode 切 TAgent 计划态** + **ExitPlanMode 用户审批**，消除 bypass 下 SDK 自动 "User has approved"。

## 必搬清单（路径以 General 为准，落 Desktop 对等目录）

1. **主进程** `agent-exit-plan-service.ts` → `apps/electron/src/main/lib/agent/agent-exit-plan-service.ts`（基本原样，import `@tagent/shared`）。  
2. **canUseTool** 在 `permission-service.ts` `createCanUseTool` 内增加（参考 General `agent-orchestrator.ts:2523-2565`）：  
   - `EnterPlanMode`：allow + 回调 emit `plan_mode_changed(true)` + 通知 session 切 plan（需接 session-service 现有 setPermissionMode 路径）。  
   - `ExitPlanMode`：**始终** `exitPlanService.handleExitPlanMode`，**不论** bypass/auto/plan。  
3. **IPC**：补 `EXIT_PLAN_MODE_REQUEST` / `EXIT_PLAN_MODE_RESPOND`（+ 可选 RESOLVED）；preload expose；ipcMain handler 调 `exitPlanService.respondToExitPlanMode`。  
4. **渲染** `ExitPlanModeBanner.tsx` → `apps/electron/src/renderer/components/chat/`，视觉对齐 `AskUserQuestionBanner`（玻璃、全宽、不透明正文）。  
5. **atoms + hook**：pending exit plan 队列（仿 General `allPendingExitPlanRequestsAtom`）；在 App 根或 Chat 旁挂载监听 + Banner。  
6. **`agent-plan-mode.ts`**：搬 `getPlanModeChangeFromToolName` / `updatePlanModeSessionSet`（若 General 有）。  
7. **Chat.tsx**：`<ExitPlanModeBanner sessionId={sessionId} />` 与 AskUser 并列。

## EnterPlanMode 切 permissionMode

- 收到 `plan_mode_changed active:true source:tool` → 调现有 `setPermissionMode('plan')` + `updateSessionMeta` + 通知 runtime `setPermissionMode`（与 pill 手动切换同路径）。  
- 勿与 Chat 模式冲突（Chat 下 Enter 已被 deny，不应收到此事件）。

## ExitPlanMode 展示 plan 正文

- 优先 `toolInput.plan` string；空则读 `toolInput.planFilePath`（UTF-8，限 64KB）。  
- Banner 内 Markdown 渲染（与 AskUser preview 同依赖）。

## 单测（最少）

- `agent-exit-plan-service.test.ts`：pending → respond approve → resolve allow + targetMode。  
- `permission-service` 或 extract 纯函数：`ExitPlanMode` 在 bypass 下返回 Promise pending（mock sendToRenderer）。

## 验收（写进 PR 描述）

- [ ] EnterPlanMode 后 composer pill = 计划模式  
- [ ] ExitPlanMode 弹 Banner，未点不能写  
- [ ] bypass 下不再自动 "User has approved"  
- [ ] 手测拒绝 / 批准并完全自动 / 反馈 三条路径

## 不做

- 不改 execution-mode-prompt 长文（另开 DP 规格）  
- 不 commit/push（除非用户要求）  
- 不用 Cursor Task

## 返回 stdout

改动文件列表 + 手测步骤 + 已知未做项。
