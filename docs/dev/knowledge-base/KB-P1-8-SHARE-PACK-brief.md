# 刀 4 brief · 知识库导出 / 导入分享包

> 依据：`KB-PROJECT-BRAIN-ROADMAP.md` 刀 4  
> 工作目录：`F:\TAgent-Desktop`  
> 本轮：单库导出为分享包 + 导入成新库；**不做**云同步、增量合并、加密、多库打包

## 用户故事

用户导出本机某个知识库（正式文档 + 库元数据）→ 把文件发给同事 → 同事导入后得到**新的本地库**（新 id），可挂到会话使用。  
来源目录（本机绝对路径）**不保证可移植**：导出时可带路径作参考，导入时若路径在本机不存在则丢弃该 source，仅保留正式文档。

## 包格式（瘦）

单文件 **JSON**（扩展名建议 `.tagent-kb.json`），便于审阅与单测；不必上 zip（除非正文极大，本轮 JSON 足够）。

```ts
{
  format: "tagent-kb-share",
  version: 1,
  exportedAt: number,
  library: {
    name: string,
    description?: string,
    // 不导出 relatedWorkspaceIds（别人机器上的 workspace id 无意义）
    // sources：可选导出 { label, path? }；path 仅作提示，导入默认不自动绑定目录
  },
  documents: Array<{
    title: string,
    content: string,
    kind?: KnowledgeBaseDocumentKind,
    snapshotAt?: number,
    originNote?: string,
    // 云来源元数据可原样带上（url 等），无则省略
    sourceUrl?: string,
    sourceProvider?: ...,
    sourceAccessMode?: ...,
    sourceSyncedAt?: number,
  }>
}
```

- **不导出**旧 `id`（导入一律新生成）  
- **不导出**本机会话绑定信息  

## 主进程 API

新建 `kb-share-package.ts`（或放 store 旁）：

- `buildKnowledgeBaseSharePackage(knowledgeBaseId): SharePackage`  
- `importKnowledgeBaseSharePackage(pkg): KnowledgeBaseRecord`  
  - 校验 `format` + `version`  
  - `createKnowledgeBase({ name, description })`  
  - 逐条 `createKnowledgeBaseDocument`（保留 kind/snapshotAt/originNote/云字段）  
  - sources：本轮 **默认不导入目录**（避免绑到别人的盘符）；若 brief 实现时加「可选尝试绑定存在的 path」也行，但默认跳过更安全  

IPC（经 dialog）：

- `exportKnowledgeBase(id)` → `dialog.showSaveDialog` 写文件 → `{ ok, path? }`  
- `importKnowledgeBase()` → `dialog.showOpenDialog` 读 JSON → 导入 → 返回新库 record  

preload + App 类型补齐。

## UI

知识库详情页「添加内容」旁或更多菜单：

- **导出分享包…**  
- **导入分享包…**（也可放在库列表空态/顶栏；至少详情页有导出，列表页或顶栏有导入）

导入成功后选中新库并刷新列表；失败 toast/错误文案（格式不对、版本不支持、JSON 坏）。

## 单测

1. build → import roundtrip：文档标题/正文/kind 一致；新旧 id 不同  
2. 缺 format/version → throw  
3. 导出对象不含 relatedWorkspaceIds、不含原 document id  
4. 空文档库也可导出/导入  

跑：`bun test` 覆盖新模块 + 不破既有 kb 测。

## 文档回写

ROADMAP / FINDINGS / SPEC-v2：刀 4 ✅；下一刀按需 P1-3/P1-4 或刀 1.1。**2026-08-28** 与 ROADMAP 同步：主线刀 1–4 全部落地。

## 本轮不做

- zip / 附件二进制 blobs  
- 导入时合并进已有同名库  
- 自动关联工作区  
- 加密分享  

## 验收

1. 导出生成 `.tagent-kb.json`。  
2. 另一侧（或同机）导入出现新库，文档可打开、可挂会话检索。  
3. 原库 id 与新库 id 不同。  
4. 单测通过。
