# 协作室 P0 体验加固 · 实现 + 冒烟清单（2026-08-12）

> 分支：`feature/collab-room`
> 范围：HANDOFF §6 P0-1 ~ P0-4（体验/错误呈现），批量 A 前半。
> 前置：本机 `kscc` 可用且设置里 **kscc 渠道已启用**，或至少启用一个外部渠道。

按 HANDOFF §7 批次 A，先加固体验与错误呈现，再开 S4 A2A。

---

## 1. 本次改动

### P0-1 清理同步弹窗（`window.alert` → sonner toast）

协作室路径上所有 `window.alert` 替换为 `toast.error(标题, { description })`：

| 文件 | 触发点 | 说明 |
|------|--------|------|
| `CollaborationRoomsPage.tsx` | 发送失败 / 取消失败 / 暂停失败 / 归档失败 | 主区 |
| `CollaborationRoomSidebar.tsx` | 暂停/恢复失败 / 归档失败 / 恢复失败 | 侧栏 |
| `App.tsx` | 创建协作室失败 | 已在 `openSettings` 侧上抛 |

依赖 `sonner`（`@tagent/ui` 已带 `Toaster`，renderer 全局挂载于 `App.tsx`）。

### P0-2 静默错误 → 可见呈现

把 `console.error` 但 UI 静默的分支升级为 toast：

- 添加成员失败（`confirmAddMember`）
- 重命名失败（主区 `confirmRename` + 侧栏 `confirmRename`）

### P0-3 成员渠道展示 + 无渠道禁发 / CTA

- 挂载时 `listChannels()` 拉取渠道名，映射 `channelId → name`。
- 成员状态条气泡显示绑定渠道名；`cli` 后端显示 `CLI`；未绑显示 `无渠道`（琥珀描边）。
- 输入区三态：
  - **所有成员无后端** → 禁发，显示「去渠道设置」CTA。
  - **部分成员无后端** → 提示条 + CTA（仍可发给有后端的成员）。
  - 正常 → `ChatInput`。
- CTA 复用 `App.openSettings('channels')`（新增 `onOpenSettings` prop 下传）。

### P0-4 输入框 @成员补全

复用 `ChatInput` 自带 `mentionRoles` + `MentionPicker`：
把房间成员映射为 `MentionRoleOption[]` 传入，`@` 时下拉补全成员 `displayName`。

> 关键对齐：`ChatInput` 序列化产出 `@displayName`，主进程 `parseCollaborationMentions` 也按 `displayName` 精确匹配 → 两者天然一致，无需改动主进程。

---

## 2. 冒烟测试清单（每轮 commit 前过一遍）

```bash
git checkout feature/collab-room
bun run dev
```

| # | 步骤 | 期望 |
|---|------|------|
| 1 | Rail 协作 ↔ 会话 | Chat tab/草稿不被毁掉 |
| 2 | 新建房间 | 默认「协调者」「开发」；`listChannels` 拉到后成员气泡显示渠道名或「无渠道」 |
| 3 | 无任何可用渠道时新建房间 | 输入框被「去渠道设置」CTA 取代，点击跳到渠道设置页 |
| 4 | 发「你好」（无 @） | 仅协调者回复 |
| 5 | 输入 `@` | 弹出成员补全下拉，选「开发」→ 文本变 `@开发` |
| 6 | 发「@开发 看下」 | 仅开发回复 |
| 7 | 发「@协调者 @开发 并行」 | 两条思考中 → 两条成员消息 |
| 8 | 思考中点取消 | 该 run 取消，可续发；失败时 toast「取消失败」而非 alert |
| 9 | 添加成员 / 重命名 | 应用内弹层（`CollaborationTextPrompt`），无 `window.prompt` 报错；失败 toast |
| 10 | 关掉某个渠道后发消息给该成员 | toast 呈现失败原因，无静默 |
| 11 | 强关 app 再开 | 无假 running；历史消息在 |
| 12 | 暂停房间 | 发消息不触发新 run |

**回归红线：** 全程不应出现 `window.alert`；任何失败路径必须有可见 toast。

---

## 3. 已知限制（HANDOFF §6 P0 剩余 + P1）

- P0-5 `@` 与 displayName 强绑定：改 displayName 后历史 `@` 语义乱（本批次未解，需 S4 mention 规范化）。
- P0-6 上下文投影过简：最近 N 条 chat 文本，无滚动摘要/文件感知。
- P1-1 非事务多文件写、P1-2 scheduler 纯内存、P1-3 runTurn 非流式、P1-4 CLI worker 未接、P1-6 权限档位未 enforce —— 见 HANDOFF §6。

---

## 4. 验证命令

```bash
# 依赖安装（本机 npx/tsc 曾缺失，若 bun install 后）
bun install
# 类型
bun run typecheck
# 协作单测
npx vitest run packages/shared/src/types/collaboration-room.test.ts
npx vitest run apps/electron/src/main/lib/collaboration
# 全量
npx vitest run packages/shared
npx vitest run apps/electron
```

> 本次开发环境无网络、`node_modules` 缺 `tsc`/`vitest`，故未实跑；以上改动已通过静态审查（括号平衡、引用符号与 preload IPC 名称逐一对齐）。