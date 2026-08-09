# 文档归类 / 过期扫描 · FINDINGS

> 扫描人：kscc `-p --model glm-5.1 --dangerously-skip-permissions`（只读扫文档 + 小改状态行）
> 范围：`docs/dev/**`（重点 `moa-roundtable/`、`core-loop/`、`kscc-acp/`）+ `docs/plans/multi-runtime/` MoA 索引句
> 约束：禁改应用代码、禁删文件；仅小改明显过期的 MASTER/SPEC 状态行（见 §4）

---

## 1. 总判

**MoA / 圆桌主线规格与 FIX-NOTES 健康度尚可，但 MASTER / SPEC 顶部状态行落后于代码现状（「有库无 UI」「外部渠 MoA 不做」「Agent 行为待实现」三条明显过期，本轮已随手改）；审计 / 子 brief 簇存在「未挂 MASTER」的归类缺口；`usability-audit/` 与 `streaming-rework/` 两条线已被更新文档实质取代但未标过期。**

---

## 2. 按目录现状表

| 线（目录） | 入口文件 | 健康度 | 说明 |
|---|---|---|---|
| `moa-roundtable/` | `00-MASTER.md` | **过期（已修）+ 乱** | 顶部状态行过期（已随手改）；6 个 AUDIT/brief 文件未挂 MASTER；SPEC 01 与 03 在「外部渠 MoA」上自相矛盾（已加勘误指针）。 |
| `core-loop/` | `00-SPEC.md` + 最新 `HANDOFF-2026-08-08.md` | **齐但杂** | 入口清晰；REGRESS A–O 线均有 brief/FINDINGS/FIX-NOTES，但目录平铺 60+ 文件无子目录，新接手者靠 HANDOFF 找路。无 MASTER，00-SPEC 兼入口。 |
| `kscc-acp/` | `00-MASTER.md` | **齐** | GATE 已结、状态「维持 C / 搁置」与现状一致；FINDINGS + brief 挂在 MASTER。健康。 |
| `usability-audit/` | `00-MASTER.md` | **过期** | 2026-08-05 审计，P0 表标「未修」；`core-loop/00-SPEC.md` 已声明「审计里部分未修已过时」，但本 MASTER 未加过期指针。 |
| `streaming-rework/` | `00-SPEC.md` | **可归档** | W1–W4 流式重构已被 `core-loop/00-SPEC §5` + `CURSOR-CONCISE` 接续/取代；无 MASTER、无状态行，读者不知是否仍权威。 |
| `docs/dev/`（顶层散件） | 无 | **乱** | `2026-07-29-round{1..5}-*` 5 轮早期 brief + 2 个看板调研 + 1 个侧栏记录 + 1 个 Proma 调研，均无入口索引挂靠，仅靠文件名日期可读。 |
| `docs/plans/multi-runtime/` | `README.md` + `09-handoff` | **齐** | 03/05 的 MoA 索引句与现状基本一致（见 §3）；仅 `05 §3.3`「跨渠实现期再定」可补一句「外部渠已落地，跨渠混席仍不做」。 |

---

## 3. 建议更新清单（按优先级）

### P0（与代码现状直接矛盾，本轮已随手改 3 条，另 1 条建议改）

| # | 文件 | 当前句 | 问题 / 建议 |
|---|---|---|---|
| P0-1 | `moa-roundtable/00-MASTER.md` L5 | 「`moa-orchestrator.ts` 有库、无 UI；发版须标注 MoA 未上线」 | 与 IMPLEMENT-FIX-NOTES §1/§8/§9 矛盾（圆桌卡 / 会诊分组 / ConsultMenu 已落地）。**本轮已改为**「MoA 会诊 UI 已落地…待手测 + 设置页 CRUD」。 |
| P0-2 | `moa-roundtable/01-MOA-PRODUCT-SPEC.md` L6 | 「外部渠 MoA 本期不做」 | 与 `03-PI-EXTERNAL-MOA-SPEC`（已实现）直接矛盾，brief 明确点名。**本轮已加勘误指针**指向 03 + FIX-NOTES §9。 |
| P0-3 | `moa-roundtable/01-MOA-PRODUCT-SPEC.md` L162 §7 不做 | 「- 外部渠道 MoA」 | 同上矛盾。**本轮已改为**「~~外部渠道 MoA~~（已落地，见 03）」。 |
| P0-4 | `moa-roundtable/04-AGENT-BEHAVIOR-SETTINGS-SPEC.md` L3 | 「状态：待实现」 | 与 00-MASTER 第 9 条「🔧 进行中」及代码现状矛盾：`saveMoaPresets` IPC（session-service/preload/App/shared）已接、SettingsPage 已加 `agent` tab，但 `AgentBehaviorSettings.tsx` 组件尚未创建（import 悬空）。**本轮已改为**「进行中（IPC + SettingsPage tab 已接，UI 组件待创建）」。 |

### P1（归类缺口 / 一致性，建议下次顺手做）

| # | 文件 | 建议 |
|---|---|---|
| P1-1 | `moa-roundtable/00-MASTER.md` | 增「相关审计 / 子 brief」索引块，把 `AUDIT-channel-model-gate-*` / `AUDIT-fresh-session-consult-*` / `AUDIT-latest-session-*` / `FIX-moa-then-normal-context-brief` / `IMPLEMENT-{,SESSION-UX,kscc-followup}-brief` 挂上 MASTER（当前 6 类文件无入口可寻）。 |
| P1-2 | `usability-audit/00-MASTER.md` 顶部 | 加过期指针：「2026-08-05 快照；P0 表状态以 `core-loop/00-SPEC.md` §2 + HEAD 为准」。避免读者把它当现网未修清单。 |
| P1-3 | `streaming-rework/00-SPEC.md` 顶部 | 加状态行：「W1–W4 已由 `core-loop/00-SPEC §5` + `CURSOR-CONCISE` 接续；本文件保留为契约出处」。或标「已归档」。 |
| P1-4 | `moa-roundtable/02-SESSION-UX-SPEC.md` L3 | 「状态：实现中」→ 建议改「已实现·待手测」（对齐 03 写法；§8 FIX-NOTES 显示已落地）。 |
| P1-5 | `plans/multi-runtime/05-moa-and-kscc.md` §3.3 | 「跨渠…实现期再定合规文案」补一句：「外部渠同渠会诊已落地（见 dev/moa-roundtable/03）；跨渠混席仍不做」。 |

### P2（整洁度，非阻断）

| # | 项 | 建议 |
|---|---|---|
| P2-1 | `core-loop/` 60+ 平铺文件 | 不动结构（brief 禁删/禁大改）；仅在 `00-SPEC.md` 或 HANDOFF 末尾加一行「REGRESS 线索引：A–O，按字母序，每线 = brief + kscc-prompt + FINDINGS(+FIX-NOTES)」。 |
| P2-2 | `docs/dev/` 顶层 `2026-07-29-round{1..5}-*` | 早期 5 轮 brief 已被后续 SPEC/HANDOFF 取代；建议各顶部加一行「历史 brief，状态见 core-loop/00-SPEC」，不删。 |
| P2-3 | `moa-roundtable/IMPLEMENT-FIX-NOTES.md` | 出现两个「## 10.」标题（§10 续聊注入 + §10 审计补丁）；编号撞车，建议改后者为 §11。纯文档编号，无内容影响。 |

---

## 4. 本轮已随手修正的 MASTER / SPEC 状态行

> 均为状态行 / 索引句小改，未触应用代码、未删文件、未重写历史 FINDINGS。

1. `moa-roundtable/00-MASTER.md` L5 代码现状行：删「有库、无 UI；发版须标注 MoA 未上线」→ 改为「MoA 会诊 UI 已落地（圆桌卡 + 会诊分组 + ConsultMenu + 外部渠 Pi 直连 + 续聊注入），见 IMPLEMENT-FIX-NOTES §1/§8/§9/§10；待手测 + 设置页 CRUD」。
2. `moa-roundtable/01-MOA-PRODUCT-SPEC.md` L6 范围行：「外部渠 MoA 本期不做」→ 划线 + 勘误指针到 `03-PI-EXTERNAL-MOA-SPEC.md` + FIX-NOTES §9。
3. `moa-roundtable/01-MOA-PRODUCT-SPEC.md` L162 §7 不做项：「- 外部渠道 MoA」→ 划线 + 「已落地，见 03」。
4. `moa-roundtable/04-AGENT-BEHAVIOR-SETTINGS-SPEC.md` L3 状态行：「待实现」→「进行中（IPC + SettingsPage tab 已接，UI 组件待创建）」。

---

## 5. 不做（本轮边界）

- **不删任何文件**（含明显被取代的 `streaming-rework/`、早期 round brief）——只建议、不删。
- 不改应用代码（即便发现 `SettingsPage.tsx` import 了尚未创建的 `AgentBehaviorSettings.tsx`，仅在报告记录，不动）。
- 不大段重写历史 FINDINGS / REGRESS 长文。
- 不逐字复核 `core-loop/` 全部 REGRESS RUN log（按 brief 用标题/状态段抽样）。

---

## 6. 附：缺口核对（对照 brief「查什么」§4）

| 缺口项 | 在 MASTER 可见？ | 说明 |
|---|---|---|
| Agent 行为设置（04） | ✅ 00-MASTER 第 9 条 | 可见；状态本轮已与 SPEC 对齐为「进行中」。 |
| Pi MoA（03） | ✅ 00-MASTER 第 7 条 | 可见；01 的「不做」勘误已补。 |
| 续聊注入（§10） | ⚠️ 部分可见 | 00-MASTER 第 8 条「待手测」含此场景，但未点名「续聊注入已修」；建议 MASTER 增一行指向 FIX-NOTES §10（归入 P1-1 索引块即可）。 |
