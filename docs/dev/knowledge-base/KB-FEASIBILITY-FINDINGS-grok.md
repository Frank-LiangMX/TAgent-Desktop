# KB 可行性评审 · grok

## 一句话结论

**值得做，但必须作为与 L0–L5 / BotMemory 严格隔离的独立子系统；六层全量 + Agent 自动策展 + 多视图导出一次性上线不可行，应以「命名库 + 文档/素材入库 + FTS 检索 + 人机确认」为 MVP，把策展自动化与富媒体解析明确延后。**

---

## 可行性评级（产品/技术/集成 各 1–5 分 + 一句理由）

| 维度 | 分 | 理由 |
|---|---|---|
| **产品** | **3.5 / 5** | 「记忆 ≠ 知识库」心智正确且必要，但 brief 把「项目档案 / 素材池 / 增量成稿 / 多视图 / Agent 策展」捆成一条产品线，边界仍糊：附件、项目 wiki、协作室 BotMemory、会话绑定库的职责未钉死，六层模型对首发用户过重。 |
| **技术** | **4 / 5** | Electron 桌面 Agent 走 **SQLite（元数据 + FTS5）+ blobs 原文件 + 可选向量** 与现有 L4 FTS5、本会话 `session-vector-store` 同栈，落地成本可控；真正难点不在存，而在 Office/截图/网页 ingestion 质量与 Agent 合并正确性。 |
| **集成** | **3.5 / 5** | 挂载点清晰（独立 IPC + AgentTool/`@kb`，勿塞进 `lib/memory/`）；但与 8k L-rag、Frozen cache、BotMemory candidate→active、workspace 作用域的优先级与注入预算尚未设计，一做错会污染 prompt 与用户心智。 |

**综合**：可立项，**不可按用户完整愿望表一次交付**。先做「可检索的项目参考书」，再做「有门控的策展员」。

---

## 核心建议（3–5 条，可执行）

1. **先钉四元边界，再写 schema**  
   明确：`Memory(L0–L5)` = 交互沉淀；`KB` = 用户显式给 Agent 的参考书；`Attachment` = 单会话临时文件，默认不入库；`BotMemory` = 协作室 Bot 人设/经验，candidate→active 门控，**永不与 KB Document 互通写入**。缺这条，后续所有「Agent 整理入库」都会串库。

2. **砍六层为 MVP 三层，保留演进钩子**  
   MVP：`Library → Collection → Document|Source`。  
   `Fragment`（切块）可做内部实现细节、不对用户暴露；`View`（表格/脑图/Word）**必须延后**。成稿版本用 `DocumentRevision` 表即可，不必先上完整六层 UX。

3. **存储默认本地混合，外部 RAG 引擎列为「企业/重文档」分支**  
   默认：`kb.sqlite`（FTS5）+ `kb-blobs/` +（可选）sqlite-vec / 渠道 embedding。  
   **不要** MVP 默认拉起 Qdrant / RAGFlow / PixelRAG；仅当用户明确需要复杂版式 PDF/扫描件批量、或跨机共享检索时，再以 MCP/外部服务接入。

4. **策展必须抄 BotMemory 门控，禁止静默合并规范类成稿**  
   所有「合并 / 改结构 / 覆盖成稿」走 `candidate → user confirm → active`；规范类 Collection 默认 **append-only + 显式 diff 确认**。可复用 consolidation/stage-queue 的「空闲批量 + 确认」模式，但 **服务、表、IPC、UI 命名全部带 `kb-` 前缀**，禁止复用 `memory-consolidation-service` 写 KB。

5. **会话集成走「绑定 + 工具检索」，慎用自动全量注入**  
   推荐：会话/工作区绑定 0..N 个 Library；Agent 通过 `kb_search` / `kb_get` / `@kb` 按需取；仅「置顶规范」可进 system 短摘要。KB 命中进 messages 头部时必须遵守现有 D8 cache 纪律（稳定块进 system，变动块进 messages），且 **KB 预算与 L-rag(memory) 预算分账**，避免挤爆 8k 协调器。

---

## 推荐 MVP 范围（做 / 不做）

### 做（Phase 1–2 量级）

- 创建/重命名/归档 Library；模板建库（规范 / 架构 / 开发笔记 / 参考资料 / 待整理）  
- 入库：Markdown、纯文本、聊天「整理入库」产生 Source/Document；原文件进 blobs，元数据 + 全文进 SQLite FTS5  
- 素材池：零散 Source 列表 + 手动/半自动归入 Collection（确认后）  
- 会话绑定 Library + AgentTool 检索（标题/路径/FTS）+ 引用回显  
- 基础权限心智：KB 只读检索默认可开；写入/合并必须确认  

### 不做 / **必须延后**（至少一条硬延后）

| 事项 | 判定 | 原因 |
|---|---|---|
| **Word/Excel/PPT 高保真解析 + 版式感知切块（RAGFlow DeepDoc 级）** | **必须延后** | 桌面端自建成本与失败率最高；MVP 可用「存原件 + 抽纯文本（能抽多少算多少）」降级，复杂文档引导用户先转 MD/PDF 文本层 |
| 截图 OCR + 网页整站抓取入库 | 延后 | 依赖视觉/爬虫链路，和 Browser tools 边界易混；先支持「用户粘贴文本 / 另存 MD」 |
| Agent 无人值守自动合并成稿、自动改规范 | **明确不建议做（首年）** | 规范被幻觉改写是产品级事故；无 diff 门控等于劝退 |
| 多视图导出（Word / Mermaid 脑图 / 表格投影）作主路径 | 延后到 Phase 3+ | Canonical 先定 Markdown；导出是渲染问题，不是存储问题 |
| 默认引入 Qdrant/RAGFlow 进程 | **明确不建议做** | 与 Electron 单机分发、安装体积、运维心智冲突；用 MCP 作可选逃生舱即可 |
| 把 KB 条目写入 L2/L5 或反向用 consolidation 吞文档 | **明确禁止** | 直接违反 master-design「L5=交互沉淀」与用户诉求 |

---

## 推荐架构草图（文字或 ASCII）

```
┌──────────────────────────── TAgent Desktop ────────────────────────────┐
│  Renderer: KB 页（库/集合/条目） | Chat @kb | 确认门控 Toast/Diff       │
│                              │ IPC (kb-*)                              │
│  Main: KbService                                                   │
│    ├─ Library / Collection / Document / Source / Revision (SQLite) │
│    ├─ FTS5 index (title, path, body)                               │
│    ├─ blobs/  (original files, content-addressed)                  │
│    ├─ ingest pipeline (md/txt first; office=best-effort text)      │
│    ├─ curation queue (candidate ops → user confirm → commit)      │
│    └─ optional: embedding job → sqlite-vec (later)                 │
│                                                                        │
│  Agent runtime                                                         │
│    ├─ AgentTool: kb_search / kb_get / kb_propose_ingest              │
│    ├─ 8k coordinator: KB hits 与 memory L-rag **分预算、分来源标注** │
│    └─ Frozen system: 仅「绑定库的短规范摘要」可选注入；正文不进 Frozen │
│                                                                        │
│  隔离墙                                                                │
│    ✗ 不写 lib/memory L0–L5                                             │
│    ✗ 不写 BotMemoryRecord                                              │
│    ✗ 不把附件目录当 KB                                                  │
│    ✓ 可读：面板消息 →「整理入库」提案（经确认）                          │
└────────────────────────────────────────────────────────────────────────┘

外部可选（非默认）：MCP → AnythingLLM / RAGFlow / 文件夹 wiki
```

与 `docs/memory/master-design.md` 的衔接原则：

- L5 / L-rag 继续只服务「对话学会的东西」；KB 是另一条检索源。  
- D8 cache：KB 全文禁止塞进 Frozen；置顶规范摘要若注入 system，必须在绑定变更时重建 session（对齐 R7）。  
- handoff 已列「本会话向量 embedding」仍未完成——**KB 向量层应排在 memory 本会话向量稳定之后**，避免两条半成品 embedding 管线并行拖垮渠道适配。

---

## 主要风险与对策

| # | 风险（失败模式） | 对策 |
|---|---|---|
| R-KB1 | **心智坍缩**：用户把聊天废话、Nudge 事实、规范文档丢进同一「记忆」页 | 独立 Rail 入口「知识库」；文案禁止用 Memory 词汇；检索引用徽章区分 `memory` / `kb` |
| R-KB2 | **Agent 乱合并规范** | 规范 Collection 强制 diff 确认；无确认不 commit；提供一键回滚 Revision |
| R-KB3 | **检索噪声挤爆上下文** | 工具返回 top-k + 引用片段；自动注入默认关；与 L-rag 分预算（建议 KB≤L-rag 预算或单独开关） |
| R-KB4 | **ingestion 垃圾进索引**（扫描件、空 Excel、登录墙网页） | 入库状态机：`pending_parse → needs_review → indexed`；失败可见，不静默当成功 |
| R-KB5 | **与现有 better-sqlite3 / electron-rebuild 债叠加**（master-design R6） | KB 与 L4 分库文件（`memory-l4.sqlite` vs `kb.sqlite`），避免 migration 耦合；同依赖不同 schema |
| R-KB6 | **scope 膨胀拖死 Desktop 主线**（双核压缩、协作室仍在增强） | 硬门禁：MVP 不含多视图与富解析；未完成「绑定+检索+确认入库」不得开策展 Agent |

**最大的 3 个失败模式（答 Q7）**：

1. 做成「第二个 Memory」，用户分不清写哪、Agent 检索串味。  
2. 做成「全能 RAG 平台」，Electron 安装包与解析质量双双崩盘。  
3. 做成「自动文档员工」无门控，规范被改写后信任不可恢复。

**劝退 / 大幅缩 scope 条件**：

- 若资源只能保一条线，且 memory 真 LLM consolidation / 本会话向量仍未稳——**KB 应缩成「MD 文件夹 + FTS + 绑定检索」**，或暂用 Obsidian/目录 + MCP，而不是开六层子系统。  
- 若产品坚持「无人确认自动维护企业规范」——建议 **不做**（桌面 Agent 幻觉风险不可接受）。

---

## 与 L0–L5 边界建议（具体规则）

1. **写入隔离**：KB ingest/curation **零调用** `memoryLayerService` 写接口；Memory consolidation **零写入** KB Document。  
2. **读取隔离**：会话检索 API 分开：`memory.search*` vs `kb.search*`；coordinator 合并结果时必须带 `sourceType`。  
3. **优先级（规范类问题）**：若 Library 绑定且 KB 命中「规范/架构」集合 → **先采信 KB 成稿**；Memory L2/L5 仅作补充，且 UI 标明「来自对话记忆，可能过时」。  
4. **聊天整理入库**：允许从面板消息生成 KB Source **提案**，但默认不自动把同一内容再 Nudge 进 L5（用户勾选「同时记入记忆」才双写，且分两条确认）。  
5. **vs 附件**：Chat 附件 ≠ KB；提供显式「加入知识库」动作。  
6. **vs 项目 wiki**：若未来有 workspace 内 `.tagent/wiki`，应映射为「文件系统后端的一个 Library」，而不是第三套模型。  
7. **vs BotMemory**：BotMemory 继续 candidate→active；KB Document 不属于任何 BotProfile。协作室里 Bot 只能 **检索** 房间授权的 Library，不能把 KB 条目 activate 成 BotMemory。

---

## 开源借鉴清单

| 项目 | 抄哪一层（不要整包 fork） | 不抄什么 |
|---|---|---|
| **AnythingLLM** | Workspace↔文档绑定、本地优先、桌面「chat with docs」交互 | LanceDB 全家桶默认；其「一切进 workspace 向量」过粗，缺成稿/素材心智 |
| **Dify** | Knowledge 的 retrieval 模式（keyword / semantic / hybrid 权重）、应用侧挂载知识库的产品形状 | 可视化工作流平台本体；过重 |
| **RAGFlow** | DeepDoc/版式切块的**产品预期与降级文案**；hybrid BM25+vector 思路 | Docker 重引擎进默认安装；AGPL/运维成本 |
| **Khoj** | 笔记/Obsidian 同步「第二大脑」定位、定时研究 Agent 的边界感 | Postgres+pgvector 强依赖；AGPL |
| **sqlite-vec / 社区 sqlite-rag** | 单文件混合检索技术验证 | 当完整产品 |
| **Obsidian 文件夹 + MCP**（替代方案） | 若只想「项目档案可检索」：先做 Library=目录映射 + FTS，少造轮子 | 不能替代「素材池 + 确认成稿 + Agent 工具」的一体化体验——但可作为 Phase 0 验证 |

**用户漏看的替代路径**：

- **纯 wiki（Git MD）**：适合已有文档纪律的团队；TAgent 只需绑定目录 + 检索，不必自研成稿版本。  
- **外挂 AnythingLLM via MCP**：验证「要不要自建 KB」的便宜实验；自建的理由应是「素材池 / 确认策展 / 与双核会话深度绑定」，不是「又能 RAG」。

---

## 反对意见 / 若我是 devil's advocate

- **「六层很完整」是架构师爽点，不是用户爽点。** 用户要的是「把规范放进库、对话时找得到、偶尔让 Agent 帮忙归类」。Fragment/View 过早产品化，会让首屏像库管系统。  
- **「混合存储最优」不假，但向量不是第一天真理。** 代码库内规范/API 名以关键词为主，FTS5 往往比未调好的 embedding 更稳；过早上向量会重复 handoff 里未完成的 embedding 债。  
- **「Agent 策展」是差异化，也是最大坑。** 竞品多数停在 ingest→chunk→retrieve；TAgent 若要做合并成稿，必须先有比 BotMemory 更严的 diff UX，否则差异化变成差评化。  
- **与 master-design 抢带宽**：Phase 1–5 记忆刚落地，consolidation 真 LLM、本会话向量仍标「可加强」。KB 若并行开富解析，总监调度会被迫在双核稳定与 KB 华之间二选一——应故意选前者。  
- **不同意「KB 优先于 memory 回答一切」的绝对化**：仅对**用户标记为规范/档案**的集合成立；对「我们上周怎么决定的」类问题，memory L4 会话检索仍应优先。优先级必须按 Collection 类型配置，而不是全局硬编码。

---

## 待用户拍板的问题（≤5 个）

1. **Library 作用域**：全局（跨 workspace）还是绑定单个项目 workspace？会话能否同时绑多个库？  
2. **Canonical 格式**：成稿是否锁定 Markdown（+YAML frontmatter），Office 仅作 Source 原件？  
3. **MVP 是否包含「素材池 + 确认归类」**，还是第一期只做「直存文档 + 检索」？  
4. **规范类集合的写入策略**：永远人工确认，还是允许「信任模式」自动 append？  
5. **与外挂 RAG 的关系**：自建是主路径，还是接受「目录/Obsidian/AnythingLLM MCP」作为 Phase 0，自建延后？

---

## 分期粗估（答 Q5，供圆桌对照）

| Phase | 内容 | 粗估 | 最大技术债 |
|---|---|---|---|
| P1 | schema + IPC + MD/文本入库 + FTS 检索 + 会话绑定 + kb tools | 1.5–3 周 | 与 session/tooling 指纹、引用 UI |
| P2 | 素材池 + candidate 确认门控 + 简单增量 Revision | 2–3 周 | 策展 prompt 与误合并 |
| P3 | 可选向量、导出视图、best-effort Office、MCP 外挂 | 按需 | native/embedding/解析质量 |

**集成挂载点建议**：新 IPC 子系统 `kb-service`（主）+ Pi/kscc 双侧 AgentTool（会话能力）+ 可选 MCP 出口（互通）；**不要**把 KB 塞进 `memory-service` IPC。

---

*评审立场：产品架构完整性、竞品/开源对照、风险挑刺。只读评审，未改业务代码。对照：`docs/dev/knowledge-base/KB-FEASIBILITY-ROUNDTABLE-brief.md`、`docs/memory/master-design.md`、`docs/memory/handoff.md`，以及协作室 BotMemory 门控与现有 `lib/memory` 落地现状。*
