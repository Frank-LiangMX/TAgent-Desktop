# Changelog

本项目变更记录，遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [2.0.0-dev.1] - 2026-07-25

2.0 新架构骨架首版（TAgent-Desktop，从骨架重构，不继承 TAgent_General 旧"一圈一结"骨架）。

### 新增
- **双核可拔插适配层** — kscc 核（Claude Agent SDK + kscc 渠道，长驻）+ Pi 核（外部渠道，占位）。按渠道选核，kscc 可拔插（对外版排除）。见 `docs/decisions/ADR-0001-dual-core.md`。
- **长驻会话运行时** — 会话=进程，常驻直到退出。首条消息 spawn kscc 一次，后续复用同进程，靠子进程内存累积上下文，不每轮重放历史。见 `docs/decisions/ADR-0002-longlived-process.md`。
- **模块化骨架** — adapters/{shared,claude,pi} + agent/runtime + ipc 分层，不巨脚本（对照 TAgent_General 的 3997 行 orchestrator + 1279 行 adapter）。
- **最小会话 UI** — 发消息 + 流式回复 + 停止，验证长驻闭环（体感快，多轮不重放）。
- **项目管理规范** — docs/{plans,decisions,dev} 分离，release-notes + CHANGELOG + 版本号规矩。见 `docs/PROJECT_MANAGEMENT.md`。

### 架构决策（实测驱动）
- 全切 Pi 否决：kscc 网关 OAuth 锁死 + bare 咬不住长会话 cache + antml↔tool_use 死结。
- 双核模式：kscc 可插拔（内网增强包）+ Pi 主核（对外版单核）。
- 渠道绑核终身不切，kscc↔外部互斥，核内换模型自由。
- 长驻只 kscc 核（Pi 自带循环无长驻问题）。

### 已知缺口（后续版本补）
- 工具循环（canUseTool/MCP/Skill 注入）未接
- 会话持久化（JSONL + resume）未接
- 记忆系统（Nudge/L0-L5）未接
- 渠道管理（多渠道/API Key 加密）未接
- 完整渲染层（SDKMessageRenderer/标签页/会话列表）未接
- 知识库体系（设计已定，未实现）
- 错误恢复（进程崩溃 fallback / prompt_too_long compaction）未接
```
