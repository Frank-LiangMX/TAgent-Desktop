# TAgent 知识库 · 产品规格 v1

> 状态：已拍板；Phase 0 已完成，Phase 1 部分落地
> 依据：`KB-FEASIBILITY-R2-SYNTHESIS.md` + 用户拍板 2026-08-24
> 当前契约：以 KB-PRODUCT-SPEC-v2.md 为准，实施进度见 KB-PHASE0-FINDINGS.md
> 对外话术：**项目参考书**（比记忆更稳、比附件更好找）— 不向用户暴露 L0–L5 术语

---

## 0. 一句话定位

用户显式维护的 **知识库（Library）**：可挂多份文档/素材，会话里 **按需绑定 0..N 个库** 检索引用。
与 L0–L5 记忆、BotMemory **物理隔离**；解释权归用户（库 ≠ 项目文件夹）。

---

## 1. 用户已拍板（锁定）

| # | 决定 |
|---|------|
| **Q1 场景** | 先做 **A：能搜、能引用**；**B（素材池+成稿策展）预留**。存储 = **原样保存 + 派生可检索层**。PixelRAG **非 MVP**，仅作未来难文档可选 ingest |
| **Q2 作用域** | 库与 workspace/项目文件夹 **不强关联**；会话可 **绑多个库**；绑定与含义 **解释权归用户** |
| **Q3 写入** | **永远人工确认**（candidate → active）。不做信任模式自动 append（P2+ 再议） |

---

## 2. 边界（硬规则）

| 对比 | 规则 |
|------|------|
| **vs L0–L5** | KB **零写入** memory 层；L-rag **不读** KB。KB 检索独立 API。规范类问题：已绑定库命中 → **先采信 KB**，L5 作补充并标注来源 |
| **vs BotMemory** | 严格隔离。Bot **只读**授权库；KB 条目 **不得** activate 成 BotMemory；不收编（首年） |
| **vs 附件** | Chat 附件 ≠ KB；须显式「加入知识库」 |
| **注入** | KB 命中进 **messages 区头部**（与 L-rag 同位），**禁止**进 L0–L2 Frozen / system 稳定段。引用徽章 `[KB: 库名 · 条目标题]` |
| **写入** | Agent **不得**静默写 active。任何入库/改写先 candidate，用户确认唯一激活入口（抄 BotMemory 门控，独立队列） |

---

## 3. 概念模型

```
Library（库）          用户命名，如「TAgent-Desktop」「个人规范」
  └─ Collection        MVP：标签/模板字段即可，可不做独立表
       └─ Entry        用户可见的一条资料（文档/笔记）
            ├─ Asset   原文件（blobs，永远原样）
            ├─ Derived 派生文本（OCR/Office 抽取/抓取正文）
            └─ Fragment 检索单元（FTS5 索引）
```

**会话绑定**：`session.libraryIds: string[]`（0..N）。检索默认在绑定集合内联合搜；可临时指定单库。

**可选便利（非强制）**：UI 可「建议关联当前项目」，只写建议标签，不自动锁库。

---

## 4. 存储原则

```
~/.tagent[-dev]/knowledge-base/     # Phase 1；Phase 0 可先用目录
├─ kb.db                             # SQLite + WAL + FTS5
└─ blobs/{libraryId}/{entryId}.*     # 原件
```

| 用户投入 | Asset | Derived | Fragment |
|----------|-------|---------|----------|
| Markdown / 纯文本 | 原文件或内联 | ≈ 自身 | heading/段落切 |
| Word/PPT/Excel | 原件 | best-effort 抽文本/MD | 派生切块 |
| 截图 | 原图 | OCR/描述 | 描述文本 |
| 链接 | URL + 可选快照 | 正文 MD | 正文切块 |

- **Canonical 成稿格式（P2）**：Markdown；Office **不作**唯一真相，只作 Asset。
- **PixelRAG**：不进 P0/P1；P2+ 仅当复杂版式 PDF 检索失败再作可选派生管道。

---

## 5. 分期与验收

### Phase 0（≤1 周）— 去风险

**做：**
- 用户指定目录（或仓库内 `knowledge/`）中的 `.md` / `.txt`
- AgentTool：`kb_search` / `kb_get`（Pi `extraTools` + kscc `createSdkMcpServer`，照 kanban dual-mount）
- 会话可配置绑定路径/库名列表（多选）
- 命中结果带来源路径；Chat 可显示 `[KB: …]`

**不做：** 新 db、新 Rail 面板、写入、Office、向量、策展

**验收：**
1. 放入 2–3 份 TAgent 相关 MD，绑定后问「IPC / 目录约定」类问题，能命中并带来源
2. 未绑定则工具明确无库 / 空结果，不静默搜全盘
3. 不写 L0–L5、不碰 BotMemory

**闸门：** 若 Phase 0 已满足「能搜到」且用户暂无策展需求 → **可暂停**，不强制开 Phase 1。若需要面板/多格式/确认入库 → 开 Phase 1。

### Phase 1（3–4 周）— 自建瘦 MVP

**做：**
- `kb-store`：`libraries` / `entries` / `fragments`(+FTS5) / `stage`(candidate)
- 库 CRUD；模板仅影响默认 collection 标签（规范/架构/笔记/参考/待整理）
- 入库：MD/纯文本优先；其它格式 = 原件 + best-effort 派生
- 会话 `libraryIds[]`；`@kb` / 工具检索；来源徽章
- 用户显式「整理入库 / 加入知识库」→ candidate → 确认 → active
- KB Rail：库列表 / 条目列表 / 预览
- 独立 IPC（`KB_IPC_CHANNELS`），禁塞进 `memory-service`

**不做：** 素材池、Agent 主动合并、多视图导出、向量库、Office 高保真、PixelRAG、BotMemory 收编、信任模式 append

**验收：**
1. 创建两库，会话同时绑定，联合检索正确隔离未绑定库
2. 拖入 MD → 可搜可预览
3. candidate 未经确认不进检索结果
4. 注入不进 Frozen；与 memory 引用徽章可区分

### Phase 2（预留，用过再开）

素材池、Agent 提议合并（**diff + confirm + Revision**）、简单版本链、可选 Office 加强 / MCP 重解析。
触发建议（mimo）：观察期内确有合并/拼凑需求再开，不默认排期。

---

## 6. Agent 工具契约（P0/P1）

| 工具 | 作用 | 写权限 |
|------|------|--------|
| `kb_list_libraries` | 列出可用库 | 无 |
| `kb_search` | 在已绑定库（或指定 libraryId）内 FTS 检索 | 无 |
| `kb_get` | 按 entryId 取正文/片段 | 无 |
| `kb_propose_ingest`（P1） | 提议入库 → 只写 stage candidate | **仅 candidate** |

禁止：无确认直接改 active Entry。

---

## 7. 与现有代码挂载点（实现指引）

- 工具装配：仿 `kanban-agent-tools.ts`（Pi `extraTools` / kscc MCP）
- 门控：仿 `bot-memory-service.ts` 的 candidate→active，**独立文件/表**
- SQLite 范式：仿 `memory-layer-service.ts`（WAL + FTS5 + 迁移），**独立 `kb.db`**
- 注入：`agent-prompt-builder` / coordinator **独立段或工具返回**，不混 Frozen snapshot

---

## 8. 本轮不做（明确）

- PixelRAG / Qdrant / RAGFlow 默认进程
- Word/脑图/表格多视图导出管线
- Agent 无人值守改规范
- 库强制绑定 workspace
- 信任模式自动 append
- 与 BotMemory / L5 合并存储

---

## 9. 附录 · Phase B（整理成稿）效果验证（预留，非本轮）

开源无成熟「开箱整理」产品；可参考 Karpathy llm-wiki（raw+wiki）与 Provenance-First（防自毒化）。
**上 B 前须满足：**

1. A 已稳定：搜得到、来源对、用户愿意绑库
2. 仅 **提议 + diff + 确认**；raw/原件不可被 Agent 改写
3. 成稿句可回链到原件；一键回滚
4. 小库试跑（数十条级）；规范集合永不无人值守
5. 验收：「你是否敢把合并结果当正式规范」— 经常不敢则停在 A + 半自动归类

## 10. 文档关系

| 文档 | 角色 |
|------|------|
| `KB-FEASIBILITY-*.md` | 可行性与圆桌过程 |
| **本文件** | **产品契约（实现以此为准）** |
| `KB-PHASE0-brief.md` | Phase 0 派工 brief |
