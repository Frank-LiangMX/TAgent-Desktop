# 刀 1 brief · 知识库受控写入 MVP（kb_propose_save）

> 依据：`KB-PROJECT-BRAIN-ROADMAP.md` 刀 1、`KB-PRODUCT-SPEC-v2` 触发原则、`KB-AGENT-MODE-DESIGN`  
> 工作目录：`F:\TAgent-Desktop`  
> 本轮：确认后才写入正式文档；**不做**完整 diff UI、不做导出、不做可发现荐库、不做向量

## 用户故事

挂库会话中，Agent 整理出公约/统计/规范后调用提议保存 → 用户在会话内确认 → 写入当前绑定库的正式文档 → 之后 `kb_search` 可命中。拒绝则库不变。

## 方案（仿 ExitPlanMode 门控，不信任模型自觉）

新增只写工具 **`kb_propose_save`**（非静默 Write）：

1. Agent 调用工具（带 `knowledgeBaseId` / `title` / `content`）  
2. 主进程**拦截并阻塞**（同 ExitPlanMode / AskUserQuestion）  
3. 渲染层横幅展示标题 + Markdown 预览 +「保存到《库名》」/「取消」  
4. 用户确认 → `createKnowledgeBaseDocument` → resolve 成功（含 `documentId`）  
5. 用户取消 / 会话停止 → resolve 拒绝文案，**零写入**

禁止：另设无门控的 `kb_write` / `kb_create_document` 给 Agent。

## 契约

### 工具入参

```ts
{
  knowledgeBaseId: string  // 必须 ∈ 当前会话 knowledgeBaseIds
  title: string            // trim 非空
  content: string          // Markdown 正文
  // 可选，本轮可先忽略或透传进文档扩展字段（若类型已有则写；没有可暂存正文头部注释）
  kind?: "note" | "contract" | "norm" | "snapshot"
}
```

### 校验失败（立即返回错误，不弹 UI）

- 会话未绑定任何库 / `knowledgeBaseId` 不在绑定列表  
- 标题空、正文空（或仅空白）  
- 目标库不存在  

### 成功返回（JSON text）

```ts
{ ok: true, documentId, knowledgeBaseId, title }
```

### 拒绝返回

```ts
{ ok: false, reason: "user_rejected" | "aborted" }
```

## 实现要点

### A. 主进程服务

新建 `apps/electron/src/main/lib/kb/kb-propose-save-service.ts`（仿 `agent-exit-plan-service.ts`）：

- `handleProposeSave(sessionId, input, { signal, sendToRenderer })` → Promise  
- pending map；`respond({ requestId, action: "confirm" | "reject" })`  
- confirm 路径调用 `createKnowledgeBaseDocument`  
- abort / 会话清理时 reject  

### B. 工具挂载

`kb-agent-tools.ts`：

- Pi + kscc MCP 均注册 `kb_propose_save`（**不要** `readOnlyHint`）  
- 执行体走 propose-save-service（需能拿到 session 的 sendToRenderer；对照 ExitPlanMode 在 permission / adapter 中的注入方式）  
- **重要**：若 kscc/Pi 对自定义工具不走 `canUseTool` 同一套拦截，必须在 **tool execute 内直接 await 门控**（推荐：门控逻辑放 execute，不依赖权限钩子是否覆盖 MCP 工具）

### C. 提示词

更新 `KB_SYSTEM_PROMPT` / `buildKbPromptAppend`：

- 需要把结论/统计/公约沉淀进知识库时，调用 `kb_propose_save`（须已挂库）  
- **禁止**声称已保存；只有工具返回 `ok:true` 才算保存成功  
- 未挂库时不要调用本工具  

### D. IPC + 渲染

- shared 类型：`KbProposeSaveRequest` / `KbProposeSaveResponse`  
- preload + IPC：`kb:propose-save-respond`；主→渲染事件（对齐现有 ASK_USER / EXIT_PLAN 频道风格，查 `packages/shared` 事件常量后复用命名习惯）  
- atom：`allPendingKbProposeSaveRequestsAtom`  
- 组件 `KbProposeSaveBanner.tsx`：玻璃卡、标题、库名、正文预览（Markdown）、确认/取消；挂到 Chat 与 AskUser/ExitPlan 同级槽位  
- 会话停止 / 切走时清理 pending（对照 ExitPlan 清理）

### E. 单测

1. 未绑定库 → 工具立即 error，不发 UI  
2. 绑定库 + confirm → document-store 多一篇，`kb_search` 能命中标题关键词  
3. reject → 文档数不变  
4. abort → 不写入  
5. 越权 knowledgeBaseId（非本会话绑定）→ error  

跑：`bun test apps/electron/src/main/lib/kb`  
若有 banner 纯逻辑可另加轻量测；UI 可不强制组件测。

### F. 文档回写

- `KB-PHASE0-FINDINGS.md` / `KB-PROJECT-BRAIN-ROADMAP.md`：刀 1 状态  
- `KB-AGENT-MODE-DESIGN.md`：写入契约  
- `KB-PRODUCT-SPEC-v2.md`：触发原则「已实现提议确认」  

## 本轮不做

- 完整 side-by-side diff / 版本链  
- `kb_propose_update`（整理后更新已有文档）— 可列刀 1.1  
- 导出包、可发现荐库、公约模板 UI  
- 向量 / 自动抽取  

## 验收

1. 挂库会话：Agent 调 `kb_propose_save` → 出现确认横幅；确认前管理页文档列表不变。  
2. 点确认 → 库内出现文档；同会话 `kb_search` 能搜到。  
3. 点取消 → 不出现文档。  
4. 未挂库调用 → 工具报错，无横幅。  
5. 相关单测通过；不破现有 kb / chat 测试。

## 给实现者的定位提示

- ExitPlan 参考：`agent-exit-plan-service.ts` + `ExitPlanModeBanner.tsx` + permission-service 内拦截；**KB 工具优先在 execute 内门控**，减少双核差异。  
- 写文档：`knowledge-base-document-store.createKnowledgeBaseDocument`。  
- 绑定校验：`getSessionMeta(sessionId).knowledgeBaseIds`。
