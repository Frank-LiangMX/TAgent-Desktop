# UX FIX 笔记 — 最终正文层级对齐 Cursor（编号 + 标题另起 + 正文缩进）

> 日期：2026-08-07  
> Brief：`docs/dev/core-loop/UX-final-answer-hierarchy-brief.md`  
> 派工：本机 `kscc -p --dangerously-skip-permissions`  
> 交叉：与并行 REGRESS-G（`REGRESS-G-implement-brief.md`）同改 `output-style-prompt.ts` / `execution-mode-prompt.ts` / `CURSOR-CONCISE.md`，已按两 brief「合并窄口、勿互覆盖」要求合并，未回退 G。  
> **未 commit / push**（brief「不做」明令）。

---

## 0. 结论

改 4 个文件、3 类改动；prompt 测 15/15 绿；`@tagent/shared` / `@tagent/electron` / `@tagent/ui` typecheck 全绿。最终正文「乱」的主因（prompt 笼统禁清单 → 模型把多点糊成 `**标题**：整段`）已在 prompt 层修掉，渲染层仅做最小透气微调。

---

## 1. 改了什么

### A. 输出风格 prompt（主）— `packages/shared/src/utils/output-style-prompt.ts`

- **收窄「禁止 Markdown 大清单」**：原「禁止表演全面 … Markdown 大清单/表格/mermaid」→ 改为「**禁止表演式超长清单**」，并显式注明「禁的是表演式超长清单，不是有序层级本身」。有序编号不再被笼统禁。
- **新增「多点并列用有序编号」**条款 + 3 条缩进子项（prompt 本身即示范该结构）：
  - 多条并列结论 / 对照 / 步骤 → 必须 `1. 2. 3.` 有序列表，不要挤进一段散文；
  - 每条 list item 首行 = **加粗标题**（`**标题**` 或 `**标题** → **一句结论**`），标题独占首行；
  - 细则换行写在标题之后，用缩进子列表 `-` 或同 item 内换行；**禁止** `**标题**：` 后直接糊一整段正文；
  - 单点短答仍 1～3 句，不硬套编号。
- 保留：短答优先、禁注水、禁结尾复盘长清单、长度上限、工具过程几乎不提。
- **与 G 合并**：G 已先加了「**进度一句短文例外**」条款（思考后/阶段间可写一句进度短文，仍禁逐步旁白/复盘）。本改在其后追加层级条款，未删 G 的任何行；`Chat / Work` 末句合并为「进度一句短文例外、多点对照用编号层级，仍算短答」。测试依赖的 `输出风格` 标题保留。

### B. Chat/Work 短答补例外句 — `apps/electron/src/main/lib/agent/execution-mode-prompt.ts`

- Chat（`:28`）与 Work（`:57`）「短答」句末各补：「多点对照 / 多结论时用有序列表（1. 2. 3.），加粗标题独占首行、细则换行缩进。」
- 与 G 已加的「思考后/阶段间可写一句进度短文，仍算短答」并存，未互覆盖。work 测试 `/Work/`、`/kanban_create_board/`、`/短答/` 三断言仍绿；chat 测试 `/Chat/`、`/EnterPlanMode/`、`/ExitPlanMode/`、`.not.toMatch(/kanban_create_board/)` 仍绿。

### C. 渲染微调（次，小）— `packages/ui/src/components/message/index.tsx:433`

- `prose-li:my-1` → `prose-li:my-1.5`（条目间距 ~4px → ~6px，略增，让编号列表 + 缩进子项更透气）。
- **未加 `pl-`**（刻意）：实测 `@tailwindcss/typography` base prose 的 `ol`/`ul` `paddingInlineStart: em(26,16)` = **1.625em**（13px 字号下 ≈21px），嵌套列表（`ul ul, ul ol, ol ul, ol ol`）再各加 1.625em → 嵌套缩进本就可见且会叠加。故 brief 的「保证可见缩进」**默认即满足**；额外加固定 `pl-*` 反而可能触发 logical（`padding-inline-start`）与 physical（`padding-left`）属性相互覆盖的副作用，得不偿失。此判断已写入行内注释。
- **未碰** chip / 行内 code 灰底 / 标题字号（brief「不要大改 chip / 行内 code」，且 FINDINGS 的标题层次弱属另一轮范围）。

### D. 验收文档 — `docs/dev/core-loop/CURSOR-CONCISE.md`

- §3 验收新增第 9 条「**多点 final 层级**」：多点须 `1. 2. 3.` + 加粗标题独占首行 + 细则换行缩进子列表 `-` + 禁 `**标题**：` 糊一整段；单点短答仍 1～3 句。注明与 `output-style-prompt.ts` 对齐。
- G 已把「期望模型吐一句；无 text 时不编造」写入 §3 第 4 条 —— 该条属 G，未动。

---

## 2. 与 REGRESS-G 的合并细节（防互覆盖）

两 brief 同时派工改同一组文件，发生实时竞态：本 agent 首次 Edit `output-style-prompt.ts` / `execution-mode-prompt.ts` / `CURSOR-CONCISE.md` 时均遇「File has been modified since read」（G 正在并发改）。处理：

1. 重读 G 改后版本，确认 G 已落「一句进度短文」窄口；
2. 改为**追加式**最小 Edit（只在本轮目标子串后补层级条款，old_string 取 G 版本里的独有短句），不回退 G 的任何行；
3. `output-style-prompt.ts` 最终态：G 的「禁止注水」「进度一句短文例外」在前，本轮「多点并列用有序编号 + 子项」「禁止表演式超长清单」在后，`Chat / Work` 末句两窄口并存 —— 无重复、无冲突。

G 的落盘闸口改动（`session-service.ts` / `kscc-message-adapter.ts` + 单测）属 G，本轮未触及。

---

## 3. 测试 / 校验

| 项 | 命令 | 结果 |
|----|------|------|
| prompt 单测 | `bunx vitest run packages/shared/src/utils/rich-output-validate.test.ts apps/electron/src/main/lib/agent/execution-mode-prompt.test.ts` | **2 files / 15 tests 全绿**（含 `buildOutputStylePrompt().toContain('输出风格')`、work `/短答/`） |
| typecheck | `bun run --filter='@tagent/shared' --filter='@tagent/electron' --filter='@tagent/ui' typecheck` | **三包全 exit 0** |

> 注：本机 Git bash 沙箱 fork 偶发失败（见 memory `windows-git-bash-sandbox-fork`），命令均以 `dangerouslyDisableSandbox` 跑；fork 报错非命令失败，重试即过。

---

## 4. 手测说明（交付后请验）

1. 起一个新会话（concise / full 均可，两者共用 `MessageResponse` 渲染器）。
2. 问一个**多点对照**题，例如：「对比 TAgent 与 Cursor 在最终正文排版上的三点差异」或「这次改动有哪几处？」。
3. 期望模型吐出：
   ```markdown
   1. **标题A** → **一句结论**
      - 细则 1
      - 细则 2
   2. **标题B**
      - …
   ```
   即 `1.` 有序列表 + 加粗标题独占该 item 首行 + 细则换行缩进子列表，而非 `**标题**：一大段挤一行`。
4. 观感：列表条目间距略增（~6px），嵌套子项在父项下可见缩进。
5. 单点短答题仍应是 1～3 句，不应被硬套成编号清单（防过矫）。

若实测模型仍把多点糊成一段 → 说明 prompt 边界不够，再考虑运行时后处理（brief「不做」项，需先证伪 prompt 不够）。

---

## 5. 未做（与 brief「不做」一致）

- 未写运行时「把 `**x**：` 正则拆成标题」后处理（优先 prompt，且本轮 prompt 已显式约定结构）。
- 未碰 AskUserQuestion（H）、未碰 chip / 行内 code / 标题字号。
- 未 commit / push。
- 未动 G 的落盘闸口代码与单测。
