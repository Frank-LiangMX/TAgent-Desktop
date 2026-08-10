# SLICE-4 · 多 CLI · DONE

## 交付

- **seed**：kscc / grok / codex / mimo 四工人；旧配置 list 时 merge 补齐
- **resolve-backend**：按 `defaultCliId` 路由，不再锁死 kscc
- **run-cli-worker**：按 id 分发
- **runners + observers**：kscc（已有）+ grok / codex / mimo（NDJSON 解析 + spawn）
- **task 工具**：`runCliWorker`
- **设置**：默认 CLI 下拉 + 多工人行编辑

## 测

```
node node_modules/vitest/dist/cli.js run apps/electron/src/main/lib/agent/cli-workers packages/shared/src/types/cli-workers.test.ts
```

**159 passed**（2026-08-10 验收）

## 用法

设置 → Agent 行为 → 本地 CLI 工人 → 启用 → 默认 CLI 选 kscc/grok/codex/mimo → 外渠会话 `task` 派子代理。
