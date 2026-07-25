# TAgent-Desktop 项目管理规范

> 2.0 新项目，吸取 TAgent_General 文档混乱的教训，定规矩。
> 参照 F:/Kun、F:/Proma 的版本管理实践。

## 1. 目录结构

```
TAgent-Desktop/
├── docs/
│   ├── plans/        # 设计计划文档（长期，功能设计、改造方案）
│   ├── decisions/    # 架构决策记录（长期，ADR，定调不轻易改）
│   └── dev/          # 开发期间临时记录（调研、实验、进度日志，可定期清理）
├── release-notes/   # 每个版本一份 release note（vX.Y.Z.md）
├── CHANGELOG.md      # 变更总览（Keep a Changelog 格式）
├── .github/workflows/ # CI/CD（release.yml 等，参照 kun）
```

### 文档归类规则（避免 TAgent_General 的乱）

- **plans/**：功能设计、改造方案。写"要做什么、怎么做"，长期保留。文件名 `YYYY-MM-DD-<主题>.md`。
- **decisions/**：架构决策（ADR）。写"为什么这样定、否决了什么"，长期保留。如双核定调、长驻决策。文件名 `ADR-NNNN-<主题>.md`。
- **dev/**：开发期间临时记录。调研报告、实验数据、进度日志、待办。**可定期清理**（归档或删）。文件名 `YYYY-MM-DD-<主题>.md`，带 `[dev]` 前缀标识可清。
- **release-notes/**：每个 release 一份，格式见 §3。

**禁止**：把临时实验/调研塞进 plans/（TAgent_General 的教训）。临时内容进 dev/。

## 2. 版本号

- **语义化版本**：`MAJOR.MINOR.PATCH`（https://semver.org）
- 从 **2.0.0** 起（TAgent_General 旧骨架到 1.7.0，TAgent-Desktop 是新架构 2.0）
- 开发期间用预发布号：`2.0.0-dev.1`、`2.0.0-beta.1`、`2.0.0-rc.1`
- 版本号写在 `apps/electron/package.json` 的 `version` 字段

### 发版流程

1. 更新 `apps/electron/package.json` version
2. 写 `release-notes/vX.Y.Z.md`
3. 更新 `CHANGELOG.md`（追加该版本）
4. git tag `vX.Y.Z`
5. push tag → 触发 `.github/workflows/release.yml` 自动构建发版（参照 kun）

## 3. release-notes 格式（参照 proma）

每个版本一个文件 `release-notes/vX.Y.Z.md`：

```markdown
# TAgent vX.Y.Z 更新

## 新功能
- **<功能名>** — <一句话说明>。(#PR号)

## Bug 修复
- **<修复项>** — <说明>。(#PR号)

## 其他优化
- **<优化项>** — <说明>。(#PR号)

## 下载
- **Windows** — `TAgent-X.Y.Z-x64.exe`
- **macOS Apple Silicon** — `TAgent-X.Y.Z-arm64.dmg`
- **Linux** — `TAgent-X.Y.Z-amd64.AppImage`
```

## 4. CHANGELOG.md

Keep a Changelog 格式（https://keepachangelog.com），倒序（新在上）：

```markdown
# Changelog

## [2.0.0] - YYYY-MM-DD
### 新增
- ...
### 修复
- ...
### 变更
- ...

## [2.0.0-dev.1] - YYYY-MM-DD
- ...
```

## 5. 临时文件规矩

- 调研/实验脚本：放 `test-fixtures/` 或 `dev/`，**不进** `apps/`/`packages/`
- 实验输出/数据：放 `dev/`，可清
- 调试日志：不提交（.gitignore）
- 临时 TODO：写进 `dev/TODO.md` 或 issue，不散落代码注释

## 6. 提交信息

- 中文，带类型前缀：`feat:` / `fix:` / `docs:` / `refactor:` / `chore:` / `release:`
- 示例：`feat(kscc): 长驻适配层，result 后不 close 进程`
- release 提交：`release: vX.Y.Z`
```
