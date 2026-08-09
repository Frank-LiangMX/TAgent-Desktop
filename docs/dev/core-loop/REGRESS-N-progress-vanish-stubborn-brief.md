# REGRESS-N Brief — 阶段性总结顽固闪没：根因是「修法互撕」

> 用户 2026-08-08 截图：只剩「思考了 7s」+ 一长串「运行了 N 条命令」+ 大空白 + 最终结论；  
> **中间阶段性总结 live 可见、流完即消**；执行链被隔断成碎步骤。  
> 派工：本机 `kscc -p --dangerously-skip-permissions`（禁止 Cursor Task）

## 为什么改了三天还顽固（先读再改）

不是单一 bug，是 **REGRESS B / J / M 目标互相打架**：

| 批次 | 意图 | 副作用 |
|------|------|--------|
| B | live 段间 progress 可见 | 每条 text `flushStage` → 碎成「运行了 1 条命令」 |
| J | idle 丢掉 `isShortProgressText` 以合并 stage | **idle 把阶段性总结直接 `continue` 扔掉** ← 用户今天骂的「流完即消」 |
| M | `tool_start` commit text 防秒消 | commit 进 items 后，idle 投影仍被 J 丢掉 → 看起来「M 没生效」 |
| C/J3 | 中段思考埋进 `stage.steps` | 折叠后只见「运行了 N 条命令」，思考像没了 |

截图同时有：**碎 stage（J 合并失败或分隔符非 short）** + **总结消失（J 故意丢）** + **大空白（疑似空 narrative / 被吃掉的进度占位）**。

## 产品裁决（覆盖 J1 idle-drop）

对齐 Cursor：

```
思考了 Ns（可点开）
进度短文（深色，常驻）
探索了/运行了…（灰字阶段）
进度短文
…
最终正文
```

1. **禁止** idle 为合并阶段而删除用户可见的段间 progress（撤销/改写 `isShortIdleProgress → continue`）。
2. 合并阶段：只对 **纯 filler**（如「好的」「嗯」级 `isTrivialThinking` 同类极短无信息）可吞；**有信息的进度句必须常驻**为 `narrative.progress`。
3. 中段有分量的思考：idle 后至少有一条可点的「思考了 Ns」灰字（不要只埋在折叠 stage 里看不见）。
4. live 打字机 + idle 常驻同一套 segments 语义（禁止 live 一套、idle 把总结删光）。

## 必须回答（FINDINGS，带行号）

1. 用户截图路径下，段间总结在 process 里是 `text` 还是 `thinking`？idle 后 `buildConciseTimeline(isLive=false)` 是否命中 `isShortIdleProgress` 被 `continue`？
2. 为何碎成多个「运行了 N 条命令」——分隔符是长 progress / 独立 thinking fold / 别的？
3. 大空白 DOM 来自哪个 segment/CSS？
4. `commitStreamTextToLastAssistant` 是否把 text 插到正确位置？随后是否被 J 或 dedupe 吃掉？

可对照本机最近会话 jsonl（`~/.tagent/**/*.jsonl` 或 Electron userData）；没有则用合成序列复现：  
`think → tool → text(短进度) → tool → text(短进度) → tool → text(长结论)`，断言 live 与 idle 都含 progress narrative。

## 必改

1. `concise-timeline-model.ts`：改写 J1——**不得**再 `continue` 丢掉有信息的段间 progress；另写「仅 filler 可跳过」规则；补/改 vitest（idle 仍见 progress；filler 不拆 stage）。
2. 中段思考可见性：折叠 stage 摘要带「· 含思考」**或**非 filler 中段思考升独立 ThinkingFold（勿恢复「思考了 1s」刷屏——用时长/长度阈值）。
3. 查清空白：NarrativeRow / CSS；无内容勿占位。
4. 更新 `HANDOFF-2026-08-07.md` 或新建 `HANDOFF-2026-08-08.md` 写明「J1 idle-drop 已否决」。
5. 不 commit（除非用户另说）；避开无关 MoA 工作树改动。

## 验收

1. vitest：上述合成序列 `isLive:false` 时 segments 含 ≥2 个 `narrative.tone=progress`（短有信息句不被丢）。
2. vitest：仅 filler「好的」夹在两 Bash 之间 → idle 可合并为一个 work_stage（或不增加多余 narrative）。
3. 手测步骤写进 FINDINGS：concise 长任务结束后，进度短文与「思考了 Ns」仍在，不是只剩碎命令行。

## 主要文件

- `concise-timeline-model.ts` / `*.vitest.test.ts`
- `ConciseTimelineView.tsx` / `chat.css`（空白）
- `stream-item-model.ts`（commit text，只读确认）
- `Chat.tsx` tool_start（只读确认）
- `docs/dev/core-loop/REGRESS-J-FINDINGS.md`（注明被 N 否决的条款）

## 交付

`REGRESS-N-FINDINGS.md` + 代码 + vitest 绿 + stdout 手测步骤。
