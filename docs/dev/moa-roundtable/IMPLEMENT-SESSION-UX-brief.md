# 实现 brief · MoA Session UX（历史 + one-shot + 文案）

> **执行顺序**：先 `mimo run -m aicode/MiniMax-M3 --dangerously-skip-permissions`；额度不足再 `kscc -p --model glm-5.2 --dangerously-skip-permissions`  
> **规格**：[`02-SESSION-UX-SPEC.md`](./02-SESSION-UX-SPEC.md)（必读）+ 既有 `run-moa-turn.ts` / `moa-orchestrator.ts` / ModelSelector / Chat  
> **交卷**：更新 [`IMPLEMENT-FIX-NOTES.md`](./IMPLEMENT-FIX-NOTES.md) 追加「Session UX」节，或写 `SESSION-UX-FIX-NOTES.md`

---

## 必须完成

### A. 历史注入

1. 纯函数（建议 `packages/shared` 或 `apps/electron/.../moa-history.ts`）：从面板消息列表拼 `historyText`，字符预算 12000，单测截断。
2. `runMoaTurn`：读面板历史 → 拼议题 → 传给 `runReferenceModels` / `runAggregatorModel`。
3. `moa-orchestrator`：支持 optional history（扩展 prompt，兼容旧调用）。

### B. One-shot

1. `SendMessageInput` + preload 类型：`moaOneShotPresetId?: string`。
2. `session-service.handleSend`：若有 one-shot preset → `runMoATurn`，**禁止** `updateSessionMeta({ modelId: 'moa:…' })`；tab/meta 保持真实模型。
3. Chat UI：发送旁「会诊 ▾」菜单（`listMoaPresets`），选预置后发送带 `moaOneShotPresetId`；空输入禁用。

### C. 粘性文案

- ModelSelector：分组名「会诊模式」+ 说明「之后每条都会多模型会诊」。
- 圆桌卡进行中：体现「带本会话上下文」；避免「讨论中」。

### D. 测试 + FIX-NOTES

- 历史拼装单测；dispatch/one-shot「不写 sticky moa」单测（纯函数或 mock）。
- 跑相关 vitest；typecheck 既有 ConciseTimelineView 债可记不修。
- 不 commit。

---

## 禁止

改 plan 文件；新会话实体；设置页 CRUD（可 FIX-NOTES 标明下轮）；hermes-studio。

---

## 返回

5 行摘要 + FIX-NOTES 路径。
