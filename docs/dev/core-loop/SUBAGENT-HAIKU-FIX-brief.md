# Brief — 子代理不要钉死 haiku（kscc 渠道继承父模型）

> 依据：`docs/dev/core-loop/SUBAGENT-FAIL-FINDINGS.md` 根因 1  
> 派工：本机 `kscc -p --dangerously-skip-permissions`  
> **实现 + 单测**；不 commit / push。

## 修法（最小）

### 1. `session-service.ts` kscc 路径（主）

约 `:1143`：

```ts
agents: executionMode === 'work' ? buildBuiltinSubagentDefinitions(true) : undefined,
```

改为按**当前渠道**判定 `claudeAvailable`：

- `channel.provider === 'kscc-internal'`（或非 Anthropic 系）→ **`false`**  
  → explorer/researcher 的 `AgentDefinition` **不带 `model`** → SDK 继承父会话模型（glm 等）
- 仅当渠道确为 Claude / Anthropic 可用时 → `true`（可钉 haiku）

参考现有 `channel.provider`、Pi 路径 `buildBuiltinSubagentDefinitions(false)`。

可抽小函数 `isClaudeAvailableForChannel(channel): boolean`（同文件或 channel 工具模块），避免魔法布尔。

### 2. 测试

- 现有 `role-projection.test.ts` / `subagent-definitions.test.ts`：`claudeAvailable:false` 时 explorer **无 model 字段**（已有部分断言则对齐）。
- 若有 session-service 可测点：Work + kscc-internal → agents.explorer 无 `model`；可选 anthropic 渠道 → 有 haiku。

### 3. 文档

写 `docs/dev/core-loop/SUBAGENT-HAIKU-FIX-NOTES.md`：改了什么、为何、手测（Work + glm 渠道派 explorer，应跑通而非秒失败）。

## 不做

- 不修 Windows 嵌套 spawn（根因 2，另轮）
- 不接 AskUserQuestion（H）
- 不 commit / push
- 不必大改 `fallbackToChannelDefault` 全链路（本轮靠不钉 haiku 即可；若顺手一行注释说明意图可写）

## 验收

1. `buildBuiltinSubagentDefinitions(false)` / Work+kscc 路径：explorer 无 `model`  
2. 相关 vitest 绿；electron typecheck 绿  
3. FIX-NOTES 落盘  
