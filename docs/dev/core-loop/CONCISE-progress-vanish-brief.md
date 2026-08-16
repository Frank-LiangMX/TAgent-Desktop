# Brief — concise 阶段性总结不输出 + 勿自动展开思考链

## 用户原话

1. 简洁模式流式：阶段性思考总结总是不输出（旧问题复发）
2. 简洁模式不要自动展开思考链；只需把阶段性总结落盘到正文（narrative）

## 根因

- `Chat.tsx` 的 `tool_start` 分支会 `commitStreamTextToLastAssistant`，但 **main 从未 emit `tool_start`** → REGRESS-M 提交路径是死代码。
- `shouldClearStreamText`：assistant 带 `stop_reason`（含 `tool_use`）即清 `streamState.text`。工具终态 sdk_message 若尚无 text 块 → **缓冲总结被清且未 commit** → 秒消。
- `WorkStageFold` REGRESS-O O2：live 末步思考在折叠外挂打字机 → 等于自动展开思考链正文，与产品裁决冲突。

## 已修

1. `Chat.tsx` sdk_message：清 stream text 前，若消息无 text → 先 `applySdkMessageToItems` 再 `commitStreamTextToLastAssistant`（顺序防同 uuid upsert 盖掉 text）。
2. `WorkStageFold`：去掉 O2 live thinking 外挂打字机，恢复底栏「正在思考…」扫光；思考全文仅用户展开可见。
3. 单测：`stream-item-model` 覆盖工具终态无 text 须 commit；O2 契约改为「留 steps、不外挂」。

## 验收

1. 段间 progress（stream 正文）在工具 sdk_message 到达后仍进 timeline `narrative.progress`，idle 后仍在。
2. concise live：思考链默认折叠；不在 stage 摘要下自动铺思考正文。
3. vitest：stream-item / regress-o / regress-b / concise-timeline 全绿。
