# Brief · 查「未在渠道展示的模型不应被会诊调用」+ 误触发

> `kscc -p --model glm-5.2 --dangerously-skip-permissions`  
> 以读代码 + 读 `~/.tagent-dev` 证据为主；**可改代码仅当**确认门禁缺口且补丁小；否则只写 findings。

## 用户假设

kscc 加了若干新模型（具体 id 不清）。**只要模型没出现在 TAgent 的 kscc 渠道可选列表里，会诊就不该调用它们。**

## 已知落盘证据（勿重复大扫）

- 会话 `session-1786163012352`：L265/L267 的 `uuid=moa-agg-moa-rt-…`，`model=glm-5.2`，正文无上下文。
- 同会话**无**参考席 `moa-ref` 落盘、无 `phase` / 圆桌面板。
- 预置 `~/.tagent-dev/moa-presets.json`：default 用 `glm-5.2` + `kimi-k2.5`；cheap 用 `glm-5.1` + `mimo-v2.5`；汇总 `glm-5.2`。
- 渠道 `~/.tagent-dev/channels.json` kscc-internal 已有：`glm-5.1, glm-5.2, kimi-k2.5, kimi-k2.6, mimo-v2.5, mimo-v2.5-pro`。

注意：预置模型**目前都在渠道列表里**。要查的是：
1. 运行时是否仍可能调用**渠道未启用 / UI 未展示**的模型（绕过 `validateMoAPresetForChannel`）？
2. 为何普通轮会出现 `moa-agg` 且像「裸汇总、无参考席、无历史」？
3. 渠道 `models[].enabled` / UI 过滤 vs 校验用的集合是否一致？

## 必读代码

- `apps/electron/src/main/lib/agent/moa-dispatch.ts`（`findEnabledModel` / `validateMoAPresetForChannel`）
- `apps/electron/src/main/lib/agent/run-moa-turn.ts`（席位调用、历史注入、落盘 uuid）
- `packages/pi-core/src/moa-orchestrator.ts`
- 渠道模型如何进入 UI：搜 `channels` 设置页 / model list 同步（kscc 新模型如何进 `channel.models`）
- `session-service.ts` MoA / one-shot 分支

## 验收产出

写 `docs/dev/moa-roundtable/AUDIT-channel-model-gate-FINDINGS.md`：

1. 结论：用户假设是否成立（会诊会不会调用渠道未展示模型）——**是/否/部分** + 一句话。
2. 证据：校验集合 =？UI 集合；有无绕过路径（bare `--model` 直传预置 id）。
3. L265/L267「只有 agg、无 ref、无历史」的最可能根因（与模型门禁是否同一 bug）。
4. 若有明确小补丁（例如校验与 UI 共用同一 enabled 列表、或参考席失败时禁止空上下文汇总），可直接打；否则只列「下一刀」。
5. 本轮不做：大改 UI、预置 CRUD 页、ACP。
