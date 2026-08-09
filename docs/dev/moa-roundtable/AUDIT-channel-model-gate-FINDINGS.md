# FINDINGS · 查「未在渠道展示的模型不应被会诊调用」+ L265/L267 误触发现象

> 审计规格：`docs/dev/moa-roundtable/AUDIT-channel-model-gate-brief.md`
> 审计人：kscc (glm-5.2) · 2026-08-08 · 只读代码 + 读 `~/.tagent-dev` 落盘
> 关联：`AUDIT-latest-session-FINDINGS.md`（同会话，只读落盘版，假设待此处用代码复核修正）

---

## 0. 结论速览

| # | 问题 | 结论 | 一句话 |
|---|------|------|--------|
| 1 | 会诊会不会调用 TAgent kscc 渠道**未展示/未启用**的模型？ | **否** | 门禁校验集合 == UI 展示集合（均为 `channel.models` 中 `enabled` 者），且 `moa:*` 永不下发 kscc，无绕过路径。 |
| 2 | 校验集合 =？UI 集合；有无绕过路径（bare `--model` 直传预置 id）？ | **一致 / 无绕过** | `validateMoAPresetForChannel` 与 `ModelSelector` 都读 `channel.models` 的 `enabled`；`KSCC_DEFAULT_MODELS` 仅 seed/migrate，不参与运行时校验。 |
| 3 | L265/L267「只有 agg、无 ref、无历史」根因；与模型门禁是否同一 bug？ | **不同 bug** | 「无 ref/无面板落盘」= 设计如此（参考席只流式推 `moa_roundtable` 事件，不落盘）；「无历史」= 该两次会诊跑在**历史注入接线之前**的 build（会诊 14:54/14:56，源码 15:33-15:38 改），当前代码已接线 `historyText`。门禁全程未失守。 |
| 4 | 小补丁 / 下一刀 | **门禁无需补丁** | 门禁 solid + 已测。附带的「本轮 user 重复进上下文」为清晰小补丁（见 §4.1，**本轮未打**，遵 brief「无门禁缺口→只写 findings」）；其余列下一刀。 |
| 5 | 本轮不做 | — | 大改 UI、预置 CRUD 页、ACP。 |

---

## 1. 门禁结论（deliverable 1）：会诊不会调用渠道未展示/未启用的模型

**否。** 会诊（sticky `moa:<presetId>` 与 one-shot `moaOneShotPresetId` 两条路径）在落到 `kscc --model` 之前，必经 `validateMoAPresetForChannel`，要求预置里每个参考席模型 + 汇总模型都在当前渠道 `channel.models` 中且 `enabled===true`。UI（`ModelSelector`）展示的可选模型也是 `channel.models.filter(m => m.enabled)`。两者同源同集合，故「未在渠道展示/未启用」的模型既进不了 UI 选择器，也过不了会诊门禁、到不了 bare 子进程。

---

## 2. 证据（deliverable 2）：校验集合 = UI 集合；无绕过路径

### 2.1 三个集合的关系

- **`KSCC_DEFAULT_MODELS`**（`apps/electron/src/main/lib/channel/default-models.ts:13-20`）：6 个模型 `glm-5.1/glm-5.2/kimi-k2.5/kimi-k2.6/mimo-v2.5/mimo-v2.5-pro`。**仅用于** seed 内置渠道（`channel-store.ts:192-212 seedBuiltinChannels`）与启动迁移补 `contextWindow`（`channel-store.ts:224-255 migrateModelWindows`）。**运行时校验不读它**——kscc 加新模型若不写进 `channels.json` 的 `channel.models`，对会诊门禁完全不可见。
- **`channel.models[].enabled`**（落盘 `~/.tagent-dev/channels.json`）：kscc-internal 渠道当前 6 个模型全部 `enabled:true`。这是**校验集合**与 **UI 集合**的共同真源。
- **`validateMoAPresetForChannel`**（`moa-dispatch.ts:30-49`）+ `findEnabledModel`（`moa-dispatch.ts:20-24`）：`channel.models.find(x => x.id === modelId && x.enabled)`。校验：`provider==='kscc-internal'` + `preset.enabled` + 参考≥2 + 每个参考/汇总模型 `findEnabledModel` 命中。任一不满足返回中文错误，`resolveMoADispatch` 即返 `kind:'error'`，**不返 `moa`**。

### 2.2 UI 集合 = 校验集合（同源）

- `ModelSelector.tsx:78-87`：`channels.filter(channel.enabled && ...).map(ch => ({ ch, models: ch.models.filter(m => m.enabled) }))` —— UI 只展示 `enabled` 模型。`moa:*` 在选择器里已被当作**遗留粘性**处理（`ModelSelector.tsx:73-77`「请改选真实模型」），选择器不再提供预置入口（会诊入口已迁到发送键旁 ▾）。
- `validateMoAPresetForChannel` 用 `findEnabledModel` 同样要求 `enabled`。**两集合字面同源**（都是 `channel.models` 的 `enabled` 子集）。

### 2.3 `run-moa-turn` 透传给 kscc 的 modelId 均已校验

- `run-moa-turn.ts:183-191`：进入编排前**再**调一次 `validateMoAPresetForChannel`（与 dispatch 双保险）。
- `run-moa-turn.ts:202-206`：参考席 `refSeats[i].modelId = preset.references[i].modelId`（已校验）。
- `run-moa-turn.ts:207`：`aggModel = findEnabledModel(channel, preset.aggregatorModelId)!`（已校验，`!` 非空由前面校验保证）。
- `run-moa-turn.ts:219 / 259`：`runReferenceModels` / `runAggregatorModel` 拿到的就是上述已校验的真实 modelId → `spawnKsccBare({ modelId })`（`moa-orchestrator.ts:117-125 / 208-216`）。

### 2.4 绕过路径排查（bare `--model` 直传预置 id？）——**无**

| 路径 | 行为 | 是否泄漏 `moa:*` / 未启用模型到 kscc |
|------|------|------|
| sticky：`meta.modelId = moa:<preset>` | `handleSend` 取 `rawModel`，`isMoaModelId` 真 → `runMoATurn`（`session-service.ts:897-901`），**return，不走 `resolveModel`/`setModel`** | 否 |
| one-shot：`input.moaOneShotPresetId` | `moaModelId(presetId)` → `runMoATurn`（`session-service.ts:905-911`），同上 | 否 |
| `resolveMoADispatch` 对 `moa:*` | 返 `moa`（带已校验预置）或 `error`，**永不返 `normal`**（`moa-dispatch.ts:120-148`，测试 `moa-dispatch.test.ts:116-124` 钉死） | 否 |
| 裸预置 id（如 `model:'default'`，无 `moa:` 前缀） | `isMoaModelId` 假 → 走 `resolveModel` → `channel.models.find(id==='default')` 未命中 → **抛「模型不属于渠道」**（`session-service.ts:1194-1196`） | 否（被 `resolveModel` 拒） |
| 普通真实模型但 `enabled:false` | `resolveModel` → `configured.enabled` 假 → **抛「已停用」**（`session-service.ts:1198-1200`） | 否 |
| 渠道内真实 `enabled` 模型 | `resolveModel` 放行 → `setModel(modelId)` / kscc `--model` | 是（本就该调用，且在 UI 展示） |

**`moa:<presetId>` 虚拟 id 全程只用于 dispatch + meta 占位（`moa-dispatch.ts:88-112 decideMoaMetaPatch`），从不进 `setModel` / `spawnKsccBare`。** 无绕过。

### 2.5 测试覆盖

`apps/electron/src/main/lib/agent/moa-dispatch.test.ts:72-84`：「参考席模型在渠道 disabled → error（含 `kimi-k2.5`）」「汇总模型 disabled → error（含 `glm-5.2`）」。门禁核心已钉死。

---

## 3. L265/L267「只有 agg、无 ref、无历史」根因（deliverable 3）

会话 `session-1786163012352`（`meta.modelId = glm-5.2`，`turnCount:10`，kscc-internal 渠道）。两处聚合席落盘：L265 `uuid=moa-agg-moa-rt-session-1786163012352-0`、L267 `...-1`，正文均**无上下文**（L265「我不太确定您想看什么内容」、L267「您目前未提供任何改造项目的具体信息」），而 L260-263 刚在讨论 kscc ACP / resume / `recoveryAttempts`。

### 3.1 「无 ref 落盘」「无 phase / 圆桌面板」——**设计如此，非 bug**

`runMoaTurn` 只落盘两类消息：本轮 user（`persistAndPushUser`，`run-moa-turn.ts:194`）与最终汇总 assistant（`persistAndPushFinalAssistant`，`run-moa-turn.ts:292`）。参考席输出**只**经 `emitCard` → `sendPayload({kind:'tagent_event', event:{type:'moa_roundtable', panel}})`（`run-moa-turn.ts:88-90 / 216 / 230`）流式推渲染层，**不写 JSONL**；`phase` 状态机同样只在 `panel` 事件里（`setMoAPanelPhase`/`setMoASeatStatus`），不单独落盘。故：
- 重载会话只见 agg 消息、不见参考席 / 圆桌卡 = **预期**（事件不落盘）。
- live 期间圆桌卡有 emit（`MoaRoundtableCard.tsx` 消费），是否渲染是 UI 层另题（与本门禁审计无关；`REGRESS-O` 已声明「未碰 MoA」）。

> 即 `AUDIT-latest-session-FINDINGS.md` §3 D「无面板/席位/phase 落盘」属架构现状，非门禁缺口。

### 3.2 「无历史」——**最可能根因：该两次会诊跑在历史注入接线之前的 build（证据陈旧），当前代码已修**

时间线（本机 local）：

| 事件 | 时刻 |
|------|------|
| L264 user「看看呢」→ L265 agg(seq0) | 14:54:01 |
| L266 user「给我改造是否值得的分析结论」→ L267 agg(seq1) | 14:56:54 |
| `packages/shared/src/types/moa-history.ts` mtime | 15:33:49 |
| `packages/pi-core/src/moa-orchestrator.ts` mtime | 15:35:12 |
| `apps/electron/src/main/lib/agent/run-moa-turn.ts` mtime | 15:36:13 |
| `apps/electron/src/main/lib/agent/moa-dispatch.ts` mtime | 15:38:47 |

历史注入三件套（`moa-history.ts` 构造器 + `moa-orchestrator.ts` 吃 `historyText` + `run-moa-turn.ts` 读面板接线）的**最后修改时间比该两次会诊晚 ~40 分钟**。当前代码已完整接线：

- `run-moa-turn.ts:198` `buildHistoryForTurn(ctx)` 读面板 → `run-moa-turn.ts:223 / 263` 把 `historyText` 透传给 `runReferenceModels` / `runAggregatorModel`。
- `moa-orchestrator.ts:76-78 / 201-203`：`composedQuestion = historyText ? \`${historyText}[本轮议题]\n${userQuestion}\` : userQuestion`；汇总席 `buildAggregatorPrompt`（`moa-orchestrator.ts:265-295`）再把 `historySection` 前置进 system 段。
- `buildMoAHistoryFromMessages`（`moa-history.ts:98-139`）对含文本的面板返回非空（预算 12000，倒序保近轮）；`sdkMessageToIR`（`kscc-message-adapter.ts:60-122`）防御式取值，不会因 agg 消息缺 `role`/`id` 而 throw 致 `buildHistoryForTurn` 整体 `catch→''`。

**结论**：L265/L267 的「无历史」最可能是**陈旧证据**——跑在历史注入接线之前的 build。当前工作树已注入历史（未实机回归）。**与模型门禁不是同一 bug**：门禁全程未失守（L265/L267 的汇总模型 `glm-5.2` 在渠道且 enabled，参考席 `glm-5.2`/`kimi-k2.5` 亦然，门禁本就会放行）。

### 3.3 驳斥「误触发 / 反向判定」假设（修正 sibling audit §3 A / §4-1）

`AUDIT-latest-session-FINDINGS.md` 据 JSONL 推断「MoA 在不该会诊的普通轮误触发，在显式会诊轮反被绕开」= dispatch 反向判定 bug。**代码复核不支撑此假设**：

- `meta.modelId = glm-5.2`（**非** `moa:*`）→ 不会走 sticky MoA 分支（`session-service.ts:897-901` 要求 `isMoaModelId(rawModel)`）。
- 唯一能在 `meta.modelId` 保持真实模型的同时产出 `moa-agg-*` uuid 的是 **one-shot** 路径（`session-service.ts:905-911`，`moaOneShotPresetId` 由渲染层点发送键旁 ▾ 选预置触发，`ConsultMenu.tsx:164-168 onConsultPreset`）。`moaTurnSeq` 模块级自增（`run-moa-turn.ts:76`）→ seq0/seq1 = 同进程连续两次 one-shot。
- 即：**用户对「看看呢」「给我改造是否值得的分析结论」各点了一次会诊 ▾**（彼时历史未接线 → 无上下文汇总）；L268「你帮我会诊看看」是**普通发送**（未点 ▾）→ 主 agent 用通用 `Agent` 工具手搓三席（L271/294/336）。

故非 dispatch 误路由，而是用户对两条消息显式 one-shot 会诊 + 当时历史未注入。「反向判定」假设可撤。

### 3.4 附带：当前代码仍存在「本轮 user 重复进上下文」小缺陷

`run-moa-turn.ts:193-198`：`persistAndPushUser(ctx)`（`appendJsonl` 走 `appendFileSync`，**同步**——`session-store.ts:217-224`）在 `buildHistoryForTurn` **之前**执行 → 读面板时本轮 user 已落盘 → `buildMoAHistoryFromMessages`（`moa-history.ts:98-139`，不排除尾轮 user）把它收进 `[会话上下文][用户] <prompt>`，随后 `composeMoaPrompt` 又拼 `[本轮议题]<prompt>`（`moa-orchestrator.ts:76-78`）→ **本轮议题在上下文里出现两次**。`run-moa-turn.ts:197` 注释「历史不含本轮 user（避免重复）」与实现不符。属轻微冗余（非「无历史」），不改变 §3.2 结论。

---

## 4. 补丁 / 下一刀（deliverable 4）

### 4.0 门禁：**无需补丁**（solid + 已测，见 §2.5）

### 4.1 小补丁（清晰、低风险，**本轮遵 brief「无门禁缺口→只写 findings」未打**，列此备打）

修「本轮 user 重复进上下文」（§3.4）：把 `run-moa-turn.ts:193-198` 的 `buildHistoryForTurn` 移到 `persistAndPushUser` **之前**（对齐 `moa-history.ts` SPEC §2「组完再 persist」），同步把 `run-moa-turn.ts:197` 注释改为「必须在 persistAndPushUser 之前读面板，历史才不含本轮 user」、把 `moa-history.ts:15-16` 设计注记由「落盘 user 后组历史…与 SPEC §2 相反」改为「组历史后再 persist user（对齐 SPEC §2）」。两处文件、纯顺序调整 + 注释，无类型/测试影响（`run-moa-turn` 无 vitest；`moa-history.test.ts` 测纯函数不受调用顺序影响）。

### 4.2 下一刀（中）：会诊 ▾ 菜单按渠道预筛预置

`ConsultMenu.tsx:45` 仅 `presets.filter(p => p.enabled)`，**不**检查预置的参考/汇总模型是否在当前渠道 `enabled`。故一个参考模型被禁用的预置仍会出现在 ▾ 里，点了才在 `runMoATurn` 经 `validateMoAPresetForChannel` 报 `session_error`（**门禁不破**——报错先于 spawn，禁用模型不会被调用），但体验是「菜单给了一个会当场失败的会诊」。修法：把 `validateMoAPresetForChannel`（纯函数，现居 main 的 `moa-dispatch.ts`）下沉到 `@tagent/shared`，渲染层据 `channelsAtom` + `presets` 预筛 ▾ 菜单，使「菜单可见」=「门禁可过」。

### 4.3 下一刀（中）：汇总席落盘 shape 对齐 SDK 信封

`persistAndPushFinalAssistant`（`run-moa-turn.ts:120-151`）写的 `message` 仅 `{content, stop_reason, model}`，缺 `role:'assistant'` / `type:'message'` / `id` / `usage` / `session_id`（对照同文件普通 kscc assistant 有这些字段，见 session L262）。`sdkMessageToIR` 防御式兼容（不致丢），但 SDK resume 读 JSONL 时信封不全可能影响续接。补齐 `role`+`type:'message'`+`id`（uuid 复用）。

### 4.4 下一刀（大，**本轮不做**）：圆桌卡 / 席位 / phase 落盘

让 `moa_roundtable` 面板事件（或其终态快照）落盘，使 `MoaRoundtableCard` 在 reload 后仍可见参考席输出与 phase 终态（消除 §3.1「重载只见 agg」观感）。涉及面板存储格式 + 渲染层回放，属大改。

### 4.5 下一刀（大，**本轮不做**）：预置 CRUD 页、ACP（brief §5 已排除）。

---

## 5. 本轮不做（deliverable 5）

- 大改 UI、预置 CRUD 页、ACP（brief §5 明示）。
- 实机回归（需 rebuild + 重启，非本轮只读审计范围）。
- 未改任何应用代码（仅写本 findings）。

---

## 6. 一句话交付

**会诊不会调用渠道未展示/未启用的模型**：校验集合 == UI 集合（`channel.models.enabled`），`moa:*` 永不下发 kscc，无绕过，已测。L265/L267「无 ref/无面板」是设计（参考席只流式推事件不落盘），「无历史」是陈旧证据（会诊跑在历史注入接线之前，当前代码已接线），均**非**模型门禁同一 bug；门禁无需补丁，附带「本轮 user 重复进上下文」小补丁列备打。
