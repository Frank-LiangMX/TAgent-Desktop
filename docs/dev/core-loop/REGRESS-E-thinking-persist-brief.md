# REGRESS-E Brief — 思考链结束后从时间线彻底消失（含最后一段）

> 用户截图：整轮结束后只有「运行了 N 条命令」+ 最终正文，**没有任何「思考了 Ns」灰字头**；live 时有思考，一结束闪没。  
> 派工：本机 `kscc -p --dangerously-skip-permissions`

## 现象

1. live 能看到思考展开输出；结束后（甚至最后一段）**时间线上没有思考折叠**。
2. 过程区几乎只剩 shell「运行了 N 条命令」，探索/思考像被吃掉。
3. REGRESS-D 的 settle/滚动对「segment 被删光」无效——修的是折叠动画，不是数据留存。

## 根因假设（须取证后修，优先验证）

### H1 — `_partial` 从未被打上（用户会话里 agent 已坐实方向）

- `includePartialMessages:true`，但 `claude-agent-adapter` **从不**写 `_partial`。
- `kscc-message-adapter` 只读 `m._partial === true` → `isPartial` 恒 false。
- 后果：中间 assistant 快照被当 final；`shouldClearStreamThinking` / S2.2 过早切真源；思考只活在 `streamState`，随后被清。

**修复方向：** 在 `sdkMessageToIR`（或 adapter yield 前）对 assistant：**无 `message.stop_reason` ⇒ 标 `_partial: true`**（与 Claude 终态带 stop_reason 的惯例对齐）。有 stop_reason（含 `tool_use`）⇒ final。单测锁死。

### H2 — `shouldClearStreamThinking` 仅因 `stop_reason` 就清空

`stream-item-model.ts`：`if (msg.stop_reason) return true` —— 即使 content **没有** thinking 块也会清 `streamState.thinking`。  
若 kscc final 消息剥掉 thinking（只留 tool_use/text），则 **stream 缓冲被扔掉且 process 无思考** → 闪没。

**修复方向：** 仅当 content 已有非空 thinking 时才清 stream thinking；`stop_reason` 但无 thinking 时**保留** streamState.thinking，由 `buildTurnPresentation` 并入 process（已有 stream-thinking 合并路径）。回合真正 `result`/`turn_end` 再全清。

### H3 — 中段思考埋进 stageSteps，折叠后看不见

REGRESS-C：非可交付中段思考进 `work_stage.steps`，折叠摘要只有「运行了 N 条命令」→ 用户以为「没思考」。  

**修复方向（产品）：**  
- **leading / 独立 ThinkingFold 必须在整轮结束后仍在 processSegs**（灰字「思考了 Ns」，可点开）。  
- 阶段内思考：折叠摘要可带「· 含思考」或保持独立 ThinkingFold（优先：凡曾 live 展开过的思考，结束后至少留一条 ThinkingFold，不丢）。  
最小改：保证 H1+H2 后 leading fold 常驻；阶段内思考若仍不可见，摘要补「含思考」或中段非 trivial 一律升独立 fold（可与 REGRESS-C 微调：仅 trivial 进 steps，其余升 fold——但勿恢复「思考了 1s」刷屏；用 isDeliverable OR length/duration 阈值）。

## 必做

1. 验证 H1/H2（读现网 adapter + stream-item-model + 必要时对照落盘 jsonl）。写 `REGRESS-E-FINDINGS.md`。
2. 落地 H1 + H2 最小修复 + vitest。
3. 保证结束后 timeline 至少有一条 `kind:'thinking'`（有过思考的回合）；手测/单测：`thinking deltas → tool final(无 thinking 块) → process/segments 仍含思考`。
4. 不回退 REGRESS-D settle；不碰 permission；不 commit。

## 主要文件

- `packages/shared/src/utils/kscc-message-adapter.ts`（+ test）
- `apps/electron/src/main/lib/adapters/claude/claude-agent-adapter.ts`（若需在 yield 处打标）
- `apps/electron/src/renderer/components/chat/stream-item-model.ts`（+ test）
- `session-turn-model.ts` / `concise-timeline-model.ts`（若需保证 fold 常驻）
- `Chat.tsx`（仅当清理时机仍错）

## 验收

1. vitest：无 stop_reason 的 assistant → IR `_partial:true`；有 stop_reason → 无 `_partial`。
2. vitest：stream 有 thinking → sdk_message assistant(stop_reason=tool_use, content 仅 tool_use) → streamState.thinking **仍在**或 process 已含同文思考。
3. vitest：上述后 `buildConciseTimeline` 含 `kind:'thinking'`。
4. 相关包 typecheck 绿。

## 交付

FINDINGS + 改动列表 + 测试摘要 + 手测（concise：长思考→工具→结束，必须留下「思考了 Ns」）。
