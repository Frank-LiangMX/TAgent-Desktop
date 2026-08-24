# 交接：单会话↔协作室桥接（2026-08-24 凌晨）

> **给谁**：公司电脑续作（人或 Agent）  
> **基线**：`main` @ **`7ab6d74`**（未 push；回家前请先 `git push`）  
> **版本**：产品仍为 `2.0.0-dev.5`；今晚改动在融合桥接，未发版  
> **上位**：长期交接仍读 [13-HANDOFF-2026-08-23](./13-HANDOFF-2026-08-23.md)；**今晚主题以本文件为准**

---

## 0. 一句话

**不把单会话改成 room。** 明示「开启协作 / 结束协作」：进房精炼前情提要，退出精炼写回原 `sessionId`；UI 已确认闸，契约+服务+确认 UI 三层已合。

---

## 1. 到公司后先做

```powershell
cd <TAgent-Desktop>
git status --short
git pull --ff-only origin main   # 若昨晚已 push；若没有，先从家里 push
bun install                      # 如有 lock 变更
```

**不要**用 `git reset --hard` 盖掉未提交改动。本地若仍有未提交的 `BotSidecarPanel` / lightbox / message / tokens——**与桥接无关，勿卷入今晚续作**。

验证桥接：

```powershell
bunx vitest run packages/shared/src/types/session-collab-bridge.test.ts
bunx vitest run apps/electron/src/main/lib/collaboration/session-collab-bridge-service.test.ts
bunx vitest run apps/electron/src/renderer/components/chat/SessionBotBar.test.tsx
bun run --filter='./apps/electron' typecheck
```

期望：27 + 8 + 3 pass；typecheck 0。

---

## 2. 必读文档（按序）

| 顺序 | 文件 | 作用 |
| --- | --- | --- |
| 1 | **本文件** | 今晚进度与明天刀口 |
| 2 | [14-SESSION-COLLAB-BRIDGE-SPEC.md](./14-SESSION-COLLAB-BRIDGE-SPEC.md) | 产品结论 + token 预算 |
| 3 | [12-IMPLEMENTATION-LOG](./12-IMPLEMENTATION-LOG-2026-08-22.md) **§85–§87** | 契约 / 服务 / UI 实现记录 |
| 4 | briefs：`P2-UX-BRIDGE-*-brief.md`（CONTRACT / SERVICE / UI） | 已完成切片的验收原文 |
| 5 | [13-HANDOFF](./13-HANDOFF-2026-08-23.md) | 融合全线背景（P0–P2 其它切片） |

---

## 3. 产品决策（已拍板，勿推翻）

| 点 | 结论 |
| --- | --- |
| 单会话运行时 | **保持** kscc 长线程 + 记忆栈；**禁止**全线改成 room 投影 |
| 入口 | **只有「会话」页**；协作是同一标签内的模式（`fusionRoomId` 有则协作壳） |
| 升级 | **必须用户确认**「开启协作」；禁止静默升 |
| 进房 | 真协作室；`sourceSessionId` 固定；前情提要写入 goal + 系统消息 |
| 退出 | 用户确认「结束协作」；精炼写回原 session；房间 `paused` 保留 |
| 对不上时 | 协调者**按需**读原史（预算闸）；禁止每轮整包 JSONL |
| Sidecar | 仍是旁路；**不是**多 Bot 协作容器 |

### Token 预算（契约已固化）

| 步骤 | 默认 | 硬顶 |
| --- | --- | --- |
| 进房前情提要 | 3000 | 8000 |
| 回写单会话 | 2000 | 6000 |
| 按需读原史 | 每次 1500（硬 2000） | 单轮合计 ≤4000 |

近似：`1 token ≈ 1.2` 汉字（`BRIDGE_CHARS_PER_TOKEN`）。

---

## 4. 今晚已合提交（桥接相关）

| Commit | 内容 |
| --- | --- |
| `9a8aa3a` | 契约：`session-collab-bridge.ts` + 27 测 |
| `716eda2` | 服务：`session-collab-bridge-service.ts` + IPC enter/exit/excerpt + 8 测 |
| `7ab6d74` | UI：开启/结束确认；关掉 Bot 条静默升级 + 3 测 |

另有 `f2c4364`（知识库可行性文档）与桥接无关，可忽略。

---

## 5. 关键代码地图

```text
packages/shared/src/types/session-collab-bridge.ts     # 类型 + 预算 + 裁剪纯函数
apps/electron/.../session-collab-bridge-service.ts    # enter / exit / excerpt
apps/electron/.../collaboration-ipc.ts                # 三 IPC 注册
SessionBotBar.tsx                                     # 「开启协作」确认 → enter
CollaborationRoomsPage.tsx                            # 「结束协作」确认 → exit
Chat.tsx                                              # fusionRoomId 切壳；传 sourceSessionId
```

IPC（preload / App 已同步）：

- `collaboration-room:enter-with-bridge`
- `collaboration-room:exit-with-bridge`
- `collaboration-room:read-source-excerpt`

旧 `upgrade-from-session` **IPC 仍在**，UI 已不再调用；勿再从 Bot 条接回去。

---

## 6. 用户路径（手测清单）

1. 普通会话加入 **2 个 Bot** → **不会**自动进协作；出现「开启协作」。  
2. 点开启 → 确认框 → 进协作壳；房间应有前情提要系统消息。  
3. 协作壳点「结束协作」→ 确认 → 回到普通会话；面板应有「协作室回写」系统卡；房间 paused。  
4. 失败时确认框内联错误（不额外双 toast）。

（今晚无实机 GUI 手测；公司可补。）

---

## 7. 明天推荐刀口（按优先级）

### P0 续作（桥接收口）

1. **host 工具接线** ✅：协调者 turn 可调 `read_source_session_excerpt`（走已有 IPC/服务 + `validateSourceExcerptBudget`）；禁止绕过预算。
2. **exit 后 `session_meta_changed` 主进程推送** ✅（服务层曾默认 noop；现已接入统一 `STREAM_EVENT`，enter/exit 均推送）。
3. **实机手测**上面 §6 清单；修文案/切壳闪一下等问题。

### 2026-08-24 follow-up

2. **exit 后 `session_meta_changed` 主进程推送** ✅：`SessionService.notifySessionMetaChanged` now feeds the bridge callback through the existing `STREAM_EVENT` path; enter and exit both notify, and renderer manual dispatches were removed to avoid duplicate refreshes.

### 可选小项

- 成员减到只剩协调者时 toast「可点结束协作」（**禁止**自动 exit）。  
- 删或标废 UI 对旧 `upgradeFusionSessionToRoom` 的残留引用（若还有测试/文档示例）。

### 不要先做

- 把 0/1 Bot 单会话改成永远 room。  
- 打开打包公网 / 真实 OAuth（仍属 P0 跨用户，与桥接正交）。  
- 把未提交的 Sidecar/lightbox 改动混进桥接 PR。

---

## 8. 派工习惯（公司电脑同样）

主 Agent = 总监：写 `docs/plans/agent-collaboration-room/*-brief.md`，再用：

```powershell
kscc -p --model glm-5.2 --dangerously-skip-permissions '读 <brief> 并验收；git commit 不 push；返回文件+测试+未做项'
```

PowerShell 用**单引号**包 prompt，避免 `<` 被解析。

---

## 9. 工作区脏文件（勿提交进桥接）

若 `git status` 仍见：

- `BotSidecarPanel.tsx` / `.test.tsx`
- `image-lightbox.tsx` / `message/index.tsx` / `tokens.css`
- `docs/dev/knowledge-base/*prompt*.txt`

→ **旁支**，与今晚桥接无关；续作桥接时保持不碰，或另开分支。

---

## 10. 回家前 / 到公司

**家里**：`git push -u origin main`（或当前分支），确认远端可见 `7ab6d74`。  
**公司**：`git pull --ff-only`，从本文件 §1 / §7 开干。


---

## 10. 当前开发检查点（2026-08-24）

本轮继续推进了桥接后的生产化收口，未进行实机测试。

### 已完成

- 暂停房间的 queued run 不再阻塞 awaitAllRuns()；恢复 active 后 scheduler 会重新唤醒并执行。
- 重启恢复时 running run fail-closed 为 blocked，保留用户确认续跑语义；paused 房间的 queued run 保持排队。
- 历史协作室不会仅凭 sourceSessionId 把已退出或普通多 Bot 主会话重新绑定；必须由 session meta 明确持有同一 fusionRoomId。
- 历史分页后的运行中 / 排队统计改由主进程 CollaborationRunSummary 全量计算。
- “停止全部”改为房间级批量取消，不再只处理当前已加载历史页。

### 代码与接口

- shared：CollaborationRunSummary、GET_RUN_SUMMARY、CANCEL_ALL_RUNS。
- main：getRunSummary()、cancelAllRuns()、来源会话投影守卫。
- preload / renderer：运行摘要展示与房间级停止接线。
- UI 与主会话切换仍以 fusionRoomId 为唯一协作壳入口，普通多 Bot 仍保持普通主会话。

### 当前验证状态

- bun run typecheck：通过。
- 本轮未跑测试、未做实机 GUI 验证。
- Electron 集成测试目前受本机 Bun/Electron safeStorage named export 兼容问题影响，属于测试环境阻塞，不是本轮代码检查结果。
