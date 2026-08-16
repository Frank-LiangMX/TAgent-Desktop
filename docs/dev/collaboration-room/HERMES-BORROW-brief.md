# 协作室 · Hermes 机制移植 · 实现 brief

> **日期：** 2026-08-16  
> **给谁：** 下一任实现 agent  
> **规格真源：** [04-HERMES-BORROW-SPEC](../../plans/agent-collaboration-room/04-HERMES-BORROW-SPEC.md)  
> **分支：** `feature/collab-room`  
> **本次只写文档，不改业务代码。**

## 0. 30 秒

协作室 S1–S3 能聊、能 @、能并行；S4-1/S4-2 信箱纯逻辑和 host 落盘已有。缺的是 Hermes 群聊已经踩过的坑：mention 守卫、按成员投影上下文、房间摘要、handoff outbox、安静时间线。

先做 **S3.5-a**（纯函数 + `appendUserMessage` + composer chip），不碰 pi-core 工具回路。

## 1. 必读（按这个顺序）

1. ADR-0007、00-MASTER（红线）
2. **04-HERMES-BORROW-SPEC**（本轮实现真源）
3. 02-spec §4 / §7 / §9（路由、投影、深度）
4. `S3-IMPLEMENT-NOTES.md`、`S4-A2A-NOTES-2026-08-13.md`
5. `P0-HARDENING-NOTES` 里的 P0-5 / P0-6

不要从 8 月 8 日 `docs/dev/moa-roundtable/HERMES-STUDIO-TAKEAWAYS.md` 开工——那份把群聊标成「勿整室搬迁」，已被 ADR-0007 推翻。可取清单以 04 §2 为准。

## 2. 建议 PR 切割

| PR | 切片 | 主要改动 | 验收 |
| --- | --- | --- | --- |
| 1 | S3.5-a | `resolveCollaborationMentions` + `projectCollaborationTurnContext` + `appendUserMessage.mentions` + MentionPicker 传 memberId | 04 §4.5 / §5.4 + 04 §9 T1–T8 |
| 2 | S3.5-c | `groupCollaborationTimelineItems` + `CollaborationTimeline` / `CollaborationRunCard` | 并行时两张卡不是两条灰泡 |
| 3 | S3.5-b | `summaries.json` + 总结者 prompt 原文 + 阈值/CAS | 假 runner 单测；无模型不阻塞发言 |
| 4 | S4.5 | envelope `attemptId`/`delivery` + 重启 outcome_unknown + 停止卡谓词 | 04 §7.4；**不要**在无 S4-3 时假装能续跑 |

PR 1 不得夹带 UI 大改或摘要模型。PR 2 不得改路由语义。

## 3. 红线（违反即打回）

- 成员正文 `@` 不能产生 run。
- 不得用 prompt 代替 mention / 深度 / 可见性守卫。
- 不得静默用推荐深度覆盖已存 `maxA2ADepth`。
- 不得引入 Hermes Socket.IO / `gc_*` / 多人 invite。
- 不得在本轮改 Chat/Work、圆桌、看板真值。
- 保留 `parseCollaborationMentions` 导出（可委托新函数），避免测试一次性全炸。

## 4. 当前代码锚点

```text
packages/shared/src/types/collaboration-room.ts     # parseCollaborationMentions
apps/electron/src/main/lib/collaboration/
  collaboration-room-service.ts                     # appendUserMessage / buildTurnPrompts
  collaboration-room-scheduler.ts
  collaboration-room-repository.ts
apps/electron/src/renderer/components/collaboration/
  CollaborationRoomsPage.tsx                        # 时间线仍内嵌在 page
apps/electron/src/renderer/components/chat/ChatInput.tsx  # mentionRoles
```

`buildTurnPrompts`（service 约 1164 行）是投影替换点。`appendUserMessage` 里对 `parseCollaborationMentions` 的调用是路由替换点。

## 5. 验证命令

```bash
git checkout feature/collab-room
bun install
npx vitest run packages/shared/src/types/collaboration-room.test.ts
npx vitest run packages/shared/src/types/collaboration-context.test.ts
npx vitest run apps/electron/src/main/lib/collaboration
bun run --filter='@tagent/shared' typecheck
bun run --filter='@tagent/electron' typecheck
```

手测用 04 §9。普通会话 / 会诊 / 圆桌必须点一遍。

## 6. 不要在本 brief 里做的事

- 不实现 S4-3 tool bridge。
- 不写 worktree / 产物预览 / 写闸门。
- 不把 04 再抄一份进 HANDOFF；HANDOFF 只加指针。
