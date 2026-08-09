# FINDINGS · 审计最新 TAgent 会话（MoA / 会诊）

> 只读审计，**未改任何应用代码**。仅读 `~/.tagent-dev` 落盘 + 写本 findings 文件。
> 审计人：kscc (glm-5.2) · 2026-08-08

## 0. 应返回摘要

| 项 | 值 |
|---|---|
| 会话 id | `session-1786163012352` |
| 是否含会诊 | **含会诊痕迹，但异常**：MoA 圆桌聚合席在两个**普通轮**（turn 8 / 9）误触发；用户**显式**请求会诊的 turn 10 **未走** MoA 运行时（主 agent 用通用 `Agent` 工具手搓 3 席） |
| meta.modelId | `glm-5.2`（会话级 + 仅有的 2 条逐消息 `_channelModelId` 均为 glm-5.2；**未粘成** `moa:<preset>`） |
| phase | **无** —— 全文件 524 行无任何 `phase` 字段；MoA 聚合席记录仅有 `stop_reason:"end_turn"`，无 `running/aggregating/completed/cancelled/error` |
| 一句话结论 | **有问题**：MoA 圆桌在两个普通轮误触发并产出**无上下文**的聚合回复（历史未注入），落盘为缺 `message.role` 的非标准 shape，且无面板/席位/phase 落盘、turn 9 缺 turn_end；而真正请求会诊的轮次反被手搓子席绕开。 |

## 1. 会话 id / 路径 / 时间

- **id**：`session-1786163012352`，标题「你好」，`mode: general` / `executionMode: work` / `permissionMode: bypassPermissions` / `status: idle`
- **索引**：`C:\Users\loumi\.tagent-dev\agent-sessions.json`（`updatedAt: 1786176876606`，为全索引最大值 → 确认为最新会话；下一新者无）
- **消息**：`C:\Users\loumi\.tagent-dev\projects\C--Users-loumi-Desktop-AI-TAgent-Desktop\session-1786163012352.messages.jsonl`（524 行 / 1.91MB）
- **SDK jsonl**：同目录 `session-1786163012352.jsonl` —— 与 `messages.jsonl` **逐字节相同**（同一份双写，无独立差异）
- **时间**：`createdAt: 1786163017238`（≈ 2026-08-08T08:14Z）→ `updatedAt: 1786176876606`（≈ 2026-08-08T12:05Z，跨度 ~3h51m）
- **预置**：`C:\Users\loumi\.tagent-dev\moa-presets.json`（`default` / `cheap` 两个 preset，**aggregator 均为 `glm-5.2`**）

## 2. 证据表

| 维度 | 观测 | 判定 |
|---|---|---|
| modelId（会话级） | `glm-5.2` | ✓ 真实模型 |
| modelId（逐消息 `_channelModelId`） | 仅 L265、L267 两条带，值均 `glm-5.2`；其余 522 条无此字段 | ✓ 未粘 `moa:*` |
| 总记录 / 角色 | 524 行 = user 214 / assistant 310；tool_use 199 ≈ tool_result 199 | ✓ 配对平衡 |
| 真人 user 文本轮次 | 10 条（L1/4/73/168/171/174/261/264/266/268） | 与索引 `turnCount:10` 一致 ✓ |
| turnDurations | 9 条（**turn 9 缺失**） | ⚠ 10 ≠ 9 |
| 含 MoA | 是：L265/L267 `uuid` = `moa-agg-moa-rt-session-1786163012352-{0,1}` | — |
| MoA 面板（`MoARoundtableCard` / `moa_roundtable`） | 无面板 jsonl 文件、无对应 content type | ✗ 未落盘 |
| phase | 全文无 `phase` 字段 | ✗ 缺失 |
| roundtableId | 无独立字段（uuid 内嵌 `moa-rt-session-<sid>`，两轮共用同一基） | ✗ |
| 聚合席正文落盘 | L265、L267 文本已落盘 | ✓ 但无上下文 |
| 参考席落盘 | 无任何 `moa-ref` / `seat` 记录（presets 定义了 架构师/实战派、省并发甲/乙） | ✗ 未落盘 |
| 席位状态 | 无 | ✗ |
| 历史注入（弱证据） | L524 聚合正文引用前文（ACP / SDK 0.3.185 / context usage）✓；但 L265/L267 MoA 聚合回复**完全无上下文** | ✗ MoA 路径历史未注入 |
| 终态 | 会话 `status:"idle"`；turnDurations 全部 `endedBy:"complete"` | ✓ 未卡 running |
| 空 assistant | 0 | ✓ |
| 异常文案 | L265/L267 上下文错答 | ✗ |

## 3. 异常详述

### A. MoA 圆桌在普通轮误触发（最关键）
- L264 用户「看看呢」(turn 8) → L265 助手回复，`uuid: moa-agg-moa-rt-session-1786163012352-0`
- L266 用户「给我改造是否值得的分析结论」(turn 9) → L267 助手回复，`uuid: moa-agg-moa-rt-session-1786163012352-1`
- 两条都不是会诊请求，却走了 MoA 圆桌**聚合席**（`moa-agg-moa-rt-`）。
- 而真正请求会诊的 L268「你帮我会诊看看」(turn 10) → L269/L270 是**标准流式**记录（有 `message.role:"assistant"`、`thinking`、`id`、`session_id`），主 agent 随后用通用 `Agent` 工具手搓红队/中道/守方三席（L271 / L294 / L336，`subagent_type` = `analyst` / `code-reviewer`），最后 L524 自行聚合。**MoA 运行时被绕开。**
- 即：MoA 在"不该会诊"的轮次误触发，在"该会诊"的轮次反被绕开 —— 判定与意图**反向**。

### B. MoA 聚合席历史未注入（上下文丢失）
- L265："您好！您说'看看呢'，但我不太确定您想看什么内容…" —— 全程在讨论 ACP，"看看呢"显指"去看 resume 路径"，但聚合席完全无上下文。
- L267："很遗憾，您目前未提供任何改造项目的具体信息，我无法直接给出结论" —— 整个会话就是 ACP 改造讨论，却答复"未提供信息"。
- 结论：MoA 聚合席调用**未注入会话历史**。与验收 #4（弱证据）相反，此处为**强证据**的历史丢失。

### C. 非标准落盘 shape
- L265/L267 的 `message` 仅有 `{content, stop_reason, model}`，**缺 `role`**（全文 310 条 assistant 中仅此 2 条无 `message.role`），且**缺** SDK 信封（`id` / `type:"message"` / `usage` / `session_id`），仅多一个 `_channelModelId`。
- 渲染端若按 `message.role` 取值，可能误渲染或丢失这 2 条（即验收 #2 的"残缺"风险点，但当前未空、未卡 running）。

### D. 无面板 / 席位 / phase 落盘
- 会话目录下**无** `*.panels.jsonl` 或任何面板/圆桌文件（仅 `messages.jsonl` 与 `jsonl` 两份，且相同）。
- 全文无 `phase`、无 `roundtableId`、无参考席（`moa-ref` / `seat`）记录。
- 即 MoA 圆桌卡（`MoaRoundtableCard`）、席位状态、phase 状态机**均未落盘** —— UI 无卡可显，验收 #3 的"面板 / phase 终态 / 席位状态"全部缺失。

### E. turn_end 缺失
- `turnCount:10` 但 `turnDurations` 仅 9 条；缺的是 **turn 9**（L267 `createdAt: 1786172224572` 无对应 key）。turn 8（`1786172049108`, 10132ms, complete）有记录。
- 同一条 MoA 路径，turn_end **时有时无** → 落盘 / 事件闭合不一致（验收 #5 的"turn_end 缺失迹象"命中）。

## 4. 根因假设（不改代码，仅假设）

1. **误触发（反向判定）**：`moa-dispatch.ts` 的"是否走会诊"判定在 turn 8/9 把普通轮判成了会诊（可能 UI consult 开关被开 / channel 配置 / 关键词误命中），而 turn 10 显式会诊反被判为普通轮 —— 判定输入与用户意图反向。
2. **历史未注入**：`runMoaTurn` 聚合席（及参考席）构造 prompt 时未拼接本会话历史，或拼了空 → glm-5.2 聚合席拿到无上下文输入。
3. **落盘 shape 不全**：聚合席只 append 了最终 text，未走 SDK 标准 message 信封（缺 `role` / `usage` / `session_id`），且未写面板 jsonl / phase / 席位 —— 与 `MoaRoundtableCard` 期望的 IR 不一致。
4. **turn_end 漏写**：MoA 路径完成时未稳定 emit turn_end（turn 9 漏），导致 `turnDurations` 与 `turnCount` 不一致。

## 5. 建议下一刀（勿直接改代码，先验证）

1. 在 `moa-dispatch.ts` 判定处加日志/单测：复现"普通轮被判会诊 / 显式会诊被判普通"的反向条件，先定位判定输入到底是 `modelId`、channel、UI toggle 还是关键词。
2. 在 `runMoaTurn` 聚合席/参考席 prompt 构造处断点确认历史 messages 是否注入；对照 `moa-orchestrator` 的 history 组装路径。
3. 对齐聚合席落盘 shape：让 `moa-agg-*` 记录补齐 `message.role` 与 SDK 信封，或改由 IR 通道统一写；并补写面板 jsonl / phase 终态 / 席位状态，使 `MoaRoundtableCard` 有数据可显。
4. 修 turn_end：MoA 路径完成时稳定 emit turn_end，使 `turnDurations` 与 `turnCount` 一致（覆盖 turn 9 这类二次 MoA 触发）。

## 6. 本轮不做

- 未做 UI 手测（未启动 Electron）。
- 未改任何产品代码（仅读 `~/.tagent-dev` 落盘 + 写本 findings 文件）。
- SDK `jsonl` 与 `messages.jsonl` 逐字节相同，未单独二次审计。
