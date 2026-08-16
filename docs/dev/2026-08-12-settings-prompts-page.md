# 设置 · 提示词页（2026-08-12）

## 目标

设置侧栏增加「提示词」页：CRUD Chat 系统提示词模板（对齐 General PromptSettings）。

## 交付

- `system-prompt-manager` + `SystemPromptService` IPC + preload / App 类型
- `PromptSettings` UI + `SettingsTab: prompts`
- Chat 模式主会话 `append` 注入默认提示词（`buildUserSystemPromptAppend`）

## 验收

1. 设置 → 核心 → 提示词：可见内置项、可新建/编辑/删自定义、可设默认
2. 「追加日期时间和用户名」可切换并落盘
3. Chat 发送时 system append 含「用户系统提示词」段
