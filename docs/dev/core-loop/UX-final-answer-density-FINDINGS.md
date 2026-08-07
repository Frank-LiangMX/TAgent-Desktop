# UX FINDINGS：最终正文密度为何比 Cursor「乱」

> 只读摸底 · 2026-08-07 · 工作区 `F:\TAgent-Desktop`  
> **禁止改代码**（本文档仅为调查结论）  
> 对照用户描述：TAgent 挤、行距紧、inline code 灰底密、路径 chip 插句中；Cursor 列表留白、层次清晰、inline code 克制。

---

## 结论（乱在哪三处）

与「输出风格 / prompt 短答」无关的纯 UI Top 3：

1. **行内路径一律升格为 `FilePathChip`（带字母色块图标）** — 句中视觉噪声最大来源  
2. **行内 `code` 显式灰底 + 技术文高频反引号** — 灰底色块阵  
3. **`MessageResponse` prose 列表/段间距偏紧 + 标题几乎贴正文** — 层次不透气  

concise / full **共用同一 Markdown 渲染器**；差异只在外壳（timeline narrative vs answer shell），不是两套排版。

---

## 1. 最终正文渲染组件

| 角色 | path:line | 说明 |
|------|-----------|------|
| Markdown 真源 | `packages/ui/src/components/message/index.tsx:257-462` | `MessageResponse`：`react-markdown` + `remarkGfm` / `remarkMath` + `rehypeKatex` |
| 内容壳 | 同文件 `:110-137` | `MessageContent`：`flex flex-col gap-2` |
| 消息根 | 同文件 `:52-62` | `Message`：`px-2.5 py-2.5`；concise final 会 `py-0` 压掉 |
| **concise 最终正文** | `apps/electron/src/renderer/components/chat/ConciseTimelineView.tsx:628-638` | `agent-concise-narrative--final` → `Message` → `MessageContent` → **`MessageResponse`** |
| concise 过程 narrative | 同文件 `:613-624` | 仍用 `MessageResponse`，额外 class `agent-concise-narrative__text` |
| **full 最终正文** | `apps/electron/src/renderer/components/chat/AssistantTurnView.tsx:340-352` | `agent-answer-block` → `Message` → `MessageContent` → **同款 `MessageResponse`** |
| 回合入口 | `AssistantTurnView.tsx:86-113, 262-265` | `processDisplayMode === 'concise'` 走 timeline；否则回答壳 |
| 模型分流 | `session-turn-model.ts:453, 604-606, 803` | concise：`answerTexts=[]`，正文留 process 由 timeline 投 `narrative final`；full：外置 `answerTexts` |

没有独立的 `FinalAnswer.tsx`；最终 Markdown = **`MessageResponse`**。

---

## 2. 样式：`chat.css` / globals / prose 相关

### 2.1 真正管最终正文密度的是 `MessageResponse` class（不在 chat.css 大段 prose）

`packages/ui/src/components/message/index.tsx:431-442`：

| Token | 值 | 观感影响 |
|-------|-----|----------|
| 字号 | `text-[length:var(--md-preview-font-size,13px)]` | 13px 偏密（globals 设变量） |
| 段距 | `prose-p:my-2` | 上下各 8px，偏紧 |
| 行高 | `prose-p:leading-[1.65]` / `prose-li:leading-[1.65]` | 尚可，但配小字号仍挤 |
| 列表容器 | `prose-ul:my-2` / `prose-ol:my-2` | 列表块与前后贴得近 |
| 条目间距 | `prose-li:my-1` | **条目间仅 ~4px**，相对 Cursor「透气列表」最明显 |
| 标题 | `prose-headings:mt-5 mb-2`；h1 `16.5px` / h2 `15px` / h3 `13.5px` / **h4 `13px`=正文字号** | 粗体标题与正文层次弱（尤其 h3/h4） |
| 代码块间距 | `prose-pre:my-0` + wrapper `mt-4` | 块级依赖 wrapper，默认 pre 无外边距 |

### 2.2 `globals.css`

- `:42-43` — `--md-preview-font-size: 13px`（会话 Markdown 基准）  
- `:224-228` — 关掉 typography 给 `code` 的 `::before/::after` 反引号伪元素  

### 2.3 `chat.css` 与最终正文相关（**几乎不管 p/ul/code**）

| path:line | 规则 | 作用 |
|-----------|------|------|
| `chat.css:13-20` | `.tagent-thread` 宽/padding | 线程容器，非 prose 密度 |
| `chat.css:30-44` | `.agent-user-bubble` `line-height: 1.72` | **用户气泡**，非 assistant 最终正文 |
| `chat.css:250-255` | `.agent-answer-block` `gap: 0` | full 回答壳垂直贴紧 |
| `chat.css:519-540` | `.agent-concise-narrative` / `--final` | final：`margin-top: 8px`，无边框无底 |
| `chat.css:528-531` | `.agent-concise-narrative__text` `13px` / `line-height: 1.55` | **progress** narrative 更紧；final **不用**此 class |
| `chat.css:542-548` | `--final > .is-assistant { padding:0 }`；turn `gap: 4px` | 故意去掉 Message 默认 padding + 缩小 turn gap → **更挤** |

**要点：** assistant 最终 Markdown 的行高/列表/inline code **主要在 `MessageResponse` Tailwind**；`chat.css` 只做 concise 贴紧外壳，进一步压缩留白。

### 2.4 行内 code 样式（组件内，非 chat.css）

`message/index.tsx:387-395`：

```text
rounded-[3px] bg-foreground/[0.05] px-[0.25em] py-[0.05em] font-mono text-[0.92em]
```

注释已承认：「一段能出现十几个行内代码，底色一重整段就成了色块阵」。

---

## 3. 文件路径 chip 如何注入 Markdown

### 注入点

`MessageResponse` 自定义 `code` 组件（`message/index.tsx:350-396`）：

1. 无 `language-*` 且无 `\n` → 视为**行内 code**  
2. 若 `MessageFilePathContext.onOpenFile` 存在，且  
   `isAbsoluteFilePath(text) || isRelativeFilePath(text)`  
3. → 渲染 **`FilePathChip`**，**不再走灰底 `<code>`**

### 识别启发式（偏宽）

- `packages/shared/src/utils/file-path.ts:136+` — 绝对路径（盘符 / UNC / Unix）  
- 同文件 `:149-163` — **相对路径：只要可预览扩展名 + 字符集匹配即 true**  
  - **不要求必须含 `/` 或 `\`**  
  - 因此 `` `index.tsx` ``、`` `chat.css` ``、`` `a.ts` `` 都会进 chip（只要扩展名在 `ALL_PREVIEWABLE_EXTS`）

→ **几乎每个「像文件名的反引号」都会变成 chip**，不是仅长路径。

### Chip 视觉（「蓝 C」）

`packages/ui/src/components/file-path-chip/index.tsx:291-321`：

- `inline-flex` + `text-primary/90` + 可选 `FileIcon`  
- **`Chat.tsx:1798-1821` 的 Provider 未注入 `FileIcon`**  
- 回退：`bg-primary/15 text-primary text-[8px]` 的 **首字母方块**（如 `chat.css` → **C**）——即用户说的句中蓝字母图标  

应用层启用：`Chat.tsx:1804-1806` 提供 `onOpenFile` → 全会话 `MessageResponse` 均开启路径升格。

### 与 Cursor 对比（UI 层）

Cursor 最终回答里路径多半仍是克制的 inline code / 纯文本链接；TAgent 主动把路径/文件名做成**可点 chip + 色块图标**，技术回答里路径一多就「密布插花」。

---

## 4. concise vs full：是否不同渲染器？

| 模式 | 数据路径 | UI 渲染器 |
|------|----------|-----------|
| **concise** | process 内 text → timeline `narrative` `tone: final`（`answerTexts=[]`） | **`MessageResponse`**（`ConciseTimelineView` Narrative） |
| **full** | `answerTexts` → 回答壳 | **同一 `MessageResponse`**（`AssistantTurnView`） |

差异：

- 外壳 CSS（`agent-concise-narrative--final` 去 padding / turn gap 4px vs `agent-answer-block`）  
- 流式/打字机参数不同  
- **prose / code / FilePathChip 管线相同**  

过程区 `ProcessGroupView` 另有更紧的 `PROCESS_MD_CLASS`（`prose-p:my-1` 等，`:42-47`），**不作用于最终 final**。

---

## 5. 纯 UI 原因 Top 3（展开）

### Top1 — FilePathChip 过宽升格 + 字母色块图标

- **组件：** `MessageResponse` `code` → `FilePathChip`（`message/index.tsx:364-382`）  
- **启发式：** `isRelativeFilePath` 无路径分隔符也可命中（`file-path.ts:149-163`）  
- **视觉：** 无 `FileIcon` 时 primary 首字母方块（`file-path-chip/index.tsx:312-315`）  
- **效果：** 句中连续 chip，打断阅读节奏，比 Cursor 吵一个数量级  

### Top2 — 行内 code 灰底密布

- **样式：** `bg-foreground/[0.05] px-[0.25em] ...`（`message/index.tsx:387-395`）  
- **效果：** 非路径的 API/符号/标识符仍铺灰底；技术 final 一段十几个 → 「色块阵」  
- Cursor 更常弱装饰或几乎无底，故更克制  

### Top3 — prose 列表/段间距紧 + 标题层次弱 + concise 再贴紧

- **列表：** `prose-li:my-1` + `ul/ol:my-2`（`message/index.tsx:432-433`）→ 编号列表「挤在一起」  
- **标题：** h3/h4 接近或等于 13px 正文（`:439-440`）→ 粗体标题不「跳」出来  
- **concise 外壳：** `chat.css:542-548` 去掉 Message padding、turn `gap: 4px` → 相对 Cursor 更不透气  

---

## 非本结论范围（刻意排除）

- 模型 / system prompt「短答、少空行」导致源 Markdown 本身少空行 —— 用户要求排除；即便源文有空行，上述 UI 仍会把列表与 chip 压密。  
- 过程折叠 / work_stage 样式 —— 非最终正文。  

---

## 若后续改 UI（仅建议，本轮不做）

1. 收紧 `isRelativeFilePath`（要求分隔符或最小路径深度），或 final 默认不升格为 chip / 无图标仅下划线。  
2. 最终正文行内 code 去掉或再降灰底（依赖 mono + 字重即可）。  
3. 加大 `prose-li` / `prose-ul` 间距，拉大 h2/h3 与正文差；concise final 略恢复呼吸间距。  

---

## 证据索引（快速跳转）

```
packages/ui/src/components/message/index.tsx:301   MessageResponse
packages/ui/src/components/message/index.tsx:364   FilePathChip 注入
packages/ui/src/components/message/index.tsx:387   inline code 灰底
packages/ui/src/components/message/index.tsx:431   prose 间距/字号/标题
packages/ui/src/components/file-path-chip/index.tsx:291  chip + 字母图标
packages/shared/src/utils/file-path.ts:149          isRelativeFilePath（过宽）
apps/.../ConciseTimelineView.tsx:628               concise final
apps/.../AssistantTurnView.tsx:340                 full final
apps/.../styles/chat.css:519                       narrative / final 贴紧
apps/.../styles/globals.css:42                     --md-preview-font-size: 13px
apps/.../Chat.tsx:1798                             MessageFilePathProvider（无 FileIcon）
```
