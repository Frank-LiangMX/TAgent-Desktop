# 实现 brief · MoA 续作（kscc glm-5.2 · 接 mimo 半成品）

> **执行者**：`kscc -p --model glm-5.2 --dangerously-skip-permissions`  
> **原因**：mimo MiniMax-M3 额度耗尽（`$0`），停在 T2 `runMoaTurn` 之前  
> **规格**：[`01-MOA-PRODUCT-SPEC.md`](./01-MOA-PRODUCT-SPEC.md) + 原 [`IMPLEMENT-brief.md`](./IMPLEMENT-brief.md)  
> **交卷**：[`IMPLEMENT-FIX-NOTES.md`](./IMPLEMENT-FIX-NOTES.md)

---

## 已有（勿重做、可修）

| 件 | 路径 |
|---|---|
| 类型/helpers/seed | `packages/shared/src/types/moa-preset.ts` + `.test.ts` |
| 导出 | `packages/shared/src/types/index.ts` |
| 圆桌 panel 类型 | `packages/shared/src/types/tagent-message.ts`（`MoARoundtablePanel`） |
| SendMessageInput 字段？ | `packages/shared/src/types/agent.ts`（核对其是否必要） |
| 预置服务 | `apps/electron/src/main/lib/agent/moa-preset-service.ts` |
| 路径 | `config-paths.ts` `getMoaPresetsPath` |
| IPC list | `session-service` ~687 + `preload` `listMoaPresets` |

先 `git diff` / 读上述文件，确认编译通过后再加新代码。

---

## 尚未做（本包必须完成）

1. **`runMoaTurn`**（新模块）+ `session-service.sendMessage` 分支：`isMoaModelId` → 走 MoA，**禁止** `setModel('moa:…')` / 把 `moa:*` 传给 kscc  
2. 增强 `moa-orchestrator`：进度回调 / AbortSignal（按需）  
3. **ModelSelector**：会诊分组 + 隐藏 ReasoningSlider  
4. **MoaRoundtableCard** 挂主时间线 + 席位详情  
5. CTA：复制；建看板尽量接通（缺口写 FIX-NOTES）  
6. 单测补：session 分支不 setModel moa、卡状态机（若适合纯函数）  
7. `bun run typecheck`（`ConciseTimelineView durationSec` 若为**既有**无关错误可记入 FIX-NOTES，勿大范围清债）  
8. 写 FIX-NOTES

---

## 禁止

- 重写已有 moa-preset 类型（除非有 bug）  
- commit / push  
- 改 hermes-studio / ACP 线  

---

## 验收

同 `IMPLEMENT-brief.md` 验收清单；返回先 5 行摘要 + FIX-NOTES 路径。
