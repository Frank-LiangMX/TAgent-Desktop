# Phase 5：阈值自学习 + 跨核格式统一 + 页面增强 + 验证

> 收尾 Phase。依赖 Phase 1-4 主体完成。
> 决策：D10（kscc 不显 token 栏）/ D11（本会话向量）。

---

## 5.1 压缩产物分流协议

一次 LLM 压缩请求产出三字段（Phase 3/4 共用，复用 General consolidation defaultExecutor 多字段思路，省调用）：
- **summary** → 进 L-mid（pi coordinator 的 lmidChain）/ 进 SDK JSONL-B 摘要段（kscc 软重置）
- **facts** → 进 evidence sink（`writeNudgeEvidence`）或 consolidation candidates → 异步进 L5
- **retrievable_spans** → 带关键词进 L4 sessions.db key_facts + 原文留面板存储可检索

LLM prompt 模板（pi coordinator + kscc 软重置共用，放 `memory/compaction-prompt.ts`）：
```
对以下对话片段做结构化压缩，返回 JSON：
{
  "summary": "逻辑骨架摘要（保留脉络，模糊细节）",
  "facts": ["关键事实1", "事实2"],  // 稳定事实/用户偏好/项目画像
  "retrievable_spans": [{"keywords": ["k1","k2"], "anchor": "原文片段标识"}]
}
```

---

## 5.2 跨核格式统一

### 问题
kscc 落 SDKMessage，pi 落 IR（TAgentMessage）。L-rag 检索 / 软重置压缩 / nudge recentMsgs 都读历史，需统一。面板消息存储（Phase 1.2）是统一源。

### 新建 `apps/electron/src/main/lib/memory/history-normalizer.ts`
- `normalizeToTextMessages(raw: unknown[]): Array<{role, contentText}>` — 把两种格式归一成 role+content_text 文本对（喂 L-rag query / recentMsgs / 压缩 LLM 输入）。
- `normalizeToAgentMessages(raw: unknown[]): AgentMessage[]` — 转 pi AgentMessage（软重置压缩喂 LLM 用）。
- 复用 `sdkMessageToIR`（`packages/shared/src/utils/kscc-message-adapter.ts`，已有）转 SDKMessage→IR，再统一。
- **R8 约束**：只处理完整消息，不处理流式 delta（流式 delta 不进存储，见 session-service 落盘逻辑）。

### 使用点
- pi coordinator L-rag：用 `searchSessions`（已统一 L4 FTS5）+ 本会话向量（Phase 3.3）。
- kscc 软重置压缩：读 SDK JSONL-A 的 SDKMessage → `normalizeToAgentMessages` → 喂 LLM 压缩 → 产出 SDKMessage 写 JSONL-B。
- nudge `onTurnStart` recentMsgs：`readPanelMessages` → `normalizeToTextMessages`。

---

## 5.3 阈值自学习

### 爆点记录
- `session-runtime` onBurst（Phase 4.3）记录 `lastBurstTokenCount`（result.usage.inputTokens 或 stderr 估算）→ `AgentSessionMeta.lastBurstTokenCount`。
- per-channel per-model 存 `~/.tagent[-dev]/projects/{slug}/memory/context-limits.json`（`{ [modelId]: { safeLimit, burstCount, lastBurst, history: [{burst, at}] } }`），复用 `getProjectMemoryDir`。

### 回写算法
```
learnedSafeContextLimit = max(lastBurstTokenCount × 0.9, contextWindow × 0.5)
多次爆取最近 N 次中位数（history.length > 3 时取 median）
```

### 读取优先级（`resolveModelContextWindow`，Phase 1.1）
`ChannelModel.safeContextLimit` > `learnedSafeContextLimit` > `ChannelModel.contextWindow × 0.7` > fallback(200k)

### UI 展示
记忆页加"模型安全线学习历史"视图（每模型 burst 次数 / 当前 safeLimit / 历史）。

---

## 5.4 页面增强

### 照搬 General 四组件（Phase 2.3 已做）
MemoryMonitorPanel / MemoryGraph / StageQueueCard / NudgeToast。

### 锦上添花（新做）

**1. pi 四层实时占用条**（D8 可视化）：
- coordinator 返回 lshort/lmid/lrag/lfact tokens → 推 `tagent_event { type:'memory_layer_usage', layers }`。
- 新组件 `MemoryLayerUsageBar`（堆叠条），在 Chat 底部显示四层占用。
- **注意 D10**：kscc 不显示此条（kscc token 不准），仅 pi 核显示。

**2. 压缩记录**：
- 每次压缩（pi coordinator / kscc 软重置）推 `tagent_event { type:'compact_log', turn, summary, facts }`。
- 记忆页加"压缩历史"tab，展示历次压缩（压了几轮、产出摘要、抽了什么事实进 L5）。
- 让"压缩不再是黑盒"。

**3. L-rag 命中来源标注**（Phase 3.3 rag_hit 事件）：
- pi-agent-adapter 推 `rag_hit` → Chat 消息流里轻量标注引用来源（角标：L4:某会话 / L5 / 本会话:turnN）。
- General 没有此（General 无 L-rag），Desktop 新增。

**4. kscc token 栏**（D10：**不加**）：
- 保持 `showTokenBar = lockedKind === 'external'`（Chat.tsx L299），kscc 不显示占用环。
- kscc 软重置触发不外显，用户只在切换时看到"正在整理记忆"提示。
- **不误导**：kscc token 估算不准，显示反而误导用户。

### 软重置状态可视化（kscc，无 token 栏但有状态提示）
- kscc 切换时（shadowState='switching'）显示"正在整理记忆"（D7）。
- 不显示占用比例（D10），但可显示"已整理 N 次"计数（记忆页）。

---

## 5.5 验证

### pi 8k（Phase 3）
- 单测 `allocateLayerBudgets`（8k/32k/200k/1M 自适应）；`reconcile`（80% 阈值切点 + 分流产出 summary/facts/spans）；lmidChain 滚动 + 二次压缩；ragHits 缓存。
- 集成 pi-agent-adapter + mock streamFn：验证 lmidChain 持续 + pendingSystemMessages 事件（compacting/compact_complete/rag_hit/memory_layer_usage）。
- 手测灌 200k+：自动压缩异步不阻塞（本轮不卡）+ cache 命中（token 计费 cacheRead 增长）+ L-rag 命中历史会话注入 + 来源标注显示。

### kscc 软重置（Phase 4）
- 单测状态机转移（45→60→75%，D10 粗估触发）；补尾游标 uuid；归档 rename；原子回滚（spawn 失败不归档 A）；爆了兜底（onBurst 走 preparePromptTooLongRecovery）。
- 集成 spawn 真实 kscc + GLM-5.2 灌 256k：60% 拉影子 B 后台压缩 A 不阻塞；75% 切换用户无感（同一 TAgent sessionId）B 转正；切换后面板历史完整（D5）；爆了不 closed 自动 compact + 重试续命。
- 手测长会话 100+ 轮：软重置触发 + 切换 + 自学习回写 safeContextLimit。

### L5 移植（Phase 2）
- 单测 memoryLayerService schema/FTS5/eager 创建；nudge 4 模式阈值；evidence 原子 consume；consolidation 9 步条件。
- 集成记忆页四组件渲染；Nudge toast accept→L0 写入→下会话 Frozen 命中 cache（对比 systemPrompt 前缀不变）。
- 防线验证：构造 LLM 想 Write memory/test.md，验证被反向指令拒 + 落 /tmp 废目录。

### 爆了恢复
- 构造 256k 爆点：session-runtime 不 closed，走 preparePromptTooLongRecovery + 自学习回写。
- 回归旧会话单 JSONL（无面板份）fallback `readPanelMessages` 不崩。

### 跨核格式
- 单测 history-normalizer：SDKMessage→text/agent；IR→text/agent；混合历史归一。

### 页面增强
- MemoryLayerUsageBar 显示 pi 四层占用（kscc 不显示）；压缩历史 tab；L-rag 来源标注角标。

---

## Phase 5 完成标准

- [ ] 压缩产物分流协议（summary/facts/retrievable_spans 三字段，共用 prompt）
- [ ] `history-normalizer.ts` 跨核格式统一
- [ ] 阈值自学习：爆点记录 + 回写 `context-limits.json` + 读取优先级
- [ ] 页面：四层占用条（pi only）/ 压缩历史 / L-rag 来源标注 / 模型安全线学习历史
- [ ] kscc 不加 token 栏（D10 遵守）
- [ ] 全部验证通过

---

## 全部 Phase 完成后的整体回归

- [ ] 双核新建会话：L0/L1/L2 注入 system（Frozen cache）；发送对话正常。
- [ ] pi 核长会话：8k 四层滚动，不阻塞，cache 命中，L-rag 命中标注。
- [ ] kscc 核长会话：软重置触发，用户无感切换，面板历史完整，爆了自动救。
- [ ] 记忆页：L0-L5 可看，Nudge accept 写入下会话生效，压缩历史可追溯。
- [ ] 自学习：爆过的模型 safeContextLimit 收敛，下次提前触发不爆。
- [ ] 旧数据兼容：无窗口字段/单 JSONL 的老会话加载不崩。
