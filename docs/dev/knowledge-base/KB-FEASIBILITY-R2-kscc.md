# KB 圆桌 R2 · kscc

> 立场：工程落地与工期真实性。只读复评，未改业务代码。
> 对照：R1 三方 FINDINGS + SYNTHESIS 分歧表 + 仓库近期 commit（FusionRoom 仍在落地）。

## 读后总评（一段：对方哪里说服了我 / 哪里仍不同意）

读完两方后，我被 **mimo 的「做早了 > 做多了」** 和 **grok 的「MCP 作逃生舱 + Phase 0 验证」** 在「是否一上来就自建子系统」这一点上共同说服了——我 R1 虽在反对意见里提过 Obsidian+MCP 替代，但主路径仍直奔自建，这是工期上的冒进。我也被 **grok 在 D4 的「BotMemory 严格隔离、Bot 只读 KB」** 说服，撤回我 R1 的「P2 评估收编」——因为收编会撞上正在开发的 FusionRoom（近期 commit `09e76ac`/`76ea2d0` 才刚落地 transport 与 room title），工期上不可行。但我仍不同意 mimo 的「Obsidian+MCP 永远够用、不必自建」：用户诉求 #3 增量补充带版本、#4 Agent 策展合并，是文件夹+只读 MCP 在物理上做不到的（文件夹没有版本链、没有合并成稿的写路径），自建是被用户自己列出的诉求倒逼的，只是不该在 day 1 就全量开。也不同意 grok 把素材池塞进 P1-P2 的厚度——素材池在我 R1 的 schema 里就是 `status=draft` 的 entry，不是独立层，P2 作为「行为」落地几乎不额外花存储成本，但 P1 塞它会拖长 MVP。

## D1 MVP 厚度
- 原立场：库 + MD/文本 + FTS + @kb + candidate 门控，约 2–3 周 × 2 phase（P1 检索三件套，P2 candidate+策展+素材池）。
- 看了对方后最终立场：**折中，P1 让步给 mimo 的极瘦，P2 守住策展与素材池（作为 draft entry，非独立层）**。
- 理由（≥3 句，须点名引用对方 1 条具体论点）：
  - mimo 说「最大风险不是做多了，是做早了」「MVP 做素材池 = 90% 时间维护 10% 场景」——这条在工期上成立：P1 的真成本不是 candidate 门控（那只是抄 `bot-memory-service.ts:107-122` 的 stage 表 + confirm UI，2–3 天），而是新 SQLite store + IPC 三处同步（R4）+ AgentTool dual-mount + 中文 FTS5 分词调参（R5/R6），这些跟有没有素材池无关。所以 P1 应该砍到 mimo 的「库+直存+检索注入」三件套，先把 2–3 周花在存储/IPC/检索底座上。
  - 但我**不同意 mimo 把素材池从路线图里彻底删掉**：mimo 说「200 行代码、不需要六层」是对检索型 KB 成立，对用户诉求 #3/#4 不成立。我 R1 已把 Source 与 Document 统一成 `entries(status=draft|published, parent_entry_id)`，素材池就是 draft entry，P2 落地不额外建表。砍掉它不是因为厚，而是因为 P1 没有 Agent 写入就没有 candidate 可确认——这是时序问题，不是厚度问题。
  - 对 grok「P1–P2 含素材池 + 半自动归类」我反对塞进 P1：半自动归类牵涉 Agent 归类 prompt + candidate→active confirm UX + diff 预览，这是 P2 的活，塞 P1 会让 MVP 从 3 周变 5 周。
- 对另外两方的回应：
  - 对 mimo：接受 P1 极瘦，但拒绝「永久不做策展/素材池」——那是把用户已写明的诉求 #3/#4 当 nice-to-have 砍掉。
  - 对 grok：同意素材池/策展是 P2 核心差异化，但不同意它进 P1；P1 厚度应向 mimo 靠拢。

## D2 是否自建
- 原立场：自建 `kb-store` + IPC（照抄 memory 范式），但反对意见里已留「若只检索则 MCP 更轻」。
- 看了对方后最终立场：**坚持自建为最终目标，但接受「Phase 0 赌注」向 mimo/grok 让步——先用文件夹 + 只读检索 AgentTool 验证 1 周，再决定是否开 Phase 1 自建**。
- 理由：
  - grok 的「MCP 作逃生舱」与 SYNTHESIS 的 Phase 0（项目内 `knowledge/` 目录 + KB 检索 AgentTool，零新 UI 验证高频场景）在工程上是最省工期的去风险动作，我接受。mcp-service.ts 已支持 per-workspace 外部 MCP，dual-mount 模式（`kanban-agent-tools.ts:7-9`）现成，Phase 0 基本是挂一个只读检索工具，1 周可跑通「绑定库 + @kb + 来源标注」。
  - 但我**不同意 mimo 的「Obsidian/文件夹 + MCP 可能够用、不必自建」作为终态**：文件夹 + 只读 MCP 物理上没有写路径——它做不到 user 诉求 #3 的「增量补充带版本」（没有 `parent_entry_id` 版本链）、#4 的「Agent 策展合并」（没有 candidate→active 写入门控）、#6 的多视图成稿。mimo 自己也承认「如果用户其实有多人协作 + 项目档案场景，Obsidian 路线就不够」——而 brief 的「项目档案 + 成稿」正是这个场景。所以自建不是架构师爽点，是被诉求倒逼。
  - 工程上要诚实指出：mimo 说「200 行代码搞定」低估了——无论是走 IPC 还是 MCP，检索引擎（SQLite+FTS5+中文分词+LIKE fallback）是同一份代码，差别只在 transport 和是否拥有 store。真正的省力点不是「MCP vs IPC」，而是「索引用户的文件夹（B）」vs「拥有自己的 kb.db（A）」。Phase 0 走 B，验证策展需求后 Phase 1 转 A，这才是工期最优。
- 对另外两方的回应：
  - 对 mimo：接受 Phase 0 验证以避开「做早了」，但拒绝把 B 路线当终态——它服务不了诉求 #3/#4。
  - 对 grok：同意「自建为主、MCP 作逃生舱」，Phase 0 就是那个逃生舱的工程化落地。

## D3 Agent 策展
- 原立场：P2 上，candidate 确认。
- 看了对方后最终立场：**坚持 P2，但升级为「candidate 门控 + diff 确认 UX + Revision 回滚」三件套——吸收 grok 的 diff 门控，对冲 R1 误合并风险**。
- 理由：
  - grok 的「规范 Collection 强制 diff 确认；无确认不 commit；提供一键回滚 Revision」是我 R1 漏的工程要件。我 R1 只说了 candidate→active，但规范类合并光靠 yes/no confirm 挡不住「Agent 把规范悄悄改一个字」——必须 diff 视图 + 一键回滚。这直接抬高了 P2 工期：P2 不是「抄个 stage 表就完」，而是 candidate 门控 + diff UX + Revision 链三件套，所以 P2 仍是 2–3 周而非更短。
  - mimo 的「P1 不做、全部用户 confirm」与我的 P2 不冲突——P1 本来就没有 Agent 写入，自然全是用户手动。但 mimo 说「KB 阶段不该引入新的 Agent 自主写权限」，我部分同意：P2 引入的是「Agent 提议、用户确认」的 candidate-only 写入，**不是自主写**——Agent 只产 draft 进 stage 队列，激活权在用户。这跟 L5 consolidation 的 Nudge→accept 是同型门控，但物理隔离（独立 stage 表、kb- 前缀，不共用 `memory-service` 的 ACCEPT_STAGE_*）。
  - mimo「与 L5 consolidation 行为重叠、用户分不清」是心智风险不是工程阻塞——用 grok 的 kb- 前缀命名隔离 + mimo 的文案区分 + 我的独立 stage 队列三重隔离可解。
- 对另外两方的回应：
  - 对 grok：接受 diff 门控与 Revision 回滚作为 P2 必选，这抬高了 P2 成本，我承认。
  - 对 mimo：同意 P1 不开 Agent 写入，但拒绝「永远手动」——诉求 #4 明确要 Agent 策展，P2 上的前提是 diff 门控就位，而非不做。

## D4 与 BotMemory
- 原立场：P1 并存，P2 评估收编。
- 看了对方后最终立场：**改口向 grok——P1/P2 严格物理隔离，Bot 只读 KB，收编推迟到 P3+ 且需 FusionRoom 稳定后再评估**。
- 理由：
  - grok 的「BotMemory 继续 candidate→active；KB Document 不属于任何 BotProfile；协作室里 Bot 只能检索房间授权的 Library，不能把 KB 条目 activate 成 BotMemory」是比我 R1 更干净、更保守的隔离规则，我采纳。
  - 我 R1 的「P2 评估收编」在工期上不成立：收编要把 `bot-memories.json` 迁进 kb.db、统一两套 candidate→active、并改协作室 Bot 读写路径——而 FusionRoom 正在开发中（`09e76ac` transport 启动刚接 gate+TLS，`76ea2d0` room title/goal 编辑刚上）。在子系统还在变的时候去收编它的下游依赖，是典型的工期冒进。所以收编最早 P3+，且前置条件是 FusionRoom 稳定。
  - mimo 的「文案上区分『参考书 vs Bot 经验』」是 grok 隔离规则之上的 UX 层，同意叠加：隔离是骨架，文案是皮肤，两者不矛盾。
- 对另外两方的回应：
  - 对 grok：完全采纳严格隔离，撤回收编主张。
  - 对 mimo：同意文案区分，但文案不能替代物理隔离——必须 grok 的隔离在先。

## 我的终裁推荐（给用户的单一路径，5–8 行）

1. **Phase 0（1 周）**：项目内 `knowledge/` 目录 + 只读 KB 检索 AgentTool（dual-mount），跑通「绑定库 + @kb 检索 + 来源徽章」，零新 UI、零新 db——验证检索是否高频，是对冲「做早了」的最低成本赌注。
2. **Phase 1（3–4 周，Phase 0 验证策展需求后才开）**：自建 `kb-store` 子系统（`~/.tagent[-dev]/knowledge-base/kb.db` + blobs，照抄 `memory-layer-service.ts` 的 WAL+FTS5+幂等迁移）；库 CRUD + 五模板；MD/纯文本/手动聊天文本入库；FTS5 + 中文分词 + LIKE fallback；`@kb` AgentTool；会话绑定 libraryId；KB 面板（与 Memory 同级 Rail）；引用带 `[KB: xxx]` 徽章。**No Agent 写入。**
3. **Phase 2（3 周）**：candidate 门控（抄 BotMemory）+ **diff 确认 UX + Revision 回滚** + Agent 策展草稿（含「聊天整理入库」提案）+ 素材池（draft entry，非独立层）+ 增量版本（`parent_entry_id` 链）。独立 stage 队列、全 `kb-` 前缀，禁碰 `memory-consolidation-service`。
4. **严格不做（除非 6 周验证后用户强要）**：多视图导出（Word/脑图/表格）、Office 高保真解析、无人值守自动策展、默认 Qdrant/RAGFlow、BotMemory 收编。
5. **与 BotMemory**：P1/P2 严格物理隔离，Bot 只读 KB，KB 条目不得 activate 成 BotMemory；收编最早 P3+ 且需 FusionRoom 稳定后评估。
6. **若只能选一条路写死**：走 SYNTHESIS 的「两阶段赌注」——Phase 0 先验证，再决定 Phase 1 自建。别一上来就开六层子系统。

## 我愿意向谁让步、不愿让步什么

- **向 mimo 让步**：P1 厚度砍到「库 + 直存 + 检索注入」极瘦三件套；接受 Phase 0 验证以对冲「做早了」。**不让步**：不把素材池/策展从路线图永久删除——诉求 #3/#4 需要它们，且 schema 已让 P2 落地几乎零存储成本。
- **向 grok 让步**：D4 改口严格隔离、Bot 只读 KB、撤回收编；D3 吸收 diff 门控 + Revision 回滚作为 P2 必选。**不让步**：素材池不进 P1（grok 想塞 P1-P2，我坚持 P2-only）。
- **不愿让步**：candidate→active 门控是 Agent 写库的唯一可靠闸门，比 prompt 规则强——这点三方一致，不退；IPC 三处同步（shared→preload→App.tsx）是硬约束，漏一处渲染层 typecheck 即报错，已有踩坑 memory，不可省。

## 仍需用户拍板的问题（≤3）

1. **Phase 0 的 KB 检索 AgentTool 索引什么**：项目内 `knowledge/` 目录（我们建样例），还是用户指一个已有 Obsidian/markdown 文件夹？——决定 Phase 0 是否真的零新存储、能否直接复用用户已有笔记。
2. **Library 作用域**：per-workspace 还是全局？会话能否绑多库？——影响 `libraries.workspace_id` 是否可空、跨库检索是否开（跨库会放大 R3 边界混淆风险，我倾向 P1 不开跨库）。
3. **规范集合写入策略**：永远人工 confirm，还是允许对某库开「信任模式」自动 append（grok Q4 / SYNTHESIS Q4）？——若允许信任模式，P2 的 diff 门控需额外做「append-only 无 diff」快路径，工期 +3 天，需现在定。
