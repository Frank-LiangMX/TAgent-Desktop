# 刀 3 brief · 可发现、不可偷用（口头轻问）

> 依据：`KB-PROJECT-BRAIN-ROADMAP.md` 刀 3；产品拍板：必须挂才用正文；未挂可口头轻问；不弹窗；不教怎么挂（除非用户问）；拒绝后本会话不再追问  
> 工作目录：`F:\TAgent-Desktop`  
> 本轮不做：自动挂载、UI 强提醒、导出、偷读正文、教操作步骤

## 用户故事

通用会话（未挂库）里用户问到明显的项目规范/资源/公约问题 → Agent **只知道**「本机有相关库《名》」→ 口头问要不要挂上参考 → 用户说不 / 忽略 → **本会话不再问**。  
未挂期间：`kb_search` / `kb_get` / `kb_propose_save` **不得**返回或写入正文。

## 方案（瘦）

### A. 库 ↔ 工作区弱关联

`KnowledgeBaseRecord` 增加可选：

```ts
relatedWorkspaceIds?: string[]
```

- `createKnowledgeBase` / 新增 `updateKnowledgeBase`（或 patch）可写该字段  
- 管理页详情：提供「关联当前工作区」开关/按钮（有当前 workspace 时）；已关联则显示并可取消  
- 无关联时：可发现列表可退化为「用户最近在某会话挂过的库」（可选，见 C）；都没有则不荐

### B. 可发现元数据（无正文）

新增只读工具 **`kb_list_available`**（或扩展 `kb_list_roots` 在未绑定时的行为——**推荐独立工具名更清晰**）：

返回（仅元数据）：

```ts
{
  bound: boolean  // 当前是否已挂库
  available: Array<{ id, name, description?: string, related: boolean }>
}
```

规则：

- **已挂库**：`available` 可为空或仍列全部，但提示词以绑定库为准；检索仍只用绑定集  
- **未挂库**：`available` = 与当前 `session.workspaceId` 关联的库（`relatedWorkspaceIds` 含之）；若无关联库，可附「最近使用」最多 3 个（从 session metas 扫 `knowledgeBaseIds` 频次/时间，实现简单即可；太难则跳过最近使用，只荐关联库）  
- **绝不**返回文档标题列表或正文摘录  

`kb_search` / `kb_get` / `kb_propose_save`：未绑定（`knowledgeBaseIds` 空且无兼容 kbRoots）时保持空/error——加单测钉死「不可偷用」。

### C. 提示词（口头轻问）

在 `buildKbPromptAppend`（未绑定分支）追加：

- 若 `available.length > 0`：列出库名（可带一句话 description）  
- 规则文案（大意）：  
  - 仅当用户问题**明显**依赖项目规范/公约/资源统计等本地项目知识时，可**口头**问是否挂上《某库》参考  
  - **不要**说明如何挂（除非用户明确问怎么挂）  
  - 用户拒绝、表示不用、或忽略后继续聊别的 → **本会话不要再推荐**  
  - **未挂上前禁止**把知识库内容当作答案依据；也禁止调用 `kb_search`/`kb_get`/`kb_propose_save` 指望读到正文（调用也会空/失败）  
- 已绑定：保持现有 preferred/strict/off + 正式文档指引；可一句带过「无需再推荐挂载」

会话级「已拒绝推荐」：  
- **优先**靠对话上下文 + 提示词（不强制新 meta）  
- 可选增强：session meta `knowledgeBaseSuggestDismissed?: boolean`，由极薄工具 `kb_dismiss_suggest` 或用户说「不用」时 Agent 调用——**本轮可不做工具**，提示词约束即可；若实现成本低可加 meta 标志 + 小工具。

### D. UI（最小）

- 知识库详情：关联/取消关联当前工作区（需能读到当前 active workspace id；若管理页无 workspace 上下文，可用「输入/选择 workspace」或从 app 状态取 activeWorkspaceId——对照现有 workspace atoms）  
- **不要**做「建议挂上」弹窗/横幅  

### E. 单测

1. 未绑定：`kb_search` count=0；`kb_get` error；`kb_propose_save` error  
2. `kb_list_available`：未绑定 + 关联库 → 返回 name/id，无 content 字段  
3. 绑定后 search 仍只命中绑定库（回归）  
4. `buildKbPromptAppend` 未绑定且有 available 时含口头推荐规则与「不要教怎么挂」；无 available 时不硬荐  

跑：`bun test` 覆盖 kb-agent-tools / knowledge-base-store / 相关新文件。

### F. 文档回写

ROADMAP / FINDINGS / SPEC-v2 / AGENT-MODE：刀 3 ✅；刀 4 ✅。**2026-08-28**：知识库页「关联工作区」UI 已撤，荐库改靠最近使用兜底；下一刀按需 1.1 或 P1-3/P1-4。

## 验收

1. 未挂库问项目规范类问题 → Agent 可口头提到相关库名并询问；不出现操作教程。  
2. 未挂库时工具搜不到正文。  
3. 挂上后行为与刀 1/2 一致。  
4. 用户说不用后，同会话不再反复推销（提示词 + 手测）。  
5. 单测通过。

## 本轮不做

- 工作区「新会话默认挂载」开关（产品说可以后再加）  
- UI 确认挂载条  
- 自动 `updateSessionMeta` 挂库（即使用户口头说「挂上」——仍须用户在「+」里操作，除非另开刀；本轮 Agent **只问不代挂**）
