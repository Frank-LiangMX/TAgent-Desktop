# Findings · 审计打包版最新会话：turn 间隙 vs 运行计时归零

> 审计日期：2026-08-18  
> 交卷者：`kscc -p --model glm-5.2 --dangerously-skip-permissions`（只读，未改 `apps/` / `packages/`）  
> 规格：`docs/dev/core-loop/RUN-TIMER-ACROSS-TOOL-WAIT-SPEC.md`

## 会话元数据（来自索引 `agent-sessions.json` + 文件 mtime）

| 字段 | 值 |
|---|---|
| 是否打包目录 | **是**（`C:\Users\liangmingxuan\.tagent`，不是 `.tagent-dev`） |
| 应用 sessionId | `session-1787014972010` |
| sdkSessionId | `5f3f6f8b-66c3-4336-b139-43c89f243673` |
| title | 当前贴图统计换了一个分支目录，你先帮我查… |
| modelId | `deepseek-v4-flash` |
| workspaceId | `H--j3-statics` |
| executionMode / permissionMode | `work` / `bypassPermissions` |
| 索引 createdAt | 1787015021335（2026-08-18T01:03:41Z / 北京 09:03:41） |
| 索引 updatedAt | 1787015494318（2026-08-18T01:11:34Z / 北京 09:11:34） |
| 索引 turnCount / status | `1` / `idle`（**陈旧**：索引只记到 turn 1 结束） |
| 索引 turnDurations | `{"1787015494288":{"ms":472983,"endedBy":"complete"}}`（仅 turn 1） |
| 消息文件（绝对路径） | `C:\Users\liangmingxuan\.tagent\projects\H--j3-statics\session-1787014972010.messages.jsonl` |
| SDK jsonl（绝对路径） | `C:\Users\liangmingxuan\.tagent\projects\H--j3-statics\session-1787014972010.jsonl` |

**选会话依据**：索引 46 条会话按 `updatedAt` 降序，本条 `1787015494318` 最大；其 `.messages.jsonl` mtime 也是全目录最新（09:11），二者一致，取此条。

**重要说明（live session）**：审计期间该会话文件**仍在活跃增长**（从 100→107→133→168→176 行），说明用户正在打包版里实时跑这条会话复现 bug。索引 `updatedAt`/`turnCount` 只反映 turn 1 完成时刻，turn 2 仍在进行、尚未回写索引。下表数字基于**冻结快照** `C:\Users\liangmingxuan\AppData\Local\Temp\audit-snap\m.jsonl`（176 行 / 601,775 字节；SDK 108 行）。所有读取用 `readFileSync` 一次性原子读，行数与统计自洽。

**时间戳可用性**：176 行**全部带 `createdAt`（ms epoch）**，0 条缺失；assistant 行另带 ISO `timestamp`；`stop_reason` 全文 **0 条**（deepseek-v4-flash 落盘不写 stop_reason，与 glm 同病）。故 turn_end 不能用 stop_reason 判，改用「assistant run 末块 → 下一 run 首块」+ `tool_use`↔`tool_result` 配对推断。

## 结论（一句话）

**是。** 本会话两轮都在 `RUN_STOP_GRACE_MS=3000` + `HARD=2000` 下反复触发软停/硬停、令计时从 0 重来——**且全程无子代理**，所有停顿来自普通 Bash/Read/Glob/Write/Grep/Edit 工具的工具等待间隙，与 SPEC 根因完全吻合。

## 证据表

### Turn 1（idx 0..99，最长一轮，墙钟 473.0s，09:03:41→09:11:34）

| 指标 | 值 |
|---|---|
| 主线 assistant 行（无 `parent_tool_use_id`） | **63** |
| 其中带 `tool_use` 的行 | **36** |
| assistant run（连续 assistant 段）数 | 31 |
| 带 `tool_use` 的 run 数（= `turn_end` 次数） | **30** |
| **相邻主线 assistant 间隔（block 级，brief Q2 字面）** | 共 62 段；**>3s = 32**；**>5s = 19**；最大 **81.3s**（idx 93→95） |
| ↳ 其中 intra-run thinking 间隙（中间无 tool_result，thinking 期间有 delta，不算 turn_end） | 10 段 → 真 turn_end/idle 间隙 >3s ≈ **22** |
| **turn 级 idle 窗口（run 末→下一 run 首，真无 delta）** | 共 30；**>3s = 22**；**>5s = 14**；最大 **81.3s** |
| `tool_use`→`tool_result` 间隔（brief Q4） | 共 36；**>3s = 11**；**>5s = 10** |
| 子代理 | **无** |

turn 1 的 turn 级 idle 窗口 >3s（22 个，降序）：
`81.3 / 78.9 / 38.0 / 33.2 / 23.8 / 18.2 / 14.5 / 12.8 / 12.0 / 11.4 / 10.7 / 9.7 / 6.4 / 6.0 / 4.2 / 3.8 / 3.7 / 3.7 / 3.5 / 3.3 / 3.1 / 3.1`（秒）

### Turn 2（idx 100..175，最新一轮，墙钟 346.9s，09:13:16→09:19:03，仍在增长）

| 指标 | 值 |
|---|---|
| 主线 assistant 行 | **48** |
| 其中带 `tool_use` 的行 | **27** |
| assistant run 数 | 27 |
| 带 `tool_use` 的 run 数（= `turn_end` 次数） | **27** |
| **相邻主线 assistant 间隔（block 级）** | 共 47 段；**>3s = 21**；**>5s = 12**；最大 **55.8s**（idx 168→170） |
| ↳ intra-run thinking 间隙（不算 turn_end） | 2 段 → 真 turn_end/idle 间隙 >3s ≈ **19** |
| **turn 级 idle 窗口（真无 delta）** | 共 26；**>3s = 19**；**>5s = 10**；最大 **55.8s** |
| `tool_use`→`tool_result` 间隔 | 共 27；**>3s = 4**；**>5s = 4** |
| 子代理 | **无** |

turn 2 的 turn 级 idle 窗口 >3s（19 个，降序）：
`55.8 / 33.3 / 18.9 / 10.1 / 8.9 / 7.1 / 6.6 / 5.6 / 5.5 / 5.2 / 4.7 / 4.5 / 4.4 / 3.8 / 3.7 / 3.5 / 3.4 / 3.3 / 3.2`（秒）

### 子代理判定（brief Q3）

- 全文 `tool_use.name` 集合：`Glob, Bash, Read, Write, Grep, TaskUpdate, Edit`。
- 命中 `/Agent|Task|task/i` 的只有 **`TaskUpdate`**——但它是协作房间的**单发任务更新工具**（`room_task_update`），非子代理派发：其 `call_144` 的 `tool_use→tool_result` 仅 **17ms** 即返回，且不产生子会话。
- 全文 **0 条**带 `parent_tool_use_id` 的消息（无 parented/subagent 消息）。
- **无 `Agent` 工具调用。**
- **结论：无子代理。** 用户「不派子代理也莫名停」在此会话得到直接复现——停顿全来自普通工具间隙。

## 最长 8 个工具等待（brief Q4）

### Turn 1
| call | result idx | 等待 | 备注 |
|---|---|---|---|
| `call_ee2` | 85 | **70.7s** | Bash |
| `call_bec` | 94 | **68.6s** | Bash |
| `call_c7c` | 8 | **35.3s** | Bash (ERR) |
| `call_ccc` | 53 | **30.3s** | Bash |
| `call_509` | 54 | **30.0s** | Read (ERR) |
| `call_05c` | 12 | **15.2s** | Bash (ERR) |
| `call_c9c` | 68 | **15.2s** | Bash (ERR) |
| `call_5cc` | 13 | **14.9s** | Read |

### Turn 2
| call | result idx | 等待 | 备注 |
|---|---|---|---|
| `call_bba` | 175 | **68.9s** | Bash |
| `call_5af` | 169 | **48.5s** | Bash |
| `call_145` | 116 | **30.3s** | Bash |
| `call_e22` | 119 | **15.2s** | Bash (ERR) |
| `call_e05` | 108 | 1.0s | Bash |
| `call_0a3` | 113 | 0.7s | Read |
| `call_200` | 111 | 0.4s | Grep |
| `call_329` | 127 | 0.2s | — |

> 仅 `>5s` 的工具等待就足以硬停：turn 1 共 **10** 个、turn 2 共 **4** 个。任一 >5s 的 Bash/Read 等待 → 3s 软停 `running=false` → 再 2s 硬停清 `startedAt` → 下一 delta `adopt` 无记忆用 `Date.now()` → pill 从 0s。

## 验收清单逐条（数字回答）

1. **主线 assistant / 带 tool_use**：turn 1 = 63 行 / 36 行带 tool_use（31 run / 30 run 带 tool_use）；turn 2 = 48 行 / 27 行带 tool_use（27 run / 27 run 带 tool_use）。每个带 tool_use 的 run 都伴随一次 SDK `turn_end` → UI 潜在软/硬停。
2. **相邻主线 assistant 间隔分布**：
   - turn 1：62 段，`>3s=32`，`>5s=19`，最大 **81.3s**（idx 93→95，`call_bec` Bash 等待 68.6s + 恢复延迟）。
   - turn 2：47 段，`>3s=21`，`>5s=12`，最大 **55.8s**（idx 168→170，`call_5af` Bash 等待 48.5s + 恢复延迟）。
   - 注：block 级口径含 intra-run thinking 间隙（thinking 期间有 delta，不应判停）；改用 turn 级 idle 窗口后：turn 1 `>3s=22/>5s=14`、turn 2 `>3s=19/>5s=10`，仍远超阈值。
3. **子代理**：**无**。无 `Agent` 工具、无 parented 消息；`TaskUpdate` 命中子串但实为协作房间单发工具（17ms 返回），非子代理派发。
4. **普通工具 tool_use→tool_result 最长 8 个**：见上表。turn 1 八个全 >14s（最高 70.7s）；turn 2 四个 >5s（最高 68.9s）。
5. **结论句**：**是**。两轮在现网 `GRACE=3000`/`HARD=2000` 下，仅 turn 1 就有 14 个、turn 2 有 10 个真无 delta 窗口 >5s（最长 81.3s / 55.8s），全部由普通 Bash/Read 工具等待造成——3s 软停、5s 硬清 `startedAt`，下一轮 delta 从 `Date.now()` 重计，pill 从 0s。证据：`call_ee2` Bash 等待 70.7s、`call_bec` 68.6s 等，远超 5s 硬停线。
6. **时间戳缺失**：`createdAt` 0 缺失；`stop_reason` 全缺（deepseek 落盘不写，同 glm 旧病），故 turn_end 改用 run 边界 + tool_use↔tool_result 配对推断；ISO `timestamp` 仅 2 条 user-tool_result 行缺失（用 `createdAt` 兜底）。

## 与 SPEC 根因是否吻合

**完全吻合**，逐条对照：

| SPEC 根因 | 本会话证据 |
|---|---|
| ① 出 `tool_use` 后 SDK 发 `turn_end`（整次 query 未完） | turn 1 有 30 个带 tool_use 的 run、turn 2 有 27 个 → 各对应一次 `turn_end`，query 仍在继续 |
| ②③④ 3s 无 delta 软停、再 2s 硬停清 `startedAt`，下一 delta 无记忆用 `Date.now()` | 14/10 个 idle 窗口 >5s（最长 81.3s/55.8s），每个都跨过一次 Bash/Read 工具执行 → 必然软停+硬清 → 计时归 0 |
| ⑤ `useLiveElapsedMs` 复活后锁新起点 | 与 ④ 连续：硬清后 pill 从 0s 重计 |
| ⑥ 子代理 parented 被跳过 adopt / 看门狗 20s 再清 | 本会话**无子代理**，故该路径未触发；但「不派也停」由 ①~⑤ 单独成立 |
| 「没派子代理也停一下」= 普通工具间隙同样走 `turn_end` | **直接复现**：全程无 `Agent`、无 parented，停顿全来自 Bash/Read/Glob/Write/Grep/Edit |

补充：`stop_reason` 落盘恒空（与 [[regress-g-glm-stream-shape-gate]] 的 glm 现象同族，此处是 deepseek-v4-flash），UI 侧任何「用 stop_reason 判 final」的逻辑都会误判——与计时归零叠加会放大「停一下再继续」体感。

## 本轮不做

- 不改 `apps/` / `packages/` 产品代码（含 `Chat.scheduleRunStop` / `useLiveElapsedMs` / adopt 记忆链）。
- 不手测 GUI（仅落盘静态分析）。
- 不 commit / push。
- 未删除冻结快照 `C:\Users\liangmingxuan\AppData\Local\Temp\audit-snap\`（保留供复核；可手动清）。

## 复核脚本

冻结快照与统计脚本（均在系统临时目录，非仓库）：
- 快照：`C:\Users\liangmingxuan\AppData\Local\Temp\audit-snap\{m.jsonl,s.jsonl}`
- 统计脚本：`C:\Users\liangmingxuan\AppData\Local\Temp\audit-final.js`（可重跑）
