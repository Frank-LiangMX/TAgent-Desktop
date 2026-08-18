# FINDINGS · 审计打包版 TAgent-Desktop 上一条会话（session-1786959659981）

> 审计者：kscc（只读）　规格：`docs/dev/core-loop/RUN-TIMER-ACROSS-TOOL-WAIT-SPEC.md`  
> 本轮**不改代码**。结论由落盘 JSONL 流式扫描得出（未整文件入模）。

## 会话元信息

| 项 | 值 |
|---|---|
| sessionId（强制） | `session-1786959659981` |
| workspaceId | `F--TAgent-Desktop` |
| modelId | `glm-5.2` |
| 消息 JSONL | `C:\Users\liangmingxuan\.tagent\projects\F--TAgent-Desktop\session-1786959659981.messages.jsonl` |
| SDK JSONL | `C:\Users\liangmingxuan\.tagent\projects\F--TAgent-Desktop\session-1786959659981.jsonl` |
| 两文件关系 | **字节同源**（md5 均为 `4186c9c8651f41fa0d35e8575a433ea7`，703 行） |
| 起止 | 2026-08-17 09:41:18.728Z → 2026-08-18 01:09:42.758Z（跨度 15.47h，含隔夜等用户） |
| 记录数 | 703（0 解析失败）；主线 315 / 子代理 parented 388；assistant 448 / user 255 |
| 时间戳完备性 | `createdAt`(epoch ms) **703/703 全有**；ISO `timestamp` 字段缺 4 条（首条 user 等），**不影响计时分析**（一律用 createdAt） |

实际用户回合 **4 个**（与 brief 的 ≈4 吻合）：@0 09:41:18 初始、@32 09:46:46「肯定都得开发完成…」、@42 09:49:39「先打包我测一下」、@85 09:57:17「可以了，接着开发吧」。
@41「[Request interrupted by user]」是用户**中断**（非新回合）；@446「This session is being continued…」是**子代理** parented 消息（非主线回合）。

## 结论一句话

**会反复软/硬停并让计时从 0：4 个回合内共 59 个主线间隔 >3s（软停）、42 个 >5s（硬停归零）、20 个 >20s（看门狗硬清）；子代理把空窗拉到 52–218s 且其 parented 消息不刷新主线看门狗，确实「派子代理时更明显」——落盘结构吻合 SPEC 根因 #2/#3/#6。**

## 证据表（逐回合，验收 1+2+4）

主线 assistant = `type=assistant` 且 `parent_tool_use_id` 为空。

| 回合 | 主线 assistant 条数 | 其中带 tool_use | 间隔>3s | 间隔>5s | 间隔>20s | 回合内最大 gap | 回合跨度 |
|---|---|---|---|---|---|---|---|
| 1 (@0)  | 19 | 12 | 4 | 4 | 2 | 84.6s（Grep 普通工具往返 `[6->12]`） | 130.9s |
| 2 (@32) | 6  | 2  | 3 | 3 | 1 | 69.4s（Read 普通工具往返 `[35->37]`） | 92.0s |
| 3 (@42) | 30 | 12 | 10 | 7 | 3 | 70.9s（`[80->81]` 见下方注） | 220.5s |
| **4 (@85) ★最长回合** | **149** | **80** | **42** | **28** | **14** | 53438.2s（隔夜 AskUserQuestion `[473->475]`） | 54724.3s |
| **合计** | **204** | **106** | **59** | **42** | **20** | — | — |

★ 最长回合 = **回合 4**（@85「可以了，接着开发吧」→ 会话末）。149 条主线 assistant、80 条带工具；跨度 15.2h 中 14.8h 是 `AskUserQuestion` 隔夜等用户（`[473->475]`），活跃工作集中在 09:57–10:10 与次日 01:01–01:09 两段。

> 注：回合 3 的 70.9s `[80->81]` 被自动分类为「纯流式」，但 raw 显示 @80「已提交并推送，打包后台跑中」→ @81「打包完成(exit 0)」——实际是**等后台打包 Bash** 的主线静默，仍 >20s，照样触发看门狗硬清。即「纯流式」桶里也藏着工具等待。

### 间隔分类（回合内，5 类）

| 类别 | n | >3s | >5s | >20s | 最大 |
|---|---|---|---|---|---|
| 普通工具往返（Read/Bash/Grep/Glob/Edit/EnterPlanMode） | 95 | 33 | 23 | 12 | 88.3s（Read） |
| 等子代理（主线静默，中间只有 parented 消息） | 13 | 6 | 5 | 4 | 128.8s |
| 纯流式/思考（含上述后台 Bash 等待伪 thinking） | 83 | 14 | 9 | 1 | 70.9s |
| AskUserQuestion（等用户） | 4 | 4 | 4 | 3 | 53438.2s |
| Agent 派发（launcher→下一主线消息，本身很小） | 5 | 2 | 1 | 0 | 8.2s |

「真 turn_end 空窗（中间有主线 tool_result）」= 普通工具往返 + AskUserQuestion + Agent 派发，共 104 个；其中 >5s 共 28 个。其余为 intra-run thinking / 等子代理静默。

## 子代理（验收 3）

- `tool_use.name` 含 **`Agent`** —— 是子代理启动器。`TaskCreate`/`TaskUpdate` 是**协作室房间任务工具**（非子代理），按 brief 排除 `TaskUpdate`（`TaskCreate` 同属房间任务管理，亦不计为子代理）。
- **有 `parentToolUseId` 消息**：388 条，分属 5 个 Agent 作用域（`call_5bac9358b` / `call_88bac749b` / `call_d62da6956` / `call_8c438539f` / `call_5e3467654`）。
- **关键陷阱**：Agent 的 `tool_result` 是**派发即落盘的 stub**（launcher→result 仅 +9~23ms），**不等于子代理完成时刻**。子代理真正的运行时长要看其 parented 消息末尾。

| # | Agent id | 派发@idx | 派发时刻 | launcher→result（stub） | parented 消息数 | 末条 parented 时刻 | **真实运行时长** |
|---|---|---|---|---|---|---|---|
| 1 | call_5bac9358b | 92  | 09:59:04.181 | **23ms** | 56 | 09:59:55.947 | **51.8s** |
| 2 | call_88bac749b | 101 | 09:59:08.404 | **9ms**  | 67 | 10:00:37.503 | **89.1s** |
| 3 | **call_d62da6956** | **267** | **10:06:56.540** | **19ms** | **119** | **10:10:34.486** | **217.9s（最长）** |
| 4 | call_8c438539f | 287 | 10:07:04.726 | 11ms | 64 | 10:08:34.707 | 90.0s |
| 5 | call_5e3467654 | 479 | 01:01:45.635 | 18ms | 82 | 01:03:59.886 | 134.3s |

证据（call_d62）：`@267` 主线 `tool_use:Agent[call_d62da]` → `@268` 主线 `tool_result[call_d62da]`（+19ms）→ `@269..@471` 才是该子代理的 119 条 parented 消息（10:06:58→10:10:34）。即**主线在派发后 218s 内只产 stub、无新 delta**。

## 普通工具 tool_use→tool_result 最长 8（验收 4，主线非 Agent）

| # | 工具 | 等待 | use@idx | result@idx | 时刻 |
|---|---|---|---|---|---|
| 1 | AskUserQuestion | 53397.5s | 473 | 474 | 10:10:43（隔夜等用户） |
| 2 | AskUserQuestion | 174.3s | 259 | 260 | 10:02:55 |
| 3 | Bash | 49.2s | 2 | 10 | 09:41:28 |
| 4 | Bash | 48.9s | 3 | 11 | 09:41:29 |
| 5 | AskUserQuestion | 22.3s | 39 | 40 | 09:48:49 |
| 6 | Bash | 14.8s | 620 | 622 | 次日 01:04:43 |
| 7 | Read | 14.7s | 621 | 623 | 次日 01:04:43 |
| 8 | AskUserQuestion | 13.3s | 263 | 264 | 10:06:17 |

> 全部主线普通工具等待 101 个；分布（秒桶 0–1/1–3/3–5/5–10/10–30/30–60/60–300/>300）= 82/5/2/1/7/2/1/1。即绝大多数工具 <1s，但 Read/Bash/Grep 偶发 14–88s 长尾——正是「没派子代理也停一下」的来源。

## 与 SPEC 是否吻合（验收 5）

SPEC 根因 ↔ 落盘证据：

- **#2（3s 宽限软停）**：59 个回合内主线间隔 >3s → 59 次软停条件成立。✅
- **#3（任意工具 >5s 硬清 startedAt）**：42 个回合内间隔 >5s（普通工具 23 + 等子代理 5 + AskUser 4 + 后台 Bash 伪 thinking 1 + 其它 thinking 8 + Agent派发 1）→ 计时会反复从 0。✅
- **#6（子代理 parented 消息不刷新 lastStreamEventAt，20s 看门狗硬清）**：5 次子代理真实运行 52–218s，期间主线无 delta；20 个 >20s 主线静默（普通工具 12 + 等子代理 4 + AskUser 3 + 后台 Bash 1）。子代理确实**额外拉长空窗**并多次触达 20s 看门狗。✅

**吻合结论**：落盘 gap 结构完全支持 SPEC 描述的现象——「同一用户回合内 startedAt 应只记一次，但工具循环/等子代理被当成新一轮 → 软停/硬清 → 计时归零」。回合 4 最严重（28 次硬停），子代理（尤其 call_d62 的 218s）是「派子代理时更明显」的直接证据。

> 诚实边界：落盘能证明**空窗/turn_end 结构存在**（即触发条件成立）；UI 是否真把计时归零属运行时行为，需结合 `Chat.scheduleRunStop` / `useLiveElapsedMs` 代码侧验证（SPEC 已列代码根因，本轮不改代码）。

## 验收 6：时间戳缺失

- `createdAt`（epoch ms）：703/703 全有，无缺失。
- ISO `timestamp`：缺 4 条（如首条 @0 user），均可用 createdAt 替代，**不产生计时空洞**。
- 子代理 `tool_result` 的 createdAt 是**派发 stub 时刻**（非完成时刻），若误用其计算子代理等待会得到 9–23ms 的误导值——本报告改用「末条 parented 消息 − 派发时刻」还原真实时长。

## 本轮不做改代码

按 brief 要求，仅落盘审计、不动 `apps/` `packages/`。修复方向见 SPEC「落地（2026-08-18）」三条（turn_end 仍有在途工作不排停表 / 无在途时不硬清 startedAt / adopt 记忆优先 + 工具与 task_* 刷看门狗）。
