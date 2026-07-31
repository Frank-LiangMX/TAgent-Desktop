# Phase 3：pi 核 8k 协调器（会话内四层）

> pi 核会话内上下文分层调度。依赖 Phase 1.1（contextWindow）+ Phase 2.2（memorySnapshot 注入）。
> 决策：D2（四层）/ D3（接入 transformContext）/ D8（cache 断点）/ D11（L-rag 跨会话+本会话）。

---

## 3.1 新建 session-memory-coordinator

### 为什么新建而非纯扩 transformContext
`transformContext` 是 Pi Agent 的单点钩子（每轮一次），只管"本轮 messages 重组"，无状态。但四层预算/L-rag 检索/L-mid 滚动是**状态化的**，需跨轮持有（L-mid 摘要链、L-rag 命中缓存）。单点无状态函数不够。新建 `packages/pi-core/src/session-memory-coordinator.ts`，`transformContext` 仍作入口调 coordinator。

### 四层定义（D2）
| 层 | 内容 | 位置 | 性质 |
|---|---|---|---|
| L-fact | = L0/L2 固定注入 | system prompt（Phase 2 已做） | 冻结，命中 cache（D8） |
| L-short | 最近 N 条原文 | messages 区尾部 | 每轮变，主体（80%） |
| L-mid | 滚动递归摘要 | messages 区头部 | 每轮变，固定段（12%） |
| L-rag | 按需检索 L4/L2/L5 + 本会话 | messages 区头部 | 命中才占（8%） |

### 四层预算按 contextWindow 自适应（D3）
```
totalBudget = contextWindow - systemPromptTokens - toolsTokens - outputReserve
  // outputReserve = maxTokens（buildPlaceholderModel L966 的 8_192，也该按模型调，见 Phase 1.1）
比例分配（自适应 contextWindow 大小）：
  L-fact : 已在 system，不计 messages 预算（Frozen cache）
  L-rag  : 8%   （按需检索，命中才占）
  L-mid  : 12%  （滚动摘要，固定段）
  L-short: 80%  （最近原文，主体）
小窗口（<32k）：L-rag/L-mid 压到 4%/6%，L-short 90%（保近期完整）
大窗口（>200k）：L-mid 放 20%（更丰富摘要链），L-short 70%
阈值：L-short 占用达 80% 自身预算 → 触发 L-mid 压缩（把 L-short 最旧段压进 L-mid）
```
预算函数：`coordinator.allocateLayerBudgets(contextWindow, currentTokens)`。

### coordinator 状态（per-session，同 SessionEntry 生命周期）
- `lmidChain: string[]` — 摘要链（滚动递归）
- `lastRagQuery` + `lastRagHits` — L-rag 命中缓存
- 可选落盘 `projects/{slug}/{sessionId}.lmid.json`（崩溃恢复）

---

## 3.2 transformContext 接入 + L-mid 滚动 + 异步压缩 + 分流提取

### 改 `pi-agent-adapter.ts` transformContext（L595-636）
- 现状：调 `piCore.maybeCompactMessages`（整体压 → 摘要合并首条 user）。
- 改：调 `coordinator.reconcile(messages, { contextWindow, mode, sessionId, models, model })`。

### coordinator.reconcile 流程
1. 估 token（复用 `estimateContextTokens` from pi-agent-core）。
2. **未达 L-short 80% 阈值** → 返回原 messages（不压）。
3. **达阈值** → 找切点（复用 `findCompactionCutIndex`，user turn 边界，`pi-context-compaction.ts` L145-160）。
4. **分流提取**（D2 核心，新做）：
   - 切点前 `toSummarize` 段 → 喂 LLM 一次请求，prompt 要求同时产出三字段：
     - ① 摘要文本 → L-mid
     - ② 关键事实列表 → 喂 evidence sink（`memory-evidence-sink.writeNudgeEvidence`）或 consolidation candidates → 异步进 L5
     - ③ 是否有可检索原文片段标记（retrievable_spans，带关键词，进 L4 key_facts + 原文留面板存储可检索）
   - 复用 General `memory-consolidation-service.defaultExecutor` 多字段思路（一次 LLM 出多结构化字段），但 coordinator 用更轻 prompt。
5. 摘要 → 装配进 messages 头部（L-mid 段）。**改 `assembleCompactedMessages`**：现状"摘要合并进首条 user"，改"摘要进独立 system/summary 消息"（D8 滚动层进 messages 区，断 cache 本就预期）。
6. `retainedTail` → L-short 段，原样保留。
7. 写回 `agentRef.state.messages`（同现状 L620）。

### L-mid 滚动递归（改 maybeCompactMessages → coordinator 化）
- 现状 `maybeCompactMessages` 每次从当前历史重新生成摘要（Phase 1 限制注释 L262-264）。
- coordinator 持 `lmidChain`：reconcile 时把新切点前段压成摘要追加进链；链过长（>L-mid 预算）时把链最旧几条再压成一条（二次压缩，递归）。
- 链持久化：coordinator 实例 per-session Map；可选落盘 `projects/{slug}/{sessionId}.lmid.json`。

### 异步压缩不阻塞（D3/D7）
- `transformContext` 是同步 await（Pi Agent 每轮调，阻塞当轮）。
- **自动压缩异步化**：transformContext 检测需压缩时，先返回原 messages（本轮不压，不阻塞），同时 `void coordinator.compressAsync(...)` 后台跑，跑完写回 `state.messages`，下一轮生效。
- **风险**：本轮可能仍 prompt_too_long（没来得及压）。兜底：`pi-agent-adapter` L296-323 已有"过长 force compact 重试"路径，coordinator 的 force 压缩走同步（阻塞一次）救场。
- 即：**自动压缩异步（不阻塞日常轮），过长重试 force 压缩同步（救场）**。两条路径用同一 `coordinator.reconcile`（force flag 区分同步/异步）。

---

## 3.3 L-rag 检索（D11：跨会话 + 本会话）

### coordinator.reconcile 的 L-rag 步骤
1. 当前 user 消息文本 → 检索 query（取关键词/前 N 字）。
2. **跨会话**（D11）：调 `memoryLayerService.searchSessions(mode, query, limit=5)`（L4 FTS5，Phase 2 已移植）。
3. **全局事实/洞察**：`memoryLayerService.getMdContent(mode, 'L5')`（L5 洞察，Frozen 注入 system 时已含 L0/L1/L2，L-rag 只补 L5/L4 命中）+ L2（已在 system，L-rag 只补命中）。
4. **本会话**（D11，新做）：检索本会话已被压出 L-short 窗口的旧轮原文。
   - 需新增**本会话向量存储**：`projects/{slug}/{sessionId}.vectors.json`（或 sqlite-vec）。
   - 写入时机：L-mid 压缩时，被压出窗口的原文段 → 向量化（embedding，走渠道或本地模型）→ 存本会话向量库。
   - 检索：当前 query 向量化 → 本会话向量库 top-k → 命中旧轮原文片段注入。
   - **R9 成本**：长会话才建向量库，短会话跳过（消息数 < 阈值不向量化）。
5. 命中条目 → 拼成 `## 相关记忆（按需检索）` 段，进 messages 区头部（独立 user/system 消息，D8 滚动层进 messages）。
6. **来源标注**（页面增强用）：命中条目带 `{ source: 'L4:sessionSlug' | 'L5' | 'L2' | 'local:turnN', score }`，coordinator 返回 `ragHits`，pi-agent-adapter 经 `pendingSystemMessages` 推 `tagent_event { type:'rag_hit', hits }` 给渲染层标注。

### L-rag 命中缓存
- coordinator 持 `lastRagQuery` + `lastRagHits`，相同 query 不重复检索（保 cache + 省调用）。

### 本会话向量存储实现（用户已拍板：向量检索 + 渠道 API embedding）
- **不用 FTS5 关键词兜底**，用真正的向量语义检索。
- **embedding 来源**：调当前会话渠道的 embedding API（不发本地模型）。需确认各渠道的 embedding 接口能力（不是所有 provider 都有 embedding 端点，没有的渠道本会话 L-rag 降级跳过）。
- **向量库实现**（待定 A/B）：
  - 选项 A：纯 JS 向量（存 json，余弦相似度本地算）—— 简单，长会话量大时慢。
  - 选项 B：sqlite-vec（sqlite 扩展）—— 快，加依赖。
  - Phase 3 实现时二选一（倾向 B 用 sqlite-vec，与 L4 的 SQLite 同栈，长会话性能稳）。
- **R9 成本**：长会话才建向量库，短会话跳过（消息数 < 阈值不向量化）。embedding 调用要批量 + 缓存（同文本不重复 embed）。

### cache 断点顺应（D8）
- L-fact/L0-L2 进 systemPrompt（Phase 2 已做，稳定命中 cache）。
- L-mid/L-rag/L-short 进 messages 区（滚动，本就断 cache，预期行为）。
- pi-ai Anthropic 适配器自动在 system 末尾 + 最后一条 user 加 `cache_control` 断点（已查证，`pi-ai` dist/api/anthropic-messages.js L961 "Add cache_control to the last user message"）。
- **确认**：pi-core `createHttpDirectStreamFn` 是否已加 cache_control。无则在 coordinator 装配 messages 时给最后一条 user 的 content block 加 `cache_control: {type:'ephemeral'}`。
- L-rag 放 messages 最头部，变动只影响其后 L-mid/L-short，尾部最新 user 仍命中 cache（R3 对策）。

---

## Phase 3 完成标准

- [ ] `packages/pi-core/src/session-memory-coordinator.ts` 新建，四层 + 预算自适应 + lmidChain + ragHits 缓存
- [ ] `transformContext`（L595-636）改调 `coordinator.reconcile`
- [ ] 分流提取：一次 LLM 出 summary/facts/retrievable_spans，facts 进 evidence sink→L5
- [ ] L-mid 滚动递归（lmidChain + 链过长二次压缩）
- [ ] 异步压缩（自动异步不阻塞 + force 同步救场）
- [ ] L-rag 跨会话（L4 FTS5 + L2/L5）+ 本会话（向量/FTS5，待定方案）
- [ ] 来源标注 rag_hit 事件推渲染层
- [ ] cache 断点确认/补加

### Phase 3 验证细节
- **单测**：`allocateLayerBudgets`（8k/32k/200k/1M 自适应比例）；`reconcile`（80% 阈值切点 + 分流产出 summary/facts/spans）；lmidChain 滚动 + 二次压缩；ragHits 缓存。
- **集成**：pi-agent-adapter + mock streamFn，验证 lmidChain 持续 + pendingSystemMessages 事件（compacting/compact_complete/rag_hit）。
- **手测**：灌 200k+ 上下文，验证自动压缩异步不阻塞（本轮不卡）+ cache 命中（对比 token 计费 cacheRead 增长）；L-rag 命中历史会话注入 + 来源标注显示。
