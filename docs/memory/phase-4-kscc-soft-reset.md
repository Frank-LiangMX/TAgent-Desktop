# Phase 4：kscc resume 核软重置（双 session A/B）

> kscc resume 核上下文管理。依赖 Phase 1.2（JSONL 分离）+ 1.3（meta 字段）+ 2.1（compactor 移植）。
> 决策：D4（双 session）/ D7（切换同步等）/ D9（降级方案新 query+上下文回填）/ D10（kscc token 不准，不显 token 栏，触发不依赖精确 token）。
> **D10 修正**：早期讨论的"45/60/75% × safeContextLimit"依赖精确 token，kscc token 不准则不适用。触发改用：消息轮次计数 + 字符量粗估 + 爆了兜底。

---

## 4.1 compactor + agent-context-utils 移植 + 透传补全

### compactor（Phase 2.1 已移植到 `memory/agent-session-compactor.ts`）
- 廉价清理 `planDropOldToolResults`（PROTECT_FIRST_N=3/PROTECT_LAST_N=6，丢 middle 纯 tool 块，配对保护）照搬。
- 改读写用 `readSdkMessages`/`writeSdkMessages`（SDK JSONL，不碰面板那份）。
- **新增 `summarize` 策略实现**（General 未实现 L253-259）：调 LLM 摘要老消息 → 生成 summary 消息替换。软重置 B 压缩用此策略 + 抽事实。

### agent-context-utils（Phase 2.1 已移植 `memory/agent-context-utils.ts`）
- `setSessionContextWindow`/`getSessionContextWindow`/`computeMaxContextMessages` 照搬。
- Desktop kscc 核现状无 contextWindow 缓存（claude-agent-adapter 无 onContextWindow），靠 `ChannelModel.contextWindow`（Phase 1.1）。

### 透传补全 KsccQueryOptions + claude-agent-adapter

**改 `claude-agent-adapter.ts` `KsccQueryOptions`（L32-65）加：**
- `resumeSessionAt?: string` — rewind/软重置补尾游标用
- `forkSession?: boolean` / `forkSourceDir?: string` / `forkSourceSdkSessionId?: string` — 分叉用（AgentSessionMeta 已有字段，未消费）
- `onContextWindow?: (cw: number) => void` — 缓存 contextWindow 回调

**改 `buildSdkOptions`（L140-191）：**
- `...(options.resumeSessionAt && { resumeSessionAt: options.resumeSessionAt })`（确认 Desktop claude-agent-sdk 版本支持）
- `...(options.forkSession && { forkSession: true, forkSourceDir, forkSourceSdkSessionId })`
- `...(options.onContextWindow && { onContextWindow: options.onContextWindow })`
- `autoMemoryDirectory: getDiscardedMemoryDir()`（Phase 2.4 防线）

**改 `session-service.ts` sendMessage kscc opts（L503-544）：**
- 传 `resumeSessionAt: meta?.resumeAtMessageUuid`（消费后 `updateSessionMeta` 清空该字段——对应 General rewindResumeAt 消费一次）
- 传 `onContextWindow: (cw) => setSessionContextWindow(sessionId, cw)` + 自学习回写（Phase 5）
- 传 `forkSession`/`forkSourceDir`/`forkSourceSdkSessionId`（meta 已有，首次 resume 后清 forkSourceDir）

---

## 4.2 双 session 状态机 + 影子拉起 + 后台压缩

### 状态机（AgentSessionMeta.shadowState，Phase 1.3 已定义）
```
idle       无影子，A 正常聊
compacting A 达触发阈值 → 拉起 B，后台压缩中（A 继续聊不阻塞）
ready      B 压缩完成，等切换条件（A 达切换阈值）
switching  正在原子切换（同步阻塞，显示"正在整理记忆"）
switched   已切到 B，B 成新 A，旧 A 归档；下次达阈值拉新影子（B→C）
```
单向链：`shadowChainPrev` 指向前驱归档 session（A→B 切换后，B.shadowChainPrev = A.sdkSessionId）。

### 触发阈值（D10 修正，不依赖精确 token）

kscc token 估算不准（一两轮就爆、token 估算与实际偏差大），**不用 45/60/75% × safeContextLimit**。改用：

**度量组合**：
1. **消息轮次计数**：累计 user turn 数（粗略增长指标）。
2. **字符量粗估**：读 SDK JSONL-A 字符数 ÷ 4（CHARS_PER_TOKEN=4，General `agent-context-utils.ts` L16）粗估 token。**仅用于触发判定，不外显**。
3. **result usage**：kscc result 带 `usage.inputTokens`（若准则用，不准则弃用）。
4. **爆了兜底**：`isPromptTooLongMessage` 命中 → 强制软重置救场（4.3）。

**三层触发阈值**（用 `safeContextLimit` 的比例，但 safeContextLimit 对 kscc 取保守值 + 爆了自学习修正）：
- **廉价清理**（drop_old_tool_results）：粗估达 `safeContextLimit × 0.45` → 不调 LLM 先清老工具结果。
- **拉影子 B**：粗估达 `safeContextLimit × 0.6` → 后台压缩。
- **切换**：粗估达 `safeContextLimit × 0.75` → 原子切到 B。
- `safeContextLimit` 优先级（Phase 1.1 `resolveModelContextWindow`）：`ChannelModel.safeContextLimit` > `learnedSafeContextLimit`（Phase 5 爆点回写）> `ChannelModel.contextWindow × 0.7` > 200k。
- **GLM-5.2 特例**：标称 1M，初值 0.7×1M=700k 兜底太激进（用户实测 256k 爆），**需手动填 `safeContextLimit: 180_000`**（256k×0.7）在 default-models，或等 Phase 5 自学习收敛。**待你定**：default-models 里 GLM-5.2 是否手动标 180k。

**检测点**：kscc 每轮 result 后（`session-service.ts` handleSdkStreamMessage 检测 `type==='result'`）调 `ksccSoftReset.onTurnResult(sessionId, usage)`。

### 拉起 B（A 达 60% 且 shadowState==='idle'）
- `shadowState='compacting'`，`shadowCursor = A 末尾消息 uuid`（记录拉起时刻 A 进度，切换补尾用）。
- 异步后台压缩（不阻塞 A）。

### B 后台压缩（复用 compactor summarize + 抽事实）
- 读 SDK JSONL-A（`readSdkMessages` 全量）→ LLM 压缩（走 consolidation 专用 streamFn 或当前渠道，Phase 2.1 适配点）→ 产出三字段（D2 分流提取）：
  - 摘要消息序列 → 写 SDK JSONL-B（`getProjectSessionPath(slug, shadowSessionId)`，shadowSessionId 新生成）
  - 关键事实 → 喂 `memory-evidence-sink`（`writeNudgeEvidence`）或 consolidation candidates → 异步进 L5
  - retrievable_spans → L4 key_facts + 原文留面板存储
- 压缩完成 → `shadowState='ready'`，`shadowSessionId = B 的 session slug`。
- **B 的 sdkSessionId**：压缩阶段不 spawn，只生成 JSONL-B + 新 session slug 占位。**B 真正获得 sdkSessionId 在切换后首次 spawn**（见 4.3 降级方案）。

### R5 风险（SDK resume 机制）— D9 已定降级方案
- 不赌"预生成 uuid + 预写 JSONL-B 让 SDK resume"。
- 切换时用**新 query + 上下文回填**（General `prepareResumeFallbackRecovery` 路径），见 4.3。

---

## 4.3 原子切换协议（D9 降级方案）+ 爆了兜底

### 原子切换（D7，A 达 75% 同步等）
**同步阻塞切换**（渲染层显示"正在整理记忆"）：

1. 检测 A 达 75% 且 `shadowState==='ready'`。
2. `shadowState='switching'`，锁定 A（`session-service` sendMessage 检查 shadowState，switching 时排队或提示"正在整理记忆"）。
3. **补尾**：从 `shadowCursor` 到 A 当前末尾的消息（A 在 B 压缩期间继续聊产生的新消息）→ 追加到 SDK JSONL-B（`appendSdkMessages` 到 B 文件）。
4. **D9 降级方案——新 query + 上下文回填**（不 resume B 的预写 JSONL）：
   - abort A 的 kscc 进程（`claude-agent-adapter.abort`）。
   - 读 SDK JSONL-B 的压缩摘要 + 补尾的最近原文 → 拼成 `session_recovery` prompt（复用 General `buildRecoveryPrompt`，`agent-orchestrator.ts` L489-509）。
   - spawn 新 kscc 进程，**新 query**（`resumeSessionId: undefined`，不 resume）+ systemPrompt 注入 `session_recovery` 上下文。
   - `onSessionId` 回调 → `meta.sdkSessionId = 新 B 的 sdkSessionId`。
5. **归档 A**：SDK JSONL-A rename `.jsonl.archived`（`shadowChainPrev = A.sdkSessionId`）。
6. `shadowState='switched'` → 立即重置为下轮 `idle`（B 成新 A，下次 60% 拉新影子 C）。

### 原子性（约束 2）
- 步骤 3-5 期间任何失败需回滚：
  - B spawn 失败 → 不归档 A，恢复 A 继续聊 + `shadowState='ready'` 重试。
  - 归档用 rename（可逆：失败则 rename 回）。
- 文件操作用 temp+rename（memory-evidence-sink 已有原子模式）。
- `meta.sdkSessionId` 改指是最后一步（之前崩溃 = 未切换 = 仍指 A，下次重开走 A）。

### 爆了兜底（替代 session-runtime 直接 closed，D4 + General preparePromptTooLongRecovery 移植）

**改 `session-runtime.ts` runLoop（L184-245）**：命中 `isPromptTooLongMessage` 不再直接 `state='closed'`+return，改调 `ksccSoftReset.onBurst(sessionId)`：
1. 先廉价清理（4.4，`drop_old_tool_results`，force）。
2. 仍过长 → 强制切换（即使 shadowState 未 ready，临时同步压一个 B 再切，走 4.3 降级方案）。
3. 自学习回写：记录 `lastBurstTokenCount`，Phase 5 回写 `safeContextLimit`。

**移植 General `preparePromptTooLongRecovery`（`agent-orchestrator.ts` L1319-1352）逻辑到 Desktop kscc 路径**：
- persistSDKMessages → compactSession(drop_old_tool_results) → 清 resume + session_recovery prompt 重试（最多 25 次，General L3112/L3593 调用点）。
- `session-runtime` `MAX_AUTO_RECOVERY=1`（L29）改为软重置专用次数（爆了可多次廉价清理 + 切换，不轻易 closed）。

---

## 4.4 廉价清理 drop_old_tool_results 触发

- 检测点同 4.2（每轮 result 后）。
- 粗估达 `safeContextLimit × 0.45` → 调 `compactSession(strategy:'drop_old_tool_results')`（不调 LLM，纯丢 middle 老 tool 块，4.1 已移植），不拉影子。
- **顺序**：45% 廉价清理 → 60% 拉影子压缩 → 75% 切换。三层递进，先省 LLM。
- 廉价清理改 SDK JSONL（`writeSdkMessages` 全量重写，4.1 compactor 已改路径）；**面板那份不动**（面板仍见完整 tool 结果，D5 分离的核心收益）。

### 软重置编排器新建
**`apps/electron/src/main/lib/agent/kscc-soft-reset.ts`**：
- 类 `KsccSoftResetCoordinator`，方法：
  - `onTurnResult(sessionId, usage)` — 触发判定（45/60/75%，D10 粗估）
  - `spawnShadow(sessionId)` — 拉 B 后台压缩
  - `switchToShadow(sessionId)` — 原子切换（D9 降级方案）
  - `onBurst(sessionId)` — 爆了兜底
- 持有 per-session 状态（shadowState 机），与 SessionRuntime 1:1。
- `session-service` 持有单例，handleSdkStreamMessage result 时调 `onTurnResult`。

---

## Phase 4 完成标准

- [ ] `KsccQueryOptions` 补 `resumeSessionAt`/`forkSession`/`forkSourceDir`/`forkSourceSdkSessionId`/`onContextWindow`，`buildSdkOptions` 透传
- [ ] `session-service` kscc opts 传 `resumeSessionAt`（消费清）+ `onContextWindow` + fork 字段
- [ ] compactor `summarize` 策略实现
- [ ] `kscc-soft-reset.ts` 新建，状态机 idle→compacting→ready→switching→switched
- [ ] D10 触发：消息轮次 + 字符粗估 + 爆了兜底（不依赖精确 token，不显 token 栏）
- [ ] 三层递进：45% 廉价清理 → 60% 拉影子 → 75% 切换
- [ ] B 后台压缩读 JSONL-A → LLM → JSONL-B + 抽事实进 L5
- [ ] D9 降级切换：补尾 + 新 query + 上下文回填（session_recovery prompt）+ 归档 A + meta.sdkSessionId 改指
- [ ] 原子性 + 回滚（spawn 失败不归档 A）
- [ ] 爆了不直接 closed：session-runtime 改调 `onBurst` + 移植 preparePromptTooLongRecovery
- [ ] 廉价清理改 SDK JSONL，面板份不动

### Phase 4 验证细节
- **单测**：状态机转移（45→60→75%）；补尾游标 uuid；归档 rename；原子回滚（spawn 失败不归档 A）；爆了兜底（onBurst 走 preparePromptTooLongRecovery）。
- **集成**：spawn 真实 kscc + GLM-5.2，灌 256k 上下文，验证：
  - 60% 拉影子 B 后台压缩，A 继续聊不阻塞
  - 75% 切换，用户无感（同一 TAgent sessionId），B 转正成新 A
  - 切换后面板历史完整（D5 分离验证）
  - 爆了不 closed，自动 compact + 重试续命
- **手测**：长会话 100+ 轮，观察软重置触发 + 切换 + 自学习回写 safeContextLimit。
