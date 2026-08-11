# Brief：附件已发送但 Agent 未收到 — 根因排查

## 现象

用户发消息时带了附件，界面像发出去了，但 Agent / 运行核侧未收到附件内容（或未注入上下文）。

## 目标

定位附件从 Composer → IPC → session/agent → kscc/Pi 的断点；给出根因 + 最小修复（含回归点）。

## 排查路径（建议顺序）

1. renderer：Composer / Chat 发送 payload 是否含 `attachments` / `files` / paths
2. preload + main IPC：`sendMessage` / `prompt` 是否透传附件字段
3. session-service / adapter：是否写入 JSONL、是否拼进 prompt / tool / multimodal
4. 对照近期改动：队列引导、GLM 流式收尾、权限/分屏等是否误丢字段

仓库：`F:/TAgent-Desktop`

## 验收

- [ ] 写出断点文件+函数+证据（日志/代码路径）
- [ ] 最小补丁使附件进入 agent 可见上下文
- [ ] 补或标出单测/手动验收步骤
- [ ] 写 `docs/dev/attachments/SEND-ATTACHMENT-MISS-FINDINGS.md`
