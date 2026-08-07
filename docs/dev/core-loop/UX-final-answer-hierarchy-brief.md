# UX Brief — 最终正文层级对齐 Cursor（编号 + 标题另起 + 正文缩进）

> 日期：2026-08-07  
> 用户纠正：乱的主因不是 chip，而是**没有编号**；行首加粗应是**标题单独一行**，实际内容**换行并缩进**（像 Cursor）。  
> 派工：本机 `kscc -p --dangerously-skip-permissions`

## 现象

TAgent 常见形态（糊成一段）：

```text
**思考结束后消失（REGRESS-E）**：这是时序问题……接着整段正文……
**正文闪一行被滚走（R2）**：……
```

Cursor 清晰形态：

```markdown
1. **思考块有时立刻消失** → **真 bug…**
   - 细则 1
   - 细则 2
2. **下一项**
   - …
```

## 根因

1. **Prompt**：`packages/shared/src/utils/output-style-prompt.ts` 写「禁止…Markdown 大清单」，模型倾向「加粗标题：正文」挤在同一段，不用 `1.` / 子列表。  
2. **渲染**：`MessageResponse` 对合法 `ol`/`ul` 能排；问题主要是**模型没吐出层级 Markdown**，不是列表 CSS 完全坏了。可顺手略增 `prose-li` / `prose-ol` 间距与缩进，让合法列表更透气。

## 必做

### A. 改输出风格 prompt（主）

`output-style-prompt.ts`：

- 保留短答、禁注水、禁结尾复盘长清单。
- **改掉/收窄**「禁止 Markdown 大清单」：改为禁止**无结构的大段散文**与**表演式超长清单**；**多点对照/多结论必须用有序编号列表**。
- 显式约定（写入 prompt）：
  - 多条并列结论 → `1. 2. 3.` 有序列表
  - 每条：**加粗标题单独占该 list item 的首行**（可用 `**标题**` 或 `**标题** → **一句话结论**`）
  - **细则换行**，用缩进子列表 `-` 或同 item 内换行，**禁止** `**标题**：后面直接糊一大段`
  - 单点短答仍可 1～3 句，不必硬套编号
- 与 REGRESS-G 窄口一致：允许思考后**一句**进度短文（若 G 实现已改则勿回退；若未改可一并写入）。
- `execution-mode-prompt.ts` Chat/Work「短答」加一句：多点时用编号层级，仍算短答。

### B. 样式微调（次，小）

`packages/ui/src/components/message/index.tsx` `MessageResponse` prose：

- `prose-li:my-1` → 略增（如 `my-1.5` 或 `my-2`）
- `prose-ol` / `prose-ul` 保证可见缩进（必要时 `pl-` / `prose-ol:pl-5`）
- **不要**大改 chip / 行内 code（用户本轮焦点是层级）

### C. 文档

`CURSOR-CONCISE.md` 或 `docs/dev/core-loop/UX-final-answer-hierarchy.md` 记一条验收：多点 final 须编号 + 标题行 + 缩进细则。

## 不做

- 不写 fragile 的运行时「把 `**x**：` 正则拆成标题」后处理（除非 prompt 不够且你能证伪）；优先 prompt。  
- 不碰 AskUserQuestion（H）、不 commit。  
- 若与进行中的 REGRESS-G 实现撞车：合并 prompt 窄口，勿互相覆盖。

## 验收

1. 读改后 prompt 文本：含编号层级约定，不再笼统禁清单。  
2. 相关 typecheck / 既有 prompt 测（若有）绿。  
3. FIX 笔记：`docs/dev/core-loop/UX-final-answer-hierarchy-FIX.md`

stdout 中文：改了什么 + 手测（新会话问多点对照题，看是否 `1. **标题**` + 子项缩进）。
