# 渠道模型 contextWindow 补全（2026-08-06）

> **状态**：待落地
> **范围**：channel-store 启动迁移 + 已有 channels.json 模型字段补全
> **关联**：`2026-08-06-kscc-soft-reset-first-turn-trigger.md`（阈值依赖 safeLimit，safeLimit 依赖 contextWindow）

---

## 1. 现象

`channels.json` 中所有模型的 `contextWindow` / `safeContextLimit` 字段缺失（渠道在 `default-models.ts` 加窗口字段之前创建，seed 幂等不覆盖已有渠道）。

导致 `resolveModelSafeContextLimit` 全部走 fallback `200k × 0.7 = 140k`：
- glm-5.2 应有 180k safeLimit → 实际 140k（更保守，但非设计意图）
- mimo-v2.5 / deepseek-v4 应有 700k safeLimit → 实际 140k（84k 就触发压缩）
- UI 显示 1M 窗口但软重置按 140k 触发，用户看到「8% 就开始压缩」

## 2. 修复方案

### 2.1 启动迁移：补全已有渠道模型窗口字段

`channel-store.ts` 新增 `migrateModelWindows()`，在 `seedBuiltinChannels()` 之后调用：

- **kscc-internal 渠道**：按 `default-models.ts` 的 `KSCC_DEFAULT_MODELS` 补全（权威源），逐模型按 id 匹配，缺 `contextWindow` / `safeContextLimit` 则写入。
- **外部渠道**：缺 `contextWindow` 时用 `inferContextWindow(modelId)` 推断写入（shared 已有完整推断表）。
- **幂等**：已有字段不覆盖（用户手动改过的值保留），仅补缺失字段。
- **持久化**：有变更才 writeConfig（避免无谓写盘）。

### 2.2 直接修复磁盘 channels.json

对当前 `~/.tagent-dev/channels.json` 执行一次性补全，让用户重启即生效。

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

- 启动后 `channels.json` 模型含 `contextWindow` 字段
- `resolveModelSafeContextLimit` 读到真实值，不再走 fallback
- typecheck + test 全绿
