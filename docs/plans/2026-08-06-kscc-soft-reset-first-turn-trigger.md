# kscc 核首轮即触发压缩（2026-08-06）

> **状态**：待落地
> **范围**：kscc 软重置阈值守卫 + token 估算修正
> **关联**：`ADR-0002` 长驻 · `docs/memory/phase-4-kscc-soft-reset.md` · D10 粗估触发

---

## 1. 现象

kscc 核偶发「一条会话就显示正在压缩中」——第一轮对话结束后，UI 弹出「正在整理记忆」横幅。

## 2. 根因

触发链路：

```
session-service.ts:1260  收到 result 消息
  → ksccSoftReset.onTurnResult({ inputTokens, modelId, channelId })
    → kscc-soft-reset.ts:185  estimated = inputTokens || estimateSdkTokens(全部JSONL)
    → kscc-soft-reset.ts:194  safeLimit = resolveModelSafeContextLimit(...)
    → kscc-soft-reset.ts:203  if (estimated >= safeLimit * 0.6) → startShadowCompact()
      → onStatus('compacting') → Chat.tsx:1277 显示「正在整理记忆」
```

### 2.1 原因 A：`estimateSdkTokens` 高估（usage 缺失时）

`session-service.ts:1262-1263` 提取 usage：

```typescript
const usage = (msg as { usage?: { input_tokens?: number; inputTokens?: number } }).usage
const inputTokens = usage?.input_tokens ?? usage?.inputTokens
```

kscc 网关代理 GLM/Kimi/MiMo 等非 Claude 模型，**不总是返回 `usage.input_tokens`**。缺失时回退到 `estimateSdkTokens`（`kscc-soft-reset.ts:53-75`）：

- 读取**整个 SDK JSONL 的所有消息**逐条数 chars / 4。
- **把 `tool_result` 内容也算进去**（第 67-70 行）。
- 第一轮助手调 Read 读大文件 / Bash 跑长输出，tool_result 动辄 50-100k chars，几条叠加到 300k+ chars = 75k+ tokens。

### 2.2 原因 B：自学习拉低 `safeLimit`

`context-limits-store.ts:79` 爆点后写入：

```typescript
const learned = Math.max(Math.ceil(base * 0.9), Math.ceil(opts.contextWindow * 0.5))
```

对 200k 窗口模型（glm-5.1 / kimi-k2.5 / kimi-k2.6），floor = `200k * 0.5 = 100k`。`resolveModelSafeContextLimit` 优先取学习值（`model-window.ts:61`），`safeLimit = 100k`，影子压缩阈值 = `100k * 0.6 = 60k`。

若 kscc 网关恰好返回了 `input_tokens`（含完整 system prompt + 工具定义 + 记忆注入），第一轮 input_tokens 可能 40-65k，逼近 60k。

> glm-5.2 有手动 `safeContextLimit: 180k`（阈值 108k），mimo 1M 窗口阈值 300k，不受此影响。**仅 200k 窗口且爆过点的模型受影响**。

### 2.3 原因 C：无最小轮次守卫

`onTurnResult`（`kscc-soft-reset.ts:178`）**没有消息数 / 轮次下限**。无论 JSONL 里只有 2 条消息还是 200 条，都照样跑阈值判断。

### 2.4 为什么「偶尔」

三条件叠加才触发，缺一不响：
1. 之前有 200k 模型的会话爆过 → 学习值拉低阈值。
2. kscc 网关**没返回** usage → 回退 `estimateSdkTokens` 高估，**或恰好返回了**高 input_tokens。
3. 第一轮助手有大体量工具输出，或 system prompt + 工具定义特别大。

## 3. 修复方案

### 3.1 最小轮次守卫（主修复）

`kscc-soft-reset.ts` `onTurnResult` 开头加守卫，消息数太少不触发：

```typescript
const turnCount = meta.turnCount ?? 0
if (turnCount < MIN_TURNS_FOR_COMPACT) return  // 至少 2 轮才考虑压缩
```

**为什么用 `meta.turnCount` 而非消息计数**：SDK JSONL 里 `tool_result` 消息的 `type` 也是 `'user'`，按 `type==='user'` 计数会把 tool_result 也算进去，一轮有工具调用的对话就有 2+ 条 `type:'user'`，守卫失效。`meta.turnCount` 在 session-service 发消息时 +1，精确反映真实用户轮次，且旧会话无字段时 fallback 为 0（不触发压缩，安全）。

### 3.2 `estimateSdkTokens` tool_result 限速（辅助）

tool_result 内容截断后再计入估算，防单条大体量输出撑高估：

```typescript
// kscc-soft-reset.ts estimateSdkTokens 内
if (block.type === 'tool_result' && Array.isArray(block.content)) {
  for (const c of block.content as Array<{ text?: string }>) {
    if (c?.text) chars += c.text.slice(0, 2000)  // 限 2000 chars ≈ 500 tokens/条
  }
}
```

### 3.3 不改的部分

- **不自学习拉低 floor**：`contextWindow * 0.5` 的 floor 是 D10 决策的保守策略，不改。
- **不删 `estimateSdkTokens` 回退**：D10 明确 kscc token 不准，粗估 + 爆了兜底是设计意图，保留。
- **不调阈值比例**：`CHEAP_RATIO 0.45 / SHADOW_RATIO 0.6 / SWITCH_RATIO 0.75` 是 Phase 4 定调，不改。

## 4. 验证

- 单测：`kscc-soft-reset.sim.test.ts` 补「1 轮不触发压缩、2 轮 + 高估 token 触发」用例。
- 手测：kscc + 200k 模型，第一轮调 Read 大文件 + Bash 长输出，验证不弹「正在整理记忆」。
- 回归：长会话（20+ 轮）仍正常触发压缩，不被守卫误杀。

## 5. 遗留

- kscc 网关 usage 字段不稳定是根因之一，长期应推动网关返回标准 `input_tokens`（非本项目可控）。
- `estimateSdkTokens` 仍含 system prompt 体积，大 prompt 会高估——限速 tool_result 后缓解，system prompt 本身不长，暂不处理。
