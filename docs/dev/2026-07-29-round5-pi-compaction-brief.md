# [dev] Round 5 Brief — Pi 上下文自动压缩（Phase 1）

> 主线总监 brief。开发代理（kscc / glm-5.2）执行。  
> 设计全文：`docs/plans/2026-07-29-pi-context-compaction.md`

## 红线

1. **可以用** `@earendil-works/pi-agent-core` 导出的 compaction API。  
2. **禁止**读取、复制、改写 `F:/Proma` 或任何 Proma 源文件。  
3. 产品接线、常量、事件、测试全部 **TAgent 自研**。

## 必做

### 1. 自研配置模块

新建例如：

- `packages/shared/src/utils/pi-context-settings.ts`（或 `packages/pi-core/src/context-compaction-settings.ts`）

内容：

- `TAGENT_PI_COMPACTION_THRESHOLD_RATIO = 0.8`  
- `calculateReserveTokens(contextWindow)`  
- `resolveContextWindow(modelId?: string): number`（最小：有声明用声明，否则 200_000）  
- 组装 `CompactionSettings`：`enabled: true` + Pi `DEFAULT_COMPACTION_SETTINGS` 中合理字段 + 我方 reserveTokens  

### 2. 自研压缩执行器

新建例如 `packages/pi-core/src/pi-context-compaction.ts` 或 `apps/electron/.../pi/pi-context-compaction.ts`：

- 输入：`AgentMessage[]`、`contextWindow`、`model`（Pi Model）、可选 signal  
- 用 Pi：`estimateContextTokens` / `shouldCompact`  
- 若不需要：原样返回 `{ compacted: false, messages }`  
- 若需要：调用 Pi `prepareCompaction` + `compact`（或文档推荐的最小组合）；把结果变成新的 `AgentMessage[]`（摘要消息 + retainedTail）  
- 注意：裸 `Agent` 只有 messages、没有完整 Session tree 时，用 Pi 提供的最小路径；读 `node_modules/@earendil-works/pi-agent-core` 的 **d.ts/README**，不要读 Proma。

若 `prepareCompaction` 强依赖 session entries：实现一个 **TAgent 自研** 的「messages → 最小 SessionTreeEntry[]」适配，或使用 `transformContext` 内「超阈值则 `generateSummary` + 截断旧消息」的 **可工作 MVP**，并在注释写明限制。

### 3. 挂到 PiAgentAdapter

文件：`apps/electron/src/main/lib/adapters/pi/pi-agent-adapter.ts`

创建 `Agent` 时增加：

```ts
transformContext: async (messages, signal) => {
  // 调用自研压缩执行器；压完返回新列表
}
```

压缩发生时：

- `console.log('[pi-compaction] ...')`  
- 若便于推流：经现有 event→SDKMessage 管道发 compacting/完成类 system（能接就接，Phase 1 日志优先）

压缩后尽量同步 `agent.state.messages`（若 transformContext 仅影响本轮请求，需确认 Pi 行为；必要时压完后显式写回 state）。

### 4. 测试

- 阈值/换算单测  
- shouldCompact 边界（低于阈值不压、高于压）  
- mock 或轻测执行器 noop 路径  
- `bun run typecheck` + 相关 vitest 绿  

## 不要做

- CompactContext 工具、自动续跑 prompt（Phase 3）  
- 手动 IPC（Phase 2）  
- kscc 压缩  
- 大重构升 AgentHarness（除非不升就无法调用 compact API——那时再最小接入，并写注释）

## DoD

- [ ] Pi 路径具备自动压缩能力（基于 Pi API + 自研接线）  
- [ ] 无任何 Proma 源码引用  
- [ ] typecheck + 单测绿  
- [ ] 设计文档路径在 PR/总结里可点  

## 完成后

中文总结：改了哪些文件、如何触发压缩、已知限制。  
**不要** git commit / push（总监 checkpoint）。
