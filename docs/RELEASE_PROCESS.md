# 发布流程规范（三端：macOS / Windows / Linux）

> 参照 F:/Kun、F:/Proma、TAgent_General/.github/workflows/release.yml。
> 脚本化控制，避免人为出错。

## 1. 版本号

- 语义化版本 `MAJOR.MINOR.PATCH`，从 `2.0.0` 起
- 预发布：`2.0.0-dev.N` / `2.0.0-beta.N` / `2.0.0-rc.N`（含 `-` 即预发布，GitHub 标记 prerelease）
- 版本号写在 `apps/electron/package.json` 的 `version`

## 2. 发版前检查清单（必须全过）

- [ ] `bun run typecheck` 全包通过
- [ ] `apps/electron` 能 `bun run dev` 正常起
- [ ] 核心功能冒烟（发消息/工具/记忆按当前阶段验证）
- [ ] `apps/electron/package.json` version 已更新
- [ ] `release-notes/vX.Y.Z.md` 已写
- [ ] `CHANGELOG.md` 已追加该版本
- [ ] 工作区干净（git status 无未提交）

## 3. 发版流程（脚本化）

```bash
# 1. 跑发版脚本（自动检查 + 更新版本号占位 + 提示）
bun run scripts/prepare-release.ts <版本号>
# 例：bun run scripts/prepare-release.ts 2.0.0-beta.1

# 2. 手动写 release-notes/vX.Y.Z.md 和 CHANGELOG.md（脚本会创建模板）

# 3. 提交 + 打 tag
git add -A && git commit -m "release: vX.Y.Z"
git tag vX.Y.Z
git push origin main --tags

# 4. push tag 自动触发 .github/workflows/release.yml，三端构建 + 上传 GitHub Release
```

## 4. CI 自动构建（.github/workflows/release.yml）

- 触发：push `v*` tag
- 三端 matrix：macos-latest(--mac) / windows-2022(--win) / ubuntu-latest(--linux --x64)
- electron-builder `--publish always` 直传 GitHub Release
- 预发布版本（tag 含 `-`）自动标记 prerelease
- Release Body 从 `RELEASE_NOTES.md`（脚本从 release-notes/vX.Y.Z.md 拷贝生成）同步

## 5. 产物（三端）

| 平台 | 产物 |
| --- | --- |
| macOS | `*.dmg`（arm64+x64）、`*.zip` |
| Windows | `*.exe`（nsis 安装包） |
| Linux | `*.AppImage`、`*.deb` |

## 6. electron-builder 配置

`apps/electron/electron-builder.yml`（后续建，参照 TAgent_General）：
- appId、productName、产物名、图标
- files（含 dist/main.cjs、dist/preload.cjs、dist/renderer、dist/resources）
- mac/win/linux 各自配置（签名、target）
- publish（GitHub release）

## 7. 约束

- **不发未通过 typecheck 的版本**
- **不跳过 release-notes**（每个版本必须有）
- **不发不带 tag 的版本**（CI 靠 tag 触发）
- **预发布明确标 `-`**（让用户知道不是稳定版）
- **release-notes 写用户能看懂的中文**（新功能/Bug/优化，不写技术细节）
