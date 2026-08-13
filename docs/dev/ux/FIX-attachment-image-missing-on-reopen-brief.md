# FIX — 重新打开会话后消息气泡中的图片不显示

## 现象

发送图片附件（**含**或**不含**文字）→ 当次会话内**正常显示**。
关闭会话、重新打开 → 那条 user 消息的气泡里只剩一个 **`animate-pulse` 的 280×200 占位块**，永远不变成图。
说明：`MessageAttachmentImage` 的 `useEffect` 走到 `onReadAttachment(...).catch(console.error)`，UI 没降级提示也没恢复，user 看到的就是"图片丢了"。

**对照上一轮已修 bug**：`docs/dev/ux/FIX-attachment-bubble-oversize-brief.md` —— 那次只动尺寸上限，未触及 `onReadAttachment` IPC 链路。本轮是**新独立 bug**，不是回归。

## 契约

### A. 诊断（先做，再修）

让用户（开发机）打开 dev 控制台跑一次：

```js
// 1. 找到一条"重新打开会话后图不显示"的附件
const bad = await window.electronAPI.listSessions().then(s => s[0])
// 2. 手动模拟 MessageAttachmentImage 那次 IPC
const att = bad.attachments?.find(a => a.mediaType?.startsWith('image/'))
const abs = await window.electronAPI.resolveAttachmentPath(att.localPath)
console.log({ localPath: att.localPath, abs, exists: await window.electronAPI.fs?.exists?.(abs) })
const b64 = await window.electronAPI.readAttachment(att.localPath)
console.log('readAttachment ok, bytes:', b64.length, 'head:', b64.slice(0, 40))
```

至少要看到 `console.error` 在 `MessageAttachmentImage` 里那行 `[MessageAttachmentImage] 读取附件失败:`。回报三件事：

1. **报错的 error.message 原文**（是"文件不存在" / "ENOENT" / "路径越界" / "Cannot read" / 其它）
2. **`localPath` 的实际值**（绝对？相对？含 sessionId 前缀？）
3. **`resolveAttachmentPath` 解析出的绝对路径** 与磁盘真实文件是否一致

### B. 修复（按诊断结果分型）

| 诊断结果 | 修复 |
|---|---|
| A. `localPath` 是相对/被转换丢前缀 → `resolveAttachmentPath` 解析错 | `MessageView.tsx` 传给 `MessageAttachments` 的 `onReadAttachment` 前先 `await window.electronAPI.resolveAttachmentPath(localPath)`，再 `readAttachment(abs)` |
| B. localPath 形式正常但 main 端 `readAttachmentAsBase64` 在某种条件下抛错 | 修 main：`saveAttachment` 与 `readAttachmentAsBase64` 的 `localPath` 约定统一（绝对 vs 相对 vs 含 sessionId） |
| C. `attachments` 字段在重开时被映射函数（session-store / persist 层）改写 / 丢失 | 在 `MessageAttachmentImage` 收不到合法 `attachment.localPath` 时降级显示"附件已丢失"chip 而不是无限 pulse；顺带修映射 |

### C. 不可破坏

- 上一轮 360×200 / 220 气泡上限保持
- 首发送图片正常显示的路径不动
- `ImageLightbox` / 文件 chip / 占位 280×200 不动
- 报错至少在 UI 上有降级（不空跑 animate-pulse），但**不必**做完整"附件丢失"设计 — 一行 muted 小字即可

### D. 本轮不做

- 不重做 attachment 存储路径策略
- 不重做 `session-store` 持久化
- 不做"附件未找到 → 智能提示用户去工作区重传"等大动作

## 主要文件

- `packages/ui/src/components/message/index.tsx`（`MessageAttachmentImage` 651-729 — 错误降级 + 用 `resolveAttachmentPath`）
- `apps/electron/src/renderer/components/chat/MessageView.tsx`（user 渲染分支 101-111 — `onReadAttachment` 是否需要先 resolve）
- `apps/electron/src/main/lib/attachment-service.ts`（`saveAttachment` 70 行 / `readAttachmentAsBase64` 76-83 — localPath 约定）
- `apps/electron/src/main/lib/ipc/session-service.ts`（`READ_ATTACHMENT` / `RESOLVE_ATTACHMENT_PATH` handler 578-585）
- `apps/electron/src/preload/index.ts`（118-122 暴露两个 IPC）
- 必要时 `session-store.ts` 看重开时附件字段是否被改写

## 验收

1. 发 1 张图（含/不含文字）→ 关会话 → 重新打开 → 图正常显示在气泡里（≤ 360×200）
2. 发 1 张图 → 不关会话（持续运行）→ 仍正常显示
3. 发多张图 → 同 1
4. 发 1 张图 → 重开 → **如果文件真被外部删了**，气泡显示"附件已丢失"chip，**不**是无限 pulse
5. console 干净：用户操作过程中不出现 `[MessageAttachmentImage] 读取附件失败:`