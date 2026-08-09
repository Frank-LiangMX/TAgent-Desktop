# MoA 续作 · FIX-NOTES（kscc glm-5.2 接 mimo 半成品）

> 交卷者：`kscc -p --model glm-5.2 --dangerously-skip-permissions`
> 规格：`01-MOA-PRODUCT-SPEC.md` + `IMPLEMENT-kscc-followup-brief.md`
> 验收：见文末「验收核对」

---

## 1. 本包完成清单

| 件 | 路径 | 说明 |
|---|---|---|
| 圆桌卡纯函数状态机 | `packages/shared/src/types/moa-roundtable.ts` (+`.test.ts`) | `createMoARoundtablePanel` / `deriveMoAPhase` / `setMoASeatStatus` / `markMoAPanelCancelled` / `setMoAPanelPhase` |
| Panel 契约 | `packages/shared/src/types/tagent-message.ts` | `MoARoundtablePanel` 增 `roundtableId`；新增 `MoARoundtableEvent` 信封 |
| orchestrator 增强 | `packages/pi-core/src/moa-orchestrator.ts` (+`.test.ts`) | `runReferenceModels` 加 `onSeatUpdate`+`signal`+`seatId`；新增 `runAggregatorModel`（流式 `onTextDelta`+abort） |
| runMoaTurn 主链路 | `apps/electron/src/main/lib/agent/run-moa-turn.ts` | 单轮编排：校验→落 user→圆桌卡→参考席→汇总→流式正文→落 final assistant→result/turn_end；abort→cancelled |
| 调度纯函数 | `apps/electron/src/main/lib/agent/moa-dispatch.ts` (+`.test.ts`) | `resolveMoADispatch` / `validateMoAPresetForChannel`（纯函数，便于单测「不 setModel moa」） |
| session-service 分支 | `apps/electron/src/main/lib/ipc/session-service.ts` | `handleSend` 在 `resolveModel` 前按 `isMoaModelId` 分流；`runMoATurn` 方法；STOP 经 `moaAbortBySession` 中止；`getStatus` 计 `moaInFlight` |
| ModelSelector 会诊分组 | `apps/electron/src/renderer/components/chat/ModelSelector.tsx` | 拉 `listMoaPresets` →「会诊 · MoA」分组；选中 `moa:<presetId>`；MoA 会话隐藏 ReasoningSlider |
| MoaRoundtableCard | `apps/electron/src/renderer/components/chat/MoaRoundtableCard.tsx` | 头部+phase 徽章+席位行（点席位→Sheet 全文）+复制/建看板 CTA |
| 时间线挂载 | `Chat.tsx` / `session-turn-model.ts` / `stream-item-model.ts` | `DisplayItem.moaRoundtable`；`groupItemsIntoTurns` 走 standalone；`handlePayload` 按 `roundtableId` upsert + 非终态 adopt running；`purgeStreamingItems` 保留圆桌卡 |
| 预载类型补全 | `apps/electron/src/renderer/App.tsx` | 手写 `Window.electronAPI` 增 `listMoaPresets`（该声明与 preload 重复且偏旧，本期最小补洞，未整体替换） |
| 发送门禁 | `Chat.tsx sendQueued` | `isMoaModelId` 跳过模型启用校验（moa:* 不在渠道模型表，由主进程校验预置） |

未重写：`moa-preset.ts`（类型/helpers/seed）、`moa-preset-service.ts`、`config-paths.ts`、IPC `listMoaPresets` 通道、preload `listMoaPresets` 桥——均沿用 mimo 半成品，仅按需读取。

---

## 2. 关键不变式

- **绝不** `setModel('moa:…')` / 把 `moa:*` 传给 kscc `--model`：`handleSend` 在 `resolveModel` 之前按 `isMoaModelId` 分流到 `runMoATurn`，普通链路（含 `rt.setModel`）只对真实 modelId 触发。`resolveMoADispatch` 返回 `normal` 时 modelId 必为真实模型（单测覆盖）。
- 锁核：MoA 仅 kscc-internal；外部渠道不展示会诊分组（`internalGroups` 为空），误发由 `resolveMoADispatch` 报中文错。
- 圆桌卡按 `roundtableId` 就地 upsert（同轮多张状态卡只留最新；跨轮不串台）。
- 取消：`STOP_AGENT` → `moaAbortBySession` abort → `runReferenceModels`/`runAggregatorModel` 杀 bare 子进程 → 未完成席 `cancelled` → 卡 phase=cancelled；`turn_end` 由 STOP 处理器统一推（runMoaTurn 取消路径不重复推）。

---

## 3. 已知缺口 / 下轮再做（本期不做）

1. **汇总席纯文本无工具**：`runAggregatorModel` 用 `tools:[]`（与参考席一致）。SPEC §3.6 允许汇总默认带只读工具（Read 等），但 kscc bare 工具接线成本高，本期汇总**纯文本无工具**。下轮再开（接线 `buildToolsSystemPromptSection` + 只读工具集）。
2. **建看板 CTA 仅最小接通**：`MoaRoundtableCard` 的「建看板」调 `kanbanCreateBoard({ rootGoal: 结论前 300 字, sessionId, title })`。Chat 模式由主进程 `assertKanbanWriteAllowed` 网关拦截并回错误文案（卡片 alert 出错原因）。**未做**：Chat→Work 确认条（`setSessionExecutionMode(...,'user-confirm-suggestion')`）、按结论拆解多任务、看板创建后跳转/刷新。下轮对齐 05 §7。
3. **席位详情 Sheet 渲染纯文本**：未用 `MessageResponse` 渲染 markdown；参考席/汇总席全文按 `whitespace-pre-wrap` 展示。汇总结论的 markdown 渲染走主时间线的 final assistant 消息（`MessageView`），席位 Sheet 仅作「看全文」入口。下轮可换 `MessageResponse`。
4. **Context Usage 圆环分母**：SPEC §2.2 要求 MoA 会话分母取汇总模型 `contextWindow`。本期未接（§7 明列不做 ACP 圆环）；`effectiveSelection.modelId='moa:…'` 时 `configuredContextWindow` 为 undefined → 圆环走默认窗口。下轮接 `resolveModelContextWindow(channel, preset.aggregatorModelId)`。
5. **预置设置页 CRUD**：仅 seed（`moa-preset-service` 首访落 `default`/`cheap`）+ `listMoaPresets` 只读；无 UI 增删改（SPEC §5 E1 允许仅 seed）。下轮可加设置页列表。
6. **MoA 轮 Nudge**：`handleSend` 普通路径跑 `runNudgeOnTurnStart`；MoA 分支早 return 未跑。Nudge 不在 MoA 范围，本期略。
7. **`validateMoAPresetForChannel` 双校验**：`session-service.runMoATurn`（经 `resolveMoADispatch`）与 `runMoaTurn` 模块各校一次。冗余但廉价（早失败少占资源），保留。
8. **pi-core dist 需重建才能跑应用**：`@tagent/pi-core` `exports.import` 指向 `dist/index.js`，应用主进程 esbuild 打包从 dist 走。新增导出（`runAggregatorModel` 等）需 `bun run build:pi-core` 后再 `dev`/`package`。`bun run dev` 已含 `build:pi-core`；手动 `start`/`package` 前需先建。typecheck 与单测走 src，不依赖 dist。

---

## 4. typecheck 结果

```text
cd apps/electron && bun run typecheck   # tsc --noEmit
```

- `@tagent/shared`：通过。
- `@tagent/pi-core`：通过。
- `@tagent/electron`：**仅 1 条既有无关错误**（非本包引入）：
  - `src/renderer/components/chat/ConciseTimelineView.tsx(645,12): error TS2339: Property 'durationSec' does not exist on type '{ kind: "tool"; ... }'`
  - 该文件本包未改动（`git status` 不含）；错误在简洁时间线把 `step.durationSec` 用在 `tool` 类条目上（`durationSec` 仅 `thinking` 类有）。属既有债，按 brief「勿大范围清债」未修。

---

## 5. 单测结果

```text
bunx vitest run \
  packages/shared/src/types/moa-roundtable.test.ts \
  packages/shared/src/types/moa-preset.test.ts \
  packages/pi-core/src/moa-orchestrator.test.ts \
  apps/electron/src/main/lib/agent/moa-dispatch.test.ts
# 4 文件 / 39 用例 全过
```

全量 `bunx vitest run`：**86 文件 / 859 用例全过**（无回归）。
`bun test session-turn-model.test.ts`（bun:test，被 vitest 排除）：13 用例全过（`groupItemsIntoTurns` 加 `moaRoundtable` standalone 分支未破坏既有分组）。

覆盖：
- `buildAggregatorPrompt`：参考席输出拼装 + **失败席标记** `[该参考模型运行失败]`。
- 圆桌卡状态机：pending→running→ok/failed、fail-open（一 ok 一 failed → aggregating）、全失败 → error、汇总 ok → done、汇总 failed → error、cancel（pending/running → cancelled，终态席保留）。
- `resolveMoADispatch`：真实 modelId → normal（永不 `moa:*`，可安全 setModel）；`moa:default` kscc → moa；外部渠道 → error；未知预置 → error；参考/汇总模型未启用 → error。
- orchestrator（mock `spawnKsccBare` 喂 NDJSON）：`onSeatUpdate` running→ok/failed/cancelled；`runAggregatorModel` 流式 `onTextDelta` + abort + 空正文降级。

---

## 6. 验收核对（对 01-MOA-PRODUCT-SPEC §1）

1. ✅ 模型选择器「会诊 · MoA」分组，含 `default`（glm-5.2 + kimi-k2.5，汇总 glm-5.2）/`cheap`（glm-5.1 + mimo-v2.5，汇总 glm-5.2）seed 预置。
2. ✅ 选中预置 → 触发器显预置名；隐藏 ReasoningSlider（改显「会诊模式…不适用思考强度」说明）。
3. ✅ 发消息 → 主时间线出现圆桌卡（进行中：席位状态；完成：卡 phase=done + 汇总结论作主 assistant 回答流式展开）。
4. ✅ 点席位 → 右侧 Sheet 看全文（失败席标失败原因）。
5. ✅ 汇总结论作为本轮 assistant 主回答；参考席全文不刷满主线（只在卡席位行点开看）。
6. ⚠️ 完成卡 CTA：复制（✅）；建看板（最小接通，缺口见 §3.2）。
7. ✅ 取消发送中：未完成席 cancelled，卡 phase=cancelled。
8. ✅ 参考席全失败 → error 卡 + session_error（文案提示检查模型/切回单模型）。

---

## 7. 文件改动清单

新增：
- `packages/shared/src/types/moa-roundtable.ts` + `.test.ts`
- `packages/pi-core/src/moa-orchestrator.test.ts`
- `apps/electron/src/main/lib/agent/run-moa-turn.ts`
- `apps/electron/src/main/lib/agent/moa-dispatch.ts` + `.test.ts`
- `apps/electron/src/renderer/components/chat/MoaRoundtableCard.tsx`
- `docs/dev/moa-roundtable/IMPLEMENT-FIX-NOTES.md`（本文件）

修改：
- `packages/shared/src/types/tagent-message.ts`（`MoARoundtablePanel.roundtableId` + `MoARoundtableEvent`）
- `packages/shared/src/types/index.ts`（导出 moa-roundtable）
- `packages/pi-core/src/index.ts`（导出 `runAggregatorModel` / 新类型）
- `packages/pi-core/src/moa-orchestrator.ts`（onSeatUpdate/signal/runAggregatorModel）
- `apps/electron/src/main/lib/ipc/session-service.ts`（MoA 分支 + runMoATurn + STOP abort + getStatus）
- `apps/electron/src/renderer/App.tsx`（`listMoaPresets` 类型 + `MoAPreset` 导入）
- `apps/electron/src/renderer/components/chat/ModelSelector.tsx`（会诊分组 + 隐藏滑块）
- `apps/electron/src/renderer/components/chat/Chat.tsx`（moa_roundtable 事件处理 + 发送门禁 + 渲染挂载）
- `apps/electron/src/renderer/components/chat/session-turn-model.ts`（`moaRoundtable` standalone）
- `apps/electron/src/renderer/components/chat/stream-item-model.ts`（`purgeStreamingItems` 保留圆桌卡）

未改：moa-preset 类型/服务、config-paths、IPC 通道、preload `listMoaPresets`、hermes-studio / ACP 线。
未 commit / push（按 brief 禁止）。

---

## 8. Session UX 续作（2026-08-08 · mimo 半成品 + 总监收尾）

对照 `02-SESSION-UX-SPEC.md` / Hermes：同会话 + 历史 + one-shot 主入口。

### 8.1 完成

| 件 | 说明 |
|---|---|
| 历史注入 | `packages/shared/src/types/moa-history.ts`；`run-moa-turn` 读面板拼上下文；orchestrator 吃 `historyText` |
| One-shot | `SendMessageInput.moaOneShotPresetId`；`sticky=false` 不写 meta.modelId=`moa:*`；`decideMoaMetaPatch` 单测 |
| UI 会诊本条 | `Chat.tsx` `ConsultMenu` / `sendConsult` 发送旁「会诊 ▾」 |
| 粘性文案 | ModelSelector「会诊模式」+「之后每条都会…」；主入口提示用发送旁会诊本条 |
| 圆桌卡文案 | 进行中「会诊中 · 带本会话上下文」；徽章交卷中/已汇总（避免「讨论」互聊误解） |
| 修 bug | `session-service` one-shot 曾 `const moaModelId = moaModelId(...)` 自阴影 → 改 `oneShotModelId` |

### 8.2 测试

```text
bunx vitest run moa-history moa-roundtable moa-preset moa-orchestrator moa-dispatch
# 5 文件 / 63 用例通过（2026-08-08）
```

### 8.3 手测清单

1. 普通模型聊 2～3 轮 → 发送旁「会诊」选默认会诊 → 汇总应能引用前文；模型选择器仍显示原模型。
2. 模型选择器进「会诊模式」粘性预置 → 每条都会诊且带历史；切回真实模型退出。
3. 会诊进行中卡文案含「带本会话上下文」。

### 8.4 仍后置

- 设置页预置 CRUD（班底仍 seed / `moa-presets.json`）
- 气泡下「用会诊再议」
- 汇总席只读工具、建看板 Chat→Work 确认条（见 §3）

### 8.5 点击修复（2026-08-08）

- **根因**：`ConsultMenu` 写在 `Chat` 函数体内 → 每次 render 重挂载 → Popover 打不开。
- **修复**：抽到 [`ConsultMenu.tsx`](../../apps/electron/src/renderer/components/chat/ConsultMenu.tsx)；按钮始终可打开菜单（无草稿时预置项 disabled）。
- **模型选择器**：去掉会诊预置列表（主入口仅发送旁「会诊」）；旧 sticky `moa:*` 自动落回渠道默认真实模型。

---

## 9. Pi / 外部渠 MoA（2026-08-08 · 会诊放开到外部渠）

对照 `03-PI-EXTERNAL-MOA-SPEC.md` / brief `IMPLEMENT-PI-MOA-brief.md`：非 kscc-internal 渠道也能会诊，同 UI（发送 ▾ / 圆桌卡 / 历史 / one-shot），席位走 Pi HTTP 直连，不调用 `spawnKsccBare`。

### 9.1 完成

| 件 | 路径 | 说明 |
|---|---|---|
| 按渠解析预置（纯函数 + 单测） | `packages/shared/src/types/moa-preset.ts` (+`.test.ts`) | `resolveConsultPresetsForChannel`：kscc 过滤 stored 不可用；外部 ≥2 命中 stored 或合成 `channel-default`；外部 =1 合成 `channel-same-model`（同模多角色，两参考同 modelId 不同 system） |
| 合成预置标记 | `packages/shared/src/types/moa-preset.ts` | `MoAPreset.synthetic?` + `MoAReferenceSeat.systemPrompt?`；`isValidMoAPreset` 放行（ephemeral，不落盘） |
| 放宽门禁 | `apps/electron/src/main/lib/agent/moa-dispatch.ts` (+`.test.ts`) | 删除「仅 kscc-internal」硬拒（`validateMoAPresetForChannel` + `resolveMoADispatch`）；跨渠禁席由「席位 modelId 是否属于当前渠道」天然保证，消息改「当前渠道」 |
| 席位 runner 分流 | `packages/pi-core/src/moa-orchestrator.ts` (+`.test.ts`、`index.ts`) | `MoASeatRunner` 接口 + `createKsccSeatRunner`（既有 bare）+ `createPiHttpSeatRunner`（`createHttpDirectStreamFn`/`streamSimple`，`tools:[]`）；`runReferenceModels`/`runAggregatorModel` 增 `seatRunner?`（默认 kscc，兼容旧单测）；删 `runOneReference` |
| runMoaTurn 注入 runner | `apps/electron/src/main/lib/agent/run-moa-turn.ts` | `MoATurnContext.ksccPath` → `seatRunner: MoASeatRunner`；编排骨架渠道无关 |
| session-service 分流 | `apps/electron/src/main/lib/ipc/session-service.ts` | `runMoATurn` 按 `channel.provider` 选 runner（kscc→bare，外部→`getDecryptedApiKey`+`createPiHttpSeatRunner`）；外部 dispatch 用 `resolveConsultPresetsForChannel` 注入合成预置 |
| UI 渠道感知 | `apps/electron/src/renderer/components/chat/ConsultMenu.tsx`、`Chat.tsx` | `SendSplitButton` 增 `channel?`：外部菜单加「将按预置席位分别计费」+ 同模预置 trailing 标「同模」；`Chat.tsx` 用 `resolveConsultPresetsForChannel(selectionChannel, consultPresets)` 替代 `filter(enabled)` |

### 9.2 关键不变式（对齐 SPEC §2 / brief）

- **不 setModel('moa:…') / 外部不 spawn kscc bare**：`runMoaTurn` 只收 `seatRunner`，凭据（apiKey）在 session-service 解密后注入 runner，**不**进 `MoATurnContext` 的落盘 / 圆桌卡 / 预置文件路径。外部渠 `createPiHttpSeatRunner` 走 `createHttpDirectStreamFn`，绝不 `spawnKsccBare`。
- **同场不混核 / 跨渠禁席**：一个 `runMoaTurn` 全程只用一种 runner（主进程按 channel 选定）；`validateMoAPresetForChannel` 校验席位 modelId ∈ 当前 channel.enabled，kscc 预置的 glm/kimi 不在外部渠 → 报「在当前渠道未启用」。
- **合成预置 ephemeral**：`channel-default` / `channel-same-model` 由 `resolveConsultPresetsForChannel` 现场合成，不写 `moa-presets.json`（无 CRUD）。
- **HTTP 首包超时用预置 timeout**：`createPiHttpSeatRunner` 把 `timeoutMs`（= `preset.timeoutMsPerSeat`）透传给 streamOptions，不用 30min 默认（SPEC §7）。

### 9.3 单测

```text
bunx vitest run \
  packages/shared/src/types/moa-preset.test.ts \
  packages/shared/src/types/moa-roundtable.test.ts \
  packages/pi-core/src/moa-orchestrator.test.ts \
  apps/electron/src/main/lib/agent/moa-dispatch.test.ts
# 4 文件 / 71 用例全过
```

全量 `bunx vitest run`：**88 文件 / 910 用例全过**（无回归）。
`bun test apps/electron/src/renderer/components/chat/session-turn-model.test.ts`（bun:test，vitest 排除）：13 用例全过。

新增覆盖：
- `resolveConsultPresetsForChannel`：kscc 过滤不可用；外部 ≥2 合成 `channel-default`（汇总=defaultModelId 或首个 enabled）；外部 =1 合成 `channel-same-model`（同 modelId + 不同 system）；外部 ≥2 命中 stored 不合成；external 0 模 / 渠道缺失 → `[]`。
- `createPiHttpSeatRunner`（mock `createHttpDirectStreamFn` 喂事件流）：收集 `done.message` 纯文本；`onTextDelta` 流式；error 事件抛 errorMessage；factory 注入 provider/apiKey/baseUrl/modelId、`Context.systemPrompt` + `tools:[]`、`options.timeoutMs`。
- seatRunner 注入分流：`runReferenceModels`/`runAggregatorModel` 注入 runner 时绕过 `spawnKsccBare`；参考席 `ref.systemPrompt` 透传；汇总席 systemPrompt 含参考输出 + 聚合器指令。
- dispatch 放宽：外部渠 seats 命中 → `moa`（不再因 provider 硬拒）；seats 不在渠道 → error 点名模型（跨渠禁席）；合成 `channel-default` 可解析。

### 9.4 typecheck

```text
cd packages/shared && bun run typecheck   # tsc --noEmit
cd packages/pi-core && bun run typecheck
cd apps/electron && bun run typecheck
```

- `@tagent/pi-core`：通过。
- `@tagent/shared`：**1 条既有无关错误**（非本包引入）：`src/types/moa-history.test.ts(24,5)` —— `assistantMsg` 测试桩把 `TAgentContentBlock` 拼进 content 联合，属上轮 §8 留下的测试桩类型债；本包未改 moa-history，按 brief「勿大范围清债」未修。
- `@tagent/electron`：**1 条既有无关错误**（非本包引入）：`src/renderer/components/chat/Chat.tsx(658,62)` —— 上轮 §8 sticky-moa 回落 `updateSessionMeta(sessionId, { modelId })`，而 preload `updateSessionMeta` patch 类型仅 `{title,pinned,archived,subagentEagerness,reasoningEffort}`（不含 `modelId`）。属 preload 类型偏窄的既有债；本包仅改 Chat.tsx 的会诊菜单预置解析（import / `consultPresetsForMenu` / 3 处 `channel` prop），未触该 useEffect 与 preload，未修。

### 9.5 验收核对（对 03-PI-EXTERNAL-MOA-SPEC §6）

1. ✅ 外部渠（≥2 模）会话：▾ 出会诊 → 发本条 → 圆桌卡进度 → 汇总结论；选择器仍显真实模型（one-shot 不写 sticky `moa:*`，沿用 §8.1 `decideMoaMetaPatch`）。
2. ✅ 会诊引用前文：`runMoaTurn` 复用 `buildHistoryForTurn` → orchestrator `historyText`（kscc / 外部同路）。
3. ✅ 仅 1 模外部渠：合成 `channel-same-model`，菜单 trailing 标「同模」。
4. ✅ kscc 会诊回归：默认 runner = `createKsccSeatRunner`（既有 bare），行为不变（旧单测全绿）。
5. ✅ 单测：`resolveConsultPresetsForChannel`；Pi seat runner mock HTTP；dispatch 外部渠不再因 provider 硬拒。
6. ✅ 未做：跨渠混席、外部预置 CRUD 设置页、汇总席工具、ACP 圆环。

### 9.6 文件改动清单

修改（全在既有文件上加，无新增文件）：
- `packages/shared/src/types/moa-preset.ts`（`MoAReferenceSeat.systemPrompt?` + `MoAPreset.synthetic?` + `resolveConsultPresetsForChannel` + 合成 helpers；`isValidMoAPreset` 放行）
- `packages/shared/src/types/moa-preset.test.ts`（`resolveConsultPresetsForChannel` + synthetic 字段单测）
- `packages/pi-core/src/moa-orchestrator.ts`（`MoASeatRunner` / `createKsccSeatRunner` / `createPiHttpSeatRunner`；`runReferenceModels`/`runAggregatorModel` 增 `seatRunner?`；删 `runOneReference`）
- `packages/pi-core/src/index.ts`（导出 runner 符号）
- `packages/pi-core/src/moa-orchestrator.test.ts`（Pi runner mock HTTP + 注入分流单测）
- `apps/electron/src/main/lib/agent/moa-dispatch.ts`（放宽门禁：删 provider 硬拒；消息改「当前渠道」）
- `apps/electron/src/main/lib/agent/moa-dispatch.test.ts`（外部 seats 命中→moa；跨渠禁席；合成预置可解析）
- `apps/electron/src/main/lib/agent/run-moa-turn.ts`（`MoATurnContext.seatRunner`；转发 runner）
- `apps/electron/src/main/lib/ipc/session-service.ts`（按 provider 选 runner + 解密 apiKey；外部 dispatch 注入合成预置）
- `apps/electron/src/renderer/components/chat/ConsultMenu.tsx`（`channel?` prop + 外部计费提示 + 同模 trailing）
- `apps/electron/src/renderer/components/chat/Chat.tsx`（`resolveConsultPresetsForChannel` + 3 处 `channel` prop）

未改：`moa-preset-service` / `config-paths` / IPC 通道 / preload / `ModelSelector`（sticky MoA 仍 kscc-only，外部入口仅发送旁 ▾ one-shot）/ `moa-roundtable` 状态机 / `moa-history` / ACP 线。
未 commit / push（按 brief 禁止）。

### 9.7 仍后置（本期不做）

- 跨渠混席（一席 kscc + 一席外部）—— SPEC 不变式，显式不做。
- 外部预置 CRUD 设置页（合成预置仍 ephemeral）。
- 汇总席只读工具（Pi HTTP 端 tools 接线）。
- ACP / context-usage 圆环（外部汇总模型 contextWindow 分母）。
- preload `updateSessionMeta` 类型偏窄（§9.4 既有债）。

---

## 10. 会诊→普通续聊上下文断裂 + 落盘 role（2026-08-09 · P0 #1 / P0 #2 / P1）

对照 `AUDIT-fresh-session-consult-FINDINGS.md` + brief `FIX-moa-then-normal-context-brief.md`。
**根因（非误触发）**：会诊不建长驻 kscc、不写 `sdkSessionId`；下一条普通 `isFirst=true` spawn 时
`resumeSessionId: meta?.sdkSessionId` 为空 → kscc 新进程零上文（L5「这个会话没有上文」）；Pi 首条
Agent `messages:[]` 同样零上文。落盘侧 L2 `uuid=moa-agg-…` 缺 `message.role`（不利于后续 resume / IR）。

### 10.1 完成

| 件 | 路径 | 说明 |
|---|---|---|
| 续聊注入纯函数 | `packages/shared/src/types/moa-history.ts` (+`.test.ts`) | 新增 `panelMessageToHistoryIR`（面板 SDKMessage / IR 混排 → IR）+ `buildResumeHistoryFromPanel`（面板 → `[会话上下文]…`，复用 `buildMoAHistoryFromMessages`，`excludeTrailingTurn` 默认 true 排除本轮 user）。`index.ts` 已 `export * from './moa-history'`，自动导出 |
| 落盘 shape 纯函数 | `packages/shared/src/types/moa-persist.ts` (+`.test.ts`、`index.ts`) | 新增 `buildMoAFinalAssistantSDKMessage`：对齐普通 assistant + 补 `message.role:'assistant'`（`stop_reason:'end_turn'` / `model` / `_channelModelId` / `uuid` / `parent_tool_use_id:null` / `createdAt`）。集中构造便于单测断言 shape |
| session-service 续聊注入 | `apps/electron/src/main/lib/ipc/session-service.ts` | `handleSend` 在落 user 后、`buildQueryOptions` 前：`isFirst && !meta?.sdkSessionId && !adapter.hasActiveChannel?.(sessionId)` 三合一触发时，把 `buildResumeHistoryFromPanel(面板)` 历史经 `composeMoaPrompt` 拼进 `normalizedInput.prompt`。kscc / Pi 共用 `buildQueryOptions` 读 `input.prompt`，一次覆盖两核 |
| run-moa-turn 落盘复用 | `apps/electron/src/main/lib/agent/run-moa-turn.ts` | `persistAndPushFinalAssistant` 改用 `buildMoAFinalAssistantSDKMessage`（消除散落字段；shape 由纯函数单测锁定） |
| ConsultMenu 副文案（P1） | `apps/electron/src/renderer/components/chat/ConsultMenu.tsx` | PopoverContent 加一行「会诊席位无工具；查本地仓库请用左侧 ↑。」（提示会诊无工具，查本地仓库用普通发送） |

### 10.2 关键不变式（对齐 brief）

- **注入仅在「无任何上文来源」时触发，避免双上下文**：三条件缺一不注——
  ① `isFirst`：仅 spawn 路径；长驻续轮（kscc live loop / Pi `SessionEntry`）上文在内存，不注入。
  ② `!meta?.sdkSessionId`：kscc 有 `sdkSessionId` 时走 resume（`resumeSessionId` 读 JSONL，含会诊落盘），不注入；Pi 从不写 `sdkSessionId`，此条件恒 true。
  ③ `!adapter.hasActiveChannel`：**Pi 续轮 `isFirst` 恒 true**（每 turn loop 退、Agent 留内存），但 `SessionEntry` 仍在即 `state.messages` 持有上文 → 此处为否决项，仅当无内存 Agent（会诊后 / 重启 / 切核重建）才注入。kscc spawn 前无活跃渠道，同满足。
- **落盘 user 仍是干净原文，模型才看注入版**：注入只改 `normalizedInput.prompt`（副本），落盘 user 用 `input.prompt`（原文）。故面板 / JSONL 转录忠实（`user: 原始问题`），模型收 `[会话上下文]…[本轮议题]\n原始问题`。下一轮读面板历史时见干净的 user 文本，无重复。
- **空历史 → no-op**：新会话首条面板仅本轮 user，`excludeTrailingTurn` 排除后历史为空 → `buildResumeHistoryFromPanel` 返回 `''` → `composeMoaPrompt(prompt,'')` 原样返回，不污染 prompt。
- **落盘 shape**：`message.role:'assistant'` 是会诊落盘对普通 SDK assistant 的**增强**（普通 SDK assistant 不带此字段），显式补上利于后续 resume / IR 识别角色；`stop_reason:'end_turn'` 使 `sdkMessageToIR` 判 final 非 partial（单测验证 round-trip 不带 `_partial`）。
- **绝不 setModel('moa:…')** 不变式沿用 §2 / §9.2；本期只改普通路径 spawn 前的 prompt 拼装，不触 MoA 分流。

### 10.3 单测

```text
bunx vitest run \
  packages/shared/src/types/moa-history.test.ts \
  packages/shared/src/types/moa-persist.test.ts
# 2 文件 / 33 用例通过（moa-history 26 + moa-persist 7）
```

全量 `bunx vitest run`：**89 文件 / 930 用例全过**（无回归）。

新增覆盖：
- `panelMessageToHistoryIR`：IR 形态直通（pi 面板）；SDKMessage 形态 user / `moa-agg` assistant 转 IR 保文本 + `stop_reason`；`result` / `system` / `null` / 非对象 → null。
- `buildResumeHistoryFromPanel`：**面板有 MoA 轮 → 拼出含会诊结论的历史块**（SDKMessage / IR / 混排三场景；含 `[用户]`/`[助手]` 标签 + 会诊结论）；`excludeTrailingTurn` 默认排除本轮 user（不进历史）；空面板 / 新会话首条 → `''`；`excludeTrailingTurn:false` 保留本轮；`charBudget` 超限从最旧截断、保留含结论的近轮。
- `buildMoAFinalAssistantSDKMessage`：`type:'assistant'` / `message.role:'assistant'` / `content[0].text` / `stop_reason:'end_turn'` / `message.model` + `_channelModelId` / `uuid(moa-agg-*)` / `parent_tool_use_id:null` / `createdAt`；round-trip `sdkMessageToIR` 为 final 非 partial。

### 10.4 typecheck

```text
cd packages/shared && bun run typecheck   # tsc --noEmit  → 通过（exit 0）
cd apps/electron && bun run typecheck     # → 1 条既有无关错误（见下）
```

- `@tagent/shared`：**通过**。顺手修了 §9.4 既有测试桩类型债：`moa-history.test.ts` 的 `assistantMsg` helper 把 `extra` 类型从 `TAgentMessage['content']`（user/assistant 联合，含 `{type:string;…}` 导致不可赋值）改为 `TAgentContentBlock[]`（assistant 内容类型）。该桩 `extra` 从未传非空值，行为不变；因本期已改该测试文件，就近清掉以还 typecheck 干净。
- `@tagent/electron`：**1 条既有无关错误**（非本包引入，与 §9.4 同一条）：
  - `src/renderer/components/chat/Chat.tsx(658,62): error TS2353: ... 'modelId' does not exist in type '{ title?; pinned?; ... }'`
  - 上轮 §8 sticky-moa 回落 `updateSessionMeta(sessionId, { modelId })`，而 preload `updateSessionMeta` patch 类型偏窄（不含 `modelId`）。本包未改 Chat.tsx / preload，按 brief「勿大范围清债」未修（修需扩 preload IPC patch 类型，溢出本期范围）。

### 10.5 验收核对（对 brief）

1. ✅ **续聊注入**（单测映射）：新会话 ▾ 会诊一条（任意短问）落盘 `[user, moa-agg assistant]` → 再 ↑ 普通追问「刚才结论里第 1 点是什么」落盘本轮 user。`buildResumeHistoryFromPanel` 读面板 → `[会话上下文]\n[用户] <短问>\n[助手] <会诊结论>\n\n`（排除本轮 user）→ `composeMoaPrompt` 拼成 `[会话上下文]…[本轮议题]\n刚才结论里第 1 点是什么` → 模型收本轮 prompt 含会诊结论，可引用第 1 点。（单测 `SDKMessage 面板有 MoA 轮 → 拼出含会诊结论的历史块` 锁定；端到端需跑应用 + 真实模型，环境受限未手测。）
2. ✅ **落盘 shape**：`buildMoAFinalAssistantSDKMessage` 单测断言 `message.role:'assistant'` + 对齐字段 + `sdkMessageToIR` round-trip 非 partial。
3. ✅ **P1 副文案**：`ConsultMenu` PopoverContent 加「会诊席位无工具；查本地仓库请用左侧 ↑。」
4. ✅ 相关 vitest 绿（33 用例）+ 全量无回归（930 用例）。

### 10.6 文件改动清单

新增：
- `packages/shared/src/types/moa-persist.ts` + `moa-persist.test.ts`（落盘 shape 纯函数 + 单测）

修改：
- `packages/shared/src/types/moa-history.ts`（新增 `panelMessageToHistoryIR` + `buildResumeHistoryFromPanel`；新 import `sdkMessageToIR` / `SDKMessage`）
- `packages/shared/src/types/moa-history.test.ts`（新增 `panelMessageToHistoryIR` + `buildResumeHistoryFromPanel` 单测；顺手修 `assistantMsg` stub 类型债）
- `packages/shared/src/types/index.ts`（`export * from './moa-persist'`）
- `apps/electron/src/main/lib/ipc/session-service.ts`（`handleSend` 续聊注入 + import `buildResumeHistoryFromPanel` / `composeMoaPrompt`）
- `apps/electron/src/main/lib/agent/run-moa-turn.ts`（`persistAndPushFinalAssistant` 改用 `buildMoAFinalAssistantSDKMessage`）
- `apps/electron/src/renderer/components/chat/ConsultMenu.tsx`（P1 副文案一行）

未改：`moa-dispatch` / `moa-preset` / `moa-roundtable` 状态机 / pi-core orchestrator / `ModelSelector` / preload / IPC 通道 / `moa-preset-service` / `config-paths`。
未 commit / push（按 brief 禁止）。

### 10.7 仍后置（本期不做）

- 汇总席只读工具（Read 等）—— 会诊席位仍 `tools:[]`（§3.1 / §9.7）；P1 仅加文案提示「无工具，查仓库请用 ↑」。
- preload `updateSessionMeta` patch 类型偏窄（§9.4 / §10.4 既有债，Chat.tsx:658）。
- 跨渠混席 / 外部预置 CRUD / ACP 圆环（沿用 §9.7）。
- 续聊注入仅做「拼历史进 prompt」最小改；未做把会诊结论写成可 resume 的结构化 shape 接到 kscc `--resume`（brief 明列「不上汇总只读工具大改」，注入即最小修复）。
- **长驻 live loop 不知会诊（既有缺口，非本包引入，超出 brief P0 #1 范围）**：brief P0 #1 显式只覆盖「`isFirst` spawn」路径。若先普通聊一轮（kscc live loop 存活、`sdkSessionId` 已写）→ 再 ▾ 会诊一条（MoA 走 bare、不喂 live loop、只落 JSONL）→ 再普通续聊，此时 `isFirst=false`（live loop 在）→ 走 enqueue，live loop 内存上下文只含第一轮、**不含会诊**，模型仍引用不到会诊结论。本包注入条件含 `isFirst`，对此场景不触发（避免与 live loop 内存双上下文）。修需在 enqueue 前注入或会诊后 drop live loop re-spawn，属大改，本期不做。审计场景（新会话首条即会诊 → 续聊）`isFirst=true` 已由本包覆盖。

---

## 10. 新会话首条会诊审计补丁（2026-08-09 · AUDIT-fresh-session-consult）

对照 `AUDIT-fresh-session-consult-brief.md` / FINDINGS。审计最新会话 `session-1786259684183`（kscc-internal，one-shot 会诊本条）后的小修。

### 10.1 已修（小补丁 + 单测）

- **历史重复**：`buildHistoryForTurn` 在 `persistAndPushUser` 后读面板，把本轮 user 算进「会话上下文」→ 新会话首条议题重复（参考席 2 倍 / 汇总席 4 倍），违反 `run-moa-turn.ts`/`moa-history.ts` 注释不变式。
  - `packages/shared/src/types/moa-history.ts`：`BuildMoAHistoryOptions` 增 `excludeTrailingTurn?: boolean`；`buildMoAHistoryFromMessages` 为 true 时丢末条。默认 false（兼容）。
  - `apps/electron/src/main/lib/agent/run-moa-turn.ts`：`buildHistoryForTurn` 传 `{ excludeTrailingTurn: true }`；JSDoc 改述机制。
  - `packages/shared/src/types/moa-history.test.ts`：+3 用例（丢末条 / 首条→空 / 默认 false）。
- **moa-agg 落盘 shape**：`persistAndPushFinalAssistant` 补 `message.role:'assistant'`（对齐普通 assistant；`sdkMessageToIR` 不读 role，无行为变化）。

单测：`bunx vitest run` 5 MoA 文件 87 用例 + 23 文件 217 用例 + `bun test session-turn-model` 13 用例全过；typecheck 仅既有 `moa-history.test.ts(24,5)` 债（非本包）。

### 10.2 待办（需产品拍板 / 另开 brief，本轮勿大改）

- **P0 主因——会诊→续聊上下文断裂**：one-shot 会诊走 bare 编排，不建长驻 kscc、不写 `meta.sdkSessionId`；续聊 `isFirst` 且 `resumeSessionId: meta?.sdkSessionId` 为空 → kscc 全新进程丢会诊上下文（最新会话 msg[3] thinking 原文「我之前没有对话上下文（这是新会话的第一条消息）」为冒烟枪）。拟修：首条 spawn 且无 `sdkSessionId`、面板有历史时注入面板历史到 system prompt（泛化 `buildMoAHistoryFromMessages`），需先核 kscc resume 与 JSONL 文件名（TAgent sessionId）vs sdkSessionId 对应。**非小补丁**，另开 brief。
- 汇总席只读工具（§3.1 / §9.7 仍后置）、圆桌卡落盘（上轮 finding D）、会诊轮 turnDurations 缺记（上轮 finding E）——见 FINDINGS §3 选项。

---

## 11. 设置 · Agent 行为 tab + 会诊班底 CRUD（2026-08-09 · SPEC 04）

对照 `04-AGENT-BEHAVIOR-SETTINGS-SPEC.md` / brief `IMPLEMENT-AGENT-BEHAVIOR-SETTINGS-brief.md`：
设置页新增 **Agent 行为** tab（核心组，渠道之后）；班组 / 圆桌占位 + 会诊班底 CRUD。本轮**只做会诊
stored 预置 CRUD**，班组 / 圆桌不做真表单。

### 11.1 完成

| 件 | 路径 | 说明 |
|---|---|---|
| IPC 通道 | `packages/shared/src/types/agent.ts` | `AGENT_IPC_CHANNELS.SAVE_MOA_PRESETS: 'agent:save-moa-presets'`（紧邻既有 `LIST_MOA_PRESETS`） |
| 整单校验 + 拒写 | `apps/electron/src/main/lib/agent/moa-preset-service.ts` | 新增 `validateMoAPresetList`（结构复用 `isValidMoAPreset` + id 唯一，返回中文错或 null）；`writeMoaPresets` 改为**整单校验失败抛中文错、不写盘**（SPEC §2.2），写前防御性剥离 `synthetic` ephemeral 字段；文件头注释更新「已有 UI CRUD」 |
| save handler | `apps/electron/src/main/lib/ipc/session-service.ts` | `SAVE_MOA_PRESETS` handler：`validateMoAPresetList` 拒写抛错 → `writeMoaPresets` → 再 `listMoaPresets` 回传 |
| preload 桥 | `apps/electron/src/preload/index.ts` | `saveMoaPresets(presets)` → `Promise<MoAPreset[]>`（校验失败 reject，调用方 catch） |
| App 类型 | `apps/electron/src/renderer/App.tsx` | 手写 `Window.electronAPI` 补 `saveMoaPresets`（与 `listMoaPresets` 同口径补洞） |
| Settings tab | `apps/electron/src/renderer/components/settings/SettingsPage.tsx` | `SettingsTab` 增 `'agent'`；核心组插「Agent 行为」（渠道与关于之间，`Users` 图标）；`renderTabContent` 分支；`agent` 并入 `settings-shell-content--wide`（编辑器密度同渠道） |
| Agent 行为页 | `apps/electron/src/renderer/components/settings/AgentBehaviorSettings.tsx`（新） | 三节：班组占位 / 会诊 CRUD / 圆桌占位（`SettingsSection`+`SettingsCard`）；会诊列表 + 新建/编辑编辑器 + 启用开关 + 参考席增删 + 汇总模型 + 超时；modelId 下拉吃 kscc-internal enabled 模型（无 kscc 渠时手动输入兜底） |
| service 单测 | `apps/electron/src/main/lib/agent/moa-preset-service.test.ts`（新） | `validateMoAPresetList`（合法/null、非数组、参考<2、空名、id 重复、空数组）+ `writeMoaPresets`（写盘、非法抛错不脏写、剥离 synthetic、重复 id 抛错） |

### 11.2 关键不变式（对齐 SPEC §2 / brief）

- **整单校验失败不脏写盘**：`writeMoaPresets` 先 `validateMoAPresetList`，任一条目结构非法或 id 重复即 `throw new Error(中文)`，**不调用** `writeJsonAtomic`。save handler 同样先校验再写，校验失败以 reject 传给渲染层（IPC `invoke` reject → 渲染层 catch 回显中文错）。单测锁定「先写合法、再写非法 → 文件保留合法内容」。
- **只编辑 stored 预置**：列表来自 `listMoaPresets`（读 `moa-presets.json`，本就只含 stored）；synthetic / channel-default / channel-same-model 由 `resolveConsultPresetsForChannel` 现场合成、不进设置列表、不落盘。`writeMoaPresets` 写前剥离 `synthetic`（防御性，即便误传也不脏盘）。
- **id 稳定 + seed 不可改 id**：新建预置自动生成 `custom-<短随机>`（碰撞重试 / 时间戳兜底）；seed `default`/`cheap` 编辑器内 id 字段 disabled。SPEC「seed 允许改内容、不允许改 id」由编辑器只读 id 保证；内容（名称/席位/汇总/超时/启用）可改。
- **删除二次确认**：所有删除（seed + custom）走 `DestructiveConfirmDialog`，满足「删除 seed 要二次确认」。
- **modelId 下拉同渠口径**：参考席 / 汇总模型下拉优先列 kscc-internal 渠已启用模型（`ksccChannelAtom`）；无 kscc 渠或无已启用模型时降级为手动输入（提示「须在会诊时所属渠道启用」）。当前值不在列表时兜底显示，避免空白。运行时可用性（席位是否真属于当前渠道且 enabled）仍由 `validateMoAPresetForChannel` 在 `runMoaTurn` 发送前校验——设置页只做结构校验，不做「modelId 是否真实存在」二次校验（与 service 注释一致）。
- **不 setModel('moa:…')** 不变式沿用 §2 / §9.2；本期仅加设置页 CRUD，不触发送分流。

### 11.3 单测

```text
npx vitest run \
  apps/electron/src/main/lib/agent/moa-preset-service.test.ts \
  packages/shared/src/types/moa-preset.test.ts \
  packages/shared/src/types/moa-persist.test.ts
# 3 文件 / 41 用例全过（moa-preset-service 10 新增 + moa-preset 24 + moa-persist 7）
```

全量 MoA 线 `vitest run`（7 文件：moa-preset / moa-roundtable / moa-history / moa-persist / moa-orchestrator / moa-dispatch / moa-preset-service）：**114 用例全过**（无回归）。

新增覆盖：
- `validateMoAPresetList`：seed 合法→null；非数组→「不合法」；参考<2→「结构不合法」点名名称；空 name→「结构不合法」；id 重复→「重复」点名 id；空数组→null。
- `writeMoaPresets`：合法写盘后 `listMoaPresets` 回读 id 齐；**先写合法再写非法 → 抛「结构不合法」且文件保留合法内容**（不脏写）；写含 `synthetic` 的预置 → 落盘文件 `synthetic` 被剥离；重复 id → 抛「重复」。

### 11.4 typecheck

```text
cd packages/shared && bun run typecheck   # tsc --noEmit → 通过（exit 0）
cd apps/electron && bun run typecheck     # → 1 条既有无关错误（见下）
```

- `@tagent/shared`：**通过**（新增 `SAVE_MOA_PRESETS` 常量无类型影响）。
- `@tagent/electron`：**1 条既有无关错误**（非本包引入，与 §9.4 / §10.4 同一条）：
  - `src/renderer/components/chat/Chat.tsx(658,62): error TS2353: ... 'modelId' does not exist in type '{ title?; pinned?; ... }'`
  - 上轮 §8 sticky-moa 回落 `updateSessionMeta(sessionId, { modelId })`，而 preload `updateSessionMeta` patch 类型偏窄（不含 `modelId`）。本包未改 Chat.tsx / preload 的该 patch，按 brief「勿大范围清债」未修。

### 11.5 验收核对（对 SPEC 04 §3）

1. ✅ 设置出现 **Agent 行为** tab（核心组，渠道之后）；班组 / 圆桌占位文案可见（`SettingsSection`+`SettingsCard`，无表单）。
2. ✅ 会诊 CRUD：新建（自动 `custom-<短随机>` id）→ 保存（整份 `saveMoaPresets`）→ 重开设置仍在（落 `moa-presets.json`）；编辑启用 / 模型 → 列表反映（保存后服务端 `list` 回传刷新本页）。▾ 菜单反映需重拉（见 §11.6 后置）。
3. ✅ 非法预置（参考<2 / 空名 / 重复 id）保存失败有中文提示（客户端 `validateDraft` + 服务端 `validateMoAPresetList` 双重），文件不被脏写（单测锁定）。
4. ✅ 单测：`writeMoaPresets` / `validateMoAPresetList`（service 层）；`isValidMoAPreset` 既有测保留（24 用例未动）。
5. ✅ typecheck 无新增错（仅 §9.4 既有 Chat.tsx:658 债）；不 commit。

### 11.6 仍后置（本期不做）

- **Chat ▾ 热刷新**：设置页保存后仅刷新本页列表；Chat 的「会诊 ▾」菜单不强制热刷新（SPEC §2.3 允许最小：新开会话或重开菜单前再拉）。本期未做 `listMoaPresets` 广播 / CustomEvent；Chat 已有挂载拉一次的口径不变。
- 班组 / 圆桌真表单（SPEC §4 显式不做）。
- 跨渠混席、外部合成预置编辑（合成预置仍 ephemeral）。
- 汇总席只读工具、ACP 圆环（沿用 §9.7）。
- preload `updateSessionMeta` patch 类型偏窄（§9.4 / §10.4 / §11.4 既有债）。

### 11.7 文件改动清单

新增：
- `apps/electron/src/renderer/components/settings/AgentBehaviorSettings.tsx`
- `apps/electron/src/main/lib/agent/moa-preset-service.test.ts`

修改：
- `packages/shared/src/types/agent.ts`（`SAVE_MOA_PRESETS` 通道）
- `apps/electron/src/main/lib/agent/moa-preset-service.ts`（`validateMoAPresetList` + `writeMoaPresets` 整单拒写 + 剥离 synthetic + 文件头注释）
- `apps/electron/src/main/lib/ipc/session-service.ts`（`SAVE_MOA_PRESETS` handler + import `writeMoaPresets` / `validateMoAPresetList`）
- `apps/electron/src/preload/index.ts`（`saveMoaPresets` 桥）
- `apps/electron/src/renderer/App.tsx`（`Window.electronAPI.saveMoaPresets` 类型）
- `apps/electron/src/renderer/components/settings/SettingsPage.tsx`（`'agent'` tab + `Users` 图标 + `renderTabContent` + wide 内容）

未改：`moa-dispatch` / `moa-preset` 类型 / `moa-roundtable` 状态机 / pi-core orchestrator / `ModelSelector` / `ConsultMenu` / `Chat.tsx` / `config-paths` / `LIST_MOA_PRESETS` 既有通道与桥。
未 commit / push（按 brief 禁止）。

---

## 12. 会诊班底双核（channelId 落盘 + 设置渠道选择器）（2026-08-09 · SPEC 05）

对照 `05-CONSULT-PRESETS-DUAL-CORE-UX-SPEC.md` / brief `IMPLEMENT-DUAL-CORE-CONSULT-PRESETS-brief.md`：
会诊班底按 `channelId` 落盘（v2），设置页顶部「适用渠道」选择器，列表/新建/编辑/模型下拉只对应当前选中渠，
外部渠空态合成兜底 +「基于当前模型生成并编辑」CTA。同场不混核、不跨渠混席不变。

### 12.1 完成

| 件 | 路径 | 说明 |
|---|---|---|
| 类型 / 校验 | `packages/shared/src/types/moa-preset.ts` | `MoAPreset.channelId?`（落盘必填，synthetic 可不带）；`MoAPresetsFile.version` → `2`；`isValidMoAPreset` 要求非空 channelId（synthetic 豁免）；新增 `migrateMoAPresetsV1toV2(presets, ksccChannelId)`；新增 `buildChannelBasedDraftPreset(channel, presetId)`（空态 CTA 用 draft，带 channelId、无 synthetic） |
| 按渠解析 | `packages/shared/src/types/moa-preset.ts` | `resolveConsultPresetsForChannel`：stored 先按 `channelId === channel.id` 过滤（`presetBelongsToChannel`：兼容旧无字段视为 kscc），再跑可用性/合成；外部 =1 模也优先本渠 stored 同模班底，无则合成 `channel-same-model` |
| 服务迁移 | `apps/electron/src/main/lib/agent/moa-preset-service.ts` | 读文件时 version<2 或条目缺 channelId → `migrateMoAPresetsV1toV2` 绑到当前唯一 kscc-internal 渠道 id（`getKsccChannelId() ?? 'kscc-internal'`），写回 v2；`buildSeed(ksccChannelId)` 注入 channelId；`writeMoaPresets` 写 v2；`validateMoAPresetList` 错误文案含 channelId |
| 设置页双核 UI | `apps/electron/src/renderer/components/settings/AgentBehaviorSettings.tsx` | 顶部「适用渠道」Select（kscc 置顶，其余 enabled 外部渠按名）；列表/新建/编辑/模型下拉只对当前选中渠；外部 0 模禁新建 + 文案、1 模同模多角色提示、空列表合成兜底说明 + CTA（`buildChannelBasedDraftPreset` 生成 draft 进编辑器，保存带 channelId）；文案随选中渠说明；`PresetDraft.channelId` + 编辑器 `channelModels/channelId` |
| 设置页 CSS | `apps/electron/src/renderer/styles/agent-behavior-settings.css` | `.agent-behavior-channel-select[-label/-trigger]` + `.agent-behavior-empty-cta` |
| 单测 | `moa-preset.test.ts` / `moa-preset-service.test.ts` | 迁移、按渠过滤、外部有/无自定义、channelId 校验、`buildChannelBasedDraftPreset`、v1→v2 读迁移写回 |

### 12.2 关键不变式（对齐 SPEC 05 §1 / brief）

- **同场不混核 / 不跨渠混席**：一张班底 `channelId` 唯一；`resolveConsultPresetsForChannel` 按 `channelId === channel.id` 过滤（外部仅认 channelId 命中，旧无字段视为 kscc 不计外部席）；设置 UI 列表/编辑器只显本渠班底，`draft.channelId` = 选中渠 id；编辑器在选中渠上下文打开，切换渠道时选择器禁用（避免编辑中途跨渠）。
- **无自定义 → 合成兜底 / 设置可配覆盖合成**：外部渠无本渠 stored → `resolveConsultPresetsForChannel` 合成 `channel-default`（≥2 模）或 `channel-same-model`（=1 模）；有本渠 stored → 优先用 stored（=1 模亦优先 stored 同模班底）。
- **synthetic 不落盘 / channelId 落盘**：`synthetic` 合成预置 ephemeral（`isValidMoAPreset` 豁免 channelId）；`writeMoaPresets` 写前剥离 `synthetic`、写 v2；stored 预置必带 channelId（`isValidMoAPreset` 要求，`validateMoAPresetList` 经此整单校验）。
- **v1 → v2 就地迁移**：`listMoaPresets` 读到 version<2 或缺 channelId → `migrateMoAPresetsV1toV2` 绑到 kscc-internal 渠 id，写回 v2；已有 channelId 的条目保持不变（不跨渠重绑）。
- **整份保存不跨渠误删**：删除 / 切启用 / 新建 / 编辑均 `listMoaPresets` 读全量 → 仅改本条 → `saveMoaPresets` 整份写，其余渠班底原样保留。
- **不 setModel('moa:…')** 不变式沿用 §2 / §9.2；本期只改班底落盘 + 设置 UI，不触发送分流。session-service 外部路径 `resolveConsultPresetsForChannel(channel, storedPresets)` 现吃带 channelId 的 stored（函数变更自动覆盖，无需改 session-service）；▾ 仍按当前会话渠道解析，不在 ▾ 里跨渠选班底。

### 12.3 单测

```text
bunx vitest run \
  packages/shared/src/types/moa-preset.test.ts \
  packages/shared/src/types/moa-roundtable.test.ts \
  packages/shared/src/types/moa-history.test.ts \
  packages/shared/src/types/moa-persist.test.ts \
  packages/pi-core/src/moa-orchestrator.test.ts \
  apps/electron/src/main/lib/agent/moa-dispatch.test.ts \
  apps/electron/src/main/lib/agent/moa-preset-service.test.ts
# 7 文件 / 134 用例全过
```

新增覆盖：
- `migrateMoAPresetsV1toV2`：缺 channelId 绑 kscc；已有 channelId 保持；空串视为缺；保留其余字段；空数组。
- `isValidMoAPreset` channelId：非 synthetic 须非空 channelId（空/undefined/非字符串拒）；synthetic 豁免（带/不带 channelId 均过，但 channelId 类型非法仍拒）。
- `resolveConsultPresetsForChannel` 按 channelId：kscc 命中本渠 channelId；kscc 排除绑别渠的预置（不混席）；kscc 视无字段为 kscc（v1 兼容）；外部排除无字段预置（v1 兼容仅 kscc）→ 合成兜底；外部 =1 模优先本渠 stored 同模班底，无则合成。
- `buildChannelBasedDraftPreset`：≥2 模 channel-default 形态（带 channelId、无 synthetic）；=1 模 channel-same-model 形态（同 modelId + 不同 system）；0 模返回 null；汇总回退首个 enabled。
- service：v1 文件读迁移到 v2（绑 kscc、写回）；迁移保留已有 channelId（不跨渠重绑）；写 v2 + channelId；缺 channelId 整单校验报「结构不合法 channelId」；既有写盘/拒写/剥离 synthetic/重复 id（注入 channelId 后）。

### 12.4 typecheck

```text
cd packages/shared && bun run typecheck   # tsc --noEmit → 通过（exit 0）
cd apps/electron && bun run typecheck     # → 1 条既有无关错误（见下）
```

- `@tagent/shared`：**通过**。
- `@tagent/electron`：**1 条既有无关错误**（非本包引入，与 §9.4 / §10.4 / §11.4 同一条）：
  - `src/renderer/components/chat/Chat.tsx(658,62): error TS2353: ... 'modelId' does not exist in type '{ title?; pinned?; ... }'`
  - 上轮 §8 sticky-moa 回落 `updateSessionMeta(sessionId, { modelId })`，而 preload `updateSessionMeta` patch 类型偏窄（不含 `modelId`）。本包未改 Chat.tsx / preload，按 brief「勿大范围清债」未修。
- 本包改动文件（`moa-preset.ts` / `moa-preset-service.ts` / `AgentBehaviorSettings.tsx`）typecheck 无新增错。

### 12.5 验收核对（对 SPEC 05 §5 / brief 必做）

1. ✅ **MoAPreset.channelId + v2 迁移**：`channelId?` 落盘必填；`MoAPresetsFile.version=2`；`migrateMoAPresetsV1toV2`；`isValidMoAPreset` 要求 channelId（synthetic 豁免）；service 读迁移写回 v2（单测锁定）。
2. ✅ **resolveConsultPresetsForChannel 按渠**：stored 先按 `channelId === channel.id`（兼容旧无字段视为 kscc），再跑可用性/合成（单测锁定）。
3. ✅ **AgentBehaviorSettings 适用渠道选择器 + 按渠 CRUD/模型下拉**：顶部 Select（kscc 置顶，enabled 外部渠按名）；列表/新建/编辑/模型下拉只对当前选中渠；切换渠道列表不串台（`channelPresets` 按 channelId 过滤）。
4. ✅ **外部空态合成 CTA**：外部 0 模禁新建 + 文案；1 模同模多角色提示；空列表合成兜底说明 +「基于当前模型生成并编辑」CTA（`buildChannelBasedDraftPreset` 生成 draft 进编辑器，保存带 channelId）。
5. ✅ **▾ / 主进程**：`resolveConsultPresetsForChannel` + session-service 外部路径吃带 channelId 的 stored；▾ 仍按当前会话渠道解析，不在 ▾ 跨渠选班底（无 Chat.tsx 改动，函数变更已覆盖）。
6. ✅ 相关 vitest 绿（134 用例）；typecheck 无新增错；禁止 commit；同场不混核。

### 12.6 仍后置（本期不做）

- **编辑器不暴露 `systemPrompt` 字段**：CTA 生成的同模多角色 draft 带「怀疑者/实操者」system，保存时保留，但 UI 无 systemPrompt 输入框（brief「编辑器与现剧本卡同一套」，未加新字段）。下轮可加 per-ref system textarea。
- 班组 / 圆桌真表单（SPEC 04 §4 显式不做）。
- 跨渠混席（一席 kscc + 一席外部）—— SPEC 不变式，显式不做。
- 汇总席只读工具、ACP 圆环（沿用 §9.7）。
- preload `updateSessionMeta` patch 类型偏窄（§9.4 / §10.4 / §11.4 / §12.4 既有债）。
- Chat ▾ 热刷新：设置页保存后仅刷新本页列表；Chat 的「会诊 ▾」不强制热刷新（沿用 §11.6）。

### 12.7 文件改动清单

修改：
- `packages/shared/src/types/moa-preset.ts`（`MoAPreset.channelId?` + `MoAPresetsFile.version=2` + `isValidMoAPreset` channelId + `migrateMoAPresetsV1toV2` + `buildChannelBasedDraftPreset` + `resolveConsultPresetsForChannel` 按 channelId 过滤 + `presetBelongsToChannel` helper）
- `packages/shared/src/types/moa-preset.test.ts`（迁移 / channelId 校验 / 按渠过滤 / `buildChannelBasedDraftPreset` 单测 + `makeChannel` id 选项 + 既有用例注入 channelId）
- `apps/electron/src/main/lib/agent/moa-preset-service.ts`（import `migrateMoAPresetsV1toV2` + `getKsccChannelId`；`buildSeed(ksccChannelId)` v2；`listMoaPresets` v1→v2 迁移写回；`writeMoaPresets` v2；`validateMoAPresetList` 文案含 channelId）
- `apps/electron/src/main/lib/agent/moa-preset-service.test.ts`（注入 channelId + v1→v2 迁移单测）
- `apps/electron/src/renderer/components/settings/AgentBehaviorSettings.tsx`（渠道选择器 + 按渠 CRUD/模型下拉 + 外部空态 CTA + `PresetDraft.channelId` + 编辑器 `channelModels/channelId`）
- `apps/electron/src/renderer/styles/agent-behavior-settings.css`（渠道选择器 + 空态 CTA 样式）

未改：`moa-dispatch` / `moa-roundtable` 状态机 / pi-core orchestrator / `ModelSelector` / `ConsultMenu` / `Chat.tsx` / `session-service.ts`（外部路径已用 `resolveConsultPresetsForChannel`，函数变更自动覆盖）/ preload / IPC 通道 / `config-paths`。
未 commit / push（按 brief 禁止）。

---

## 13. 会诊 V3：外部渠合并 + 去 AI 竖线（2026-08-09 · SPEC 05 V3）

对照 `IMPLEMENT-CONSULT-V3-EXTERNAL-MERGE-brief.md` / `05-CONSULT-PRESETS-DUAL-CORE-UX-SPEC.md`（V3）：
会诊设置只保留 **kscc | 外部** 两档（不再一供应商一会诊）；外部档 `channelId` 落盘 = `external`
哨兵，模型下拉 = 所有已启用非 kscc 渠 enabled 模型按 id 去重合并；运行时按池过滤再校验当前渠。
视觉去 AI 味：删名册行左 2px 竖条 / 渐变卡 / hover 抬升，扁平分隔 + 字重层级。

### 13.1 完成

| 件 | 路径 | 说明 |
|---|---|---|
| 外部档哨兵 + 双档 resolve | `packages/shared/src/types/moa-preset.ts` | 导出 `MOA_EXTERNAL_SCOPE_ID='external'`；`presetBelongsToChannel`：kscc 取 `channelId===kscc.id`（+v1 无字段兼容），外部取 `channelId==='external'`；`resolveConsultPresetsForChannel` 外部路径取 external 池再按当前会话渠 `presetSeatsUsableInChannel` 校验，不可用过滤、空 → 合成兜底 |
| 外部合并迁移 | `packages/shared/src/types/moa-preset.ts` | `migrateMoAPresetsV1toV2` 扩展：缺 channelId→kscc；`channelId===kscc`/`'external'` 保持；其余（遗留非 kscc 真实渠 id）→ 改写 `external` |
| 外部档 draft CTA | `packages/shared/src/types/moa-preset.ts` | 抽 `buildDraftFromModels` 私有核心；`buildChannelBasedDraftPreset`（kscc，channelId=kscc.id）+ 新 `buildExternalScopeDraftPreset`（合并模型列表，channelId=external） |
| service 迁移触发 | `apps/electron/src/main/lib/agent/moa-preset-service.ts` | import `MOA_EXTERNAL_SCOPE_ID`；`listMoaPresets` 迁移触发扩为 version<2 / 缺 channelId / 遗留非 kscc 真实渠 id → 绑 kscc 或改写 external，写回 v2 |
| 设置页双档 UI | `apps/electron/src/renderer/components/settings/AgentBehaviorSettings.tsx` | 删「每供应商一 pill」；顶栏仅两档 pill（kscc 内网 / 外部渠道）；外部档 `channelPresets`=`channelId==='external'`、模型下拉=合并模型、draft CTA=`buildExternalScopeDraftPreset`、编辑器 `channelId=external`；kscc 档不变；kscc 不可用时 pill disabled 并回落 external |
| 设置页扁平 CSS | `apps/electron/src/renderer/styles/agent-behavior-settings.css` | 删 `.agent-behavior-row` 左 2px 竖条 + `--on` accent bar；名册去卡片渐变 / 外框，纯 hairline 分隔，hover 仅浅 fill 无抬升；pill 选中改描边+字重+浅 `--settings-chip-fill`（非纯黑/紫块）；座位标题 13px semibold / 座位 11px muted；汇总席用 ink+字重（非 accent）；编辑器去渐变/inset 高光改扁平 fill |
| 单测 | `moa-preset.test.ts` / `moa-preset-service.test.ts` | 迁移（遗留 id→external / 多供应商合并 / kscc·external 保持）、resolve（external 池命中 / 跨渠禁席过滤 / DeepSeek ▾ 命中 / kscc 排外部档）、`buildExternalScopeDraftPreset`（≥2 / =1 / 0 / 去重由调用方） |

### 13.2 关键不变式（对齐 brief A）

- **同场不混核 / 跨渠禁席**：外部档班底 `channelId='external'`，但运行时 `presetSeatsUsableInChannel(preset, 当前会话渠)` 要求席位 modelId ∈ 当前渠 enabled——混 DeepSeek+Mimo 模型的 external 班底在任一具体外部会话渠都不可用 → 过滤 → 合成兜底。kscc 档班底 `channelId=kscc.id`，外部会话取不到（`'external'!==kscc.id`）。
- **外部渠合并**：所有非 kscc 渠统一落 `external` 哨兵，不再一供应商一会诊；模型下拉=全部已启用非 kscc 渠 enabled 并集（按 id 去重）。
- **resolve 按池过滤再校验当前渠**：外部会话 ▾ 取 `channelId==='external'` 池 → 按当前会话渠校验席位 → 不可用过滤 → 空 → 现有 `channel-default`/`channel-same-model` 合成兜底（合成预置 ephemeral 不落盘）。
- **迁移就地**：`listMoaPresets` 读到遗留非 kscc 真实渠 id → 改写 `external` 写回 v2（一次后不再触发）。`channelId=kscc.id` / `'external'` 保持。
- **不 setModel('moa:…')** 不变式沿用 §2/§9.2；本期只改班底落盘档 + 设置 UI / CSS，不触发送分流。session-service 外部路径 `resolveConsultPresetsForChannel(channel, storedPresets)` 函数变更自动覆盖；Chat ▾ 按当前会话渠解析，不在 ▾ 跨档选班底。

### 13.3 单测

```text
bunx vitest run \
  packages/shared/src/types/moa-preset.test.ts \
  apps/electron/src/main/lib/agent/moa-preset-service.test.ts \
  apps/electron/src/main/lib/agent/moa-dispatch.test.ts
# 3 文件 / 81 用例全过
```

全量 `bunx vitest run`：**90 文件 / 968 用例全过**（无回归）。

新增覆盖：
- `migrateMoAPresetsV1toV2`：遗留非 kscc 真实渠 id → `external`；多个不同供应商遗留 id 全合并 `external`；`kscc.id` / `external` 保持；缺/空 channelId → kscc。
- `resolveConsultPresetsForChannel`：external 池命中（`channelId='external'` + 座位在本渠）不合成；external 池班底座位不在当前渠 → 过滤 → 合成；DeepSeek 会话 ▾ 命中本渠启用模型的 external 班底；kscc 排除 external 档（不混档）。
- `buildExternalScopeDraftPreset`：≥2 合并模型 → channel-default 形态（channelId=external，汇总=首个 enabled）；=1 → 同模多角色；0 → null。
- service：遗留 `channelId='ext-1'` 读时改写 `external` 并写回 v2。

### 13.4 typecheck

```text
cd packages/shared && bun run typecheck   # tsc --noEmit → 通过（exit 0）
cd apps/electron && bun run typecheck     # → 1 条既有无关错误（见下）
```

- `@tagent/shared`：**通过**。
- `@tagent/electron`：**1 条既有无关错误**（非本包引入，与 §9.4/§10.4/§11.4/§12.4 同一条）：
  - `src/renderer/components/chat/Chat.tsx(658,62): error TS2353: ... 'modelId' does not exist in type '{ title?; pinned?; ... }'`
  - 上轮 §8 sticky-moa 回落 `updateSessionMeta(sessionId, { modelId })`，而 preload `updateSessionMeta` patch 类型偏窄（不含 `modelId`）。本包未改 Chat.tsx / preload，按 brief「勿大范围清债」未修。
- 本包改动文件（`moa-preset.ts` / `moa-preset-service.ts` / `AgentBehaviorSettings.tsx` / `agent-behavior-settings.css`）typecheck 无新增错。

### 13.5 验收核对（对 brief C）

1. ✅ 顶栏只有「kscc 内网」「外部渠道」两档（删「每供应商一 pill」；kscc 不可用时 pill disabled 并回落 external）。
2. ✅ DeepSeek 会话 ▾ 能吃 `channelId=external` 且模型在本渠启用的班底（`resolveConsultPresetsForChannel` external 池 + `presetSeatsUsableInChannel` 当前渠校验；单测「DeepSeek 会话 ▾」锁定）。
3. ✅ 无左侧竖线 class/样式（删 `.agent-behavior-row` `border-left` + `--on` accent bar；组件不再 emit `--on`；名册去渐变/外框，纯 hairline）。
4. ✅ 相关单测更新（scope external、迁移、resolve）+ `buildExternalScopeDraftPreset`（81 用例绿，全量 968 无回归）。
5. ✅ FIX-NOTES 短节（本节）+ 不 commit。

### 13.6 仍后置（本期不做）

- 跨 kscc/外部混席（一席 kscc + 一席外部）—— SPEC 不变式，显式不做。
- 班组 / 圆桌真表单（SPEC 04 §4 显式不做）。
- 汇总席只读工具、ACP 圆环（沿用 §9.7）。
- preload `updateSessionMeta` patch 类型偏窄（§9.4 既有债）。
- Chat ▾ 热刷新（沿用 §11.6）。
- 编辑器不暴露 per-ref `systemPrompt` 字段（沿用 §12.6）。

### 13.7 文件改动清单

修改：
- `packages/shared/src/types/moa-preset.ts`（`MOA_EXTERNAL_SCOPE_ID` + `migrateMoAPresetsV1toV2` 外部合并 + `presetBelongsToChannel` 双档 + `buildDraftFromModels`/`buildExternalScopeDraftPreset` + `resolveConsultPresetsForChannel` JSDoc + `MoAPreset.channelId` JSDoc）
- `packages/shared/src/types/moa-preset.test.ts`（迁移外部合并 / resolve 双档 / `buildExternalScopeDraftPreset` 单测 + import `MOA_EXTERNAL_SCOPE_ID`/`buildExternalScopeDraftPreset`/`ChannelModel`）
- `apps/electron/src/main/lib/agent/moa-preset-service.ts`（import `MOA_EXTERNAL_SCOPE_ID` + 迁移触发扩为遗留非 kscc id + 文件头/listMoaPresets JSDoc）
- `apps/electron/src/main/lib/agent/moa-preset-service.test.ts`（遗留 ext id 读时改写 external + import `MOA_EXTERNAL_SCOPE_ID`）
- `apps/electron/src/renderer/components/settings/AgentBehaviorSettings.tsx`（双档 pill + 外部合并模型 + `buildExternalScopeDraftPreset` CTA + 编辑器 `channelId=external` + 文案）
- `apps/electron/src/renderer/styles/agent-behavior-settings.css`（去左竖条 / 渐变卡 / hover 抬升；pill 描边+字重+浅 fill；座位层级；编辑器扁平）

未改：`moa-dispatch` / `moa-roundtable` 状态机 / pi-core orchestrator / `ModelSelector` / `ConsultMenu` / `Chat.tsx` / `session-service.ts`（外部路径已用 `resolveConsultPresetsForChannel`，函数变更自动覆盖）/ preload / IPC 通道 / `config-paths`。
未 commit / push（按 brief 禁止）。


