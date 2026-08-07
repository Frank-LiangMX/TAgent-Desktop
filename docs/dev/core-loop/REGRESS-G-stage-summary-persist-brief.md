# REGRESS-G Brief — 思考段间无阶段性总结（live/落盘）

> 规格：`REGRESS-2026-08-07-RESIDUAL-SPEC.md` §G  
> 派工：本机 `kscc -p --dangerously-skip-permissions`  
> **本轮默认只读摸底**；根因明确可最小修。与 F 交叉时先 FINDINGS。

## 背景

产品契约（Cursor concise）：每段思考后应有一句**阶段性进度总结**（progress narrative），再接工具/下一阶段。  
REGRESS-B 声称 progress live 已修。用户最新会话：**每一段思考片段后仍没有阶段性总结落盘/可见**。

## 必答（带 path:line）

1. B 补丁关键路径是否仍在？（`session-turn-model` partial、`useSmoothStream`、`buildConciseTimeline` progress 条件）
2. 「阶段性总结」在 IR/落盘里对应什么？assistant text？单独 message？仅 UI 合成？
3. 思考 → text(progress) → tool 的事件序在 adapter / Chat.tsx 合并后，text 是否被：
   - 憋到 `turn_end` 才进 items
   - 被同 uuid final 覆盖丢中间 text
   - 分类成非 progress（tone 错）导致 concise 不渲染
4. 若 kscc **根本不发**段间 text（只发 thinking+tools），产品层有无合成「探索了/读了」类摘要？与用户期望「思考后落盘一句总结」差在哪？
5. 对照 `CURSOR-CONCISE.md` 验收条，标出 G 是「模型不吐 text」还是「吐了但 UI/落盘丢」。

## 交付

写 `docs/dev/core-loop/REGRESS-G-FINDINGS.md`：根因 + 与 B 关系 + 最小修建议（或不修、改产品文案）。不 commit。
