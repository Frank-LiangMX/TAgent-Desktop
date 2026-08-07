# 摸底 FINDINGS — 子代理总是「失败」

> 输入：用户截图——concise 时间线「探索了 2 个文件」阶段下一条子代理行，标题 "List project root, handoffs, and docs directories"，右侧 `子代理`，红字 `失败`。
> 派工路径：本机 `kscc -p --dangerously-skip-permissions`（即 kscc 核 / Claude Agent SDK 路径，非 Pi 核）。
> 本轮**只读摸底**，不 commit。结论见文末 stdout。

---

## Q1. UI「失败」从哪来？concise `StageStepRow` 如何判失败？

「失败」有**两条独立路径**，截图命中的是第二条：

**A. 工具步骤行 `StageStepRow`**（`apps/electron/src/renderer/components/chat/ConciseTimelineView.tsx:522`）：
```ts
const isError = step.kind === 'tool' && Boolean(step.tool.result?.isError)
```
→ 红色 `WarningCircle` 图标（`ConciseTimelineView.tsx:539-541`）。这是给**普通工具**（Bash/Read…）的 `tool_result.isError` 用的，红的是**图标**，不是「失败」二字。

**B. 子代理行 `SubagentEntryCard`（timeline 变体）**（`apps/electron/src/renderer/components/chat/SubagentEntryCard.tsx:96-135`）——**截图命中这条**：
- 右侧 `meta` = `launcherModelHint(launcher) ?? '子代理'`（`SubagentEntryCard.tsx:88`，`launcher` 无 model/subagent_type/agent 时回退 `'子代理'`）→ 截图里的 `子代理`。
- 第二行 `progressLine`：非 running 且 `status === 'failed'` → `statusText` = `'失败'`（`SubagentEntryCard.tsx:90-94` + `STATUS_TEXT` `failed:'失败'` `SubagentEntryCard.tsx:32`）。
- `status === 'failed'` → class `is-failed`（`SubagentEntryCard.tsx:103`）→ CSS 染红（`apps/electron/src/renderer/styles/chat.css` 的 `.agent-concise-subagent.is-failed`）→ 截图里的**红字「失败」**。

`status` 来源链（**UI 不自判失败，只透传**）：
1. `card.status` ← `reduceTaskEvent` 的 `task_notification` 分支（`apps/electron/src/renderer/components/chat/subagent-ui-model.ts:234-258`）。
2. ← `Chat.tsx:1431-1444` 把流式 `tagent_event` 喂进 reducer；状态**原样透传**，非法值兜底 `'stopped'`（`Chat.tsx:1433-1436`），**从不把成功改写成失败**。
3. ← `packages/shared/src/utils/kscc-message-adapter.ts:196-211`：`status: m.status as 'completed'|'failed'|'stopped'`，**原样取自子 kscc 的 system 消息**。
4. ← 子 kscc（Claude Code）在子代理收口时发的 `system.subtype='task_notification'`。

> 结论：UI「失败」= 子 kscc **真的**发了 `task_notification{status:'failed'}`。UI 没有误判（见 Q4 候选 4 排除）。

---

## Q2. Chat 下 SubAgent 是否硬拦？Work 下 Task 走哪条？

**Chat：双拦，且不会产生子代理卡。**
- **权限层硬拦**：`apps/electron/src/main/lib/permission/permission-service.ts:235` `if (executionMode === 'chat' && isChatModeBlockedTool(...))` → deny。`Task` 属于被拦工具但**非 hard-stop**（`packages/shared/src/constants/permission-rules.test.ts:220-221`：`isChatModeBlockedTool('Task')=true`、`isChatModeHardStopTool('Task')=false`）→ **软 deny**（`{allow:false, reason:CHAT_MODE_BLOCK_REASON, interrupt:false}`，`permission-service.ts:248`），让模型改口建议切 Work，不原子停轮。
- **工具层不注册**：`apps/electron/src/main/lib/ipc/session-service.ts:1143` `agents: executionMode === 'work' ? buildBuiltinSubagentDefinitions(true) : undefined` → Chat 下 `agents=undefined`，SDK 根本不挂 Task/Agent 工具。
- **prompt 层再声明**：`apps/electron/src/main/lib/agent/execution-mode-prompt.ts:34` 把 `Task / Agent 等 SubAgent 委派` 列入「绝不能调用（系统会拦截）」。
- 因此 Chat 下 Task **不会** `task_started`，也就**不会有「子代理 失败」卡**（最多是一条被 deny 的 tool_result / SessionErrorBanner）。截图有卡 → 用户在 **Work** 模式。

**Work：走 kscc agents（Claude Agent SDK 内置子代理），不是 Pi subagent。**
- kscc 核适配器把 `agents` + `forwardSubagentText:true` + `agentProgressSummaries:true` 透传给 SDK（`apps/electron/src/main/lib/adapters/claude/claude-agent-adapter.ts:174-179`）。
- 模型调 `Agent`/`Task` 工具（实例名 `Agent`，见 Q3 实证）→ SDK 用 `agents[subagent_type]` 的 `prompt`/`tools`/`model` 起一个**嵌套子 kscc**，进度通过 `agentProgressSummaries` 回流成 `task_started`/`task_progress`/`task_notification`。
- Pi 核（外部渠道）才走 `subagent-task-tool.ts` 的自研 `task` 工具（`apps/electron/src/main/lib/adapters/pi/pi-agent-adapter.ts:1068` `createTaskTool`）。两条路互斥：kscc-internal 渠道 → SDK agents；external 渠道 → Pi task 工具。

---

## Q3. 抽样 `~/.tagent/agent-sessions/*.jsonl`

格式：每行一条 Claude SDK 消息，`parent_tool_use_id` 非空=子代理会话、为空=父会话；`tool_use_result.stdout`/`is_error` 在 user 行。

**关键发现：这些 jsonl 全是旧 `F:\TAgent_General` 工程（7 月）的会话，没有任何 `TAgent-Desktop` 路径**（`grep TAgent-Desktop` 0 命中）。即本次失败的会话**未落盘到这里**（当前 App 的 `persistSession:true` 似乎写到别处 / kscc 项目目录，或本机该目录是旧工程残留）。无法直接拿到失败那轮的 `task_notification.summary`。

能抽样到的子代理回合（均为旧工程，但能反证机制）——`485c2bbd-….jsonl`：
- 父会话模型 `glm-5.1`（行 2 `"model":"glm-5.1"`），行 3 调 `"name":"Agent","type":"tool_use","input":{...,"subagent_type":"explorer"}`。
- 行 28 起是**子代理会话**（`parent_tool_use_id` 非空），子代理每条 assistant 消息 `"model":"glm-5.1"`、`_channelModelId":"glm-5.1"` —— **跑在渠道模型上，不是 haiku**。
- tool_result 全是正常内容、`is_error:false`（行 29/31/33/35…）→ **子代理成功**。

`is_error:true` 抽样（`e80a5e28:145`、`0c8dd5b6:75/121`…）全是**普通 Bash `Exit code 2`**（如 `e80a5e28:145` 在 `deepseek-v4-flash` 渠道上 `grep` 无匹配），**不是子代理收口失败**。

> 实证含义：旧工程子代理**继承渠道模型**（glm-5.1）且成功；当前 TAgent-Desktop 子代理却被钉成 `haiku`（见根因 1）——**haiku 钉死是 TAgent-Desktop 移植引入的回归**。

---

## Q4. 根因（验证后）

### 根因 1（主因 · 高置信）：子代理模型被钉死 `haiku`，非 Claude 渠道必失败

**证据链（全部 path:line）：**

1. kscc 路径硬编码 `claudeAvailable=true`：
   `apps/electron/src/main/lib/ipc/session-service.ts:1143`
   `agents: executionMode === 'work' ? buildBuiltinSubagentDefinitions(true) : undefined`
   ——**不看渠道**，永远传 `true`。

2. `true` → 操作型角色拿到 `model:'haiku'`：
   `apps/electron/src/main/lib/agent/subagent-definitions.ts:65-72` 对 `explorer`/`researcher`（`modelPool:[]`，`apps/electron/src/main/lib/role/role-projection.ts:169/188`）调 `roleToSubagentDef({claudeAvailable:true})` → `resolveModelForRole` 命中 `apps/electron/src/main/lib/role/role-projection.ts:118` `if (options.claudeAvailable) return 'haiku'` → `def.model='haiku'`（`role-projection.ts:145`）。

3. SDK **用** agent 定义的 model，空才继承父：
   `node_modules/.bun/@anthropic-ai+claude-agent-sdk@0.3.185/.../sdk-tools.d.ts:423`
   *"uses the agent definition's model, or inherits from the parent"* —— 有 `haiku` 就**不继承**父的 `glm-5.2`。

4. kscc-internal 渠道**没有 Claude 模型**：
   `apps/electron/src/main/lib/channel/default-models.ts:13-23` —— `KSCC_DEFAULT_MODEL_ID='glm-5.2'`，内置仅 glm/kimi/mimo。Claude 模型只在**外部 `anthropic` provider**（`default-models.ts:27-31`）。

5. `fallbackToChannelDefault:true`（`role-projection.ts:171/189`）**未被消费**——`resolveModelForRole` 不读它，全仓 grep 仅落库/存档，无运行时回退（`agent-role-service.ts` 也只是存 `role.fallbackToChannelDefault`）。即「haiku 不可用就退渠道默认」的意图**没接线**。

6. **对照组（Pi 核）是对的**：`apps/electron/src/main/lib/adapters/pi/subagent-task-tool.ts:161` `buildBuiltinSubagentDefinitions(false)`，且 `createSubagentStreamFn` 用 `modelOverride || channelConfig.modelId`（`subagent-task-tool.ts:324/331`）→ 子代理继承渠道模型。session-service 外部路径也不传 `agents`（`session-service.ts:1207-1238`），全交 Pi task 工具。**只有 kscc 路径钉 `true`**。

**机理**：Work + kscc 渠道 → 模型调 `Agent`(subagent_type=explorer) → SDK 用 `agents.explorer.model='haiku'` 起子 kscc → 子 kscc 把 `haiku` 映射成 Claude haiku 模型 ID，发请求到 glm 网关 → **glm 网关不认识该模型 → API 报错** → 子代理**首轮 LLM 调用即失败**、来不及调任何工具 → kscc 发 `task_notification{status:'failed'}` → UI 红字「失败」（与截图「无进度、直接失败」一致）。task_started 在派发时就发（所以卡会出现），随后首轮就 fail。

### 根因 2（次因 · 中置信，待实证）：Windows 下子代理子进程 spawn/立即退出

- TAgent 只对**顶层** spawn 打了 Windows 补丁：`apps/electron/src/main/lib/adapters/claude/spawn-kscc.ts` + `shared/kscc-windows-spawn.ts:39-65` `planKsccWindowsSpawn`（用 `node.exe` 直跑 `cli-wrapper.js` 绕开 `.cmd`/PATH），且只在 `spawnClaudeCodeProcess` 钩子里用（`claude-agent-adapter.ts:185-201`）。
- 子代理是 **kscc CLI 内部**再 spawn 的进程，**不经过** TAgent 的 `spawnClaudeCodeProcess` 钩子 → 享受不到上述补丁。若该子进程所在环境拿不到 `node`/PATH（dev Electron 常见，见 `kscc-windows-spawn.ts:5-9` 注释），会 `exit 1` → `task_notification{status:'failed'}`。
- 与根因 1 都表现为「task_started 后无进度直接失败」，**需用 `task_notification.summary` 或 kscc stderr 区分**：模型错→API/model 报错；spawn 错→`不是内部或外部命令`/`exit 1`。`session-service.ts:1154-1158` 的 `onStderr` 已把 kscc stderr 打到主进程 console，**复现时看主进程日志即可定性**。

### 根因 3（排除项）：UI 误判失败（结果其实成功）—— 排除

- `task_notification.status` 全程**原样透传**（Q1 链路 1-4），`Chat.tsx:1433-1436` 非法值只兜底成 `'stopped'`，**绝不把 completed 改成 failed**。
- `SubagentEntryCard` 无卡时回退 `running`/`completed`（`SubagentEntryCard.tsx:79-85`），**永不回退 `failed`**。
- 抽样到的 `is_error:true` 都是真实 Bash `Exit code 2`（Q3），不是子代理卡。
- 故「卡显示失败」= kscc 真报失败，非 UI 误判。此候选**排除**。

### Q5. 与 AskUserQuestion（REGRESS-H）的关系—— 不相关

- explorer 的工具集 `ROLE_READONLY_TOOLS=['Read','Glob','Grep','Bash']`（`role-projection.ts:14`），**不含 AskUserQuestion** → 子代理根本问不了问题，不存在「auto-deny 交互导致失败」。
- REGRESS-H 的 canUseTool 拦截 AskUserQuestion 是**主会话**交互（见 memory [[regress-h-askuser-canusetool-not-controlframe]]），与子代理收口失败无关。
- 失败发生在**首轮 LLM 调用**（模型解析），早于任何工具/交互/权限环节。Q5 候选**排除**。

---

## 复现条件

- 渠道：kscc-internal（默认 `glm-5.2`，或任一非 Claude 模型）。
- 模式：Work（Chat 下 Task 不注册不跑）。
- 触发：模型调 `Agent`/`Task`，`subagent_type` 为**操作型** `explorer`/`researcher`（`modelPool:[]`）或任何 `modelPool` 空的角色库角色。
- 现象：子代理卡出现 → 直接红字「失败」，无任何工具进度；主进程 console（`[kscc stderr]`）应有 model/API 报错。
- **不**复现：外部 `anthropic`/`anthropic-compatible` 渠道（haiku 真实可用）；或 `modelPool` 非空且首项是渠道有效模型的角色。

## 最小修建议

**修根因 1（一行级，优先）：** 把 kscc 路径的 `claudeAvailable` 由渠道决定，而非硬编码 `true`。
`apps/electron/src/main/lib/ipc/session-service.ts:1143`：
```ts
agents: executionMode === 'work' ? buildBuiltinSubagentDefinitions(isClaudeModelChannel(channel, model)) : undefined,
```
其中 `isClaudeModelChannel`：`channel.provider === 'anthropic' || channel.provider === 'anthropic-compatible'`（对应 `default-models.ts:27-32` 真有 Claude 模型的 provider）。对 kscc-internal 恒为 `false` → `resolveModelForRole` 返回 `undefined`（`role-projection.ts:119`）→ `AgentDefinition` 不带 `model` → SDK「inherits from the parent」（`sdk-tools.d.ts:423`）→ 子代理跑 `glm-5.2`，与 Pi 核行为对齐。
- 兜底等价改法：kscc 路径直接 `buildBuiltinSubagentDefinitions(false)`（kscc-internal 无 Claude 模型，恒 false 安全）。
- 顺带：把 `fallbackToChannelDefault` 真正接进 `resolveModelForRole`（haiku 不可用时退渠道默认），作为二道防线。

**修根因 2（若实证确认）：** 让 kscc 内部子代理 spawn 也走 Windows 直跑 node 的等价路径，或确保子进程环境含 Node.js 安装目录 PATH（release 已从注册表补 PATH，dev 需补）。

**不修：** UI 侧无需改 —— 失败是真失败，透传正确；改 UI 反而会掩盖上游问题。

## 待证实（下轮）
- 拿到当前 TAgent-Desktop 失败会话的 `task_notification.summary` + `[kscc stderr]` 日志，定性是「model 错」（坐实根因 1）还是「spawn exit 1」（根因 2）。
- 确认 kscc 内部子代理是「同进程嵌套」还是「再 spawn 子进程」（决定根因 2 是否成立）。
