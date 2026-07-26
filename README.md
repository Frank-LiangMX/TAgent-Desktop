# TAgent-Desktop

TAgent 2.0 — 新架构骨架重构版。

## 核心特性

- **双核可拔插**：kscc 核（内网渠道）+ Pi 核（外部渠道），按渠道选核，kscc 可拔插（对外版不装）
- **会话=进程长驻**：开一个会话 spawn 一个 kscc 进程，常驻直到退出，多轮复用不重放历史
- **模块化骨架**：adapters / agent-runtime / ipc 分层，不巨脚本

## 状态

2.0.0-dev.8 — 两核工具循环完整接通 + 子代理功能。

详见 [CHANGELOG.md](./CHANGELOG.md)。

## 架构决策

- [ADR-0001 双核模式](docs/decisions/ADR-0001-dual-core.md)
- [ADR-0002 会话长驻](docs/decisions/ADR-0002-longlived-process.md)

## 项目管理

- [项目管理规范](docs/PROJECT_MANAGEMENT.md)（文档/版本号/release-notes 规矩）

## 开发

```bash
# 安装
bun install

# 开发
cd apps/electron && bun run dev

# 类型检查
bun run typecheck
```

技术栈：Bun + Electron + React + Jotai + @tagent/ui + Vite + esbuild。
