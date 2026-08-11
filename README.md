# TAgent

面向日常编程协作的桌面 Agent 客户端。在熟悉的对话界面里，把「聊清楚」和「动手干」放在同一条会话里完成。

## 能做什么

- **多渠道对话** — 接入内网与外部模型服务，按工作需要切换渠道与模型  
- **工作区会话** — 按项目组织对话，侧栏管理会话与工作区  
- **子代理协作** — 把探索、审查、调研等子任务派出去并行推进，主会话保持清晰  
- **会诊与圆桌** — 多模型各抒己见再汇总，或互相讨论形成共识（发送旁可选）  
- **本机 CLI 工人（可选）** — 需要时用本机已安装的 coding CLI 跑子任务，省主会话额度  
- **权限与执行方式** — 自动 / 放行 / 计划等模式，运行中可切换  
- **可读的过程呈现** — 简洁时间线、文件预览、用量提示，少干扰多可见  

当前处于 **2.0 预发布**（`2.0.0-dev.2`），功能与体验仍在快速迭代。变更记录见 [CHANGELOG.md](./CHANGELOG.md)。

## 文档

| 文档 | 说明 |
|------|------|
| [CHANGELOG.md](./CHANGELOG.md) | 版本变更 |
| [docs/PROJECT_MANAGEMENT.md](./docs/PROJECT_MANAGEMENT.md) | 项目管理与发布约定 |
| [docs/RELEASE_PROCESS.md](./docs/RELEASE_PROCESS.md) | 发版流程 |
| [docs/dev/cli-workers/HANDOFF-2026-08-10.md](./docs/dev/cli-workers/HANDOFF-2026-08-10.md) | 本地 CLI 子代理接手说明（开发向） |

## 开发

```bash
bun install
cd apps/electron && bun run rebuild:native   # 换机后建议执行一次
bun run dev                                  # 根目录或 apps/electron 均可
```

更细的环境与发版步骤见上表文档；日常使用在应用 **设置** 中配置渠道与 Agent 行为即可。
