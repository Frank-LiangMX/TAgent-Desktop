# KB 可行性圆桌 · 三方汇总

> 来源：`KB-FEASIBILITY-ROUNDTABLE-brief.md`  
> 评审：`FINDINGS-kscc.md` / `FINDINGS-grok.md` / `FINDINGS-mimo.md`  
> 日期：2026-08-23

---

## 共识（三人一致）

1. **值得做，且必须与 L0–L5 严格隔离** — KB 是「用户给 Agent 的参考书/项目档案」，不是 memory 的扩展层。
2. **存储路线：SQLite + FTS5 + blobs**，向量/RAGFlow/Qdrant **非 MVP 默认**。
3. **六层模型过重** — MVP 砍到 **库 → 集合/标签 → 条目（+ 内部 fragment）**；View/成稿版本/素材池高级能力 **Phase 2+**。
4. **Agent 写库必须人机确认** — 复用 BotMemory 的 candidate→active 门控；**禁止静默合并规范**。
5. **注入纪律** — KB 不进 L0–L2 Frozen cache 段；与 L-rag 分预算、分来源标注；规范类问题 KB 优先于 L5 **但有条件**（仅规范/档案集合）。
6. **必须延后** — 多视图导出（Word/脑图/表格）、Office 高保真解析、无人值守自动策展、默认外部向量引擎。

---

## 分歧（供你拍板）

| 议题 | kscc | grok | mimo |
|------|------|------|------|
| MVP 厚度 | 库+MD/文本+FTS+@kb+candidate门控（2–3周×2 phase） | P1–P2 含素材池+半自动归类 | **极瘦**：库+直存+检索，策展/成稿/多格式全砍 |
| 是否自建 | 自建 `kb-store` + IPC（照抄 memory 范式） | 自建为主，MCP 作逃生舱 | **质疑自建**：Obsidian 文件夹 + MCP 可能够用 |
| Agent 策展 | P2 上，candidate 确认 | P2 核心差异化，但 diff 门控 | **P1 不做**，全部用户 confirm |
| 与 BotMemory | P1 并存，P2 评估收编 | 严格隔离，Bot 只读 KB | 文案上区分「参考书 vs Bot 经验」 |

---

## 推荐决策（总监综合）

**立项，但按「两阶段赌注」走：**

### Phase 0（1 周，可选验证）

若你还不确定要不要大建子系统：用 **项目内 `knowledge/` 目录 + 一个 KB 检索 MCP/AgentTool** 跑通「绑定库 + @kb 检索 + 来源标注」。零新 UI 也能验证高频场景。

### Phase 1（MVP，3–4 周）

- 独立子系统：`~/.tagent/knowledge-base/kb.db` + blobs
- 库 CRUD + 模板集合（规范/架构/笔记/参考/待整理）
- 入库：**Markdown/纯文本优先**；链接/截图/Office **仅存原件 + best-effort 文本**
- FTS5 检索 + 会话绑定 + `@kb` AgentTool（dual-mount 照 kanban）
- **candidate→active** 写入门控（抄 BotMemory）
- KB 面板（库列表 / 条目 / 预览）— 与 Memory 页同级 Rail
- Chat 引用带来源徽章 `[KB: xxx]`

### Phase 2（+3 周，验证后再开）

- 素材池 + Agent 提议合并/归类（带 diff 确认）
- 增量修订（Revision 链，非完整 Git）
- Office 解析加强（或接 RAGFlow MCP）
- 可选 sqlite-vec / 渠道 embedding

### 明确不做（除非 6 周验证后用户强要）

- Word/脑图/表格 **多视图导出管线**
- Agent **无人值守**改规范
- PixelRAG / 默认 Qdrant 进程

---

## 待你拍板的 5 题（合并三方）

1. **自建 KB 子系统 vs Obsidian/文件夹 + MCP？**（mimo 强烈建议先对齐）
2. **Library 作用域**：per-workspace 还是全局？会话能否绑多库？
3. **MVP 是否包含素材池/Agent 策展？**（kscc/grok 偏 P2；mimo 偏不做）
4. **规范集合写入**：永远 confirm，还是允许「信任模式」自动 append？
5. **Canonical 格式**：成稿是否锁定 Markdown，Office 仅作附件？

---

## 文档索引

| 文件 | 立场 |
|------|------|
| [KB-FEASIBILITY-ROUNDTABLE-brief.md](./KB-FEASIBILITY-ROUNDTABLE-brief.md) | 任务 brief |
| [KB-FEASIBILITY-FINDINGS-kscc.md](./KB-FEASIBILITY-FINDINGS-kscc.md) | 工程落地 / 分期 |
| [KB-FEASIBILITY-FINDINGS-grok.md](./KB-FEASIBILITY-FINDINGS-grok.md) | 架构 / 竞品 / 风险 |
| [KB-FEASIBILITY-FINDINGS-mimo.md](./KB-FEASIBILITY-FINDINGS-mimo.md) | UX / MVP 裁剪 |
