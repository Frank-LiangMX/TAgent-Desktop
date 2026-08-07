# REGRESS-K FINDINGS — 思考落正文秒消 / 子代理详情空 / 最新会话失败归因

> 日期：2026-08-07
> 规格：`docs/dev/core-loop/REGRESS-K-residual-detail-SPEC.md` + `REGRESS-K-investigate-brief.md`
> 前置 checkpoint：`958c83e`（HEAD，F–J 已备份，未 push）
> 范围：**只读摸底**。未改业务代码、未 commit。落盘会话取证 + 代码取证。
> 验收产物：本文（K1/K2 根因 + 文件:行 + K3 最新会话结论表 + 实现优先级 + 实现 brief 要点）。

---

## 0. 结论先行（三条摘要）

1. **K1（思考落正文秒消 + 执行块无思考行）—— brief 的两个假设都被推翻，根因未单点钉死，需运行时复录确认。**
   默认 `displayMode=full`（`chat-display-prefs.ts:18`）；用户实际渠道 kscc核+glm 的**思考始终是 `thinking` 块、不是 text**（最新会话 `session-1786088306947.messages.jsonl` L2/L8/L11/L15… 均为 `"type":"thinking"`），且全核（pi-core `assistant-message-builder.ts:218-219`、kscc-ndjson-parser `:149-152`、`piBlockToIR`）reasoning→thinking 映射正确 → **「reasoning 块映射错」「短思考当 text」均不成立**。F 主修（full `ThinkingActivityRow` settle + body 常驻）+ J3（中段思考并入 `stage.steps`）**在 HEAD 未回退**（`ProcessGroupView.tsx:312-337,380-397`、`concise-timeline-model.ts:541-553`）。残留症状最可能是 **live→idle 转场 UI 假象**：过程组/RunQueue 自动收起藏起思考行（`ProcessGroupView.tsx:94-132`、`ConciseTimelineView.tsx:156-161,375-397`）+ concise idle 丢弃 trivial 思考（`concise-timeline-model.ts:540`）+ glm 一块一消息大跳变触发 one-shot 快打字机（`narrative-oneshot.ts`）；「落正文」疑为模型**短进度旁白（text）**在 live 当正文打字机流、idle 被丢（`concise-timeline-model.ts:589-591`），被误读成「思考落正文」。**不能排除 build-lag**（运行 App 可能早于 `958c83e`，同 haiku 修的 build-lag 模式，见 `SUBAGENT-FAIL-ROUND2-FINDINGS.md` §0.3）。

2. **K2（子代理无论成功/失败，点进去都是「子代理尚未产生消息…」）—— 根因清晰，主因 = Pi 核 `task` 工具按设计不向主会话发 parented 子代理消息。**
   `subagent-task-tool.ts:150-296` 的 `createTaskTool`：subscribe 只收 `text_delta` 进 `textChunks`（`:216-218`）、只经 `onTaskEvent` 推 `task_started/progress/notification`（入口卡）、最终返回**一条**汇总 `tool_result`（`:286-294`）；文件头明写「完整 token 流仍不进主时间线（Checkpoint 2 W6）」（`:8-9`）。→ 子代理的 thinking/tool_use/中间 text **从不**带 `parentToolUseId` 进主会话 items。而 `SubagentDetailView` 全靠 `filterSubagentItems(items, parentToolUseId)`（`SubagentDetailView.tsx:57-60` + `session-turn-model.ts:190-199`）取数据 → Pi 核下恒为空 → 永远渲染「子代理尚未产生消息…」（`SubagentDetailView.tsx:191-193`）。**与成败无关**，命中「无论成功/失败都空」。kscc 核（SDK `Agent` 工具）会发 parented sidechain 消息（`kscc-message-adapter.ts:75,110` 映射 `parent_tool_use_id`→`parentToolUseId`；`Chat.tsx:1140-1178` append），详情页理应能填——但**近 5 个 GUI 会话全无子代理派发**，缺实跑佐证；且修前 haiku 钉死会致 glm 子代理首轮即败、无消息→空。

3. **K3（最新会话「子代理总失败」）—— 前提不成立：最新会话根本没派子代理；红字「失败」= Windows Git-bash 沙箱 fork 失败（Exit 5）+ 普通工具错，非子代理。**
   最新 GUI 会话 = `F--TAgent-Desktop/session-1786088306947`（Glob mtime 最新，内容 `2026-08-07T07:39Z` 起）。**0 个 `Agent`/`Task` tool_use、`parent_tool_use_id` 全 null、无 `task_notification`**。`is_error:true` 5 条：Bash fork 失败 ×2（L14/L18：`Exit code 5 … bash … add_item ("\??\C:\Program Files\Git","/",…) failed, errno 1`，连 `dangerouslyDisableSandbox:true` 仍 fork 失败）、Grep `InputValidationError`（L28 `-a` 非法参数）、Read `Path does not exist`（L48/L50）。与 ROUND2（`D--UnrealTagManager/session-1786070710143`）同结论：**用户看到的「失败」是 Bash fork，不是子代理**（对齐 memory `windows-git-bash-sandbox-fork.md`）。haiku 修 `831c941` 在代码+工作树（`session-service.ts:1146`），但**无任何「修后」子代理派发可佐证运行侧生效**；最新会话跑的构建是否含 `831c941`/`958c83e` 未知（build-lag）。

> 一句话：K2 有清晰根因（Pi 核 task 工具不发 parented 消息）可直修；K3 前提不成立（无子代理，红字是 Bash fork，正交于本规格，按「不改 Bash fork」跳过）；K1 推翻 brief 两个假设、根因未单点钉死，需「先 rebuild+重启排除 build-lag → 再运行时复录定性」才能定修。

---

## 总监补记（同会话后续核对，2026-08-07 16:08）

K3「无 Agent」成立，但 **UI 仍画出「子代理」行** 的原因已钉死，不在本轮 kscc 初稿里：

- Claude/kscc 的 `task_started` / `task_notification` **同时覆盖** `local_agent`（真子代理）与 `local_bash`（本机 Bash）。
- 适配层已传 `taskType`（`kscc-message-adapter.ts:175`），`Chat.tsx` 建卡时**丢掉**该字段，凡 `task_*` 都进 `reduceTaskEvent` → `listSubagentEntryIds` 把 Bash 的 `toolUseId` 当子代理入口。
- `findSubagentTaskTool` 只按 id 匹配、不校验 `Agent|Task` → 标题=Bash `description`，右侧默认「子代理」；点开无 parented 消息 → 与 K2 空详情叠在一起。

**修法补充**：过滤 `taskType === 'local_bash'`（或仅 `local_agent` / launcher∈Agent|Task 才建子代理卡）；与 K2 空回退可同 PR。

---

## K1 — 思考落正文秒消 + 执行块无思考行

### K1.1 推翻 brief 的两个假设（证据）

| brief 假设 | 取证 | 判定 |
|---|---|---|
| 「reasoning 块映射错」→ 思考被当 text | 最新会话 `session-1786088306947.messages.jsonl` 块级 grep：L2/L8/L11/L15/L19/L23/L29/L35/L45/L51/L55/L60/L68/L74 均为 `"type":"thinking"`；L3/L9/L12… 为 `"type":"text"`。全核映射正确：pi-core `assistant-message-builder.ts:218-219`（`thinking` slot→`ThinkingContent`）、`kscc-ndjson-parser.ts:149-152`（`block.type==="thinking"`→`thinking_start`）、`pi-agent-adapter.ts:1335-1337` `piBlockToIR`（`thinking`→`thinking`）、`kscc-message-adapter.ts:25-27`（`sdkBlockToIR` `thinking`→`thinking`） | **推翻**：kscc核+glm 思考是 `thinking` 块；全核 reasoning→thinking 正确，无 thinking→text 路径 |
| 「短思考当 text」 | `buildTurnPresentation`（`session-turn-model.ts:509-533`）按 `block.type` 分流：`thinking`→`process` thinking 条目（`:615-621`），`text`→`process` text 条目（`:631-633`）；思考从不进 `answerTexts`（`:637-645` 只收 `text`）。`buildConciseTimeline`（`concise-timeline-model.ts:524-567`）思考分支只产 `thinking` segment 或 `stage.steps`，**从不产 narrative**；narrative 只来自 `text` 条目（`:582-597`）+ `mergeAnswerIntoProcess`（`:382-435` 合并 `answerTexts`/`streamingText`，不含 thinking） | **推翻**：思考在数据/投影层恒走过程链，不会变正文 text |

### K1.2 F / J3 已修项未回退（核对）

| 已修项 | 文件:行 | 现状 |
|---|---|---|
| F 主修：full `ThinkingActivityRow` settle + body 常驻 | `ProcessGroupView.tsx:312-337`（`planThinkingRowSettle`/`THINK_SETTLE_MS`）、`:380-397`（`__panel` grid 0fr↔1fr + `is-open`，body 常驻 DOM） | ✓ 在（`REGRESS-F-FINDINGS.md` §4 的最小修已落地，非硬卸） |
| F RC1：turn_end/result 提交前 flush rAF thinking | `Chat.tsx:1213-1223`（result）、`:1303-1313`（turn_end）各加 `cancelAnimationFrame`+`pendingThinkingRef` 并入 | ✓ 在 |
| J3：中段思考（当前 stage 已开工具）一律并入 `stage.steps` | `concise-timeline-model.ts:541-553`（`stageSteps.some(tool)` → push `kind:'thinking'` step，key=`cur.key` 稳定） | ✓ 在 |
| J2：`WorkStageFold` settle | `ConciseTimelineView.tsx:206-208,375-397`（`WORK_STAGE_SETTLE_MS=1800` + settle timer + panel 常驻） | ✓ 在 |
| E 数据层：`shouldClearStreamThinking` 仅凭 content 思考清 | `stream-item-model.ts:61-71` | ✓ 在 |

→ **K1 不是 F/J3 的回退**；F 主修已在 HEAD。若用户仍看到「秒卸 body 换预览」，第一嫌疑是**运行 App 早于 `958c83e`**（build-lag）。

### K1.3 残留机理（最可能，按症状逐条映射）

| 症状 | 机理 | 证据 |
|---|---|---|
| 执行块里看不到思考行 | **过程组 / RunQueue 在 idle 自动收起**，思考行折在收起的容器里。full：`ProcessGroupView` `planProcessGroupCollapse` 在 `live→false` 后 `SETTLE_MS=2500`+3s 倒计时→`setExpanded(false)`，`__body` 整块卸载（`ProcessGroupView.tsx:94-132`，`{showBody && <body>}` `:220-221`）。concise：`RunQueueShell` 沦为历史轮即折叠（`ConciseTimelineView.tsx:156-161`），`WorkStageFold` settle 后折回灰字摘要（`:375-397`），`ThinkingFold` 折成「思考了 Ns」（`:253-271`） | 上述行 |
| 瞬间消失 | **concise idle 丢弃 trivial 思考**：`if (isTrivialThinking(t) && !isLive) continue`（`concise-timeline-model.ts:540`）。live 时短思考仍可见（`!isLive` 不成立），idle 重投影即被丢 → 用户看到「live 有、idle 没」。叠加 one-shot 打字机 remount（见下） | `concise-timeline-model.ts:540`、`isTrivialThinking` `:354-366` |
| 打字机飞快 | **glm 一块一消息 → 大跳变 → one-shot 快打字机**：`isOneShotTextJump`（`narrative-oneshot.ts:2-6`）`prev===0 || jump > max(80, prev*0.5)` 命中 → `NarrativeRow` `armOneShot` 重置 `seed=''` 再喂全文（`ConciseTimelineView.tsx:705-714`），`key={epoch}` remount；full 回答壳 `useSmoothStream` 同样对大跳变快速追上 | `narrative-oneshot.ts`、`ConciseTimelineView.tsx:747-758`、`AssistantTurnView.tsx:135-139` |
| 思考落盘到正文 | **数据层无 thinking→text 路径（K1.1 已推翻）**。最可能是**模型的短进度旁白（text）**被误读成「思考」：REGRESS-I/J7 output-style-prompt 鼓励「阶段切换偶发一句进度」，该短 text 在 live 由 `NarrativeRow` 当正文（progress tone）打字机流（`concise-timeline-model.ts:595-596`），idle 若为短段间 progress 则被 `isShortIdleProgress → continue` 丢弃（`:589-591`）→ 「正文里闪一句打字机 then 没了」。若用户确实看到**思考原文**（非旁白）落正文，则属未被本机渠道复现的个例 | `concise-timeline-model.ts:582-597`、`SHORT_PROGRESS_MAX_CHARS=20` `:374` |

### K1.4 不能排除 build-lag

- F 主修在 `958c83e`（HEAD），工作树干净。最新会话 `session-1786088306947` 起于 `2026-08-07T07:39Z`；`958c83e` 与 `831c941`（haiku 修，11:22）孰先孰后、运行 App 是否 rebuild 到 `958c83e`，**仅凭代码无法判定**。
- 与 haiku 修同型 build-lag（`SUBAGENT-FAIL-ROUND2-FINDINGS.md` §0.3：「修在仓库里、不在（大概率）运行进程里」）：若运行 App 早于 `958c83e`，用户看到的「秒卸 body」就是 F **修前**的原始 bug，而非残留。

### K1.5 定修前必做（确认步骤）

1. **rebuild + 重启** TAgent-Desktop，确保运行 App = `958c83e`；重发同型任务（kscc核+glm，带思考+工具）。若「秒消」消失 → 即 build-lag，K1 无需改码。
2. 若仍复现：**运行时录屏 + 抓该轮 live `.messages.jsonl`**，定性正文里闪的是 (a) 思考原文 还是 (b) 短进度旁白（text）：
   - (b) → 调 output-style-prompt（少发段间旁白）+ `isShortIdleProgress` 策略，非思考路由 bug。
   - (a) → 才需查 `buildTurnPresentation`/`buildConciseTimeline` 的 text/thinking 路由（但代码已证无此路径，需抓到具体渠道的块形状再判）。
3. 同时确认用户 `displayMode`（`localStorage tagent:chatProcessDisplayMode`）：full 还是 concise，二者残留机理不同（见 K1.3）。

### K1.6 候选修（待 K1.5 定性后再 apply，本轮不动）

- 若「执行块看不到思考行」= 自动收起：过程组在有 thinking 行时 idle 不整组折叠，或保留末段思考行可见（改 `planProcessGroupCollapse`/`RunQueueShell` 折叠条件）。
- 若「瞬间消失」= trivial 思考被丢：idle 不直接 `continue` 丢，保留一个「思考了片刻」折叠头（点开仍见全文），对齐 `ThinkingFold` 的 body 常驻。
- 若「打字机飞快」= one-shot 过快：`isOneShotTextJump` 阈值或 `useSmoothStream` 追赶速度调档（glm 一块一消息场景）。
- 若「落正文」= 短旁白：收 output-style-prompt 的「偶发一句」诱导 + `isShortIdleProgress` 保留策略。

---

## K2 — 点进子代理「尚未产生消息」

### K2.1 根因（清晰，主因）

**Pi 核 `task` 工具按设计不向主会话发 parented 子代理消息 → `SubagentDetailView` 数据源恒空。**

链路：

1. `createTaskTool`（`subagent-task-tool.ts:150-296`）执行子 Pi Agent：
   - subscribe **只**收 `text_delta` 进 `textChunks`（`:214-218`），计数 `tool_execution_start`（`:219-231`）；
   - 只经 `onTaskEvent` 推 `task_started`/`task_progress`/`task_notification`（`:182-188,225-230,276-282`）——这三个只服务**入口卡**（`Chat.tsx:435-441 subagentCards`）；
   - 最终 return **一条** `tool_result`（`content:[{type:'text', text: truncated}]`，`:286-294`）给主 Agent，作为 `task` 工具的结果。
   - 文件头明写（`:8-9`）：「进度通过 onTaskEvent 推送 … 供主会话入口卡展示；**完整 token 流仍不进主时间线（Checkpoint 2 W6）**」。
   - → 子代理的 thinking / tool_use / 中间 text **从不**带 `parentToolUseId` 进主会话 items。

2. `SubagentDetailView`（`SubagentDetailView.tsx:57-60`）`subagentItems = filterSubagentItems(items, parentToolUseId)`；`filterSubagentItems`（`session-turn-model.ts:190-199`）只收 `m.parentToolUseId === parentToolUseId`。
   - Pi 核下无此类 item → `subagentItems.length === 0` → 渲染「子代理尚未产生消息…」（`SubagentDetailView.tsx:191-193`）。
   - 与成败无关（`task_notification` 的 `status` 只改入口卡 `card.status`，`SubagentDetailView.tsx:84-85`，不补内容）→ 命中「无论成功/失败都空」。

### K2.2 kscc 核路径（理论可填，缺实跑佐证）

- kscc CLI `Agent` 工具发 sidechain 消息带 `parent_tool_use_id`（SDK 原生）；`kscc-message-adapter.ts:75,110` 映射 → `parentToolUseId`；`Chat.tsx:1140-1178`（`parentedMsg` 分支）静默 append 进 items → `filterSubagentItems` 可命中 → 详情页**理应**有内容。
- 落盘：`stream-persist-gate.ts:31-37` `isAssistantPersistable` 对非空 content 的 assistant（含 parented）放行 → parented 消息可落 GUI JSONL（`SUBAGENT-FAIL-ROUND2-FINDINGS.md` §2a:73 已证闸口不吃 Agent tool_use）。
- **但近 5 个 GUI 会话全无子代理派发**（见 K3 表），无「成功 kscc核子代理」的 GUI 落盘可证详情页能填。
- 修前 haiku 钉死（`620ed2e`+`e495962`，`831c941` 拆）致 glm 网关不认 haiku → 子代理首轮 LLM 即败、**无任何 sidechain 消息** → 详情页空。即修前 kscc核子代理也「失败=空」，与 Pi核「成功也空」叠加成「无论成败都空」的观感。

### K2.3 实现 brief 要点（等总监确认再改）

**首选：`SubagentDetailView` 在 `subagentItems.length === 0` 时回退渲染「入口卡信息 + task 工具 tool_result 文本」**，覆盖 Pi核（设计无 parented）与 kscc核 spawn 即败（无消息）两种空：

1. `SubagentDetailView.tsx:191-193`：`subagentItems.length === 0` 时不再只显示空提示；改为渲染：
   - `card`（`TaskCardState`：status/summary/description/lastToolName）—— Pi/kscc 两核都有（`task_notification`/`task_started`）；
   - `findSubagentTaskTool` 已能取 launcher `task`/`Agent` 的 `input`（`session-turn-model.ts:167-184`，`SubagentDetailView.tsx:61-64,188` 已用）；
   - 主线 `task` 工具的 `tool_result` 文本（Pi核汇总结果 / kscc核 Agent 结果）—— 从 items 中按 `toolUseId` 找该 tool_use 的 result（主线 user tool_result，`buildTurnPresentation:456-467` 已收 `resultById`，可同样在 detail 里取）。
2. 状态文案：`card.status==='failed'` → 显示失败原因（`task_notification.summary` 或 tool_result error）；`completed` → 显示 summary + 「（子代理完整过程未回放）」说明，避免误导。
3. **不动** Pi核 `createTaskTool` 的「不发 parented」设计（Checkpoint 2 W6 有意为之，改它影响主时间线噪音）。

**备选（更大改）：Pi核 `createTaskTool` 把子代理 assistant 消息带 `parentToolUseId` 转发主会话**——违反 W6、增主时间线噪音，不推荐。

### K2.4 vitest（修后跑，本轮不跑）

```
pnpm --filter @tagent/desktop vitest run apps/electron/src/renderer/components/chat/subagent-turn-group.test.ts
pnpm --filter @tagent/desktop vitest run apps/electron/src/renderer/components/chat/turn-presentation.vitest.test.ts
# + apps/electron typecheck；+ 新增 SubagentDetailView 空回退用例
```

---

## K3 — 最新会话「子代理总失败」归因

### K3.1 最新 GUI 会话定位

Glob mtime 最新：`C:\Users\liangmingxuan\.tagent-dev\projects\F--TAgent-Desktop\session-1786088306947.jsonl`（+ `.messages.jsonl`），内容 `2026-08-07T07:39Z` 起，75 条记录。（`stat` 确认失败：sandboxed git-bash 自身 fork 报 `Exit code 5`——即被查的同型失败；Glob mtime 序为准。）

### K3.2 最新会话结论表

| 项 | 证据 | 判定 |
|---|---|---|
| `Agent`/`Task` tool_use | `session-1786088306947.messages.jsonl` grep `"name":"(Agent\|Task\|agent\|task)"` = **0** | **未派任何子代理** |
| `parent_tool_use_id` | 75+ 处全为 `null`（schema 字段，非派发标志） | 无 sidechain 消息 |
| `task_notification` / `task_started` | 0 | 无子代理生命周期 |
| `is_error:true` 记录 | **5 条**：L14/L18 Bash、L28 Grep、L48/L50 Read | 见下 |
| L14 Bash 错文本 | `Exit code 5\n 0 [main] bash (60596) C:\Program Files\Git\bin\..\usr\bin\bash.exe: *** fatal error - add_item ("\??\C:\Program Files\Git", "/", ...) failed, errno 1` | **Git-bash 沙箱 fork 失败** |
| L18 Bash 错文本 | 同上（`dangerouslyDisableSandbox:true` 仍 fork 失败，`49548`） | 同上（关沙箱也救不了 fork） |
| L15 子代理思考自述 | `"bash 命令出错了（fork 失败）…"`（模型自己识别为 fork，非子代理） | 旁证：fork，非子代理 |
| L28 Grep 错 | `InputValidationError: An unexpected parameter \`-a\` was provided` | 工具参数错，非 fork/子代理 |
| L48/L50 Read 错 | `Path does not exist: /tmp/kcwork-asar/out/main` | 路径错，非 fork/子代理 |
| 子代理 jsonl（今日） | `.claude/projects/.../subagents/*.jsonl` 内容皆 2026-07-18/07-26，**今日 0 新建**；今日会话 `3ad2df9a…` 无 `subagents/` 目录、0 `isSidechain` | 今日确无子代理跑过 |

### K3.3 与 ROUND2 对照（同结论）

| 会话 | 渠道/模型 | Agent/Task | 红字「失败」实为 |
|---|---|---|---|
| 最新 `1786088306947`（F--TAgent-Desktop） | kscc核+glm（思考块 + `stop_reason:null` + 一块一消息） | 0 | Bash fork（Exit 5）×2 + Grep/Read 工具错 |
| ROUND2 `1786070710143`（D--UnrealTagManager） | kscc-internal+glm-5.2（`executionMode:work`，Task 已注册却没派） | 0 | Bash fork（Exit 5）×2 + UE 编译错（Exit 6）×4 |

→ **两轮「最新会话」都未派子代理**；用户把 Bash fork 的红字「失败」误读成「子代理失败」。Bash fork 与本机 `windows-git-bash-sandbox-fork` 同根，且**首次确认打到 GUI 主程序 Bash 工具**（不止 kscc CLI）。

### K3.4 haiku 修 `831c941` 是否进运行 App

| 问 | 答 | 证据 |
|---|---|---|
| 代码侧已修？ | **是** | `session-service.ts:1146` `buildBuiltinSubagentDefinitions(isClaudeAvailableForChannel(channel))`（commit `831c941`，18/18 单测绿）；工作树 = HEAD `958c83e`（`git status` 未列相关改动） |
| 运行 App 生效？ | **未知（倾向未证）** | 最新会话无子代理派发，无从佐证；且 build-lag 模式（`8626f1b5` 08-05 晚于 `e495962` 08-03 仍跑 glm-5.2 → 运行构建落后 HEAD）→ `831c941`/`958c83e` 多半也未进运行 App |
| 需用户做 | rebuild+重启 → Work 模式 + kscc-internal(glm-5.2) 发**会触发委派**的任务 → 看子代理卡有无工具进度 + 收口 `completed` + 子代理 assistant `model:"glm-5.2"` | 同 `SUBAGENT-FAIL-ROUND2-FINDINGS.md` §6b |

### K3.5 K3 处置

- **本规格不改 Bash/Git fork**（SPEC「本轮不做」明列）。K3 的「子代理总失败」**前提不成立**，无需为子代理改码。
- 行动项：rebuild+重启（顺带验证 K1 build-lag + haiku 运行侧），再派一个真子代理坐实 haiku 修。Bash fork 另立（正交）。

---

## 实现优先级（K1/K2）

| 优先级 | 项 | 理由 |
|---|---|---|
| **P0** | K2：`SubagentDetailView` 空回退（§K2.3 首选） | 根因清晰、改动局部、覆盖 Pi核+kscc核 spawn 即败两个空场景；纯前端，无主进程/数据层风险 |
| **P0（先做）** | rebuild+重启 + 运行时复录 | 同时为 K1 排 build-lag、为 K3 坐实 haiku 运行侧；零代码风险，是 K1/K3 定修的前置 |
| **P1** | K1：待 K1.5 定性后再修 | 根因未单点钉死；先排除 build-lag 与「思考 vs 旁白」误读，避免误改 `concise-timeline-model`/output-style-prompt |
| **不做** | K3 Bash fork | 正交，SPEC 明列不改 |

---

## 实现 brief 要点汇总（等总监确认再改代码）

- **K2（P0，清晰）**：`SubagentDetailView` `subagentItems.length===0` 时回退渲染 `card`（status/summary）+ 主线 `task`/`Agent` 的 `tool_result` 文本（按 `toolUseId` 从 items 取，复用 `buildTurnPresentation` 的 `resultById` 思路）；`failed` 显原因、`completed` 显 summary +「过程未回放」说明。不动 `createTaskTool` 的 W6 设计。
- **K3（P0 前置，无代码）**：rebuild+重启 → 派真子代理验证 haiku 运行侧；Bash fork 另立。
- **K1（P1，待定性）**：先 rebuild 排 build-lag → 录屏 + 抓 live `.messages.jsonl` 区分「思考原文」vs「短旁白」→ 再定改 `planProcessGroupCollapse`/`RunQueueShell` 折叠条件、`isTrivialThinking` idle 丢弃策略、`isOneShotTextJump`/`useSmoothStream` 速度、或 output-style-prompt 旁白诱导。**本轮不 apply**。

---

## 关键文件清单

- K1：`apps/electron/src/renderer/atoms/chat-display-prefs.ts:18`（默认 full）；`ProcessGroupView.tsx:94-132,312-337,380-397`；`concise-timeline-model.ts:540,541-553,582-597,589-591`；`narrative-oneshot.ts:2-6`；`ConciseTimelineView.tsx:156-161,375-397,705-758`；`pi-core/assistant-message-builder.ts:218-219`；`kscc-ndjson-parser.ts:149-152`；`kscc-message-adapter.ts:25-27`；`session-turn-model.ts:509-533,615-645`；最新会话 `session-1786088306947.messages.jsonl`（思考块实证）
- K2：`subagent-task-tool.ts:150-296`（`:8-9,182-188,214-218,276-294`）；`SubagentDetailView.tsx:57-60,84-85,191-193`；`session-turn-model.ts:167-199`；`Chat.tsx:435-441,1140-1178`；`kscc-message-adapter.ts:75,110`；`stream-persist-gate.ts:31-37`
- K3：最新 `~/.tagent-dev/projects/F--TAgent-Desktop/session-1786088306947.{jsonl,messages.jsonl}`（无 Agent/Task；Bash fork L14/L18；Grep L28；Read L48/L50）；ROUND2 `D--UnrealTagManager/session-1786070710143`；`session-service.ts:1146`（haiku 修）；`SUBAGENT-FAIL-ROUND2-FINDINGS.md` §0.3/§6b；memory `windows-git-bash-sandbox-fork.md`、`regress-f-full-mode-default-gap.md`

---

## 备注

- 本轮**只读摸底**，未改业务代码、未 commit（遵 SPEC/brief）。
- K3 的 `stat`/`find` 等 bash 取证在本机 fork 失败（Exit 5，同被查问题），改用 Glob mtime + Grep `-o` 取证，结论不受影响。
- 前序 `SUBAGENT-FAIL-ROUND2-FINDINGS.md` 已把 ROUND2 查清；本轮新增：最新会话改为 `1786088306947`（仍无子代理、仍 Bash fork）、K2 的 Pi核 `task` 工具不发 parented 消息根因、K1 推翻 brief 两假设 + 残留机理。
