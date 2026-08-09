# Brief · 新会话首条直接会诊异常

> `kscc -p --model glm-5.2 --dangerously-skip-permissions`  
> 只读摸底优先；若根因清晰且补丁小可直接修 + 单测。

## 现象

用户：新会话**直接进会诊**（首条就 ▾ 会诊本条）好像有问题。

## 查什么

1. `~/.tagent-dev`（或 `.tagent`）里**最新**会话：`agent-sessions.json` → 对应 `projects/.../*.messages.jsonl`  
   - 是否有 `moa-agg` / 圆桌相关  
   - 首条 user 后 outcome：error？空结论？无卡？modelId 粘成 moa？  
2. 代码路径「首条 + one-shot」：  
   - `Chat.tsx` `sendConsult` / `sendQueued`（草稿会话尚无 sessionId？）  
   - `session-service` `handleSend` one-shot / `runMoATurn`  
   - `decideMoaMetaPatch` / 新建会话 meta  
   - `buildHistoryForTurn` 空历史是否误伤  
   - `resolveConsultPresetsForChannel` 合成预置 id 能否命中 dispatch  
3. 对照：同渠已有历史再会诊是否正常（从落盘推断）。

## 产出

写 `docs/dev/moa-roundtable/AUDIT-fresh-session-consult-FINDINGS.md`：

- 一句话结论 + 根因  
- 证据（会话 id / 关键行 / 代码点）  
- 若可修：打补丁 + 单测；更新 FIX-NOTES 短节  
- 若需产品拍板：列选项，勿大改

禁止跨渠混席大改、勿 commit。
