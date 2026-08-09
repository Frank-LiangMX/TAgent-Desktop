# FINDINGS · 新会话首条 one-shot 会诊异常

> 只读摸底 + 根因清晰的小补丁 + 单测。**未 commit**。
> 审计人：kscc (glm-5.2) · 2026-08-09
> brief：`AUDIT-fresh-session-consult-brief.md`；上轮：`AUDIT-latest-session-FINDINGS.md`（session-1786163012352）
> 本文件在「总监初判」（15:23 落盘）基础上核实并补全：**主因已验证、次因已修**。

## 0. 一句话结论 + 根因

**两个问题叠在一起，分清主次**：

- **主因（用户真正感知的「有问题」，需产品拍板、勿大改）**：one-shot 会诊走 `runMoaTurn` 独立 bare 编排，**不建长驻 kscc Query、不写 `meta.sdkSessionId`**。下一条普通发送 `isFirst=true` → spawn 时 `resumeSessionId: meta?.sdkSessionId` 为空 → kscc 全新进程、**不读面板 JSONL** → 续聊**丢会诊上下文**。证据：msg[3] thinking 原文「我之前没有对话上下文（这是新会话的第一条消息）」——续聊 agent 把「你分析不了吗」当成新会话首条，根本没看到上一轮会诊。
- **次因（本轮已修，小补丁+单测）**：`buildHistoryForTurn` 在 `persistAndPushUser` **之后**读面板，把**本轮刚落盘的 user** 也算进「会话上下文」→ 新会话首条时整段历史=议题本身，参考席收议题 **2 倍**、汇总席 **4 倍**（`buildAggregatorPrompt` 在 system 段又注一遍）。违反 `run-moa-turn.ts`/`moa-history.ts` 两处注释白纸黑字的「历史不含本轮 user」不变式——**实现与文档相反**。
- **辅因（已知缺口 §3.1，列选项）**：参考/汇总席 `tools:[]`，对「研究本地项目」这类需文件访问的首条议题，汇总席只能答「无法访问本地文件系统」——这是会诊=多模型讨论的取舍，非本轮回归。

| 项 | 值 |
|---|---|
| 会话 id | `session-1786259684183`（标题「帮我研究一下C:\Users\loumi」） |
| 渠道 | `105b303b-…`「kscc 内网」`provider=kscc-internal`；启用 glm-5.1/5.2、kimi-k2.5/2.6、mimo-v2.5/-pro |
| 会话 modelId | `glm-5.2`（**未粘成** `moa:*`；one-shot 正确不改 meta.modelId）✓ |
| sdkSessionId | `f2bcd639-…`（**由续聊 turn 2 的 onSessionId 写入**，非会诊写入）← 主因证据 |
| 含会诊 | 是：msg[1] `uuid=moa-agg-moa-rt-session-1786259684183-0` |
| 预置 | `default`（参考 glm-5.2「架构师」+ kimi-k2.5「实战派」，汇总 glm-5.2），全席本渠 enabled ✓ |
| turnDurations | `turnCount:3` 仅 2 条 → 会诊轮未记（同上轮 finding E） |
| 圆桌卡落盘 | ✗ 无 `moa_roundtable` 事件落盘 → 重开无卡（同上轮 finding D） |

## 1. 证据

### 1.1 落盘（`~/.tagent-dev/projects/…/session-1786259684183.messages.jsonl`，43 行）

| 轮 | 落盘 | 现象 |
|---|---|---|
| 1 会诊 | msg[0] user「研究 hermes-studio」(1786259726783) → msg[1] `moa-agg-…-0` (1786259738794) | 汇总答「很抱歉，我当前无法直接访问您的本地文件系统…」（无工具）；`message` **缺 `role`** |
| 2 续聊 | msg[2]「你分析不了吗」(1786259752970) → msg[3] assistant thinking | **thinking 原文：「我之前没有对话上下文（这是新会话的第一条消息）」**——续聊 agent 没看到会诊轮 |
| 3 续聊 | msg[5]「项目」→ msg[6+] 真去 Read/Bash 研究 | 这轮才真正完成用户意图（会诊被绕开走普通轮） |

`agent-sessions.json`：`sdkSessionId=f2bcd639` 存在，但它是 turn 2 spawn 的 `onSessionId` 回调写的（`session-service.ts:1354-1358`）；会诊轮（`runMoATurn`）从未写。

### 1.2 主因代码点（续聊上下文断裂）

| 位置 | 行为 | 判定 |
|---|---|---|
| `run-moa-turn.ts` `runMoaTurn` 全程 + `session-service.runMoATurn`(1090-1215) | 用 bare 席位 `spawnKsccBare`，**不**建 `SessionRuntime`、**不** `onSessionId`、**不**写 `meta.sdkSessionId` | ✗ 主因 |
| `session-service.handleSend`(947) `isFirst = !rt \|\| !rt.hasLiveProcess()` | 会诊未建 runtime → 续聊 `isFirst=true` | ✗ |
| `session-service.buildQueryOptions`(1352-1353) `resumeSessionId: meta?.sdkSessionId` | 会诊未写 → `undefined` → kscc 全新进程、不读面板 JSONL | ✗ 主因 |
| `config-paths.getProjectSessionPath`(108-110) | SDK JSONL 文件名按 **TAgent sessionId**（`session-1786259684183.jsonl`），而 resume 按 **kscc sdkSessionId**（`f2bcd639`）；无 resumeSessionId 即不读 | 确认机制 |
| msg[3] thinking | 「我之前没有对话上下文（这是新会话的第一条消息）」 | **冒烟枪**：续聊确丢会诊上下文 |

> 注：会诊的 user+moa-agg 已由 `appendSdkMessages` 写进 SDK JSONL，但 ① 无 `sdkSessionId` 根本不触发 resume；② moa-agg shape 非标准（缺 `role`/`id`/`type:"message"`/`usage`），即便 resume 也可能被 kscc 跳过。主因是 ①。

### 1.3 次因代码点（历史重复）

| 位置 | 行为 | 判定 |
|---|---|---|
| `run-moa-turn.ts` `buildHistoryForTurn`(167) | `persistAndPushUser` 后 `readPanelMessages` 读全量 → 末条=本轮 user 进了历史 | ✗ 已修 |
| `moa-history.ts:15-16` / `run-moa-turn.ts:162-166` 注释 | 均断言「历史不含本轮 user」 | 与实现相反 |
| `moa-orchestrator.runAggregatorModel`(326-330) + `buildAggregatorPrompt`(372,384) | user 段拼 historyText，system 段**又**注 historyText | 放大重复（汇总席 4 倍） |

新会话首条复现：面板=`[currentUser]` → `historyText="[会话上下文]\n[用户]{议题}\n\n"` → 参考席 `historyText+[本轮议题]`（议题 2 次）；汇总席 system `historySection+[原始问题]`（2 次）+ user `historyText+[本轮议题]`（2 次）= 4 次。有历史时重复只是「多一份」不显眼；新会话首条整段历史即议题，100% 重复——正是 brief 瞄准的「新会话首条」。

### 1.4 其余首条+one-shot 路径核对（均正常）

- 草稿会话无 sessionId？`Chat.tsx sendConsult`(1773)/`sendQueued`(1591) 用 `sessionIdRef.current` + `materializeTab` 转正 → ✓ 有 sessionId，落盘正常。
- one-shot 分流 / 新建 meta / `decideMoaMetaPatch`：sticky=false 不写 modelId、新建用真实 modelId（`session-service:1163-1165`、`moa-dispatch:107-112`）→ ✓ modelId 未粘 moa。
- 预置命中 dispatch：kscc 用 storedPresets，`resolveMoADispatch('moa:default')` 全席 enabled → `moa` ✓。
- 合成预置 id 命中 dispatch：`resolveConsultPresetsForChannel` **仅外部渠**（`session-service:1139`），本会话 kscc 不走；外部合成命中已单测（FIX-NOTES §9.3）✓ 本会话不适用。

## 2. 已修（小补丁 + 单测）

| # | 文件 | 改动 |
|---|---|---|
| 1 | `packages/shared/src/types/moa-history.ts` | `BuildMoAHistoryOptions` 增 `excludeTrailingTurn?: boolean`；`buildMoAHistoryFromMessages` 为 true 时 `messages.slice(0,-1)`（丢末条=本轮 user）。默认 false，旧调用/单测不变 |
| 2 | `apps/electron/src/main/lib/agent/run-moa-turn.ts` `buildHistoryForTurn` | 改 `buildMoAHistoryFromMessages(irs, { excludeTrailingTurn: true })`；JSDoc 改述真实机制（末条=本轮 user，排除） |
| 3 | `apps/electron/src/main/lib/agent/run-moa-turn.ts` `persistAndPushFinalAssistant` | `message` 补 `role: 'assistant'`（对齐普通 assistant 落盘 shape；上轮 finding C；`sdkMessageToIR` 不读 role，纯一致性，无行为变化） |
| 4 | `packages/shared/src/types/moa-history.test.ts` | +3 用例：丢末条(含历史) / 新会话首条→空 / 默认 false 向后兼容 |

**验证**：
```
bunx vitest run moa-history moa-preset moa-roundtable moa-orchestrator moa-dispatch   # 5 文件 / 87 用例全过
bunx vitest run packages/shared/src/types packages/pi-core/src apps/electron/src/main/lib/agent \
  apps/electron/src/renderer/components/chat/{stream-item-model,turn-durations,regress-o-ui-swallow}  # 23 文件 / 217 用例全过
bun test apps/electron/src/renderer/components/chat/session-turn-model.test.ts       # 13 用例全过
```
typecheck：`packages/shared` 仅 1 条**既有无关**错误 `moa-history.test.ts(24,5)`（`assistantMsg` 桩 content 联合类型债，FIX-NOTES §9.4 已记，非本包引入；新增行 124-150 无新错）。

**修复后效果**：新会话首条 `historyText=''` → 参考席收议题 1 次、汇总席 2 次（system `[原始问题]` + user 本轮议题，设计内复述）。有历史会话：旧轮进历史、本轮 user 排除，不再与议题重复。

## 3. 未修（需产品拍板 / 更大改，列选项勿大改）

### A. 主因——续聊上下文断裂（P0，需架构取舍）

**根因**：one-shot 会诊是「旁路」bare 编排，不建长驻 kscc、不写 `sdkSessionId`；续聊 `isFirst` 且无 `sdkSessionId` → kscc 全新进程丢会诊上下文（msg[3] 冒烟枪）。**非小补丁**（动普通 spawn 路径 + kscc resume 机制待核），列选项：

- **a（推荐先验证）**：首条 spawn 且 `!meta?.sdkSessionId`、面板已有 user/assistant 时，把面板历史注入本轮 system prompt（复用/泛化 `buildMoAHistoryFromMessages`）。覆盖「会诊→普通续聊」「app 重开无 sdkSessionId」两类。需确认 kscc resume 与 JSONL 文件名（TAgent sessionId）vs sdkSessionId 的对应，避免与后续 resume 双计。
- **b**：让会诊产出可 resume 的 `sdkSessionId`——但会诊用 bare 席位非长驻 Query，架构改动大，不推荐。
- **c**：UI 引导——会诊后首条普通发送时提示「上一条会诊结论未带入续聊上下文，如需引用请 @」。
- 建议另开 brief 做 a（带 kscc resume 机制核实 + 单测），本轮不动。

### B. 辅因——汇总席无工具（§3.1，产品取舍）

参考/汇总 `tools:[]` → 首条「研究本地项目」答「无法访问 FS」。

- a：维持（会诊=讨论，非工具 agent，研究类首条本就不适合会诊）。
- b：汇总席只读工具（Read/Glob/Grep，SPEC §3.6 允许）——接线 `buildToolsSystemPromptSection` + 只读工具集，**非小补丁**。
- c：UI 提示「席位无工具；查仓库请用 ↑ 普通发送」。
- 建议先 c（文案零风险）观察，再决定 b。

### C. 圆桌卡未落盘 → 重开无卡（上轮 finding D）

- a：turn done 时把终态 panel 追加 `*.panels.jsonl`，重开回放（中改）。
- b：重开按 `moa-agg-{roundtableId}` uuid 重建一张「已汇总」静态卡（最小）。

### D. 会诊轮 turnDurations 缺记（上轮 finding E）

`runMoaTurn` 已 emit `result`+`turn_end`，但渲染层 `recordCompletion`(`Chat.tsx:326`) 的 `lastAssistantTurnKeyRef`/`getLastMainAssistantCreatedAt` 未把会诊轮 moa-agg 消息记上。需渲染侧排查，超出小补丁范围。

## 4. 不变量复核（未破坏）

- 未 `setModel('moa:…')` / 未把 `moa:*` 下发 kscc：one-shot 分流在 `resolveModel` 前，`runMoATurn` 不建 SessionRuntime ✓
- modelId 未粘 moa：one-shot `decideMoaMetaPatch` 不写 modelId，新建会话用真实 modelId ✓
- 跨渠禁席：本会话 kscc-internal，预置席位均本渠 enabled ✓
- 未 commit / 未跨渠混席大改 ✓

## 5. FIX-NOTES 短节

见 `IMPLEMENT-FIX-NOTES.md` §10（本次新增）：moa-history `excludeTrailingTurn` + `runMoaTurn` 排除本轮 user（修复首条历史重复）；`persistAndPushFinalAssistant` 补 `role`。主因「会诊→续聊上下文断裂」列待办（§3.A），需另开 brief。
