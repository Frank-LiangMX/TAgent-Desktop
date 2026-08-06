# 消息富内容渲染（Markdown 围栏语言分派）

> 状态：主路径已落地；分屏/全屏预览与填满画布已补（2026-08-06）
> 范围：renderer 消息渲染层 + Dock 富块预览 pane；双核适配器 / 消息协议零改动
> 参考：Frakio Work 的「围栏语言约定」思路（**只借鉴产品思路，不复制其代码**）

## 近况补记（2026-08-06）

- Mermaid / DataTable / RichFrame：分屏 + 全屏；分屏走 `richPreviewRequestAtom` → `RichPreviewPane`（pane 内去嵌套卡片，画布填满）。
- Mermaid：透明 SVG 底；edge-label 需实色 `--bg`；边线加粗。
- DataTable：筛选折叠、斑马纹、Radix Select（避免 Windows 原生黄框）。
- 全局滚动条：去掉与 `::-webkit-scrollbar` 冲突的 `scrollbar-width/color`，隐藏 Windows classic 箭头按钮。

## 1. 背景

TAgent 消息渲染现状：

- `ContentBlockView`（renderer）按 IR block 分发：`text` → `MessageResponse`、`thinking` → `Reasoning`、`tool_use` → `Collapsible`
- `MessageResponse`（@tagent/ui）用 react-markdown + remarkGfm/remarkMath + rehypeKatex，**只覆写了 `a`（外链）和 `pre`（→ CodeBlock）两个组件**
- 结果：模型输出的 ` ```diff `、` ```json `、` ```mermaid ` 等围栏全部按普通代码块渲染，浪费模型能力，消息可读性差

**借鉴对象**：Frakio Work 的消息区支持多样内容（diff / JSON 树 / Mermaid / 数学 / 数据表格 / HTML / 图片 / PDF 预览）。其核心机制是**「代码围栏语言命名约定」**：模型照常输出 markdown，渲染层覆写 `code` 组件，按围栏语言分派到对应富组件。**零协议改动、纯渲染层增强**，模型天然会输出这些围栏。

## 2. 红线（不复制代码）

| 可以 | 不可以 |
|------|--------|
| 借鉴**围栏语言约定**这一产品思路（diff/json/mermaid 等语言名触发富渲染） | 复制 Frakio `RichMarkdown.tsx` / `rich-content.mjs` / `rich-content.d.mts` 的代码或结构 |
| 借鉴**错误回退链**（富块失败回退普通代码块）、**流式未闭合围栏占位**的设计意图 | 依赖 Frakio 仓库路径，或把其文件当实现来源 |
| 引用**渲染引擎类库**（mermaid、react-pdf、write-excel-file——同 react-markdown/katex 一样是库） | 引入 `@pierre/diffs`、`@uiw/react-json-view`、`beautiful-mermaid` 等 Frakio 用到的封装组件 |
| **TAgent 自研**分派表、diff 解析、JSON 树、数据表格、块外壳、流式占位逻辑 | 把 Frakio 的块外壳（RichFrame）样式/类名搬进本仓 |
| 样式全部走**全局 UI tokens**（见 3.5） | 引入独立色值/字体/圆角/动效，脱离全局主题自建视觉语言 |

**一句话：思路借 Frakio，代码与样式全部 TAgent 自研（样式走全局 tokens）。**

## 3. 目标架构

```text
MessageResponse（@tagent/ui，现有）
  └─ react-markdown components 增加 code 覆写（自研）
       └─ RichFence（自研分派器）
            ├─ 普通语言 → 现有 CodeBlock（shiki/高亮，不动）
            └─ 富语言 → 对应富块组件（自研）
                 ├─ diff          → DiffView（自研 hunk 解析渲染）
                 ├─ json          → JsonTree（自研折叠树）
                 ├─ mermaid       → MermaidView（引 mermaid 渲染引擎，自研封装）
                 ├─ math/latex    → 复用 KaTeX（包一层）
                 ├─ datatable / spreadsheet → DataTable（自研 JSON spec 表格）
                 ├─ html-preview  → sandbox iframe（自研封装）
                 ├─ image-preview → 复用 ImageLightbox + IPC 读附件（自研封装）
                 ├─ pdf-preview   → 引 react-pdf，自研翻页封装
                 └─ markdown-preview → 嵌套 MessageResponse（自研）
             每个富块包在统一块外壳（自研：标题 + 复制 + 全屏）内，
             外层 RichBlockBoundary（ErrorBoundary）→ 失败回退普通 CodeBlock
```

### 3.1 围栏语言约定（TAgent 自研定义）

模型输出带以下语言的围栏即触发富渲染；**未知语言一律回落现有 CodeBlock**（无感知风险）：

| 围栏语言 | 渲染 | 数据来源 |
|---------|------|---------|
| `diff` | 行级 diff 视图（+/- 着色、hunk 折叠） | 围栏内 unified diff 文本 |
| `json` | 折叠 JSON 树（展开/收起、复制） | 围栏内 JSON |
| `mermaid` | 图表（SVG，可全屏/缩放） | 围栏内 mermaid 源码 |
| `math` / `latex` | KaTeX 公式 | 围栏内公式源码 |
| `datatable` | 数据表格（搜索/排序/分组/CSV 导出） | 围栏内 JSON spec（3.2） |
| `spreadsheet` | 同 datatable + XLSX 导出 | 同上 |
| `html-preview` | sandbox iframe 预览 | JSON spec `{src}` → 主进程读文件 |
| `image-preview` | 图片灯箱（多图 tab） | JSON spec `{src}` → 主进程读附件 |
| `pdf-preview` | PDF 内联预览（翻页） | JSON spec `{src}` → 主进程读文件 |
| `markdown-preview` | 嵌套渲染另一 md 文件 | JSON spec `{src}` |

### 3.2 数据块 JSON spec（TAgent 自研，对齐 shared 类型）

```jsonc
{
  "title": "资源清单",            // 表格标题
  "filename": "assets.xlsx",     // 导出文件名（可选）
  "columns": ["名称", "类型", "大小"],
  "rows": [["a.png", "贴图", 2048], ["b.jpg", "照片", 1024]],
  "groupBy": "类型"               // 可选分组列
}
```

- 预览类块（html/image/pdf/markdown）的 `src` 走**主进程鉴权读取**（复用现有附件/工作区文件能力），渲染层只拿内容/URL，不暴露本地路径
- spec 解析失败 → 回落普通 CodeBlock（容错）

### 3.3 流式兼容（自研）

- 流式渲染中检测**未闭合围栏**（自研：` ``` ` 个数奇偶判定 + 当前围栏语言识别）→ 该围栏先渲染「正在生成」占位
- 围栏闭合后挂载富组件，避免半截 JSON/表格反复解析抖动
- 与现有流式打字机共存，不阻塞增量文本

### 3.4 依赖与体积（自研决策）

- mermaid / react-pdf 等重库**动态 import**（React.lazy），不进首屏 chunk
- 富块外壳、diff、JSON 树、表格、流式检测**全部自研**，无新增封装依赖

### 3.5 全局 UI 风格约束（硬性）

所有富内容样式**必须走全局 UI tokens 体系**（@tagent/ui 生成的 tokens + electron globals.css），与现有消息/代码块/玻璃面板同一视觉语言：

| 维度 | 必须使用 | 禁止 |
|------|---------|------|
| **颜色** | 语义色 token：`hsl(var(--primary))` / `foreground` / `muted-foreground` / `border` / `destructive`、glass 体系（`--glass-rgb` / `--scene-a-rgb` 顶光渐变）、tailwind 语义 utility（`bg-muted/25`、`border-border`、`text-muted-foreground`） | 硬编码 hex/rgb 色值（除跟随 token 的透明度叠加）；自建明暗分支 |
| **圆角** | `--radius-glass-*` 体系（富块外壳用 modal/popover 档，代码行内元素用 chip 档） | 新造圆角值 |
| **动效** | `--app-shell-motion` / `motion-ease-island` + `motion-duration-*`（进入/展开/折叠动画） | 新造缓动曲线；未加 `prefers-reduced-motion` 分支的动画 |
| **字体** | 现有系统字体栈；代码块沿用现有 mono 栈 | 引入新字体 |
| **明暗模式** | 跟随全局 `.dark`（现有机制），dark 变体只在同一 token 上调整透明度 | 独立 `isDark` 条件样式 |
| **玻璃质感** | 复用现有 glass 面板写法（`backdrop-filter` + inset 高光 + 渐变底），与 CodeBlock/MessageResponse 一致 | 与现有玻璃语言不同的新表面处理 |

验收时逐块检查：组件样式中**不允许出现**独立于 tokens 的色值、圆角、缓动、字体；深浅模式下与现有消息区观感一致。

## 4. 分阶段交付

### Phase 0 — 基础设施（0.5 天）
- [ ] `MessageResponse` 增加 `code` 组件覆写 + 富语言分派表（未知语言回落 CodeBlock）
- [ ] 块外壳组件（标题栏 + 复制 + 全屏，用现有 token 样式）
- [ ] `RichBlockBoundary`（ErrorBoundary → 回退普通 CodeBlock）
- [ ] 单元测试：分派命中 / 未知语言回落 / 外壳渲染

### Phase 1 — 高价值轻量块（1.5–2 天，全自研无新库）
- [ ] `diff`：unified diff 解析（hunk 头 + 行前缀）→ 行级着色视图，长 diff 折叠
- [ ] `json`：JSON 折叠树（递归组件 + 展开/收起 + 复制）
- [ ] `math`/`latex`：围栏内容包 `$$...$$` 走已有 rehypeKatex
- [ ] 测试：diff 解析边界（空 diff/错误 hunk）、JSON 树渲染、错误回退

### Phase 2 — Mermaid（1 天）
- [ ] 引 `mermaid`（动态 import）→ SVG 注入 + 错误回退代码块 + 全屏/缩放
- [ ] SVG 注入前清洗（去 script/内联事件，防注入）
- [ ] 测试：渲染成功路径 + 语法错误回退

### Phase 3 — 数据块（2–3 天）
- [ ] `datatable`/`spreadsheet`：JSON spec 驱动表格（搜索/排序/分组/CSV 导出；XLSX 导出引 `write-excel-file`）
- [ ] 空数据 / 坏 spec 回落普通 CodeBlock
- [ ] 测试：spec 归一化、排序分组、CSV 生成

### Phase 4 — 预览块（可选，每块 0.5–1 天）
- [ ] `html-preview`（sandbox iframe + 主进程读文件）
- [ ] `image-preview`（复用 ImageLightbox + 附件 IPC）
- [ ] `pdf-preview`（react-pdf 动态 import + 翻页）
- [ ] `markdown-preview`（嵌套 MessageResponse，限深 1 层防递归）

### Phase 5 — 流式兼容（1 天）
- [ ] 未闭合围栏检测 + 流式占位（配合现有打字机）
- [ ] 测试：流式中半截围栏不渲染富块、闭合后挂载

## 5. 明确非目标（本轮）

- **不改消息协议 / IR block 结构**（双核 adapter 零改动）
- 不做 Frakio 的「回合活动收敛」展示改造（另案，用户尚在决策过程可见性方案）
- 不引入 Frakio 用过的封装组件（@pierre/diffs、@uiw/react-json-view、beautiful-mermaid）
- 不做 Markdown 内嵌交互语法扩展（如 `@file:` 之外的新语法）

## 6. 验收

- 模型在对话中输出 ` ```mermaid ` / ` ```json ` / ` ```datatable {...} ` 等围栏，消息区渲染为对应富组件；未知语言照常代码块
- 富块渲染失败（如 mermaid 语法错）→ 回退普通代码块，整条消息不崩
- 流式输出中围栏未闭合不闪半截富组件
- 代码中无 Frakio 源码引用；diff/JSON 树/表格/外壳为 TAgent 自研实现
- 样式全部走全局 tokens（3.5）：无硬编码色值/圆角/缓动/字体，深浅模式与现有消息区一致
- typecheck 全绿 + vitest 相关测试通过；首屏包体无明显增长（重库动态 import）

## 7. 关联决策（记录）

- **过程可见性保留**：Frakio 的「活动行收敛」方案会削弱用户对 agent 行为的感知（用户判断"让用户看到 agent 在干什么很重要"），该方案暂缓，另行决策
- 富内容分派与「回合过程区」互不阻塞：前者是 text 块的 markdown 增强，后者是 turn 层聚合

## 8. 模型侧输出规范（rich-content-output，2026-07-31 追加）

渲染层就绪后，补「让模型输出对」的半环（参考 Frakio `rich-content-output.mjs` 意图，实现自研）：

### 8.1 校验工具（纯函数，`packages/shared/src/utils/rich-output-validate.ts`）

- `validateRichOutput(text)` → `RichOutputIssue[]`：
  - **围栏闭合**：未闭合围栏（含语言）——复用/同步 `unclosedFenceLanguage` 逻辑（单一事实源：移到 shared，ui 包从 shared 引用）
  - **datatable/spreadsheet schema**：围栏内容 JSON.parse + 结构校验（columns/rows 形状，`normalizeDataSpec` 可解析）
  - **json**：JSON.parse 可解析
- 不校验 mermaid 语法（渲染层已有错误回退，校验成本高收益低）

### 8.2 修复提示（纯函数）

- `buildRichOutputFixPrompt(issues, original)` → 中文修复指令（列出问题围栏、缺什么、要求重输出）
- 供「自动修复重试」使用；本轮先产出工具 + 单测，自动重试另案

### 8.3 systemPrompt 规范注入（本轮必做）

- 双核 systemPrompt 追加「富内容输出规范」：支持哪些围栏、datatable/spreadsheet 的 JSON spec 示例、格式要求（预防性，让模型少犯错）
- 注入点：session-service 构建 systemPrompt 处（两核共用文案工具）

### 8.4 不做（本轮）

- 自动修复重试（turn 循环内校验 + 重发消息）：插入点在 session-runtime/adapter，侵入 agent 循环，另案评估
- mermaid 语法校验
