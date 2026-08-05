# 权限与工具调用链路审计（TAgent vs Proma）

> 只读审计，未改任何代码。聚焦「TAgent 基本没法干活」在权限/工具链路上的根因。
> 对照仓库：`F:\Proma`（基线，可干活）vs `F:\TAgent-Desktop`（被审）。

## 结论摘要（5 条内）

1. **默认权限档反了**：Proma 默认 `bypassPermissions`（"完全自动：所有工具调用自动允许"，`agent.ts:1425/1439`），普通写操作**从不弹窗**；TAgent 默认 `auto`（`shared/types/agent.ts:1713`），每个 Write/Edit/非只读 Bash 都要弹窗等用户点（`permission-service.ts:232-251`）。开箱即用的「能否干活」差距由此奠定。
2. **默认叠加 Chat 形态，写操作被硬拦**：TAgent 新会话默认 `executionMode='chat'`（`execution-mode.ts:19` + `session-store.ts:116`），Chat 下 `isChatModeBlockedTool` 对 Write/Edit/非只读 Bash **直接 deny**（连弹窗都没有），只推「建议切换到 Work」条（`permission-service.ts:208-214`、`permission-rules.ts:608-634`）。用户必须先发现并手动拨 Chat→Work，才能开始干活。
3. **权限横幅单槽 + 30s 自动拒绝**：`askRenderer` 30 秒超时自动 deny（`permission-service.ts:119-124`），`PermissionBanner` 只持单条 `useState`，新请求覆盖旧请求（`PermissionBanner.tsx:23/28-29`）。用户没注意到横幅 → 写操作 30s 后静默失败。Proma 用 `pendingPermissions` Map 承载多条并发请求、靠 AbortSignal 驱动，无固定超时（`agent-permission-service.ts:109/151-161`）。
4. **Pi 子代理完全无权限钩子**：`subagent-task-tool.ts:120-130` 建 `new Agent(...)` 时不挂 `beforeToolCall`，子代理用裸 `piCore.defaultTools`（`subagent-task-tool.ts:196-202`）——连 `pi-core/permissions.ts` 的危险命令拦截都没接。子代理可任意 Write/rm，且绕过 Chat 只读约束。Proma 对每个工具 `wrapToolWithPermission` 包 `canUseTool`，子代理经 `options.agentID` 显式 auto-allow（`pi-agent-adapter.ts:760-794`、`agent-permission-service.ts:135-137`）——是「包了再决定放行」，不是「裸奔」。
5. **双份 Pi 权限实现，一份是空壳**：`packages/pi-core/src/permissions.ts` 的 `checkToolPermission` 只拦 12 条危险 Bash 正则、Read/Write/Edit 全 allow（`permissions.ts:62-64`），仍从 `pi-core/index.ts:39` 导出。Electron 路径正确地改用 `permission-service.ts`，但内网版/CLI 直连 pi-core 时只剩这层空壳。Proma 只有一套权限路径，无并存空壳。

## 对照发现

| 问题 | 严重度 | Proma 怎么做 | TAgent 现状 | 复现/证据路径 |
|---|---|---|---|---|
| 默认权限档：开箱即用能否干活 | **P0** | 只有 `bypassPermissions`/`plan` 两档，默认 `bypassPermissions`="所有工具调用自动允许"；orchestrator `canUseTool` 在 `bypassPermissions` 与 `default`（auto/escalation）两个分支都 `return allow`，普通写操作从不进 UI 审批 | 三档 `auto`/`bypassPermissions`/`plan`，默认 `auto`；`auto` 下 Write/Edit/非只读 Bash 走 `askRenderer` 弹窗，用户不点就不执行 | Proma: `packages/shared/src/types/agent.ts:1421-1425/1435-1446`、`agent-orchestrator.ts:1656-1657/1701-1702`；TAgent: `packages/shared/src/types/agent.ts:1709-1713`、`apps/electron/src/main/lib/permission/permission-service.ts:232-251` |
| 默认执行形态 Chat 硬拦写操作 | **P0** | 无 Chat/Work 二分；默认即全放行，写操作照常执行 | 新会话 `executionMode='chat'`；Chat 下 `isChatModeBlockedTool` 对 `WRITE_TOOLS`、非只读 Bash、看板/自动化变更类一律 `true` → `checkPermission` 直接 `deny`+推「建议切 Work」条，不弹窗 | `packages/shared/src/types/execution-mode.ts:19/25`、`apps/electron/src/main/lib/agent/session-store.ts:116`、`permission-service.ts:208-214`、`packages/shared/src/constants/permission-rules.ts:608-634` |
| 权限横幅单槽 + 30s 超时自动拒绝 | **P1** | `pendingPermissions: Map<id, Pending>` 承载 N 条并发请求，各自独立 resolve；仅靠 `signal.abort` 触发 deny，无固定墙钟超时 | `askRenderer` 设 30s `setTimeout` 自动 deny；`PermissionBanner` 单 `useState`，新请求覆盖旧请求；被覆盖的旧请求只能等 30s 超时 deny | `apps/electron/src/main/lib/permission/permission-service.ts:119-124`、`apps/electron/src/renderer/components/permission/PermissionBanner.tsx:23/28-29/34-37`；对照 Proma `apps/electron/src/main/lib/agent-permission-service.ts:109/151-161` |
| Pi 子代理（task 工具）无权限钩子 | **P1** | 每个工具 `wrapToolWithPermission` 包 `canUseTool`；子代理（`options.agentID`）显式 auto-allow，但「包了再放行」，Chat/plan 约束仍可由调用方覆盖 | `createTaskTool` 建 `Agent` 时完全不传 `beforeToolCall`；子代理用裸 `piCore.defaultTools`（Read/Write/Edit/Bash），无任何拦截，绕过 Chat 只读与危险命令拦截 | `apps/electron/src/main/lib/adapters/pi/subagent-task-tool.ts:117-130/196-202`；对照 Proma `apps/electron/src/main/lib/adapters/pi-agent-adapter.ts:760-794`、`agent-permission-service.ts:135-137` |
| pi-core 原始空壳权限仍导出（双实现） | **P1** | 单一权限路径（`agent-permission-service` + orchestrator inline `canUseTool`），无并存空壳 | `pi-core/permissions.ts` 的 `checkToolPermission` 仅拦 12 条危险 Bash 正则，Read/Write/Edit 默认 allow；仍从 `pi-core/index.ts` 导出。Electron 路径改用 `permission-service.ts`，但内网/CLI 直连 pi-core 只剩空壳 | `packages/pi-core/src/permissions.ts:12-25/53-64`、`packages/pi-core/src/index.ts:39`；Electron 正式版 `apps/electron/src/main/lib/permission/permission-service.ts:185-252` |
| Pi 核 systemPrompt 整体替换，子代理委派/记忆 append 缺失 | **P2** | kscc/Pi 两路均有 append 通道；委派策略、看板说明、记忆段落按形态注入 | Pi 核 systemPrompt 为「整体替换」，`subagentEagerness` 委派策略未注入 Pi（注释明言"直接注入会覆盖默认 prompt"）；Pi/kscc 功能不对等 | `apps/electron/src/main/lib/ipc/session-service.ts:1020-1022`（Pi）vs `:982`（kscc） |
| 横幅对 Pi 工具显示文件路径失败 | **P2** | — | `PermissionBanner` 取 `req.input.file_path` 显示 Write/Edit 路径，但 pi-core 工具用 `path`（非 `file_path`）→ Pi 写操作横幅落到 JSON 兜底，看不到目标文件 | `apps/electron/src/renderer/components/permission/PermissionBanner.tsx:42-43`；pi-core 工具 schema `packages/pi-core/src/tools.ts:46-49/69-73` |
| `beforeToolCall` 类型标注窄于实参 | **P2** | — | 适配器把 `beforeToolCall` 标注为 `(ctx:{toolCall:{name,arguments}})`，缺 `args`；但 pi-agent-core 实际传 `{assistantMessage,toolCall,args,context}`（`args` 为 schema 校验后值）。运行时 `resolveToolInput` 优先取 `ctx.args`，功能正常，但类型契约与运行时不一致，易在重构时被误删 `args` 读取 | `apps/electron/src/main/lib/adapters/pi/pi-agent-adapter.ts:147-148`、`apps/electron/src/main/lib/permission/permission-service.ts:91-103/331-336`；pi-agent-core `node_modules/.bun/.../pi-agent-core/dist/types.d.ts:69-79` |

## 建议修复顺序（只列 P0/P1）

1. **把默认权限档从 `auto` 改为 `bypassPermissions`**（或新会话默认 Work 形态）：对齐 Proma「开箱即用、不打扰」，让 agent 先能写文件。`shared/types/agent.ts:1713` 与 `session-store.ts:116` 的默认值是根因。
2. **默认执行形态由 `chat` 改为 `work`**：否则即便切到 `bypassPermissions`，Chat 仍会在权限层硬拦写操作（`permission-service.ts:208` 先于 bypass 判断）。至少让新会话首条发送时 meta 带 `work`。
3. **`PermissionBanner` 改为多槽队列 + 去掉 30s 硬超时**（或延长到分钟级并显式提示）：避免用户没注意横幅时写操作静默被 deny。对齐 Proma `pendingPermissions` Map + AbortSignal 驱动。
4. **给 Pi 子代理挂 `beforeToolCall`**：复用主会话的 `createBeforeToolCall`（或显式 bypass 分支），至少接上危险命令拦截与 Chat 只读约束，消除裸奔。
5. **删除/收口 `pi-core/permissions.ts` 的空壳权限**：要么让 pi-core CLI 也接 `permission-service` 同款逻辑，要么明确标注其仅作 CLI 兜底、移出公共导出，避免两份权限实现并存误导。
