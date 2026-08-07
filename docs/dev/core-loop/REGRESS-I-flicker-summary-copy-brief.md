# 摸底 Brief — 思考闪烁 + 阶段总结过长 + 运行中复制按钮

> 用户原话：中间阶段思考直接消失，过一会又出现，面板不停闪；中间阶段思考总结是大长段好几句，Cursor 更短；运行中就一直显示复制按钮，应完成时才显示。  
> 派工：本机 `kscc -p --dangerously-skip-permissions`  
> **只读摸底 → FINDINGS**；根因明确可最小修。不 commit。

## 必答（path:line）

### A. 中间思考闪没又出现（面板闪）

1. 数据层：同一段 thinking 是否被删再插（uuid upsert、tool_start 清 stream、rAF、preserveAssistantThinking）？
2. UI 层：`ThinkingFold` / `ThinkingActivityRow` / work_stage 是否因 key 变化整段 remount？settle/`isLive` 抖动导致开合闪？
3. concise：中段思考进 `work_stage.steps` 与升独立 fold 之间是否来回切换？
4. 与 REGRESS-F/D/E 已修点关系：是回退、漏网，还是新路径（如 progress narrative 插入导致列表重排）？

### B. 阶段思考总结过长

1. 「思考了 Ns」灰字头 vs 展开正文 vs step 行摘要：用户说的「大长段」是哪一层？
2. Cursor 短摘要对照：我们是否把全文/多句塞进 summary/step label？
3. 最小修：截断阈值 / 只用首句 / 固定「思考了 Ns」不展示长文在收起态。

### C. 复制按钮运行中显示

1. 复制按钮挂在哪（turn / answer / narrative / process）？
2. 显隐条件是否缺 `!isLive` / `turn complete`？
3. 期望：整轮 running 不显示；`result`/`turn_end` 后再显示。

## 交付

`docs/dev/core-loop/REGRESS-I-flicker-copy-brief-FINDINGS.md`（或分 A/B/C 节）+ 最小修建议。可同轮最小修若互不踩。stdout 中文结论。
