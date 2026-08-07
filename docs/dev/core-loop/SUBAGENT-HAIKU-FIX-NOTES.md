# 修复记录 — 子代理不再钉死 haiku（kscc 渠道继承父模型）

> 日期：2026-08-07
> Brief：`SUBAGENT-HAIKU-FIX-brief.md`（按当前渠道判定 `claudeAvailable`，避免魔法布尔）
> 调查：`SUBAGENT-FAIL-FINDINGS.md` 根因 1（子代理模型被钉死 `haiku`，非 Claude 渠道必失败）
> 派工：本机 `kscc -p --dangerously-skip-permissions`
> 提交：本轮按用户指示 **commit + push**（brief 原文「不 commit / push」，用户裁定覆盖）。

---

## 0. 结论先行

Work + kscc-internal 渠道下调 `Agent`(subagent_type=explorer) → 子代理**首轮 LLM 调用即失败**（红字「失败」、无任何工具进度）。根因：kscc 路径硬编码 `buildBuiltinSubagentDefinitions(true)` → 操作型角色 `model='haiku'` → SDK 用定义里的 model 起**子 kscc** → 子 kscc 把 `haiku` 映射成 Claude haiku 模型 ID 发到 glm 网关 → **glm 网关不认识该模型 → API 报错** → 子代理首轮就 fail。

本轮**一行级主修**：把 `true` 改为按渠道判定 —— 仅 Anthropic 系渠道（真有 Claude 模型）才钉 haiku；kscc-internal 等**非 Claude 渠道传 `false`** → `resolveModelForRole` 返回 `undefined` → `AgentDefinition` **不带 `model`** → SDK「inherits from the parent」（`sdk-tools.d.ts:423`）→ 子代理跑父会话模型（glm-5.2 等），与 Pi 核 `createSubagentStreamFn` 的 `modelOverride || channelConfig.modelId` 兜底行为对齐。

---

## 1. 改了什么（文件列表）

| 文件 | 改动 |
|------|------|
| `apps/electron/src/main/lib/channel/default-models.ts` | **新增** `isClaudeAvailableForChannel(channel: Channel): boolean`：仅 `channel.provider === 'anthropic' \|\| 'anthropic-compatible'` 返回 `true`（对应 `EXTERNAL_DEFAULT_MODELS` 真有 Claude 模型的 provider）；kscc-internal 及其余外部 provider 恒 `false`。带文档注释说明 SDK 继承父模型机理 + 引用 FINDINGS 根因 1。import 增加 `Channel` 类型。 |
| `apps/electron/src/main/lib/ipc/session-service.ts` | ① import `isClaudeAvailableForChannel`；② `:1143` `buildBuiltinSubagentDefinitions(true)` → `buildBuiltinSubagentDefinitions(isClaudeAvailableForChannel(channel))`；③ 注释说明「非 Anthropic 系 → false → 不带 model → 继承父模型，避免钉 haiku 打到无 Claude 网关而首轮失败」。 |

> 该 `agents` 行位于 `if (channel.provider === 'kscc-internal')` 块内，**只对 kscc-internal 渠道执行**；而 kscc-internal 无 Claude 模型，故 `isClaudeAvailableForChannel(channel)` 在此恒为 `false` —— 与 brief「兜底等价改法 `buildBuiltinSubagentDefinitions(false)`」等价，但抽 helper 避免魔法布尔、并自证意图。

---

## 2. 测了什么

新增 / 扩充测试（全绿）：

| 测试文件 | 用例 |
|----------|------|
| `apps/electron/src/main/lib/channel/default-models.test.ts`（**新增**） | `isClaudeAvailableForChannel`：anthropic / anthropic-compatible → `true`；kscc-internal → `false`；openai/deepseek/google/kimi-*/zhipu-*/minimax/doubao/qwen/qwen-anthropic/xiaomi-*/custom → `false`（3 用例）。 |
| `apps/electron/src/main/lib/agent/subagent-definitions.test.ts`（**+2 用例**） | `buildBuiltinSubagentDefinitions(false)` → explorer/researcher/code-reviewer/reviewer/analyst/coder/generalist 的 `model` **均 undefined**（继承父）；`buildBuiltinSubagentDefinitions(true)` → explorer/researcher/code-reviewer `model === 'haiku'`（对照组）。 |

命令摘要：
```
node node_modules/vitest/vitest.mjs run \
  apps/electron/src/main/lib/channel/default-models.test.ts \
  apps/electron/src/main/lib/agent/subagent-definitions.test.ts \
  apps/electron/src/main/lib/role/role-projection.test.ts
# 3 files / 18 tests all passed

node node_modules/.bun/typescript@5.9.3/node_modules/typescript/bin/tsc --noEmit -p apps/electron/tsconfig.json
# TYPECHECK_OK（@tagent/electron exit 0）
```

> `role-projection.test.ts`（8 用例，含 `空 modelPool + 非 Claude → 无 model`、`modelPool 优先于 haiku`）未改、回归绿，覆盖 `resolveModelForRole` 分支。

---

## 3. 手测步骤（实机 GUI，未在本机跑 Electron）

> 本机为 CLI 代理环境，未起 Electron GUI 实跑；以下为需人工验证的步骤（逻辑层由单测 + typecheck 覆盖）。

1. **Work + kscc-internal（glm）渠道**：发一个会触发子代理委派的任务（如「探索一下项目根目录结构」）。
   - 期望：模型调 `Agent`(subagent_type=explorer) → 子代理卡出现后**有工具进度**（Glob/Grep/Read 行进），最终 `completed`（绿），返回结构化结果 —— **跑通而非秒失败**。
   - 关键判据：主进程 console `[kscc stderr]` **不再**出现 haiku/model 报错；子代理每条 assistant 消息 `model` 应为 `glm-5.x`（继承父），**非** `haiku`。
2. **对比旧现象**：修复前同操作 → 子代理卡出现后直接红字「失败」、无任何工具进度；`[kscc stderr]` 有 model/API 报错。
3. **可选对照（外部 anthropic 渠道）**：若有配置 `anthropic` / `anthropic-compatible` 渠道，Work 下派 explorer → 子代理 `model` 应为 `haiku`（Claude 渠道真有 haiku，钉死安全）。
4. 抓一轮 panel/SDK JSONL，确认子代理会话（`parent_tool_use_id` 非空）的 assistant `model` 与 `_channelModelId` 为渠道模型（glm），非 haiku。

---

## 4. 修复要点（根因 → 修法）

| 根因 | 修法 |
|------|------|
| kscc 路径硬编码 `claudeAvailable=true` → 操作型角色 `model='haiku'` | 按渠道判定：`isClaudeAvailableForChannel(channel)`；kscc-internal → `false` |
| `true` → `AgentDefinition` 带 `model:'haiku'` → SDK 不继承父，用 haiku 打 glm 网关 | `false` → `resolveModelForRole` 返回 `undefined` → `AgentDefinition` **不带 `model`** → SDK 继承父会话模型 |
| 魔法布尔 `true` 不可读、易回归 | 抽 `isClaudeAvailableForChannel`（channel 工具模块），带文档 + 单测 |

---

## 5. 不做 / 限制

- **不修根因 2**（Windows 下子代理子进程 spawn/立即退出）—— 需先实证 `[kscc stderr]` 定性是「model 错」（本轮坐实根因 1）还是「spawn exit 1」，另轮处理。
- **不接 `fallbackToChannelDefault` 全链路** —— brief 明示本轮靠「不钉 haiku」即可；`fallbackToChannelDefault` 未被 `resolveModelForRole` 消费（运行时无回退），作为二道防线另轮。
- **不改 `buildSubagentDelegationPrompt`** —— 其内部 `buildBuiltinSubagentDefinitions(true)` 仅用于生成**委派提示文案**（列目录 + `model ?? '渠道默认 / haiku'`），不是运行时钉模型；文案已自含「子代理默认继承渠道模型或 haiku（Claude 渠道）」口径，未误导运行时行为。若要让 kscc 渠道下提示文案也诚实显示「继承渠道模型」而非 `haiku`，需给 `buildSubagentDelegationPrompt` 透传 `claudeAvailable`，另开小任务。
- **不接 AskUserQuestion（REGRESS-H）** —— 与子代理收口失败无关（FINDINGS Q5 排除）。
- **未实机 GUI 验**（§3 手测待人工跑）；逻辑层由 3 新测 + typecheck 覆盖。
