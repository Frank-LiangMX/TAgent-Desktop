# TAgent-Desktop

TAgent 2.0 — 新架构骨架重构版。

## 核心特性

- **双核可拔插**：kscc 核（内网渠道）+ Pi 核（外部渠道），按渠道选核，kscc 可拔插（对外版不装）
- **会话=进程长驻**：开一个会话 spawn 一个 kscc 进程，常驻直到退出，多轮复用不重放历史
- **模块化骨架**：adapters / agent-runtime / ipc 分层，不巨脚本

## 状态

2.0.0-dev.9 — 会话工作区模型与桌面体验收口，补齐测试和打包发布门禁。

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

# 原生模块（better-sqlite3）对齐 Electron ABI，换机后建议跑一次
cd apps/electron && bun run rebuild:native

# 开发（根目录或 apps/electron）
bun run dev
# 或
cd apps/electron && bun run dev

# 类型检查
bun run typecheck
```

### 换机 / 冷启动注意

- **不依赖**本机其它仓库目录（如 `TAgent_General`）；本仓 monorepo 自包含。
- **主进程 CJS**：`dist/main.cjs` 由 esbuild 打包。`@earendil-works/pi-ai`、`pi-agent-core`、`@tagent/pi-core` 为 **ESM-only**，构建时会 **打进 main.cjs**，不要再 external 成运行时 `require`（否则 `ERR_PACKAGE_PATH_NOT_EXPORTED`，窗口起不来）。
- **仍 external**：`electron`、`@anthropic-ai/claude-agent-sdk`、`better-sqlite3`、`node-pty`（原生 / 特殊加载）。
- **kscc 核**（可选）：本机 PATH 需有 `kscc` CLI；没有也能开 UI，仅内置 kscc 渠道不可用。
- **渠道 / API Key**：在应用设置里配置，落盘 `~/.tagent-dev`（开发态），不读别的盘上的项目路径。

技术栈：Bun + Electron + React + Jotai + @tagent/ui + Vite + esbuild。
