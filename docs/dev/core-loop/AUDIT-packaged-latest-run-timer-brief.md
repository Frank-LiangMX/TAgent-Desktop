# Brief · 审计打包版最新会话：turn 间隙 vs 运行计时归零

> 交卷者：`kscc -p --model glm-5.2 --dangerously-skip-permissions`  
> **只读**。禁止改 `apps/` / `packages/`。可写本目录 findings。

## 目标

用户反馈：运行中消息会「停一下再继续」，计时从 0 重来；派子代理明显，**不派也会莫名停**。  
请用 **打包版** 数据目录里 **最新一条会话** 的消息记录，重建时间线，验证是否符合「每次 tool 间隙都会 `turn_end`，且间隙经常 >3s / >5s」。

规格对照：`docs/dev/core-loop/RUN-TIMER-ACROSS-TOOL-WAIT-SPEC.md`

## 数据位置（打包版，不是 `.tagent-dev`）

当前 Windows 用户主目录下：

- 索引：`C:\Users\liangmingxuan\.tagent\agent-sessions.json`
- 会话消息：`C:\Users\liangmingxuan\.tagent\projects\{workspaceId}\{sessionId}.messages.jsonl`
- SDK jsonl：同目录 `{sessionId}.jsonl`
- 旧路径 fallback：`C:\Users\liangmingxuan\.tagent\agent-sessions\{sessionId}.jsonl` 与 `.messages.jsonl`

**选会话规则：**

1. 读索引，按 `updatedAt` 最大者为「最新」。
2. 若索引里有多条接近的，再比对应 jsonl / messages.jsonl 的文件 mtime，取更新者。
3. 在 findings 写清：sessionId、title、modelId、updatedAt（ISO）、文件绝对路径、行数/体积。
4. 若 `~/.tagent` 不存在或索引为空：检查 `~/.tagent-dev` 并 **明确写「不是打包目录」**，仍按最新会话做同样分析。

## 怎么读 JSONL（不要整文件塞进上下文）

- 用脚本（PowerShell / node / python）流式扫。大文件只抽字段。
- 每行 JSON 可能是 SDKMessage（`type`/`message`）或面板 IR。兼容两种。
- 关心字段：`type`、`timestamp` / `createdAt` / `message.timestamp`、assistant `content[]` 里的 `tool_use`（id/name）、user `tool_result`（tool_use_id）、`parentToolUseId` / `parent_tool_use_id`、`stop_reason`。
- **不要**打印工具结果全文、密钥、大段用户原文。工具名 + id 前 12 字符 + 间隔毫秒即可。

## 验收清单（必须用数字回答）

针对 **最新用户回合**（最后一条 user 文本消息及其后所有 assistant/tool，直到文件末尾或下一条 user）。若最后一轮太短，再分析 **最长的一轮**（同一 user 之后 assistant 条数最多的那轮），两轮都写。

1. 该轮有几条 **主线** assistant（无 `parentToolUseId`）？其中多少条带 `tool_use`（即几乎必然伴随 UI 的 `turn_end`）？
2. 相邻两条主线 assistant 的时间间隔分布：列出每一段 gap（ms）。统计：`>3s` 段数、`>5s` 段数、最大 gap。
3. 是否有子代理：`tool_use.name` 是否含 `Agent` / `task` / `Task`，或存在 `parentToolUseId` 的消息。没有也要写「无子代理」。
4. 普通工具（Read/Bash/Edit/Grep/…）的 tool_use → 对应 tool_result 间隔：列出最长的 8 个。
5. **结论句**：这轮是否足以在现网 `RUN_STOP_GRACE_MS=3000` + `HARD=2000` 下反复软停/硬停并让计时从 0 开始？是/否 + 一句证据。
6. 若时间戳缺失：写清缺哪个字段，改用文件内相对顺序 + 若 SDK jsonl 有 timestamp 则用那边。

## 产出

写到：`docs/dev/core-loop/AUDIT-packaged-latest-run-timer-FINDINGS.md`

结构：

- 会话 id / 路径 / 时间 / 是否打包目录
- 结论（一句话）
- 证据表（assistant 数、tool_use 轮数、gap 分布、有无子代理）
- 最长 8 个工具等待
- 与 SPEC 根因是否吻合
- 本轮不做：改产品代码、手测 GUI

## 返回给我（stdout）

文件路径 + 结论一句话 + 最大 gap + 有无子代理。
