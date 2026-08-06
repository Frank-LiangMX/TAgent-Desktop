# 渠道模型 contextWindow 补全（2026-08-06）

> **状态**：渠道迁移已落地；**UI 圆环分母接线已落地（同日）**
> **范围**：channel-store 启动迁移 + Chat ContextUsageBadge 分母
> **关联**：`2026-08-06-kscc-soft-reset-first-turn-trigger.md`（阈值依赖 safeLimit，safeLimit 依赖 contextWindow）

---

## 1. 现象

`channels.json` 中所有模型的 `contextWindow` / `safeContextLimit` 字段缺失（渠道在 `default-models.ts` 加窗口字段之前创建，seed 幂等不覆盖已有渠道）。

导致 `resolveModelSafeContextLimit` 全部走 fallback `200k × 0.7 = 140k`：
- glm-5.2 应有 180k safeLimit → 实际 140k（更保守，但非设计意图）
- mimo-v2.5 / deepseek-v4 应有 700k safeLimit → 实际 140k（84k 就触发压缩）
- UI 圆环曾固定显示 `/ 200k`（`Chat.applyUsage` 写死 `DEFAULT_CONTEXT_WINDOW`），与渠道/推断脱节（如 MiniMax-M3 应为 1M）

## 2. 修复方案

### 2.1 启动迁移：补全已有渠道模型窗口字段

`channel-store.ts` 新增 `migrateModelWindows()`，在 `seedBuiltinChannels()` 之后调用：

- **kscc-internal 渠道**：按 `default-models.ts` 的 `KSCC_DEFAULT_MODELS` 补全（权威源），逐模型按 id 匹配，缺 `contextWindow` / `safeContextLimit` 则写入。
- **外部渠道**：缺 `contextWindow` 时用 `inferContextWindow(modelId)` 推断写入（shared 已有完整推断表）。
- **幂等**：已有字段不覆盖（用户手动改过的值保留），仅补缺失字段。
- **持久化**：有变更才 writeConfig（避免无谓写盘）。

### 2.2 直接修复磁盘 channels.json

对当前 `~/.tagent-dev/channels.json` 执行一次性补全，让用户重启即生效。

### 2.3 UI 圆环分母（所有模型）

`packages/shared` 新增 `resolveUiContextWindow`：

1. 渠道 `ChannelModel.contextWindow`（经 `resolveDisplayContextWindow` 纠偏）
2. 否则 `inferContextWindow(modelId)`
3. 再否则 `DEFAULT_CONTEXT_WINDOW`（200k）

`Chat.tsx`：`contextWindowRef` 跟当前选择模型走；`applyUsage` / 切模型 / `compact_complete` 均用该分母，不再 sticky 首轮 200k。

## 3. 补全后的容量

| 模型 | contextWindow | safeContextLimit | 影子阈值(60%) |
|---|---|---|---|
| glm-5.1 | 200k | 140k（自动 200k×0.7） | 84k |
| glm-5.2 | 1M | 180k（手动标） | 108k |
| kimi-k2.5 | 200k | 140k | 84k |
| kimi-k2.6 | 200k | 140k | 84k |
| mimo-v2.5 | 1M | 700k | 420k |
| mimo-v2.5-pro | 1M | 700k | 420k |
| deepseek-v4-pro | 1M | 700k | 420k |
| deepseek-v4-flash | 1M | 700k | 420k |
| MiniMax-M3 | 1M | 700k | 420k |

## 4. 验证

- [x] 启动后 `channels.json` 模型含 `contextWindow` 字段（迁移路径）
- [x] `resolveModelSafeContextLimit` 读到真实值，不再走 fallback
- [x] ContextUsageBadge 分母随模型变化（M3 → `… / 1M`）
- [ ] typecheck + test 全绿（提交前按需跑）
