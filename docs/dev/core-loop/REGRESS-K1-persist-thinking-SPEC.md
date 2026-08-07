# REGRESS-K1 — 思考「类正文」流完即消 + 执行块无思考行

> 日期：2026-08-07  
> 前置：`REGRESS-K-FINDINGS.md`（K1 未单点）+ 用户澄清（同会话）  
> Checkpoint：`958c83e` 之后 WIP（思考默认收起、FileChip API 路径等）

## 用户澄清（定修依据）

> 「是有类似正文的流式输出思考内容，输出完就消失。也不在执行块内有显示思考块」

- **不是**问「阶段性总结被折叠了吗」——总监已答否；用户否认该解释。
- 现象 =：**像正文一样流出来的思考内容** → **流完/回合结束就没了** → **执行/过程块里看不到思考行**（连「思考了片刻」头都没有）。

## 根因（本轮定论）

数据层 thinking→text **不成立**（K1.1）。残留是 **UI 卸载/丢弃**：

| 模式 | 机制 | 文件 |
|------|------|------|
| **full（默认）** | live 时过程组展开：`ProcessTextRow`/`ThinkingActivityRow` 用 `MessageResponse` 流式（观感≈正文）。idle 后 `planProcessGroupCollapse` → `showBody=false` → **整段 `__body` 不渲染**，思考行全部卸 DOM，只剩头栏「查看过程」 | `ProcessGroupView.tsx` ~213–267 |
| **concise** | 中段思考只在 `stage.steps`，阶段默认收起 → 执行块外看不见思考行；idle `isTrivialThinking` 直接 `continue` 丢段；≤20 字段间 text live 当 narrative 打字机、idle 丢 | `concise-timeline-model.ts` ~541–591；`WorkStageFold` 默认 `open=false` |

另：模型常在 thinking 后发**分析性 text**（会话里 thinking/text 交替）→ 用户把过程区正文流误读成「思考内容」也成立；修思考行永驻后，即使 text 进折叠过程，执行区仍应留下思考头。

## 期望

1. **full**：过程组收起后，**思考行头仍留在执行块内**（「思考了片刻 / 思考了 Ns」可点开全文）；工具/过程 text 可继续进「查看过程」。
2. **concise**：idle 不因 trivial 抹掉思考；至少保留可点开的思考头（独立 fold 或 stage 下可见思考 step 摘要）。阶段收起时，若 steps 含 thinking，摘要区或 extras 旁仍能感知「有过思考」（最少：展开可见；优选：收起态也露思考 step 头或摘要计数）。
3. 思考正文可继续默认收起（对齐 Cursor 扫光头）；**禁止**流完后思考行从执行块消失。
4. 不改 Bash fork / AskUser / 子代理 K2（正交）。

## 本轮不做

- 不把段间 text 改成 thinking 块
- 不改 output-style-prompt（可另开）
- 不 commit / 不 push

## 验收

1. 单测：full 折叠后仍暴露 thinking 条目；concise idle trivial 思考仍进 timeline（有 thinking 段或 stage step）
2. `REGRESS-K1-FIX-NOTES.md`：改动文件 + 手测（full + concise 各一轮带思考+工具）
3. 手测：live 可见思考头扫光；结束后执行块仍有「思考了…」；点开可见原文
