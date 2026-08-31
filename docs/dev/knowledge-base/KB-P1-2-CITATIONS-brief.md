# P1-2 brief · KB 引用展示 + 会话闭环验收

> 依据：`KB-AGENT-MODE-DESIGN.md` P1-2、`KB-PHASE0-FINDINGS.md` P1-2  
> 前置：P1-1 正式文档已接入 `kb_search` / `kb_get(documentId)`  
> 本轮不做：受控写入、向量、云源重抓、真实 LLM 拒答黑盒（用单测 + 可手测清单代替）

## 目标

1. 一轮对话里若 Agent 调了 `kb_search`，在最终回答区下方展示**可点击来源芯片**（文档标题 / 目录相对路径）。
2. 点文档芯片 → 打开知识库 Rail，选中对应库与文档。
3. `kb_*` 工具在过程链里有中文短语（不是裸工具名）。
4. 补齐可自动化的验收测试 + 手测清单。

## 实现

### A. 解析命中（纯函数）

新建 `apps/electron/src/renderer/components/chat/kb-citations.ts`：

```ts
export type KbCitation = {
  source: "document" | "directory"
  title: string
  knowledgeBaseId?: string
  documentId?: string
  relativePath?: string
  absolutePath?: string
}

/** 从 tool_result content（string / text blocks）解析 kb_search JSON → citations */
export function parseKbSearchCitations(content: unknown): KbCitation[]

/** 从 turn process 工具条目收集去重后的 citations（仅 kb_search 成功结果） */
export function collectTurnKbCitations(
  process: Array<{ type: string; tool?: { name: string }; result?: { content: unknown; isError?: boolean } }>
): KbCitation[]
```

- 兼容 MCP 名可能带前缀（如 `mcp__kb__kb_search` / `kb_search`）：`name` 以 `kb_search` 结尾或等于即可。
- 去重键：`document:${documentId}` 或 `dir:${absolutePath|relativePath}`。
- 坏 JSON / 非 search 结果 → 空数组，不抛。

### B. UI：来源条

新建 `KbCitationBar.tsx`（或同文件内组件）：

- 无 citations 不渲染。
- 一行横向 wrap：`BookOpen` + 截断标题；directory 用 `FileText` + 相对路径。
- 文档芯片可点：`window.dispatchEvent(new CustomEvent("tagent:open-knowledge-document", { detail: { knowledgeBaseId, documentId } }))`
- 目录芯片：可选 `title` tooltip 显示绝对路径；点击可暂不打开文件（本轮可不做），或仅复制路径——**优先只做文档可点**。

挂到 `AssistantTurnView`：最终回答壳下方（`MessageResponse` / 最终正文后），live 未完成也可显示已有命中。

### C. 打开文档导航

`App.tsx` 监听 `tagent:open-knowledge-document`：

1. `setShowSettings(false)`；`setActiveRail("knowledge")`；`setSidebarOpen(false)`
2. 下一 tick / `requestAnimationFrame` 派发：
   - `tagent:knowledge-sidebar-select-base` + `{ knowledgeBaseId }`
   - 再派发 `tagent:knowledge-sidebar-select-document` + `{ documentId }`（库详情挂载后再选；可用短 `setTimeout` 0–50ms 或等 detail 挂载）

`KnowledgeBasePage`：若当前未选中目标库，先 `setSelectedId`；`KnowledgeBaseDetail` 已有 `DOCUMENT_SELECT_EVENT` 监听，确认能在文档列表加载后设 `activeId`（若列表尚未加载，在 docs load 完成后补一次 pending documentId）。

### D. 工具短语

`tool-phrase.ts` 增加：

| 工具 | 短语示例 |
|------|----------|
| kb_list_roots | 列出知识库 |
| kb_search | 检索知识库「query」 |
| kb_get | 读取知识文档 / 读取知识文件 |

`summarizeToolResult`：若能 parse 出 `count`/`hits`，摘要为 `命中 N 条`。

### E. 测试

1. `kb-citations.test.ts`：parse 样例 JSON（document + directory 混合、坏 JSON、MCP 前缀名、去重）。
2. `tool-phrase`：kb_* 用例（若已有 test 文件则追加，否则轻量测 getToolPhrase）。
3. 手测清单写入 `KB-PHASE0-FINDINGS.md` P1-2 小节（不强制自动化真实 LLM）。

### F. 规格进度

更新 `KB-PHASE0-FINDINGS.md` / `KB-AGENT-MODE-DESIGN.md` / `KB-PRODUCT-SPEC-v2.md`：标明 P1-2 UI 引用已落地；真实 preferred/strict LLM 行为仍靠手测。

## 本轮不做

- 在 Markdown 正文里解析 `[KB: …]` 替换（避免与模型文案耦合；以 tool_result 为准）
- candidate 写入、FTS5、向量
- 目录文件一键打开工作区

## 验收

1. 会话绑定库 → preferred → 问库内文档内容 → 回答下方出现文档芯片；点击打开该文档。
2. 仅目录命中时出现路径芯片（可不点击）。
3. 过程链显示「检索知识库…」而非裸 `kb_search`。
4. `bun test` 相关单测通过；不破现有 chat 测试。
