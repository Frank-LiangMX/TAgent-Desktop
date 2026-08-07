# REGRESS-G 实现 Brief — 松绑一句进度短文 + 段间 text 落盘

> 日期：2026-08-07  
> 规格：`REGRESS-2026-08-07-RESIDUAL-SPEC.md` §G  
> 用户裁定：**方案 B — 松绑 prompt，允许思考后写一句短文（兑现 Cursor 契约）**  
> 交叉：`REGRESS-G-FINDINGS.md` 修正稿 —— 仅松绑不够，`stop_reason==null ⇒ _partial` 会把独立 text 消息挡在落盘闸口外。  
> 派工：本机 `kscc -p --dangerously-skip-permissions`

---

## 目标

1. **Prompt**：允许「思考结束后写**一句**进度短文」，仍禁止逐步旁白每步工具 / 结尾复盘清单。
2. **落盘**：独立 assistant `text` 消息（含段间进度短文）必须进 panel JSONL；重开历史轮仍可见 `narrative.progress`。
3. **不回退 E**：真流式 partial 快照仍不落盘堆积；思考留存补丁保留。

---

## 改动 1 — 松绑输出风格（用户已拍板）

文件：`packages/shared/src/utils/output-style-prompt.ts`

在禁止注水条款旁加**窄口**（中英均可，与现有文风一致），语义须等价于：

- ✅ 允许：思考后 / 工具阶段之间写 **一句** 进度短文（例：「先摸清目录结构。」「摸清了，开始改权限。」）
- ❌ 仍禁止：逐步旁白每一步工具、长篇过程复述、结尾复盘清单、表演式全面

**并与 `UX-final-answer-hierarchy-brief.md` 合并**（并行 agent 可能已改同一文件）：多点对照须 `1. 2. 3.`；加粗为标题单独一行；细则换行缩进；禁止 `**标题**：糊一大段`。收窄「禁止 Markdown 大清单」——禁的是表演式超长清单，不是有序层级。

同步检查 `execution-mode-prompt.ts` Chat/Work「短答」是否与窄口/层级打架；若会压死，加例外句。

更新 `docs/dev/core-loop/CURSOR-CONCISE.md`：§3.4 / 相关条写明「期望模型吐一句；禁止编造」与 prompt 对齐。

---

## 改动 2 — 落盘闸口（FINDINGS 结构性 bug，必须同轮）

根因：`kscc-message-adapter.ts` `isPartial = m._partial===true || stopReason==null`；kscc/glm 常对**独立** text/thinking/tool 消息也发 `stop_reason:null` → 全部标 `_partial` → `session-service.ts` 跳过 `appendPanelMessages` → 段间短文不落盘。

**最小修（优先选更安全的一种，写清理由）：**

推荐方向（勿简单删掉整个 `_partial` 推断导致 E 回退）：

- **落盘闸口**（`session-service.ts` handleSdkStreamMessage）：对 assistant，若 `content` 含**非空 text**，**允许落盘**（即使 IR 带 `_partial`）；仍跳过「仅 thinking / 仅空 / 纯 tool_use 流式快照」的 partial 堆积。  
  **或**收紧 `sdkMessageToIR` 的推断：仅当 `m._partial===true` **或**（无 stop_reason **且** 同 uuid 流式替换语义可证）才标 partial；不得把「独立 uuid 的完整 text 块」标成不可落盘。

**禁止**：为省事把所有 `stop_reason:null` 一律当 final 落盘（会把真 partial 快照堆进 JSONL，回退 E/S1）。

单测必加：

1. `stop_reason:null` + content 仅非空 text → **落盘**（或 IR 不标 `_partial` / 闸口放行）  
2. 真 partial（显式 `_partial:true` 或同 uuid 流式中间态）→ **仍不落盘**  
3. 现有 `kscc-message-adapter.test.ts` / regress-b / stream-item-model E 相关用例不红

---

## 不做

- 不实现 AskUserQuestion UI（那是 H，另派）
- 不改 F（full ThinkingActivityRow settle）除非顺手零成本
- 不产品层编造假进度句
- 不 commit / push（除非用户另指令）

---

## 验收

1. vitest：改动 2 的落盘/ `_partial` 用例绿；adapter 旧测不回退。  
2. typecheck 相关包绿。  
3. 手测说明：concise 新会话 → 长思考 → 应出现一句进度短文 → 工具 → 结束后时间线仍有该短文；**重启/重开会话**仍在。  
4. 写 `docs/dev/core-loop/REGRESS-G-FIX-NOTES.md`：改了什么、测了什么、与 E 如何不互踩。

## 交付

改动文件列表 + 测试命令输出摘要 + FIX-NOTES。stdout 中文结论。
