# SLICE-7 · 会话级工人选择器（session-preferred CLI worker）

> 总监 brief。`kscc -p` 实现（建议 `--model glm-5.2 --permission-mode acceptEdits`）。**勿 git commit**。
> 前提：SLICE-5（能力画像 + require/prefer 路由）+ SLICE-6（设置页能力编辑）已合入。
> 借鉴 hermes-studio「会话级模型记忆」：每个会话记住自己偏好的工人，发起 task 且未显式指定 `cli` 时用它作 preferredCliId。
> 实现勘误：composer 实际渲染的是 `RunModeSelector`（`ComposerUnderlay` 已是死代码），工人选择器落在 RunModeSelector；ComposerUnderlay 的重复实现已撤销。

## 目标

1. 会话 meta 新增 `cliWorkerId?: string`（持久化，重启恢复）：未设置/空 = 跟随全局（启用池优先级自动挑选）。
2. Pi 核 `task` 工具：未显式传 `cli` 时，用会话偏好作为 preferredCliId 注入路由；显式 `cli` 仍最高优先（不改 require/prefer 语义）。
3. 渲染层 composer「子代理」菜单增加「工人」选择器：自动（按全局优先级）+ 启用池各工人；选择写入会话 meta。

## 边界（本刀不做）

- 不改 `resolve-backend` 的 require/prefer 语义；会话偏好只是 preferredCliId 的一个来源。
- 不改 cli-workers.json 契约 / IPC（LIST/SAVE/PROBE 形状不变）。
- 不做全局默认工人选择器（启用池优先级即全局默认，已有）。
- 不做 kscc 核子代理的会话级工人（`task` 工具当前仅 Pi 核注册，本刀只覆盖该路径）。
- 不做会话级 require/prefer 默认、多模态附件传输。

## 实现

### C1 · 契约（packages/shared/src/types/agent.ts）

`AgentSessionMeta` 增加（放在 `subagentEagerness` 附近）：

```ts
/**
 * 会话偏好的 CLI 工人 id（持久化，重启恢复）。
 * 未设置 / 空 = 跟随全局（启用池优先级自动挑选）。
 * 发起 task 且未显式传 cli 时作为 preferredCliId 注入；显式 cli 仍最高优先。
 * 已禁用/已删除的 id 由 resolve 自动回落池内，不报错。
 */
cliWorkerId?: string
```

### C2 · 主进程注入

1. `apps/electron/src/main/lib/adapters/pi/subagent-task-tool.ts`
   - `createTaskTool` 新增参数 `sessionPreferredCliId?: string | null`。
   - `execute` 里 `resolveTaskSubagentBackend({ preferredCliId: params.cli ?? sessionPreferredCliId, require: params.require, prefer: params.prefer })`。
   - 注释注明：`params.cli` 显式指定 > 会话偏好 > 启用池优先级。
2. `apps/electron/src/main/lib/adapters/pi/pi-agent-adapter.ts`（createTaskTool 调用处）
   - import `getSessionMeta` from `../../agent/session-store`（session-service 同款用法）。
   - 调用 createTaskTool 时传 `sessionPreferredCliId: getSessionMeta(sessionId)?.cliWorkerId ?? null`。
3. `apps/electron/src/main/lib/ipc/session-service.ts`（updateSessionMeta handler）
   - 对 `cliWorkerId` 规范化：非字符串或 trim 后为空 → `undefined`；否则 trim 后落盘。
   - 不校验是否在启用池（resolve 层已有回落）。

### C3 · 渲染层 UI

1. `apps/electron/src/renderer/components/chat/Chat.tsx`
   - listSessions meta 解构类型加 `cliWorkerId?: string`；新增 state（如 `sessionCliWorkerId`）并回填 persisted 值；未设置 = undefined = 自动。
   - 新增切换回调：`updateSessionMeta(sessionId, { cliWorkerId: value || undefined })`（选「自动」写 undefined）。
2. `apps/electron/src/renderer/components/chat/ComposerUnderlay.tsx`
   - 在现有子代理菜单（eagerness popover 同区）增加「工人」选择项，复用同款 popover 视觉：
     - 选项 1：「自动（按全局优先级）」（value = undefined）。
     - 其余：启用池工人 id，label 用能力卡一句话（如 `kscc — 跨层接线 / 编排 / 复杂实现`；cost/reasoning 可省略避免过长）。
   - 数据来源：`window.electronAPI.listCliWorkersConfig()`（组件内一次拉取 + useMemo；失败静默隐藏选择器）。
   - 仅当 `defaultBackend === 'cli'` 且 `enabled` 时显示该选择器；否则隐藏。
   - props 增加 `cliWorkerId?: string | null` 与 `onCliWorkerIdChange: (id: string | undefined) => void`，由 Chat.tsx 接线。

## 验证

1. `apps/electron/src/main/lib/agent/session-store.test.ts`：meta 写 `cliWorkerId` 后重读一致（扩展现有 meta 持久化用例或新增一条）。
2. updateSessionMeta 规范化（空串→undefined）若有现成 handler 测试则补断言；至少 typecheck 通过。
3. `apps/electron` typecheck + 全量 `vitest run` 全绿。
4. 手测清单：
   - 设置开启本机 CLI 后端；Pi 会话 composer 子代理菜单出现「工人」，默认「自动」。
   - 选 grok（本机有）→ 该会话发 task（不带 cli）走 grok；另一会话仍走全局优先级。
   - 显式 `task.cli=kscc` 仍优先于会话偏好。
   - 选「自动」= 清除会话偏好；重启应用后会话偏好恢复。

## 不做 / 下一刀

- kscc 核子代理的会话级工人。
- 会话级 require/prefer 默认值。
- 多模态附件传输（P2）。
