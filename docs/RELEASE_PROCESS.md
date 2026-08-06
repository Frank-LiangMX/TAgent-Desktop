# 发布流程规范（三端：macOS / Windows / Linux）

> 从 TAgent_General 痛点修正：防漏 assets、防空 release notes、防自动更新报错。
> CI 多重门禁，不完整自动阻止发版。

## 0. 设计原则

| TAgent_General 的问题 | TAgent-Desktop 的修正 |
| --- | --- |
| CI 用 `--publish always` 各平台各自直传 GitHub Release，无汇总校验 | CI 先构建上传 artifact，publish job 汇总验证后才发布 |
| `RELEASE_NOTES.md` 单文件累积，CI 只查文件存在不查内容 | 每版本独立 `release-notes/vX.Y.Z.md`，CI 校验行数≥5、字节≥100、非空模板 |
| macOS 双架构 `latest-mac.yml` 未合并，auto-updater 只看到一个架构 | publish job 中合并 arm64+x64 为统一 `latest-mac.yml` |
| `autoInstallOnAppQuit=true` Agent 运行中被杀 | `autoInstallOnAppQuit=false`，安装前检查 `hasActiveAgents()`，空闲后才装 |
| autoUpdater 网络波动直接报 error 弹窗 | 连续 3 次失败才上报 error，偶发错误静默重试 |
| 无更新后提示 | 记录 `lastSeenVersion`，升级后弹窗展示 release notes |

## 1. 版本号

- 语义化版本 `MAJOR.MINOR.PATCH`，从 `2.0.0` 起
- 预发布：`2.0.0-dev.N` / `2.0.0-beta.N` / `2.0.0-rc.N`（含 `-` 即预发布，GitHub 标记 prerelease）
- 版本号写在 `apps/electron/package.json` 的 `version`

## 2. 发版前检查清单（prepare-release.ts 自动执行）

- [ ] `bun run typecheck` 全包通过
- [ ] `bun run test` 全包通过
- [ ] 工作区干净（git status 无未提交）
- [ ] `apps/electron/package.json` version 已更新
- [ ] `release-notes/vX.Y.Z.md` 已有真实内容（行数≥5、字节≥100、非空模板）

```bash
# 一键执行所有前置检查
bun run scripts/prepare-release.ts <版本号>
# 例：bun run scripts/prepare-release.ts 2.0.0-beta.1
```

脚本会：
1. 校验版本号格式
2. 跑 typecheck（必须过）
3. 跑 test（必须过）
4. 检查工作区干净
5. 检查 release-notes 已有真实内容（不是空模板）
6. 更新 apps/electron/package.json version
7. 生成 release-notes 模板（如不存在，退出让你填充）

## 3. 发版流程（脚本化）

```bash
# 1. 跑发版脚本（自动检查 + 更新版本号 + 验证 release notes）
bun run scripts/prepare-release.ts 2.0.0-beta.1

# 2. 首次运行会生成 release-notes/v2.0.0-beta.1.md 模板并退出
#    填充内容后重新运行，验证通过会继续

# 3. 提交 + 打 tag
git add -A && git commit -m "release: v2.0.0-beta.1"
git tag v2.0.0-beta.1
git push origin <当前分支> --tags

# 4. push tag 自动触发 .github/workflows/release.yml
```

## 4. CI 自动构建（.github/workflows/release.yml）

### 流水线

```
push v* tag
    │
    ├── build-desktop (3 平台并行)
    │     ├── macOS: --mac --x64 --arm64 → dmg/zip/yml
    │     ├── Windows: --win --x64 → exe/yml
    │     └── Linux: --linux --x64 → AppImage/deb/yml
    │     每平台构建后立即验证预期产物存在
    │
    ├── verify-artifacts (门禁)
    │     下载所有 artifact → 校验三平台完整性
    │     缺任何文件 → 发版中止
    │
    ├── verify-release-notes (门禁)
    │     校验 release-notes/vX.Y.Z.md 存在且有真实内容
    │     行数<5 / 字节<100 / 空模板 → 发版中止
    │
    └── release (两个门禁都通过后)
          ├── 下载所有 artifact
          ├── 合并 latest-mac.yml (arm64 + x64)
          ├── 验证 asset 总数 ≥ 10
          └── 发布 GitHub Release (body_path = release-notes/vX.Y.Z.md)
```

### 关键防护

| 门禁 | 检查内容 | 失败后果 |
| --- | --- | --- |
| build-desktop per-platform | 每平台构建后检查预期产物文件存在 | 该平台 job 失败 |
| verify-artifacts | 三平台所有预期文件齐全（dmg/zip/exe/AppImage/yml/blockmap） | 发版中止 |
| verify-release-notes | release notes 文件存在、行数≥5、字节≥100、非空模板 | 发版中止 |
| release asset count | 发布前验证 asset 总数 ≥ 10 | 发版中止 |

## 5. 产物（三端）

| 平台 | 产物 | 更新清单 |
| --- | --- | --- |
| macOS | `*.dmg`（arm64+x64）、`*.zip` | `latest-mac.yml`（CI 合并双架构） |
| Windows | `*.exe`（nsis 安装包） | `latest.yml` |
| Linux | `*.AppImage`、`*.deb` | `latest-linux.yml` |

### latest-mac.yml 合并

electron-builder 分别构建 arm64 和 x64，各自生成只含单架构的 `latest-mac.yml`。
CI publish job 中合并为统一清单，列出两个架构的 zip/sha512/size，
否则 electron-updater 只能检测到一个架构的更新。

## 6. electron-builder 配置

`apps/electron/electron-builder.yml`：
- appId、productName、产物名、图标
- files（含 dist/main.cjs、dist/preload.cjs、dist/renderer、dist/resources）
- mac/win/linux 各自配置（签名、target）
- publish（GitHub release，供 electron-updater 轮询 latest*.yml）

## 7. 自动更新客户端（electron-updater）

### 核心模块

`apps/electron/src/main/lib/updater/auto-updater.ts`：

- **启动**：延迟 30s 首次检查，每 4h 定时检查
- **下载**：发现新版本后自动后台下载，不弹窗
- **安装**：`autoInstallOnAppQuit=false`，用户主动触发或空闲自动安装
- **Agent 感知**：安装前检查 `hasActiveAgents()`，有运行中 Agent 则等空闲
- **网络容错**：连续 3 次失败才上报 error，偶发错误静默重试
- **状态持久化**：记录 `lastSeenVersion` + `pendingUpdate`，升级后弹窗展示 release notes
- **退出清理**：移除窗口 close 监听器，避免托盘隐藏阻止退出

### IPC 通道

| 通道 | 方向 | 用途 |
| --- | --- | --- |
| `updater:check` | renderer→main | 手动触发检查 |
| `updater:status` | renderer→main | 获取当前状态 |
| `updater:install-when-idle` | renderer→main | 请求空闲安装 |
| `updater:cancel-idle-install` | renderer→main | 取消空闲安装 |
| `updater:on-status-changed` | main→renderer | 状态变更推送 |

### 状态机

```
idle → checking → available → downloading → downloaded → installing
  ↑                ↓                          ↓
  └── not-available    error (连续3次)   idle (偶发错误静默)
```

## 8. 约束

- **不发未通过 typecheck + test 的版本**
- **不跳过 release-notes**（每版本必须有 `release-notes/vX.Y.Z.md`，CI 校验内容）
- **不发不带 tag 的版本**（CI 靠 tag 触发）
- **预发布明确标 `-`**（让用户知道不是稳定版）
- **release-notes 写用户能看懂的中文**（新功能/Bug/优化，不写技术细节）
- **不手动改 CI 产物**（latest*.yml 由 CI 生成和合并，手改会导致 auto-updater 失败）
- **不跳过 prepare-release 脚本**（它是第一道门禁，防止版本号/notes 不一致）
