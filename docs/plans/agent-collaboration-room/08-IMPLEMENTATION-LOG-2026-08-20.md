# 实施追加记录：第一切片 A

> 日期：2026-08-20
> 主规格：[06-MULTIUSER-FUSION-IMPLEMENTATION.md](./06-MULTIUSER-FUSION-IMPLEMENTATION.md)
> 总记录：[07-IMPLEMENTATION-LOG.md](./07-IMPLEMENTATION-LOG.md)

## 1. 本轮范围

落地第一切片的最小领域契约，不接 UI、不改变现有 CollaborationRoom 运行时、不启动 Agent：

- `FusionHumanMember`
- `BotProfile` / `BotConfigRevision`
- `RoomBotSeat`
- `RoomAgentSession`
- `RoomWorkspace`
- 0/1/2+ Bot 路由模式纯函数
- 旧数据席位 ID 稳定派生
- 权限 fail-closed 归一化
- 工作区真实存储位置校验

## 2. 代码变更

- 新增 `packages/shared/src/types/fusion-session.ts`。
- 新增 `packages/shared/src/types/fusion-session.test.ts`。
- 更新 `packages/shared/src/types/index.ts` 导出 `fusion-session`。

兼容策略：新契约独立于旧 `CollaborationMember`，旧 room/member JSON 不被原地改写；后续迁移层可以用 `roomId + memberId` 稳定派生 legacy seat ID。权限未知/缺省值只允许归一化为 `read-only`，不允许意外升权。

## 3. 代理证据

- `deepseek-v4-flash` 最小 CLI 探针：成功输出 `DEEPSEEK_MODEL_OK`。
- `deepseek-v4-flash` A-003：返回第一切片测试矩阵，建议覆盖旧 fixture、重复 ID、席位解耦、0/1/2+ 路由标记、工作区未绑定、权限默认拒绝、枚举和 JSON 往返。
- `glm-5.2` A-002：在补充精确类型摘录后 90 秒内未返回有效复核，已停止；不作为设计依据。

## 4. 验证结果

命令：

    bun test packages/shared/src/types/fusion-session.test.ts

结果：6 pass，0 fail，16 expect。

命令：

    bun run --filter @tagent/shared typecheck

结果：失败，但错误来自现有基线：

- `src/types/collaboration-a2a.test.ts` 中 `CollaborationMailboxEnvelope.payload` 的既有类型不匹配。
- `src/types/collaboration-timeline.test.ts` 中 `CollaborationRun.createdAt` 的既有类型不匹配。

本轮新增文件未出现在失败列表中；不修复这两个无关基线错误，避免扩大范围。后续提交第一切片前需要单独建立 baseline 修复任务，或在 CI 中先区分已知失败。

## 5. 当前状态

第一切片 A：代码骨架完成，迁移适配层和运行时接线未开始。

下一步：

1. 补充 legacy room/member JSON parser/normalizer，真正验证旧 fixture 读取，而不只验证纯类型。
2. 为 `RoomBotSeat` 增加 roomId、botProfileId、ownerUserId 的权限/隔离断言。
3. 盘点现有持久化层后决定 BotProfile/Memory 的存储位置。
4. 再进入第一条用户可见路径：1 Bot 复用普通 AgentSession。
