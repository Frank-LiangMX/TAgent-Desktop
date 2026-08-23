# 可行性圆桌 brief · TAgent 独立知识库子系统

> **任务类型**：只读分析 + 落盘评审意见，**不改业务代码**  
> **仓库**：`C:\Users\loumi\Desktop\AI\TAgent-Desktop`  
> **必读背景（节选）**：  
> - `docs/memory/master-design.md` — L0–L5 记忆体系边界  
> - `docs/memory/handoff.md` — 已落地的 memory/RAG 能力  
> **产出路径（各 agent 写各自文件）**：  
> - kscc → `docs/dev/knowledge-base/KB-FEASIBILITY-FINDINGS-kscc.md`  
> - grok → `docs/dev/knowledge-base/KB-FEASIBILITY-FINDINGS-grok.md`  
> - mimo → `docs/dev/knowledge-base/KB-FEASIBILITY-FINDINGS-mimo.md`

---

## 0. 用户原始诉求（汇总）

用户希望为 TAgent Desktop **新建一套与 L0–L5 记忆分离的「知识库」子系统**，不是把文档塞进 memory layer。

### 与 L0–L5 的明确边界

| | L0–L5 记忆 | 知识库（新） |
|---|---|---|
| 来源 | 对话自动沉淀、Nudge、consolidation | 用户建库、上传、聊天整理入库 |
| 内容 | 画像、事实、纠错、会话摘要、洞察 | 项目规范、开发文档、参考资料、成稿 |
| 组织 | 固定 L0–L5 层 | 用户命名库（如 `TAgent-Desktop`）→ 集合/分类 → 条目/成稿 |
| 心智 | Agent 从交互里「学会」 | 用户给 Agent 的「参考书 / 项目档案」 |

### 用户期望的能力（完整）

1. **多格式入库**：自然语言（聊天）、截图、网页链接、Word/Excel/PPT、Markdown、Mermaid 等  
2. **有条理归类**：不是散乱文件堆；创建库时有框架/模板（如：规范、架构、开发笔记、参考资料、待整理）  
3. **三种入库模式**：  
   - 直存完整文档  
   - 素材池（零散一页/截图/几句话，待 Agent 归类）  
   - 增量补充（隔段时间补到已有成稿，带版本）  
4. **Agent 策展**：找上下文、去重、合并、写过渡、补结构；用户确认后入库  
5. **会话可检索**：绑定库、`@kb`、工具检索、自动注入（KB 优先于 memory 回答规范类问题）  
6. **多视图输出**：同一份知识可导出/呈现为表格、脑图（Mermaid/markmap）、Word 文档  
7. **存储选型疑问**：SQLite vs 向量/RAG vs JSONL vs 其他；有无开源可借鉴  

### 已讨论的技术倾向（供评审，非定论）

- **混合存储**：SQLite（元数据 + FTS5）+ blobs 目录（原文件）+ 可选 sqlite-vec/向量（语义检索）  
- **JSONL** 仅作审计/队列，不作主库  
- **六层模型**：库 → 集合 → 素材(Source) → 片段(Fragment) → 成稿(Document) → 视图(View)  
- **开源参考**：Dify/RAGFlow/AnythingLLM/Khoj/sqlite-rag-mcp 等，无完全匹配产品  
- **TAgent 现状**：已有 L4 FTS5 + 本会话向量（memory），无 KB 概念；MCP/extraTools 可接外部 RAG  

---

## 1. 评审方需回答的问题

请从 **产品可行性、技术可行性、风险、分期、与 TAgent 架构契合度** 五方面评审：

### Q1 产品定义是否清晰？缺什么？

- 「知识库 vs 记忆 vs 附件 vs 项目 wiki」边界是否还需定义？  
- 六层模型（库/集合/素材/片段/成稿/视图）是否过重？有无更简 MVP？  

### Q2 技术栈建议

- SQLite + FTS5 + blobs + 可选向量，是否是 Electron 桌面 Agent 的最优解？  
- 何时需要 Qdrant/RAGFlow/PixelRAG 等外部组件？  
- Office/截图/链接的 ingestion 应自建还是接开源 parser？  

### Q3 Agent 策展的可行性与陷阱

- 「Agent 有意识整理、拼凑、隔段时间补全」需要哪些后台 job / 人机确认点？  
- 如何避免 Agent 乱合并、乱改规范、版本冲突？  
- 与现有 memory consolidation、Bot candidate→active 门控如何复用而不混淆？  

### Q4 多视图输出（表格/脑图/Word）

- 存储层应保留什么 canonical 格式？  
- pandoc/docx、Mermaid→mindmap 等是否应 MVP 内？  

### Q5 与 TAgent-Desktop 集成

- 推荐挂载点：新 IPC 子系统 vs MCP vs AgentTool？  
- 和 `docs/memory/`、协作室 BotMemory 的隔离策略？  
- 预估 Phase 1–3 各做什么、多久、最大技术债在哪？  

### Q6 开源借鉴 vs 自建

- 最该抄哪几个项目的哪一层（不要整包 fork）？  
- 有没有用户漏考虑的替代方案（例如 Obsidian 文件夹 + MCP、纯 wiki）？  

### Q7 红旗与劝退条件

- 什么情况下建议 **不做** 或 **大幅缩小 scope**？  
- 最大的 3 个失败模式是什么？  

---

## 2. 产出格式（强制）

写入各自 FINDINGS 文件，结构：

```markdown
# KB 可行性评审 · {agent名}

## 一句话结论
## 可行性评级（产品/技术/集成 各 1–5 分 + 一句理由）
## 核心建议（3–5 条，可执行）
## 推荐 MVP 范围（做 / 不做）
## 推荐架构草图（文字或 ASCII）
## 主要风险与对策
## 与 L0–L5 边界建议（具体规则）
## 开源借鉴清单
## 反对意见 / 若我是 devil's advocate
## 待用户拍板的问题（≤5 个）
```

**禁止**：空泛 praise；禁止改代码；禁止 commit。  
**允许**：读仓库内 docs/ 与 memory 相关路径做对照（只读）。

---

## 3. 评审立场提示

- **kscc（glm-5.2）**：偏工程落地、与现有 TAgent 代码/文档对齐、分期实施  
- **grok**：偏产品架构完整性、竞品/开源对照、风险挑刺  
- **mimo**：偏 UX/用户心智、Agent 行为设计、MVP 裁剪  

三人可 disagree；分歧写进「反对意见」段。

---

## 4. 验收

- 各自 FINDINGS 文件存在且结构完整  
- 每份 ≥ 800 字（中文为主）  
- 至少 1 条「明确不建议做」或「必须延后」的事项
