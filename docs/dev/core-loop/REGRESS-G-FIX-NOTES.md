# REGRESS-G 修复记录 — 松绑一句进度短文 + 段间 text/工具/思考落盘

> 日期：2026-08-07
> 规格：`REGRESS-2026-08-07-RESIDUAL-SPEC.md` §G
> Brief：`REGRESS-G-implement-brief.md`（用户裁定：方案 B — 松绑 prompt；同轮修落盘闸口）
> 调查：`REGRESS-G-FINDINGS.md`（两因并存：落盘结构性丢失 + prompt 抑制吐量）
> 派工：本机 `kscc -p --dangerously-skip-permissions`；**未 commit / push**。

---

## 0. 结论先行

G 是「吐了但落盘丢（主）+ prompt 抑制吐量（次）」两因并存。本轮**两因同轮修**：

1. **落盘闸口（主因，369d6f7 引入的结构性丢失）**：`_partial = m._partial===true || stopReason==null`（`kscc-message-adapter.ts:105`）在 glm 渠道**恒为 true**（实测 483/483 assistant `stop_reason` 皆 null，`end_turn` 只在 `result` 消息上）→ 落盘闸口 `session-service.ts` 跳过 `appendPanelMessages`/`appendSdkMessages` → **整轮 assistant 不进 panel JSONL** → 重开会话段间短文/工具/思考全丢。
   **修**：替「按 IR `_partial` 一刀切跳过」为「**同 uuid 去重 + 内容放行**」闸口（新 `stream-persist-gate.ts`）。
2. **prompt 抑制（次因）**：`output-style-prompt.ts` 禁「逐步旁白工具过程」把段间长旁白压成短句或无（实测 2–29% 段无 text）。用户已拍板松绑：允许「思考后/阶段间写**一句**进度短文」，仍禁逐步旁白每步工具 / 长篇复述 / 结尾复盘清单。

---

## 1. 实测形状（决定修法的关键）

读 `~/.tagent/agent-sessions/6cc114a0-*.jsonl`（2026-07-24，早于 369d6f7，旧码落盘了原始流）：

- glm/kscc 把**每个 content 块拆成独立 assistant 消息**，各自**独立 uuid**、`stop_reason:null`：
  - `thinking(uuid A)` → `text "先探查…"(uuid B)` → `tool_use(uuid C)` → `tool_use(uuid D)` → `tool_result(user uuid E)` → …
- `stop_reason:"end_turn"` 只出现在 `type:"result"` 消息上，**assistant 消息一律 null**。
- 即 FINDINGS §2.3 **场景 B**（块独立 uuid、stop_reason 全 null），**无「同 uuid 累积 partial」链**。

→ 结论：对 glm，每条 assistant 都是「独立交付段」（last-of-uuid），没有会被同 uuid final 替换的中间快照。旧 `_partial` 推断把「无 stop_reason」一律当 partial 是**误伤**。

---

## 2. 改了什么（文件列表）

### 改动 2 — 落盘闸口（主修）

| 文件 | 改动 |
|------|------|
| `apps/electron/src/main/lib/agent/stream-persist-gate.ts`（**新增**） | 纯函数 + 显式状态的落盘闸口：`feedStreamPersistGate` / `flushStreamPersistGate` / `createStreamPersistGateState`。assistant 暂存 pending，下一条不同 uuid（或 flush）再提交；同 uuid 后到快照**替换** pending（只留最新=final）；显式 `_partial:true` 与空 content 不落盘；user 立即落盘并先 flush pending。 |
| `apps/electron/src/main/lib/agent/stream-persist-gate.test.ts`（**新增**） | 9 用例：见 §3。 |
| `apps/electron/src/main/lib/ipc/session-service.ts` | ① import 闸口函数/类型；② 新增字段 `streamPersistGateBySession` + 三助手 `getStreamPersistGate` / `persistStreamMessages` / `flushStreamPersistGateFor`；③ `handleSdkStreamMessage` 把原 `isPartial` 一刀切跳过替换为 `feedStreamPersistGate` + 落盘，并在 `result` 分支 `flushStreamPersistGate`；④ `onTurnEnd` / `STOP_AGENT` / `handleChatModeBlock` 三处加 `flushStreamPersistGateFor` 兜底（幂等）。 |

### 改动 1 — 松绑输出风格 prompt（次修）

| 文件 | 改动 |
|------|------|
| `packages/shared/src/utils/output-style-prompt.ts` | 新增「**进度一句短文例外（可写，不算注水）**」窄口：允许思考后/阶段间写**一句**进度短文（点当前阶段、不展开）；`禁止注水` 收紧为「逐步旁白**每一步**工具 / 长篇过程复述 / 结尾复盘清单」；Chat/Work 短答条加「进度一句短文例外，仍算短答」。 |
| `apps/electron/src/main/lib/agent/execution-mode-prompt.ts` | Chat（line 28）+ Work（line 57）短答条各加「（思考后/）阶段间可写一句进度短文，仍算短答」。 |
| `docs/dev/core-loop/CURSOR-CONCISE.md` | §3.4 写明「期望模型在每段思考后吐**一句**进度短文（点当前阶段、不展开）；无 text 时不编造、不补、不结尾复盘清单（见 §4）」，与 prompt 对齐。 |

> 注：改动 1 三个文件在编辑后被并发补入「多点并列用有序编号 / 加粗标题独占首行」UX 规则（与本 G 无关，方向一致，未回退）。G 的窄口（一句进度短文例外）在最终文件中保留。

---

## 3. 测了什么

新增 `stream-persist-gate.test.ts`（9 用例，全绿）：

1. `stop_reason:null` + 仅非空 text（独立 uuid）→ 落盘 ✅（brief 改动2 用例1）
2. 显式 `_partial:true` → 不落盘（真流式快照）✅（brief 用例2a）
3. 同 uuid 流式中间态 → 不落盘，只落盘同 uuid 链最后一条 final ✅（brief 用例2b「同 uuid 中间态不落盘」）
4. 空 content → 不落盘 ✅
5. glm 真实多段形状（块独立 uuid、stop_reason:null）→ **全段落盘、无堆积**（uuid 序列 `u1..u7` 各一次）✅
6. tool_use-only 独立段 → 落盘（工具/阶段/Files Changed 历史）✅
7. thinking-only 独立段 → 落盘（重开仍可见「思考了 Ns」折叠）✅
8. user 消息 → 立即落盘并先 flush 待提交 assistant ✅
9. 显式 partial 被同 uuid final 替换 → 只落盘 final ✅

回归（未触碰，须不红，全绿）：

| 测试 | 结果 |
|------|------|
| `kscc-message-adapter.test.ts`（adapter `_partial` 推断，未改） | 5/5 ✅ |
| `regress-b-progress-live.vitest.test.ts`（B live/历史轮） | 4/4 ✅ |
| `stream-item-model.vitest.test.ts`（E 的 H2 live 清理） | 14/14 ✅ |
| `turn-presentation.vitest.test.ts` | 20/20 ✅ |
| `session-store.test.ts`（双写 JSONL / readPanelMessages fallback） | 7/7 ✅ |
| `kscc-soft-reset.guards.test.ts` | 3/3 ✅ |
| `execution-mode-prompt.test.ts`（短答断言仍成立） | 2/2 ✅ |

**全量**：`bunx vitest run` → **80 files / 775 tests all passed**。
**typecheck**：`@tagent/shared` exit 0；`@tagent/electron` exit 0。

命令摘要：
```
bunx vitest run stream-persist-gate kscc-message-adapter execution-mode-prompt   # 9+5+2 绿
bunx vitest run regress-b-progress-live stream-item-model turn-presentation session-store kscc-soft-reset.guards  # 48 绿
bunx vitest run                                                                 # 775 绿
bun run --filter='@tagent/shared' typecheck     # exit 0
bun run --filter='@tagent/electron' typecheck   # exit 0
```

---

## 4. 与 REGRESS-E 如何不互踩

- **E 的 live 修不动**：E 的 H2 在 `stream-item-model.ts`（`shouldClearStreamThinking/Text`：仅 content 有非空 thinking/text 才清 stream 缓冲）——**未触碰**，14/14 绿。
- **adapter `_partial` 推断不动**：`kscc-message-adapter.ts:105` 的 `isPartial = m._partial===true || stopReason==null` **保留**（renderer live 的 `applySdkMessageToItems` 用 IR `_partial` 做「final 不被迟到 partial 覆盖」守卫，`stream-item-model.ts:218`）。闸口**不读 IR `_partial`**，改读**原始 `msg._partial`（显式）+ uuid + content**，故 live 行为完全不变。adapter 5/5 绿。
- **不堆 partial（E/S1 不回退）**：同 uuid 后到快照**替换** pending、只提交最新（= final），累加式渠道不会把中间快照堆进 JSONL；glm 每 uuid 唯一，无堆积。**未**做「所有 `stop_reason:null` 一律当 final 落盘」这种被 brief 明令禁止的省事写法。
- **Pi 路径不动**：`handlePiStreamPayload` 自管 `_partial`（Pi 知自身流式态），其闸口不变；`streamPersistGateBySession` 仅 kscc 路径（`handleSdkStreamMessage`）写入，Pi 会话无此状态，`flushStreamPersistGateFor` 对 Pi 幂等空转。

---

## 5. 对 brief 字面的一处偏离（写清理由，可回退）

brief 改动2 原文：「仍跳过『仅 thinking / 仅空 / 纯 tool_use 流式快照』的 partial 堆积」。

**实际实现**：放行**任何非空 content 的 last-of-uuid assistant**（text / tool_use / thinking 皆落盘），仅跳过「空 content」与「显式 `_partial:true`」；累积式同 uuid 由 uuid 去重拦中间态。

**理由**：§1 实测证明 glm 形状是**块独立 uuid**——thinking-only / tool_use-only 块是**独立交付段（last-of-uuid）**，不是「流式快照」。若按 brief 字面跳过它们，glm 重开会话会丢**全部思考折叠**（无「思考了 Ns」）与**全部工具阶段**（无「探索了 N 个文件」/ Files Changed），与 `CURSOR-CONCISE.md §1` 产品目标冲突，且劣于 369d6f7 之前的落盘行为（07-24 数据这些块都在）。

brief 担心的「partial 堆积」由 **uuid 去重**已根治（同 uuid 只留最新），不需要再按内容类型跳过。故放行非空 last-of-uuid 既不回退 E，又恢复忠实重开。

**回退为一行**：若总监仍要 brief 字面（只落 text），把 `isAssistantPersistable` 改为「仅 content 含非空 text 块」即可（gate 接口不变，单测相应调整用例 6/7）。

---

## 6. 手测步骤（实机，未在本机跑 Electron GUI）

> 本机为 CLI 代理环境，未起 Electron GUI 实跑；以下为需人工验证的步骤（单测已覆盖逻辑层）。

1. **concise 新会话**：发一个需多段思考+工具的任务（如「分析某目录结构并改个配置」）。
   - 期望：每段思考后出现**一句**进度短文（深色内联，如「先摸清目录结构。」「摸清了，开始改权限。」）→ 接工具。
   - 不期望：逐步旁白每步工具、长篇过程复述、结尾复盘清单。
2. **回合结束后**：时间线仍有该短文（`narrative.progress`），尾部最终正文（`narrative.final`）。
3. **重开/重启会话**（关键，落盘验证）：段间短文**仍在**；工具阶段（「探索了 N 个文件」/ Files Changed）、思考折叠（「思考了 Ns」）也在。
4. **不回退 E**：思考折叠 settle 后灰字「思考了 Ns」常驻，live 不闪没；末段思考不瞬间从 DOM 删光。
5. **中断（STOP）**：已生成的段仍落盘可见（闸口在 STOP 路径 flush）。
6. 抓一轮新会话的 panel JSONL（`~/.tagent/projects/<slug>/<id>.messages.jsonl` 或旧 `agent-sessions/<id>.messages.jsonl`，fallback 读 SDK JSONL），确认 assistant text/thinking/tool_use 块**都在**、无同 uuid 重复堆积。

---

## 7. 修复要点（根因 → 修法）

| 根因 | 修法 |
|------|------|
| glm assistant `stop_reason` 恒 null → `_partial` 推断恒 true → 闸口全跳过落盘 | 闸口不再依 IR `_partial`；改「同 uuid 去重 + 内容放行」 |
| 累积式渠道同 uuid partial 会堆积（E 担忧） | 同 uuid 后到替换 pending，只提交最新；显式 `_partial:true` 不落盘 |
| 轮结束/中断 pending 残留 | `result` / `onTurnEnd` / `STOP` / `handleChatModeBlock` 四处 flush（幂等） |
| prompt 禁「逐步旁白工具过程」连短文也压死 | 加「一句进度短文例外」窄口，仍禁逐步/长篇/复盘 |

---

## 8. 下一步 / 限制

- **未 commit / push**（遵 brief）；改动均在工作树。
- **未实机 GUI 验**（§6 手测待人工跑）；逻辑层由 9 新测 + 775 全量 + typecheck 覆盖。
- **未碰 F**（full 模式 ThinkingActivityRow 硬卸，记忆 [[regress-f-full-mode-default-gap]]）；G 不动 timeline 渲染，与 F 不互踩。
- **未碰 H**（AskUserQuestion Chat 无选项 UI，另派）。
- 若实机发现 glm 之外有渠道发「同 uuid 累积 partial 且 final 也无 stop_reason」的极端形状，uuid 去重仍只留最新（不堆积）；若发现「显式 `_partial:true` 独立 uuid 且无后续 final」的孤儿快照，会被跳过（符合「显式 partial 不落盘」语义）。
- 改动 1 的并发「多点并列有序编号」UX 规则非本 G 引入，如需收口另开任务。
