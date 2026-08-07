# 回归残留规格 — 思考闪没 / 阶段总结不落盘 / Chat 问答无选项

> 日期：2026-08-07（白天续验）  
> 角色：总监规格。子代理只读摸底 → FINDINGS；定位后按 brief 最小修。  
> 前置：昨夜 `369d6f7` 已合 REGRESS A–E；交接写明**实机未验完**，用户今日反馈仍坏。

---

## 1. 症状（用户原话对照）

### F. 思考块有时仍立刻消失

- 昨夜 D（settle 折叠）+ E（segment 留存）已修代码+单测。
- **实机**：有时思考块仍「立刻消失」（非 settle 过渡后折成「思考了 Ns」）。

**期望：** live 思考结束后至少 settle → 灰字「思考了 Ns」常驻；不得瞬间从 DOM/数据删光。

### G. 思考段间无阶段性总结落盘/可见

- 学 Cursor：`思考 → 进度短文 → 工具/阶段 → 进度短文 → …`
- **最新会话**：每一段思考片段后**没有**落盘/显示阶段性总结（与 REGRESS-B「progress live」相邻；可能 B 未实机过，或新路径又憋住）。

**期望：** 段间 progress 文本 live 可见，且回合结束后中间 progress 仍在 timeline（不丢）。

### H. Chat 模式「让我选择」但无选项弹出，随后说没选

- Chat 会话里模型走交互问答（高度疑似 `AskUserQuestion`），提示用户选择。
- **实际无选项 UI**；随后模型/系统当「用户未选择」处理 → 子代理/本轮失败体感。

**期望：** Chat 下 `AskUserQuestion` 必须弹出选项卡/面板；用户未点之前不得当拒绝/超时空答糊给模型；拒绝/超时须中文可理解错误，不得静默「没选」。

---

## 2. 已知线索（勿空转）

| ID | 线索 | 路径 |
|----|------|------|
| F1 | E 根因：tool_start 曾整表 reset；upsert 剥 thinking；无 `_partial` | `REGRESS-E-FINDINGS.md` |
| F2 | D 改的是 fold 动画/`isLastSegment`，救不了 segment 被删 | `REGRESS-D-FINDINGS.md` |
| G1 | B：progress live + partial 透传 | `REGRESS-B-FINDINGS.md` |
| G2 | concise：`narrative.tone=progress` 条件 `i < lastToolIdx \|\| isLive` | `concise-timeline-model.ts` |
| H1 | AskUserQuestion Chat 不硬拦 | `permission-rules.ts` |
| H2 | 事件：`ask_user_request` / `ask_user_resolved` | `packages/shared/src/types/agent.ts` |
| H3 | canUseTool 注释：AskUserQuestion 拦截并展示交互 UI | `permission-rules.ts` ~23 |

---

## 3. 本轮不做

- 不删 Chat 硬拦、不自动切 Work
- 不升 AgentSession / 不搬 Proma
- 不擅自 commit / push
- **禁止** Cursor Task/explore；只用本机 `kscc -p --dangerously-skip-permissions`

---

## 4. 派工

| Agent | Brief | 产出 |
|-------|-------|------|
| F 思考闪没残留 | `REGRESS-F-thinking-vanish-residual-brief.md` | FINDINGS + 是否需再修 |
| G 阶段总结 | `REGRESS-G-stage-summary-persist-brief.md` | FINDINGS + 最小修建议 |
| H Chat 问答无选项 | `REGRESS-H-ask-user-no-options-brief.md` | FINDINGS + 最小修建议 |

交叉：F/G 都碰 timeline 时先写 FINDINGS，总监裁定后再改，避免互踩。
