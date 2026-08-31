# P1-1 brief · 正式文档接入 Agent 检索

> 依据：`KB-PRODUCT-SPEC-v2.md` 开发闸门、`KB-PHASE0-FINDINGS.md` P1-1、`KB-AGENT-MODE-DESIGN.md` P1-1  
> 本轮只做统一检索数据源；不做向量、不做写入、不做引用卡片 UI、不做云源重抓

## 问题

`kb_search` / `kb_get` 只走 `kb-fs-index`（绑定来源目录的 `.md/.txt`）。  
界面保存的正式文档在 `knowledge-base-documents.json`，Agent **搜不到 / 读不到**。

## 目标

会话绑定的 `knowledgeBaseIds` 下：

1. **正式文档**（title + content）可被 `kb_search` 命中  
2. **`kb_get` 可按 documentId 读全文**  
3. **来源目录**原有行为保持  
4. 多库只命中当前会话授权的库  
5. 未绑定 → 两路都空

## 实现要点

### A. document-store 补查询

`knowledge-base-document-store.ts`：

- 导出 `getKnowledgeBaseDocument(id)`  
- 导出 `listKnowledgeBaseDocumentsForIds(knowledgeBaseIds: string[])`（不做 query 过滤，检索层自己打分）  
- 或 `searchKnowledgeBaseDocuments({ knowledgeBaseIds, query, limit })` 返回带 score/excerpt 的命中

### B. 检索合并（推荐在 tools 层）

`kb-agent-tools.ts`：

- 从 session meta 取 `knowledgeBaseIds`（有则用；无则仅旧 `kbRoots` 兼容）  
- `handleKbSearch`：  
  - 目录命中 = 现有 `idx.search(roots, …)`  
  - 文档命中 = 对授权库内文档做与 fs-index **同类**关键词打分（可 export `tokenize`/`makeExcerpt` 或抽共享小工具）  
  - 合并后按 score 降序，统一 `limit`  
- 命中结构建议加字段（向后兼容，旧字段目录命中仍填）：

```ts
{
  source: "document" | "directory",
  knowledgeBaseId?: string,
  documentId?: string,
  title: string,
  score: number,
  excerpt: string,
  matchedIn: "title" | "body" | "both",
  // directory only:
  rootId?: string,
  rootLabel?: string,
  relativePath?: string,
  absolutePath?: string,
}
```

### C. kb_get 双路径

- 若 `path` / 新参数像 `documentId` 能解析为正式文档 id，且该文档的 `knowledgeBaseId` ∈ 会话绑定 → 返回全文  
- 否则走现有 fs `getFile`  
- 建议参数：保留 `path`；同时接受 `documentId`（优先）。工具描述更新。

约定虚拟引用：文档命中的 `documentId` 可直接喂给 `kb_get`；提示词改为「命中后用 [KB: 文档标题] 或 [KB: 相对路径]」。

### D. 提示词

`KB_SYSTEM_PROMPT` / `buildKbPromptAppend`：说明可检索「正式文档 + 来源目录」；有 `knowledgeBaseIds` 时列出库名与文档数（不必列全文）。

未绑定任何库且无 `kbRoots` → 与现在一样返回空。

注意：仅绑定库、无来源目录、但有正式文档时，`preferred`/`strict` 仍应生效（今天 `buildKbPromptAppend` 只看 roots 路径 —— **要改成：有 knowledgeBaseIds 或 roots 任一非空即算已绑定**）。

### E. 单测

`kb-agent-tools.test.ts`（可 mock document-store 或临时写 config dir）：

1. 绑定库 + 写入正式文档 → `kb_search` 命中 title/content，带 `source:"document"` + `documentId`  
2. 未绑定 → 搜不到该文档  
3. 绑库 A 搜不到库 B 的文档  
4. `kb_get({ documentId })` 可读；越权库拒绝  
5. 目录命中回归（现有用例不破）  
6. 仅有正式文档、无来源目录时，`buildKbPromptAppend` 仍输出 preferred/strict 策略（若接口需要改签名，同步改调用方）

跑：`bun test apps/electron/src/main/lib/kb`

## 本轮不做

- FTS5 / 向量  
- Chat 引用卡片 UI  
- candidate 写入  
- 云源重抓  
- 改 renderer（ComposerPlusMenu 等）

## 验收

1. 界面新建的正式文档，会话绑定该库后 `kb_search` 能命中  
2. `kb_get(documentId)` 返回与界面一致的正文  
3. 多库隔离  
4. 目录检索与路径穿越拒绝仍通过  
5. 规格闸门：统一数据源完成，可再开 P1-2
