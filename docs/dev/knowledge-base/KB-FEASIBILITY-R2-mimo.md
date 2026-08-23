# KB 圆桌 R2 · mimo

## 读后总评（一段：对方哪里说服了你 / 哪里仍不同意）

读完 kscc 与 grok 的 FINDINGS，我必须承认：他们的「风险挑刺 + 工程落地视角」把我原立场的两处过头都削回去了——一是「MVP 砍到库+直存+检索」的三件套被证实可行，但需要保留 candidate→active 门控与独立 IPC（kscc/grok 都把这写成硬规则，少了就会从「轻」变成「脏」）；二是「质疑自建」那条我原以为可走 Obsidian+纯 MCP 兜底，grok 在 R-KB5/R-KB6 两条风险里指出 better-sqlite3 与 electron-rebuild 现成、AgentTool dual-mount 已有范式，自建成本其实可控，**「完全不自建」会让后续 candidate 门控、来源标注、置顶规范摘要等 UX 都无处挂载**。我仍坚持的只剩一条——MVP 拒绝 Agent 自动策展、规范类禁止无人值守重写，因为这是用户心智层最贵的一笔成本，做早一个月就多一个「乱合并规范」的翻车窗口。

## D1 MVP 厚度
- **原立场**：极瘦——库+直存+检索，策展/成稿/多格式全砍。
- **看了对方后最终立场**：**折中**。保留「库+直存+检索」三件套作为 Phase 1 必交，但增加 candidate→active 门控（来自 kscc 抄 BotMemory 的方案）作为不可省的 UX 闸门；素材池/Agent 策展/增量成稿/多视图全部明确延后到 Phase 2+。
- **理由**：kscc 的 R1「Agent 乱合并/乱改规范」+ R3「与 L0–L5 边界混淆」是真实威胁，没有门控就算只做直存也会出现「用户拖入就进库、Agent 顺手补一句总结写回去」的串味。grok 在「不做/必须延后」表里把六层砍到 Library→Collection→Document|Source 三层、Fragment 只做内部实现，这一刀我接受——Collection 当 tag 而非独立层，Document 与 Source 用 status=draft|published 区分（呼应 kscc 的 Entry 模型）。但多视图（脑图/Word/表格）我**坚持不做**：grok 自己 R-KB6「scope 膨胀拖死 Desktop 主线」+ kscc 反对意见第 1 条都证明这是低频长尾，Electron 安装包养不起 pandoc+markmap+docx-gen 三条依赖链。
- **对另外两方的回应**：对 kscc——你提的 FTS5 中文召回弱（jieba/trigram）我会写进 P1 技术债，但不会因此推迟 MVP 上线；对 grok——你提的「置顶规范摘要可进 Frozen」我反对，KB 命中段一律走 messages 区头部，与 L-rag 同位而非进 system 段（master-design D8 cache 纪律）。

## D2 是否自建
- **原立场**：质疑自建，Obsidian/文件夹 + MCP 可能够用。
- **看了对方后最终立场**：**改口，倾向自建独立 kb-store 子系统**，但保留 MCP 作为可选出口与 Phase 0 验证路径。
- **理由**：被 grok 的 R-KB5「与 better-sqlite3 / electron-rebuild 债叠加」说服——既然 L4 FTS5 已在跑，schema 范式 + 迁移机制现成，**自建不是从零挖地基，而是在已有的地基上加一层**。被 kscc 的「照搬 L4 范式」说服——`~/.tagent/knowledge-base/kb.db` + blobs + WAL + 触发器同步这条路径，与 memory-layer-service.ts 同栈，零新依赖。但我仍坚持：若用户 6 周内只用到了「直存整档 + @kb 检索」这两个动作，Phase 2 起就允许把存储层换成「文件夹 + frontmatter + 一个 KB MCP server」，**自建不是信仰，是工具**。MCP 作为逃生舱（grok 的方案）必须留接口，未来若用户要 AnythingLLM 风格的协作场景不必重写。
- **对另外两方的回应**：对 kscc——「复用而非新建」的提法我同意，但你说「复用 memory-layer-service.ts 写接口」我反对，**服务单例、db 单例、IPC 通道组都必须独立**，否则 R3「与 L0–L5 边界混淆」就会在第一个 IPC 改名时翻车。对 grok——「自建为主、MCP 作逃生舱」我完全同意，这条写进 brief v2 即可。

## D3 Agent 策展
- **原立场**：P1 不做，全部用户 confirm（更保守）。
- **看了对方后最终立场**：**坚持不松口**——Agent 策展 Phase 1 不上，规范类集合永久 append-only + 显式 diff 确认。
- **理由**：kscc 在反对意见第 1 条与 grok 在反对意见第 3 条**同时指出**「Agent 策展是差异化也是最大坑」——竞品多停在 ingest→chunk→retrieve，TAgent 若要做合并成稿，必须先有比 BotMemory 更严的 diff UX，否则差异化变成差评化。kscc 的「candidate-only 写入 + 用户确认唯一激活」我抄过来，但**只在「手动归类」场景开 candidate**——Agent 主动「发现两份规范重叠、提议合并」这种动作 Phase 1 砍掉，原因：用户根本没有「一个月内多次需要 Agent 主动策展」的高频证据，brief 里写「素材池待 Agent 归类」听起来 fancy 实则是抄 Notion AI / Anthropic Projects 的产物（呼应 kscc 反对意见第 1 条）。6 周验证期内看用户真实使用节奏——若每周 ≤1 次主动合并请求，Phase 2 仍不做。
- **对另外两方的回应**：对 kscc——你的「素材池 candidate→active」建议我承认它在 P2 有价值，但 P1 砍掉；对 grok——你的「P2 核心差异化但 diff 门控」我同意前提但反对时间表，P2 仍是「看数据再说」，**不是默认开**。

## D4 与 BotMemory
- **原立场**：文案上区分「参考书 vs Bot 经验」。
- **看了对方后最终立场**：**坚持 + 收敛**——文案区分 + 物理隔离 + 不收编。
- **理由**：grok 的边界规则第 4 条「KB Document 不属于任何 BotProfile；协作室里 Bot 只能检索房间授权的 Library」是把隔离钉死的最关键一句——一旦 KB 与 BotMemory 在数据层互通，「Bot 把对话里学到的事实写进 KB」或「KB 条目被 activate 成 BotMemory」两个方向都会出现，**用户体验层会立刻分不清「这个规范是 Bot 推的还是我给的」**。kscc 的 P1 并存、P2 评估收编我认为在工程上是合理的，但我主张把「评估窗口」拉长——Phase 2 末尾 + Phase 3 开头共 8 周观察期，看用户有没有主动「把 Bot 经验升级为项目档案」的请求，没有就不收编。**收编的最大成本不是工程，而是用户对「谁写的这句话」的信任会被稀释**。
- **对另外两方的回应**：对 kscc——「P2 收编」我保留窗口但不承诺时间表；对 grok——「严格隔离、Bot 只读 KB」我完全同意且认为应该写进 master-design 而非只写在 KB brief 里。

## 我的终裁推荐（给用户的单一路径，5–8 行）

- **Phase 0（1 周，可选验证）**：用本地 `knowledge/` 目录 + 一个 KB 检索 MCP server 跑通「绑定库 + @kb 检索 + 来源标注」三个动作，**不写新 IPC、不起新 db**，只为了回答「用户到底要不要自建」。
- **Phase 1（3 周，MVP 必交）**：`~/.tagent/knowledge-base/kb.db`（照搬 L4 范式，独立 db）+ blobs 原文件 + Markdown/纯文本/截图入库 + FTS5 + LIKE 中文 fallback + `@kb` AgentTool dual-mount + KB 面板（库列表/条目/预览，三栏）+ candidate→active 写入门控（仅手动归类场景）+ Chat 引用带 `[KB: xxx]` 来源徽章。**不做素材池、不做 Agent 主动策展、不做多视图、不做向量**。
- **Phase 2（+3–4 周，验证后开）**：若用户 6 周内出现 ≥3 次「想让 Agent 帮我合并/归类」的真实请求，再开素材池 + diff 确认门控 + 简单增量 Revision（status=draft→published 状态机，不做完整 Git）+ Office best-effort parser。
- **若只能选一条路写死**：Phase 1 的「库+直存+检索 + candidate 门控 + 来源徽章」——这是覆盖 80% 价值的最小集。

## 我愿意向谁让步、不愿让步什么

- **愿意让步**：接受自建独立 `kb-store` 子系统（不再坚持纯 MCP 兜底）；接受 candidate→active 门控从 P1 必交（不再坚持「全部用户直存」）；接受 Collection 用 tag 字段而非独立层（与 kscc/grok 收敛到三层）。
- **不愿让步**：P1 不开 Agent 主动策展（哪怕只是「发现两份重叠就建议合并」）；KB 命中段禁止进 Frozen（严格走 messages 区头部）；多视图（脑图/Word/表格）不在 Phase 2 默认范围内；KB 不被 BotMemory 收编，除非用户连续 8 周主动提需求。

## 仍需用户拍板的问题（≤3）

1. **KB 真实高频场景是「项目规范/参考资料」还是「多项目资料管理」？**——决定 Library 默认 per-workspace 还是全局，以及是否做跨库检索。
2. **MVP 验证期多长后用户接受「无 Agent 自动策展」状态？**——决定 Phase 2 何时开、或永远不开。
3. **BotMemory 与 KB 的关系**：P1 严格隔离（P2 再评估） vs P1 就统一收编——这是数据层决策，一旦定下来迁移成本大。