# KB 可行性评审 · kscc

> 立场：工程落地、与现有 TAgent 代码/文档对齐、分期实施。只读分析，未改业务代码。
> 对照基线：`docs/memory/master-design.md`（L0–L5 边界）、`docs/memory/handoff.md`（已落地能力）、
> `apps/electron/src/main/lib/memory/*`（存储/检索实现）、`lib/bot/bot-memory-service.ts`（candidate→active 门控）、
> `lib/kanban/kanban-agent-tools.ts`（AgentTool dual-mount）、`lib/config/config-paths.ts`（存储布局）。

## 一句话结论

KB 应该做，但要把它定位成「文档型记忆」而非新子系统：复用 `memory-layer-service.ts` 已验证的 SQLite+FTS5+WAL+迁移范式做存储，复用 `bot-memory-service.ts` 的 candidate→active 门控做 Agent 策展，把六层模型砍到「库→条目→片段」三层 + blobs 原文件，向量检索与多视图输出明确延后。

## 可行性评级（产品/技术/集成 各 1–5 分 + 一句理由）

- **产品 3/5**：用户诉求清晰，但「KB vs L0–L5 记忆 vs BotMemory vs 项目 wiki」边界尚未闭合，多视图（表格/脑图/Word）疑似伪需求，需先裁剪。
- **技术 4/5**：存储栈已被 L4 与 session-vector-store 验证（better-sqlite3 + FTS5 + embedTexts 渠道 API），ingestion（Office/截图/链接解析）才是真难点。
- **集成 4/5**：挂载点清晰（新 IPC 子系统 + AgentTool dual-mount，照抄 kanban），但要同步 `@tagent/shared` channels → preload → `App.tsx` 全局声明三处（已有踩坑记录）。

## 核心建议（可执行）

1. **照搬 L4 的 SQLite 范式建 `kb-store.ts`**：`~/.tagent[-dev]/knowledge-base/kb.db`，WAL + FTS5 + 触发器同步 + `addColumnIfNotExists` 幂等迁移，全部已在 `memory-layer-service.ts:218-279` 落地，不要新引存储引擎。better-sqlite3 的 native rebuild 风险（master-design R6）也已被 memory 踩过，electron-rebuild 流程现成。
2. **抄 BotMemory 的 candidate→active 做 Agent 策展门控**：Agent 整理（找上下文/去重/合并/写过渡/补结构）只产 `candidate` 草稿进 stage 队列，用户确认才是唯一激活入口（`bot-memory-service.ts:107-122,325-346`）。禁止 Agent 直接改 active 规范——这是避免「乱合并、乱改规范」的唯一可靠闸门，比写 prompt 规则强得多。
3. **六层砍到三层**：`Library → Entry → Fragment`。把「集合」降级为 entry 上的 `collection/tag` 字段而非独立层；把「素材(Source)」与「成稿(Document)」统一为带 `status=draft|published` 的 Entry（成稿就是 published 的 entry），用 `parent_entry_id` 表达「增量补充到已有成稿」；`View` 层整层延后。
4. **`@kb` 检索走 AgentTool dual-mount**：Pi 用 TypeBox `extraTools`、kscc 用 `createSdkMcpServer` 注入 `mcpServers.kb`，模式与 `kanban-agent-tools.ts:7-9` 完全一致。自动注入走 `agent-prompt-builder.ts` 但开**独立段**（`## 知识库快照`），绝不混进 L0–L2 Frozen snapshot 段——否则会污染 cache 命中（master-design D8）。
5. **分期与最大技术债**：
   - **Phase 1（~2–3 周）**：`kb-store.ts` + KB IPC（`kb-service.ts`）+ 单库 CRUD + Markdown/纯文本入库 + FTS5 检索 + `@kb` 工具 + 会话绑定 libraryId。**最大技术债：chunking/切片策略**——FTS5 默认分词对中文长句召回弱（`memory-layer-service.ts:497-502` 已记此坑并有 LIKE fallback），KB 文档比 session summary 长得多，必须先定切片粒度 + 中文分词（jieba 或 trigram）。
   - **Phase 2（~2–3 周）**：截图入库（走渠道多模态 OCR）+ 素材池 candidate→active + Agent 策展草稿 + 增量补充（`parent_entry_id` 版本链）+ Office parser（docx/xlsx/pptx 接开源，见下）。
   - **Phase 3（可选）**：向量语义检索（sqlite-vec 或沿用 `session-vector-store.ts` 的 embedTexts+JSON 余弦，持久化到 kb.db）+ 多视图输出。

## 推荐 MVP 范围（做 / 不做）

**做**：单库 CRUD；Markdown/纯文本入库；FTS5 + LIKE fallback 检索；`@kb` AgentTool（dual-mount）；candidate→active 策展门控；会话绑定库；KB 检索结果在规范类问题上优先于 L4 memory（注入排序 KB > L4）。

**不做 / 延后**：
- ❌ **多视图输出（表格/脑图 markmap/Word）→ 明确延后到 P3 或不做**（见「必须延后」）。
- ❌ 向量语义检索 → 延后到 P3，P1/P2 用 FTS5 + LIKE。
- ❌ Office（docx/xlsx/pptx）ingestion → 延后到 P2，P1 只收 Markdown/纯文本/截图。
- ❌ 素材池「Agent 自动归类入库」→ P1 只做手动归类 + candidate 确认，自动归类放 P2。
- ❌ 跨库检索 / 跨 workspace 共享库 → P1 不做，库默认 per-workspace。
- ❌ 增量补充的版本回溯 UI → P2 先存版本链，回溯 UI 放 P3。

## 推荐架构草图

```
~/.tagent[-dev]/
├─ memory/            ← L0–L5（Agent 自动沉淀，不动）
│  └─ sessions.db     ← L4 FTS5（L-rag 跨会话源）
├─ bot-memories.json  ← BotMemory candidate→active（不动）
├─ collaboration/     ← 协作室 FusionRoom（不动）
└─ knowledge-base/    ← 新增 KB（用户建库，独立 db/独立 IPC 段）
   ├─ kb.db           ← SQLite+WAL+FTS5（libraries/entries/fragments/stage）
   ├─ blobs/{libId}/{entryId}.{ext}   ← 原文件（docx/png/md 原样落盘）
   └─ vectors/        ← P3 可选：sqlite-vec 或 JSON 余弦

kb.db 表：
  libraries(id,name,template,workspace_id,created_at)
  entries(id,library_id,title,status,source_type,blob_path,content,
          parent_entry_id,version,created_at,updated_at)   -- status: draft|published
  fragments(id,entry_id,seq,text)  -- fragments_fts(FTS5) 触发器同步
  stage(id,library_id,kind,payload,created_at)             -- Agent 策展 candidate 草稿

接入：
  会话 meta 加 libraryId → buildKbPromptSection（独立段，非 Frozen，不进 cache 断点）
  @kb 工具 → AgentTool dual-mount（Pi extraTools / kscc mcpServers.kb）
  规范类问题 → 检索排序 KB > L4 sessions
```

## 主要风险与对策

- **R1 Agent 乱合并/乱改规范**：对策 = candidate-only 写入 + 用户确认唯一激活（抄 BotMemory `saveBotMemoryCandidate` + `activateBotMemory`），prompt 规则只是第二道防线。
- **R2 ingestion parser 体积与安全**：Office 文档含宏/外链，自建 parser 易爆依赖体积。对策 = blobs 原文件落盘 + 解析在主进程受限沙箱 + 优先接开源 parser 而非自写。
- **R3 与 L0–L5 边界混淆**：独立 db、独立 IPC 通道组、注入独立段。KB 不参与 consolidation/reflect/self-repair/cleanup。
- **R4 新增 IPC 三处同步**：`@tagent/shared` 加 `KB_IPC_CHANNELS` → preload `ipcRenderer.invoke` 暴露 → `App.tsx` 全局 `electronAPI` 类型声明（已有踩坑 memory：漏任一处渲染层 typecheck 报错）。
- **R5 FTS5 中文召回弱**：沿用 `buildMemoryLikeTerms` 思路做 fallback，KB 文档切片后建 trigram FTS5 或加 jieba 分词（P1 技术债）。
- **R6 切片粒度**：文档型 KB 片段远长于 session summary，`MAX_CHUNKS=200` / `slice(0,2000)` 这套 session 常量不能照搬，需独立调参。

## 与 L0–L5 边界建议（具体规则）

1. **来源对立**：L0–L5 = Agent 从交互自动沉淀（Nudge→evidence sink→空闲整理）；KB = 用户主动建库/上传/整理入库。两者写入路径完全不共用。
2. **注入对立**：L0/L1/L2 进 system prompt 的 Frozen snapshot 段（会话内冻结，保 cache，master-design D1/D8）；KB 不进 Frozen，只在「会话绑定库」时由 `buildKbPromptSection` 拼独立段（可滚、可断 cache），或经 `@kb` 工具按需检索。
3. **检索对立**：L-rag 的跨会话源是 L4 sessions.db + L2/L5 MD（master-design D11），**KB 不进 L-rag 源**；KB 有自己的 `@kb` 检索。规范类问题排序 KB > L4，但二者结果分别返回、不混表。
4. **门控对立**：L0–L5 写入走 Nudge→stage queue→accept（`memory-service.ts` ACCEPT_STAGE_*）；KB 写入走 candidate→active（`bot-memory-service` 同型）。两套 stage 队列物理隔离，不共用文件。
5. **共享件**：可复用 `memory-llm-client.embedTexts`（embedding 渠道 API）、better-sqlite3 句柄范式、AgentTool dual-mount 模式、`atomic-json`/`writeJsonAtomic`。但服务单例、db 单例各自独立。
6. **与 BotMemory 的关系（待拍板）**：BotMemory（`bot-memories.json`，per-bot 用户策展记忆）与 KB 在「candidate→active + 用户策展」上同型，可视为 KB 的「条目级短记忆」特例。建议 P1 先并存、不合并；P2 评估把 BotMemory 收编为 KB 的一个内置库（system 库），统一门控。

## 开源借鉴清单

- **RAGFlow / AnythingLLM**：抄 ingestion + chunking 策略层（切片、去重、分块元数据），不抄其 web 框架与向量后端。
- **Khoj**：抄 org-mode/markdown 索引 + FTS 的极简桌面思路，验证「纯本地 + FTS 够用」。
- **sqlite-vec / sqlite-rag-mcp**：若 P3 做向量，抄 sqlite-vec 作为 sqlite 扩展，避免引独立 Qdrant/Milvus 进程（桌面 Agent 不该常驻向量服务）。
- **不抄 Dify 整包**：web-first、重编排、与桌面单机模型不匹配。
- **用户漏考虑的替代**：**「Obsidian/本地文件夹 + 一个 KB 检索 MCP server」**——让用户用现成笔记工具建库，TAgent 只实现一个只读检索 MCP（走现有 `mcp-service.ts` 的 `mcp.json` 机制，零新存储）。这条值得在拍板前认真权衡，可能是「不建 KB 子系统」的最优解（见反对意见）。

## 反对意见 / 若我是 devil's advocate

1. **多视图是典型「用户提了但不会用」的功能**：表格/脑图/Word 导出听着完整，但桌面 Agent 用户真正高频的是「检索 + 注入」，导出是低频长尾。MVP 做了大概率 0% 使用率，却要养 pandoc/mermaid→markmap/docx-gen 三条依赖链。建议整段砍到 P3 之后，甚至不做——真要导出就让用户复制 Markdown。
2. **六层模型是过度设计**：连 L0–L5 都还在收敛期（handoff 列了 consolidation/reflect 真 LLM 接线、本会话向量等多项「仍可加强」），KB 再叠六层是堆复杂度。三层 + 一个 status 字段就能覆盖 90% 场景。
3. **最该质疑的是「要不要自建」**：已有 `mcp-service.ts` 支持 per-workspace 配外部 MCP server，已有 `session-vector-store` + FTS5。若用户主要诉求是「让 Agent 查得到我的项目文档」，最低成本方案是「本地文件夹 + 一个只读 KB 检索 MCP server」（可复用社区 MCP），完全不用新建子系统、不用新 db、不用新 IPC。自建 KB 的合理前提是：用户确实需要 Agent 策展入库（合并/补结构/版本），而不只是检索。如果只是检索，MCP 方案更轻。

## 待用户拍板的问题（≤5 个）

1. **KB 与 BotMemory 是否合并？** BotMemory 已是 candidate→active 的用户策展记忆，KB 是其文档化升级。P1 并存、P2 收编，还是 P1 就统一？
2. **向量检索是否 P1 必须？** 还是 FTS5 + LIKE + 中文分词在桌面单机场景已够用？（影响是否要引 sqlite-vec / 持久化向量）
3. **多视图（表格/脑图/Word）是真需求还是 nice-to-have？** 若非高频，建议明确延后到 P3 或不做。
4. **素材池「Agent 自动归类入库」是否 P1？** 还是 P1 只做手动归类 + candidate 确认，自动归类放 P2（牵涉后台 job + 人机确认点设计）。
5. **KB 是 per-workspace 还是跨 workspace 共享？** 影响 `libraries.workspace_id` 是否可空、检索时是否跨库——跨库会显著放大 R3 边界混淆风险。

## 必须延后事项（明确）

- **多视图输出（表格/脑图/Word 导出）**：明确延后到 P3，或直接不做。理由：低频长尾 + 三条额外依赖链 + 与「检索/注入」核心价值无关，是本次评审最该砍的能力。
- **Office（docx/xlsx/pptx）ingestion**：延后到 P2，P1 只收 Markdown/纯文本/截图，避免 parser 体积与安全风险在 MVP 阻塞。
- **向量语义检索**：延后到 P3，P1/P2 用 FTS5 + LIKE + 中文分词 fallback，先证明检索价值再上向量。
