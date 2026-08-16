# hermes-studio 可借鉴点调研与技术路线建议

> **状态**：Draft v1.1（Q1–Q4 已拍，Q5–Q7 待过；F1/F2 旁支已实测记录）  
> **日期**：2026-08-13（旁支实测 2026-08-13）  
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

### Q3（R3/B4 看板 DAG 化） — ✅ 已拍：不抄 DAG；做崩溃恢复五件 + 迁 SQLite

**结论**：不抄 DAG（用户不画流程图，分支/审批/图引擎无人设计无人用）；但"重启恢复"不依赖 DAG，单拎出来做——经过一轮圆桌细化成下面这套方案。要的"自由性"靠 Q1 后台子代理 + agent 自主编排，不靠人画图。

**前置确认（已查代码）**：

- TAgent 看板任务**已落盘**（`kanban-store.ts` 用 `writeJsonAtomic` 写 `kanban-store.json`，boards/tasks/links 都在盘上）。所以崩溃不会丢"账"，缺的是"启动时翻账"的钩子。
- "gateway vs 主线程"**不是障碍**——能不能恢复取决于"状态存进程外 + 启动翻账"，与 worker 在哪跑无关。hermes 能恢复是因为状态在进程外（SQLite），不是因为有 gateway。
- hermes 的恢复也不是自动续跑——`recoverActiveRuns()`（`workflow-manager.ts:1058`）把 running 标 **failed** 让用户 rerun。TAgent 单用户桌面，照搬保守策略即可。

#### 不做的事（含理由，避免后续重新讨论）

| 项 | 理由 |
|---|---|
| **DAG 化** | 用户不画流程图，分支/审批/图引擎无人设计无人用；要的"自由性"靠 agent 自主编排（Q1 后台子代理），不靠人画图 |
| **自动重派** | 重派前提是幂等性判断，而派活 agent 自己都不知道任务可否重复执行；默认重派 = 给自己埋双写雷 |
| **心跳判活** | 依赖 worker 回报心跳字段，当前没有；Q1 hook 做时顺手加，不单独立项 |
| **幂等标记 / retryPolicy** | 工程量不小，当前规模不值得；保守策略（一律判败等人工介入）已经够安全 |
| **级联取消（blocks 链）** | JSON 里遍历做级联太恶心；如果迁 SQLite 则 Q1 顺手一条 SQL 做，不迁就砍 |
| **僵尸 worker 杀** | 需要按任务 ID 找原进程 kill 或任务级互斥锁，复杂度高；等真遇到"频繁崩溃且用户不想手动介入"的场景再说，大概率永远等不到 |
| **给 JSON 加文件锁** | 单用户桌面应用撞窗口极低；`proper-lockfile` 引依赖、处理锁超时/死锁，ROI 差。验证不过 SQLite 也忍着，到实际丢数据再处理 |

#### 要做的事（按顺序，含工程量）

| 项 | 优先级 | 工程量 | 理由 |
|---|---|---|---|
| **sanitize 脏文件** | P0，第一个做 | ~5 分钟 | `writeJsonAtomic` 残留 tmp + 半拉 JSON 会让启动直接抛异常起不来；底线兜不住后面全白做 |
| **store/runner 解耦** | P0，紧接 sanitize | ~半天 | runner 只 emit `task:completed` / `task:failed` 事件，独立 TaskLifecycle 服务消费事件写 store；不拆这层，interrupted 状态在代码里没有落脚点，后面加什么恢复策略都要在 runner 里硬塞特殊分支 |
| **interrupted 枚举** | P0，跟解耦一起做 | ~加个字段 | 五态（running / interrupted / ready / failed / done），interrupted 仅由人工决策转 ready 或 failed；不加，Q1 加心跳判活时要改状态机结构动到更多地方 |
| **SQLite electron 打包验证** | 尽快，今天/明天 | ~半天 | 信息不对称卡着所有后续决策；验证过了 Q1 直接迁，并发写/恢复/级联的问题一起消失；验证不过才知道 JSON 要续命多久 |
| **SQLite 迁移** | Q1 中（验证通过后） | 中等 | 真正理由是并发安全与后续扩展，不是崩溃恢复；迁移后启动翻账一条 SQL 搞定，并发写自动消失 |
| **启动翻账恢复** | Q1，SQLite 迁移后 | 一条 SQL | `UPDATE tasks SET status='interrupted' WHERE status='running'`，UI 亮黄点，用户手动决定重跑或放弃 |
| **心跳 + 级联（可选）** | Q1 末，SQLite 的话顺手做 | 小 | 心跳 Q1 hook 做时顺手加；级联一条 SQL 的事；JSON 继命则砍级联 |

#### 核心理由（后续开发须知的"为什么"）

1. **恢复策略：保守方案就是对的**
   hermes 的恢复也不是自动续跑——它把 running 标 failed 让用户 rerun。TAgent 作为单用户桌面应用，用户本来就会手动介入（重启 Electron → 看一眼看板 → 自己决定重跑还是放弃）。"标 interrupted + UI 亮黄点让用户自己选"已经覆盖了这个场景。自动重派、心跳判活、级联取消——是在给单用户桌面应用补分布式系统的课，当前规模不值得。

2. **SQLite 迁移的真正驱动力是并发安全，不是崩溃恢复**
   `kanban-store.ts` 是 read-modify-write 整文件：两个 worker 同时完成不同任务，后写覆盖前写更新。**这不是崩溃场景，是正常运行就会丢数据。** 崩溃恢复的前提是正常运行时账就是对的。SQLite 天然行级锁根治这个问题；同时启动翻账变成一条 SQL、interrupted 变成加个字段、级联变成一条 SQL。迁移的注释里也已经写了"完整 SQLite 调度器后续从 General 移植"，不是重写。

3. **gateway vs 主线程不是障碍**
   能不能恢复取决于"状态存进程外 + 启动翻账"，与 worker 在哪跑无关。hermes 能恢复是因为状态在进程外（SQLite），不是因为有 gateway。TAgent 状态已落盘 JSON，缺的只是启动翻账钩子 + 解耦给 interrupted 一个落脚点。

**锚点**：`apps/electron/src/main/lib/kanban/kanban-store.ts`（read-modify-write 整文件，并发丢数据点）、`kanban-dispatcher.ts`（dispatchKanbanTick，调度器）、`kanban-worker-runner.ts`（runner，需解耦 emit 事件）、`kanban-bootstrap.ts`（启动钩子落点，加翻账）；hermes 对照：`packages/server/src/services/workflow-manager.ts:1058`（recoverActiveRuns 标 failed）、`index.ts:363`（启动时调恢复）

### Q4（R4/B3 圆桌回声守卫） — ❌ 已拍：不做（判错纠正）

**结论**：不做。本条建立在"圆桌没刹车、会越聊越炸"的判断上——**该判断已由子代理核实为错误**，撤销。

**核实结果（coder 子代理实测，锚点已验）**：圆桌有四重刹车，不存在"越聊越炸"，且根本不是递归联动模型：

1. **硬轮次上限**：`beginNextRound` 在 `nextRound > roundLimit` 时直接 `phase='finalizing'` 收口；默认上限 3（`run-moa-discussion.ts:474`）。类型定义 `moa-discussion.ts:203-209`。
2. **提前收敛刹车（T9）**：每轮后 `evaluateDiscussionConvergence` 判定，命中收敛信号词或本轮发言全短即收口（`moa-discussion.ts:338-372`，信号词表 282-297；调用 `run-moa-discussion.ts:608-612`）。
3. **纪要收敛刹车（T11）**：每 2 轮跑纪要模型，解析出"收敛: 是"且 `currentRound >= 2` 即收口（`run-moa-discussion.ts:586-601`）。
4. **全员失败即停 + AbortSignal 用户喊停**（`run-moa-discussion.ts:570-580、496-500、516-519、545-548、560-563`）。

**关键纠正**：hermes 的 `mentionDepth` 是给"agent @ agent 触发递归回应"的图模型用的；TAgent 圆桌是**固定席位串行轮流发言**（panel 固定、多轮），不是 agent 递归调用 agent。**mentionDepth 这个概念在 TAgent 圆桌模型里根本不存在**，硬套是错的。默认最多 3 轮就强制由总结人收口，架构上炸不了。

**附记（文档漂移，不影响结论）**：`moa-discussion.ts:82` 注释说 roundLimit"默认 6"，但实际 fallback 是 3（T9 提前收敛后改的，注释没同步）。后续可顺手修注释。

**锚点**：`apps/electron/src/main/lib/agent/run-moa-discussion.ts`、`packages/shared/src/types/moa-discussion.ts`、`apps/electron/src/main/lib/agent/agent-crew-prefs.ts`（班组偏好落盘，`maxParallelWorkers` 调度未接）

---

### Q3 补充项（核实时新发现）— failed 前置死锁后继，比审批更该修

**子代理核实 Q3 时发现一个我（主会话）之前漏掉的真实隐患**：

- `promoteReadyDependents` **只在前置变 `done` 时触发**后继 ready（`kanban-store.ts:220-262`）。
- 前置若变 `failed`，永远到不了 `done` → 依赖它的后继**永远卡 `pending`**，没有失败分支跳过/降级。
- 这是"无分支边"在 Q3 里的具体落地痛点——比"没审批节点"更急，因为它在**正常失败场景**就会发生，不用等崩溃。

**处置**：归入 Q3"不做的事"里 DAG 不抄的**反面**——不抄图引擎，但这个"失败分支跳过/降级"要在 Q1/SQLite 迁移时补上（比审批优先）。比纯队列多这一条分支能力，但仍不是完整 DAG。

**核实的另两点（更正我之前措辞，不改方案）**：
1. 看板有自主性，不是纯"外包工人"：goal 闸门验收（`kanban-goal-judge.ts:33-60` + `kanban-dispatcher.ts:195-217`，敷衍完成转 blocked）、blackboard 跨任务交接（`kanban.ts:124-129` + `kanban-agent-tools.ts:264-280`）、worker 自主 complete/block（`kanban-agent-tools.ts:199-262`）。Q3 方案不受影响，但措辞从"外包工人"更正为"有 goal 验收的自主 worker"。
2. **班组 ≠ 看板**：班组（`agent-crew-prefs.ts:10-11`）目前仅偏好落盘 + UI，`maxParallelWorkers` 调度未接；真正干活的 worker 在看板。两者别混为一谈。

### Q5（R5 MoA 常驻） — 待过

会诊保持一次性，还是做成常驻 provider？我倾向保持一次性。

### Q6（R6 Skill bundle） — 待过

要不要做"用户自定义技能包组装成 slash 命令"？和多 agent 主线关联弱。

### Q7（R4/B5 远程 relay） — 待过

圆桌要不要支持拉跨机/本机没有的 CLI 入席？

---

## 6. 旁支发现（核实中带出的真问题，独立于 Q1–Q7）

### F1 本地 CLI 子代理后端约束只挂在 task 工具一个入口（约束覆盖不全 = bug）

**发现经过**：用户设置 `defaultBackend: "cli"`（`~/.tagent-dev/cli-workers.json` 已验：`enabled:true / defaultBackend:"cli" / defaultCliId:"kscc" / 6 个 worker 全 enabled`，本机 codex 0.146.0、grok 1.0.3 均在）。但主会话派子代理时仍走内置 in-process，未走 CLI → 约束失效。

**根因（代码层面）**：
- CLI 后端选择逻辑 `resolveTaskSubagentBackend`（`apps/electron/src/main/lib/agent/cli-workers/resolve-backend.ts:46`）会读 `listCliWorkersConfig()` + `shouldUseCliWorker(cfg)`，遵守 `defaultBackend=cli`。
- 但该函数**只被 `subagent-task-tool.ts`（Pi 核 `task` 工具，name:'task'，`:213`）调用**。
- 主会话的 Agent 工具派子代理走的是**另一套子代理机制**，不经过 `resolveTaskSubagentBackend`、不读 `cli-workers.json` → `defaultBackend` 约束对它失效。

**缺口本质**：`resolveTaskSubagentBackend` 只挂在 `task` 工具这一个入口，没做成**所有子代理派工入口的共同漏斗**。任何不走 `task` 工具的派工入口都绕过用户设置。产品意图是"设了 defaultBackend=cli 子代理就走 CLI"，实际只在"agent 调 task 工具"生效，在"主会话直接派子代理"失效 → **约束覆盖不全**。

**修法方向**（待定，不落代码）：
1. 把主会话 Agent 工具也接进 `resolveTaskSubagentBackend`，让它也读 `cli-workers.json` 走 `defaultBackend` 约束（倾向，符合产品意图）。
2. 或若主会话这套本就不该走 CLI（设计如此），则设置页须明示"defaultBackend 只对 task 工具派工生效"，别让用户误以为全局（文档/UI 层修）。

**与 Q1 的关系**：Q1 后台子代理要走哪条派工路径，必须先定这个接线缺口——否则后台子代理照样绕过 CLI 约束。F1 是 Q1 的前置。

**锚点**：`cli-workers/resolve-backend.ts:46`（`resolveTaskSubagentBackend`，只被 task 工具调）、`adapters/pi/subagent-task-tool.ts:213`（name:'task'，唯一接 CLI 后端的入口）、`~/.tagent-dev/cli-workers.json`（用户设置已验）

### F2 已实测：本地 CLI 子代理能真派出去，派工代码没坏

**测试法**：直接单测 `runCliWorker`，真 spawn 本机 codex/grok（绕过主会话 Agent 工具那层，直验派工代码本身）。

**结果（2026-08-13，vitest 实跑通过）**：
- **codex**：spawn `cmd.exe argsCount=10 delivery=stdin`，10933ms，exit 0，`summary: "在的"` ✓
- **grok**：spawn `grok.exe argsCount=5 delivery=argv`，9730ms，exit 0，`summary: "在的。"` ✓

**结论**：`runCliWorker` → `runCodexWorker`/`runGrokWorker` 派工代码**是通的**，能真起本机 CLI 进程并拿到模型回复。

**所以 F1 的"失效"精确定位**：失效不在"派工能力"（能力在，刚测过 spawn 成功），失效在"主会话 Agent 工具这条入口没走派工代码"——它不调 `resolveTaskSubagentBackend`/`runCliWorker`，自己走内置 in-process，绕过了 `defaultBackend=cli`。**能力在，入口没接上。** 修 F1 = 把主会话入口接上派工代码，不是修派工代码。

---

## 7. 引用锚点（hermes-studio，相对 F:\hermes-studio）

- 后台委托：`packages/ekko-agent/src/tools/delegation.ts`、`packages/ekko-agent/src/runtime/runtime.ts:734`
- CLI 归一：`packages/server/src/services/agent-runner/`（`coding-agent-event-mapper.ts`、`responses-stream.ts`、`redact.ts`）
- Workflow DAG：`packages/server/src/services/workflow-manager.ts`、`workflow-portability.ts`、`workflow-run-store.ts`
- Group chat：`packages/server/src/services/hermes/group-chat/`（`mention-routing.ts`、`agent-relay.ts`、`access.ts`）
- MoA：`packages/server/src/controllers/hermes/config.ts`、`agent-bridge/python/bridge_pool.py:504`
- Skill bundle：`packages/server/src/services/hermes/skill-bundles.ts`
