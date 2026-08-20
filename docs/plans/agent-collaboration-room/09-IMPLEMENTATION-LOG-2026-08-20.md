# 实施追加记录：兼容归一化与融合路由

> 日期：2026-08-20
> 主规格：[06-MULTIUSER-FUSION-IMPLEMENTATION.md](./06-MULTIUSER-FUSION-IMPLEMENTATION.md)

## 1. 新增实现

- `packages/shared/src/types/fusion-session-legacy.ts`
  - 将旧 `CollaborationMember` 形状归一化为 `RoomBotSeat`。
  - 没有 seatId 时按 `roomId + memberId` 稳定派生。
  - 缺省 backend 兼容为 `channel`；非法 backend 拒绝。
  - 缺省/非法权限统一为 `read-only`。
  - 缺省能力全部关闭；不创建 BotProfile、不复制记忆、不启动 Agent。
  - 无法从旧数据知道真实所有者时标记 `legacy-unknown`，留给显式迁移流程处理。
- `packages/shared/src/types/fusion-routing.ts`
  - 单 Bot无 @：直接路由到唯一可用 Bot。
  - 多 Bot无 @：优先当前协调者，否则按首次加入时间稳定选择。
  - @ 指定：只路由到可用席位。
  - invited/paused/removed 不承接消息；无可用席位 fail-closed。
- `packages/shared/src/types/index.ts` 导出上述类型和纯函数。

## 2. 验证

命令：

    bun test packages/shared/src/types/fusion-session.test.ts packages/shared/src/types/fusion-session-legacy.test.ts packages/shared/src/types/fusion-routing.test.ts

结果：14 pass，0 fail，36 expect。

另尝试用 `bun x tsc` 做新增文件定向检查；本地 Bun 在解析依赖阶段没有返回完整诊断，因此目前以 Vitest 转译执行和 shared 全量 typecheck 的失败列表为证据。全量 typecheck 的失败仍仅是已知的 `collaboration-a2a.test.ts` 与 `collaboration-timeline.test.ts` 基线错误，未出现本切片文件错误。

## 3. 设计边界

本轮路由函数不是 RoomService，不负责修改 coordinatorMemberId，不负责发消息，不负责唤醒 KSCC/Pi。真正接线时必须由宿主在路由结果之后创建 Run/Task，并再次执行 room、seat、task 和权限校验。

## 4. 下一步

进入持久化盘点：确认 BotProfile、BotConfigRevision、BotMemory 和 RoomBotSeat 的配置目录/数据库边界，再做 1 Bot 复用现有 AgentSession 的最小运行时接线。先不实现多用户网络层和 Sidecar UI。
