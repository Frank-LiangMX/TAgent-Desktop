# 刀 2 brief · 公约 / 常识卡模板

> 依据：`KB-PROJECT-BRAIN-ROADMAP.md` 刀 2、产品讨论「公约接口卡」  
> 工作目录：`F:\TAgent-Desktop`  
> 本轮：文档 `kind` + 创建模板 + 列表标识 + 提示词优先检索；**不做**可发现荐库、导出、完整表单编辑器、向量

## 用户故事

在知识库里用模板新建「接口约定」或「规范」短卡（Markdown 骨架含入口/参数/禁忌/相关文件等占位），挂库后 Agent 检索时能看到 `kind`，提示词引导优先参考 contract/norm/snapshot，减少新话题从源码上下游重摸。

## 范围

### A. 类型与存储

`KnowledgeBaseDocument` 增加可选字段：

```ts
kind?: "note" | "contract" | "norm" | "snapshot"
snapshotAt?: number      // snapshot 建议写；其它可省略
originNote?: string      // 可选；kb_propose_save 确认写入时可填「由会话确认沉淀」
```

- `createKnowledgeBaseDocument` / `updateKnowledgeBaseDocument` 接受并持久化 `kind`（及上述可选字段）  
- 旧文档无 `kind` → 视为 `note`  
- `kb_propose_save`：若入参带 `kind`，写入文档时带上；`snapshot` 时写 `snapshotAt: Date.now()`；`originNote` 可简写会话沉淀  

### B. 模板正文（纯 Markdown，管理页用）

新建两个模板函数（如 `kb-document-templates.ts`）：

1. **`contract`（接口约定）**  
   标题默认「未命名接口约定」；正文含二级标题占位：概述、入口（路由/函数）、关键参数、约定与禁忌、相关文件指针、备注  

2. **`norm`（规范）**  
   标题默认「未命名规范」；正文：适用范围、必须做到、禁止、示例、相关文件  

可选第三：**`snapshot`（常识快照）** 骨架：探查时间、范围、正文数据区、如何更新——管理页也可提供，或仅 Agent propose 使用。

`note`：保持现有「未命名文档」空模板。

### C. 管理页 UI

`KnowledgeBasePage` / 侧栏「新建」：

- 不要只有一个「新建文档」；改为菜单或分段：**空白笔记 / 接口约定 / 规范**（+ 可选常识快照）  
- 创建后进入编辑态，预填模板正文与对应 `kind`  
- 文档列表项：按 `kind` 显示小标签或不同图标（笔记 / 接口 / 规范 / 快照）；无 kind 当笔记  

### D. Agent 侧

- `kb_search` / `kb_get` 命中与返回中带上 `kind`（document 源）；directory 命中不变  
- `buildKbPromptAppend`：挂库时说明文档可能带 kind；**查用法/约定/规范/项目常识时优先关注 contract、norm、snapshot**；长 note 作补充  
- `kb_propose_save` 工具描述：沉淀公约用 `kind:contract`，规范用 `norm`，统计类用 `snapshot`  

### E. 单测

1. create 带 kind → 读回一致；无 kind 兼容  
2. 模板函数非空且含关键标题锚点  
3. search 命中 document 含 kind  
4. propose_save 带 kind=snapshot → 文档有 kind + snapshotAt（若已实现透传）  

跑：`bun test` 覆盖 document-store / kb-agent-tools / templates 相关文件。

### F. 文档回写

更新 ROADMAP / FINDINGS / SPEC-v2 / AGENT-MODE：刀 2 已落地；下一刀为刀 3。

## 本轮不做

- 结构化表单编辑（字段 UI）；正文保持 Markdown  
- 按 kind 过滤检索 API（提示词引导即可；可选 search 参数 `kinds?` 若改动小可加，非必须）  
- 刀 3 可发现、刀 4 导出  

## 验收

1. 管理页可从模板创建「接口约定」「规范」，列表可见 kind 标识。  
2. 挂库后 `kb_search` 返回命中含 `kind`。  
3. 提示词含优先参考 contract/norm/snapshot 的指引。  
4. 旧文档无 kind 仍可搜可读。  
5. 相关单测通过。
