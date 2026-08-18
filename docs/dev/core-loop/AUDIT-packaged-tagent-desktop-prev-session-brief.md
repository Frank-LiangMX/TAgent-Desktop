# Brief · 审计打包版 TAgent-Desktop 上一条会话（不是贴图统计）

> 交卷者：`kscc -p --model glm-5.2 --dangerously-skip-permissions`  
> **只读**。禁止改 `apps/` / `packages/`。可写本目录 findings。

## 目标

上一轮误审了 `updatedAt` 最大的 `H--j3-statics` / `session-1787014972010`（贴图统计）。  
用户要的是 **再往前一条、workspace 为 TAgent-Desktop** 的会话落盘，用来核对：运行中停一下再继续、计时从 0、派子代理时更明显。

规格：`docs/dev/core-loop/RUN-TIMER-ACROSS-TOOL-WAIT-SPEC.md`

## 指定会话（不要改选最新）

- 索引：`C:\Users\liangmingxuan\.tagent\agent-sessions.json`
- **sessionId（强制）**：`session-1786959659981`
- workspaceId：`F--TAgent-Desktop`
- 标题约：当前分支 collab room，是否都已…
- modelId：`glm-5.2`
- 消息：`C:\Users\liangmingxuan\.tagent\projects\F--TAgent-Desktop\session-1786959659981.messages.jsonl`
- SDK：同目录 `session-1786959659981.jsonl`

若该 jsonl 不存在，在 `~/.tagent/projects/F--TAgent-Desktop/` 与 `~/.tagent/agent-sessions/` 搜同 id，找到后在 findings 写清实际路径。

**不要**再分析 `session-1787014972010`。

## 怎么读 JSONL

- 用脚本流式扫，禁止把整文件塞进模型。
- 抽：`type`、`createdAt`/`timestamp`、`tool_use`（id/name）、`tool_result`（tool_use_id）、`parentToolUseId`/`parent_tool_use_id`、`stop_reason`。
- 不要打印工具结果全文、密钥、大段用户原文。

## 验收清单（必须用数字）

对 **每一轮用户回合** 都做（本会话 turnCount≈4，全部覆盖）。另标出最长一轮。

1. 主线 assistant 条数（无 parentToolUseId）；其中多少带 `tool_use`。
2. 相邻主线 assistant 间隔：`>3s` / `>5s` 段数、最大 gap。并区分「真 turn_end 空窗（中间有 tool_result）」vs intra-run thinking。
3. **子代理**：`tool_use.name` 是否含 `Agent` / `task` / `Task`（排除协作室 `TaskUpdate`）；是否有 `parentToolUseId` 消息。有则列出每次派发的等待时长（launcher tool_use → 对应 tool_result）。
4. 普通工具 tool_use→tool_result 最长 8 个。
5. 结论句：在 `GRACE=3000`+`HARD=2000` 下会不会反复软/硬停并让计时从 0 开始？子代理等待是否额外拉长空窗？
6. 时间戳缺失时写清缺哪个字段。

## 产出

写到：`docs/dev/core-loop/AUDIT-packaged-tagent-desktop-prev-session-FINDINGS.md`

结构：会话 id / 路径 / 时间；结论一句话；证据表；子代理等待；与 SPEC 是否吻合；本轮不做改代码。

## 返回 stdout

文件路径 + 结论一句话 + 最大 gap + 有无子代理 + 子代理最长等待。
