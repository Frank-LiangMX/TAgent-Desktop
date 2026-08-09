# Brief · 审计最新 TAgent 会话是否正常（MoA / 会诊）

> 交卷者：`kscc -p --model glm-5.2 --dangerously-skip-permissions`  
> 只读审计，**禁止改应用代码**；可写本目录下 findings 文件。

## 目标

检查用户刚测过的最新会话落盘是否健康：普通聊 +（若有）会诊 one-shot / 圆桌卡。

## 数据位置（dev）

- 索引：`C:\Users\loumi\.tagent-dev\agent-sessions.json`
- 最新会话（按 `updatedAt`）：`session-1786163012352`（标题「你好」，`modelId: glm-5.2`，`turnCount: 10`，约 2026-08-08T08:14Z）
- 消息：`C:\Users\loumi\.tagent-dev\projects\C--Users-loumi-Desktop-AI-TAgent-Desktop\session-1786163012352.messages.jsonl`
- SDK/jsonl：同目录 `session-1786163012352.jsonl`
- 预置：`C:\Users\loumi\.tagent-dev\moa-presets.json`

若发现更新的会话（`updatedAt` 更大或 jsonl mtime 更新），以更新者为准并在报告里写清 id。

## 验收清单（写进 findings）

1. **会话 meta**：`modelId` 是否仍为真实模型（`glm-5.2` 等），**不应**粘成 `moa:<preset>`（one-shot 后）。
2. **轮次结构**：user / assistant 是否成对；有无残缺 turn、空 assistant、未闭合 running。
3. **会诊痕迹**（若有）：
   - 是否出现 `moa_roundtable` / `MoARoundtablePanel` 类面板
   - `phase` 是否终态（`completed` / `cancelled` / `error`），有无卡在 `running`/`aggregating`
   - 汇总 assistant 正文是否落盘；席位状态是否合理
   - one-shot：同会话后续普通 turn 的 meta 仍非 `moa:*`
4. **历史注入迹象**（弱证据）：会诊后汇总是否引用前文话题（读 user/assistant 文本摘要即可）。
5. **异常**：重复圆桌卡、同一 `roundtableId` 多终态、明显错误文案、turn_end 缺失迹象。

## 产出

写到：`docs/dev/moa-roundtable/AUDIT-latest-session-FINDINGS.md`

结构：

- 会话 id / 路径 / 时间
- 结论：正常 / 有问题（一句话）
- 证据表（meta、turn 数、是否含 MoA、phase、modelId）
- 若异常：根因假设 + 建议下一刀（勿直接改代码）
- 本轮不做：UI 手测、改产品代码
