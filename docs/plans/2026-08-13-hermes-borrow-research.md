# hermes-studio 可借鉴点调研与技术路线建议

> **状态**：Draft v1，待逐条过  
> **日期**：2026-08-13  
> **来源**：F:\hermes-studio 代码实测（4 套运行时 + DAG 编排层）对照 TAgent 现有 SubAgent/看板/会诊/圆桌  
> **目的**：治"主会话不太用子代理/看板/会诊/圆桌"这个痛点，挑值得抄的搬过来

---

## 1. 一句话

hermes 把多 agent 协作做成了**四套正交运行时**（hermes/coding/ekko/workflow）+ 一套 DAG 编排层；其中**后台委托**和**CLI 输出归一化**两块最值得抄，直击"不爱用子代理"和"接新模型容易乱"两个痛点。

---

## 2. 背景与痛点

| 痛点 | 表象 | 根因 |
| --- | --- | --- |
| 子代理不爱用 | 主会话能 Glob/Read 解决的就不派 | SubAgent 前台同步、结果整段塞回主上下文，用一次脏一次 |
| 多 CLI/模型接入乱 | REGRESS-G glm 流式形状 + 落盘闸口踩坑 | 各模型/CLI 落盘逻辑分散，无统一适配层 |
| 看板只线性 | 任务能排队不能拐弯、不能中途审批 | 看板是线性队列 + 依赖，无图编排、无 human-in-the-loop |
| 圆桌越聊越炸 | 多轮互聊无回声守卫 | 无 mentionDepth 级联上限 |

---

## 3. hermes 实测发现（按价值排序）

### R1 后台委托 + 跨轮回投【最值得抄】

- **TAgent 现状**：SubAgent 前台同步，结果作为 `tool_result` 整段进父上下文；深度默认 1。
- **hermes 做法**：`delegate_task` 分 `foreground`/`background`；后台子代理跑完**不阻塞父轮**，结果作为新父轮事件回投，child tool 流量不进父上下文；`delegationDepth>0` 禁递归防爆。
  - 锚点：`packages/ekko-agent/src/tools/delegation.ts`、`runtime.ts:734`（`backgroundTasks` Map、`subagent.start/text` 事件）
- **值不值**：值。直击"不爱用子代理"。后台跑完只回投结论卡片，主会话成本骤降。
- **工程量**：中。需改 SubAgent 调度路径 + 增后台任务表 + 回投事件。
- **决策点**：见 Q1。

### R2 CLI 输出归一化成统一事件流【值得抄，治正在踩的坑】

- **TAgent 现状**：本地 CLI 工人 in-process 默认关；glm 流式形状/落盘用 uuid + stop_reason 各异（REGRESS-G）。
- **hermes 做法**：node-pty 管隐藏 codex/claude，输出经本地 HTTP proxy → 归一成 canonical Responses 事件落 DB；`redact.ts` 刷密、idle recycle 30min。
  - 锚点：`packages/server/src/services/agent-runner/`（`coding-agent-event-mapper.ts`、`responses-stream.ts`、`redact.ts`）
- **值不值**：值。以后接新 CLI/模型，落盘逻辑收口到一处，不用每个模型单独踩坑。
- **工程量**：中。加一层适配器把各模型流式形状翻译成统一事件。
- **决策点**：见 Q2。

### R3 Workflow DAG 引擎 + 节点审批【强候选但大工程】

- **TAgent 现状**：看板 = 线性任务队列 + 依赖；无图编排、无审批节点、无重启恢复。
- **hermes 做法**：结构化 JSON 条件边（route `success/failure/always`、join `all/any`）、支配树编译自然循环、**节点级审批**（`pending_approval`→`approveNode`）、重启 `recoverActiveRuns` 标失败、执行预算、edge-evidence 持久化、导入导出沙箱 allowlist。
  - 锚点：`packages/server/src/services/workflow-manager.ts`（2415 行）、`workflow-portability.ts`、`workflow-run-store.ts`
- **值不值**：值，但是产品级决策。能治"长任务不可编排不可恢复"。不是顺手能搬。
- **工程量**：大。整套 DAG 引擎 + 持久化 + UI。
- **决策点**：见 Q3。

### R4 Group chat mentionDepth 防回声 + 远程 agent relay【圆桌补强】

- **TAgent 现状**：圆桌多轮互聊，无回声守卫，无跨机接外部 agent。
- **hermes 做法**：`@mention` 路由（`@name`/`@all`）+ `mentionDepth` 限级联防回声爆炸 + owner 审批路由 + `connectorId`/invite-code 接**跨服务器外部 agent**。
  - 锚点：`packages/server/src/services/hermes/group-chat/`（`mention-routing.ts`、`agent-relay.ts`、`access.ts`）
- **值不值**：中等。`mentionDepth` 防圆桌越聊越爆，简单收益高；远程 relay 让圆桌能拉本机没有的 CLI 入席，较重。
- **工程量**：mentionDepth 小；远程 relay 中-大。
- **决策点**：见 Q4。

### R5 MoA 做成常驻虚拟 provider【取舍题，倾向不抄】

- **TAgent 现状**：会诊是用户临时发起的单轮，多模型各答 → 汇总。
- **hermes 做法**：MoA = `provider:'moa'` 虚拟模型，参考模型并行跑同一 prompt + aggregator 聚合，常驻可选。机制在 Python（`agent.moa_loop`），server 只配 + 流事件。
- **值不值**：倾向不抄。你的会诊/圆桌是产品定位（用户主动发起），做成常驻会和定位冲突。会诊保持一次性即可。
- **决策点**：见 Q5。

### R6 Skill bundle → slash 命令【关联弱，可选】

- **TAgent 现状**：有 skills，无"用户自定义组装成命令"。
- **hermes 做法**：YAML 技能包组装成 slash 命令，reserved 命令防覆盖，0600 权限。
- **值不值**：和多 agent 协作主线关联弱，可选。
- **决策点**：见 Q6。

### R7 Kanban【不抄】

- hermes 看板是外部 Hermes CLI 的薄客户端，真实引擎不在仓内。TAgent 看板内置原生，反而更厚。**不抄**。

---

## 4. 技术路线建议（按性价比排序）

| 序号 | 建议 | 抄自 | 性价比 | 工程量 |
| --- | --- | --- | --- | --- |
| **B1** | SubAgent 支持后台模式，跑完只回投结论卡片 | R1 | 高 | 中 |
| **B2** | 加 CLI 输出适配层，统一各模型流式/落盘事件 | R2 | 高 | 中 |
| **B3** | 圆桌加 mentionDepth 回声守卫 | R4(部分) | 中-高 | 小 |
| **B4** | 看板升级为 DAG + 节点审批 + 重启恢复 | R3 | 中（大工程换大能力） | 大 |
| **B5** | 圆桌远程 relay 接外部 agent | R4(部分) | 中 | 中-大 |
| — | MoA 常驻化 | R5 | 低（和定位冲突） | — |
| — | Skill bundle 命令 | R6 | 低（关联弱） | — |

---

## 5. 待逐条过的决策清单

> 每条请给"抄 / 不抄 / 改 / 再调研"之一，我们逐条定。

### Q1（R1/B1 后台子代理） — ✅ 已拍：抄

**结论**：抄。把 SubAgent 做成可后台——独立 session 跑、父轮不等、跑完唤醒主会话回投结论。

**机制要点（已对齐）**：

1. **两个维度别混**：
   - 在哪跑：内置=in-process；CLI=外部进程。（现状已有）
   - 父轮等不等：前台=干等塞回主上下文（现状）；**后台=不等**（要加的）。
   - hermes 的"后台委托"是第 2 个维度，不是"在哪个进程跑"。

2. **现状**：子代理靠 SDK 内置 Task 工具触发，生命周期包在父轮 `query()` 流里。`runLoop` 的 for-await 一直阻塞到子代理吐 `tool_result`，父轮才往下走——**主会话干等，不监听**。

3. **要改的技术逻辑**：
   - 新增"后台派工"入口，**绕开 SDK Task 工具**：父 agent 调 TAgent 自己的工具，立即返回占位"已派出，任务ID xxx"，父轮不阻塞、继续干别的。
   - 后台执行器跑在**独立 session-runtime**，与父会话隔离——子的 tool 流量天生不进父上下文。
   - **主会话怎么知道子代理完成**：不靠主会话监听，靠**后台执行器侧的 hook**——钩独立 session 的 runLoop done 事件（子代理侧一次性触发器，不是"勾住主会话"）。
   - **完成→唤醒回投**：hook 触发后，走现成的 `flushPendingSteer`（`session-service.ts:323`，最后调 `handleSend`，`:336`）——跟用户正常发消息同路径，触发一轮新 query。主会话"收到回投→起一轮"。

4. **"自动总结"不自带，要包装**：`flushPendingSteer` 的原语义是"用户追加指令"。回投文本若裸投，agent 可能当成新指令去干；必须包成"后台子代理 xxx 已完成，结果如下：…请据此收口"才会走总结路径。**自动总结 = 回投文本包装问题，不是机制问题。**

5. **回投时机与堆积（待细化方案时验）**：flush 的立即触发条件是"父轮已停稳"（`!isTurnInFlight && !isRunning`）。后台子代理异步跑完时父轮可能正忙→回投排队、等当前轮 onTurnEnd 再 flush→"排在你后面那条消息后"合理，但**回投不能无限堆积**，需加上限/去重/过期。

6. **递归守卫**：后台子代理内禁止再派后台（对齐 hermes `delegationDepth>0` 禁递归）。

**一句话**：主会话不再干等；后台子代理跑完，它侧的 hook 触发，主动唤醒主会话起一轮把结果投回来。

**锚点**：`apps/electron/src/main/lib/agent/runtime/session-runtime.ts`（`runLoop` for-await）、`apps/electron/src/main/lib/ipc/session-service.ts:323`（`flushPendingSteer`）、`:336`（`handleSend`）、`:580`（`STEER_AGENT`）

---

### Q2（R2/B2 CLI 输出归一） — ❌ 已拍：不抄（伪需求）

**结论**：不抄。hermes R2 的形态（node-pty 拦 CLI 输出 → 归一成统一事件流）在 TAgent 是伪需求。

**分清三条链路（已实测）**：

1. **CLI 子代理**（外部 CLI 工人）：**已有翻译层**。`cli-workers/` 下每个 CLI 一个 `xxx-stream-observer.ts`（claude/codex/grok/mimo/opencode/kscc），统一收口到四个回调（`onToolUse/onToolResult/onTextChunk/onProgress`）；`run-cli-worker.ts` 是统一入口，按 `worker.id` 路由。**这条已经认普通话，不用补。**
2. **kscc 渠道**：走 `kscc-stream-observer.ts`，CLI 同族，已归一。
3. **Pi 主核**（主会话本身跑的模型）：走 Owtffssent SDK `query()`，背后是 HTTP 直连模型 API。**SDK 内部已把模型原始 SSE 流解析成统一 SDK 事件**（`assistant`/`text`/`tool_use`/`tool_result`/`result`）。glm 的流式形状差异 SDK 在内部就抹掉了，TAgent 拿到的已是普通话——**不存在"原始格式"给 TAgent 翻译。**

**glm 落盘坑的真实归属**：不是 TAgent 缺翻译层，是 TAgent **自己的落盘/轮次判断逻辑**对 glm 特性不鲁棒（stop_reason 恒 null、每块独立 uuid 让旧的"拿 stop_reason 判结束/拿块 id 去重"失灵）。这是兜底规则问题，归 REGRESS-G 线修，不属"多 agent 协作借鉴"。

**一句话**：hermes R2 对应 TAgent 的 CLI 子代理那条，而那条已经做了；Pi 主核由 SDK 接管，无第三处需造翻译层。Q2 不成立。

**锚点**：`apps/electron/src/main/lib/agent/cli-workers/`（已有 observer 层）、`apps/electron/src/main/lib/adapters/pi/pi-agent-adapter.ts`（SDK 事件直接消费，无翻译层缺口）

### Q3（R3/B4 看板 DAG 化） — 待过

要不要给看板升级成 DAG + 节点审批 + 重启恢复？大工程，得先确认产品要这个能力。

### Q4（R4/B3 圆桌回声守卫） — 待过

要不要给圆桌加 mentionDepth 级联上限防越聊越炸？

### Q5（R5 MoA 常驻） — 待过

会诊保持一次性，还是做成常驻 provider？我倾向保持一次性。

### Q6（R6 Skill bundle） — 待过

要不要做"用户自定义技能包组装成 slash 命令"？和多 agent 主线关联弱。

### Q7（R4/B5 远程 relay） — 待过

圆桌要不要支持拉跨机/本机没有的 CLI 入席？

---

## 6. 引用锚点（hermes-studio，相对 F:\hermes-studio）

- 后台委托：`packages/ekko-agent/src/tools/delegation.ts`、`packages/ekko-agent/src/runtime/runtime.ts:734`
- CLI 归一：`packages/server/src/services/agent-runner/`（`coding-agent-event-mapper.ts`、`responses-stream.ts`、`redact.ts`）
- Workflow DAG：`packages/server/src/services/workflow-manager.ts`、`workflow-portability.ts`、`workflow-run-store.ts`
- Group chat：`packages/server/src/services/hermes/group-chat/`（`mention-routing.ts`、`agent-relay.ts`、`access.ts`）
- MoA：`packages/server/src/controllers/hermes/config.ts`、`agent-bridge/python/bridge_pool.py:504`
- Skill bundle：`packages/server/src/services/hermes/skill-bundles.ts`
