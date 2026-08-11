# TAgent 安装器品牌素材

electron-builder NSIS 安装器/卸载器的品牌资源与定制脚本。统一用于内网双核包
（`bun run package:win`）与 external 包（`bun run package:win:external`）——后者经
`electron-builder.external.yml` 的 `extends` 继承本套配置，不复制两套逻辑。

## 文件

| 文件 | 用途 | 尺寸 / 格式 | 由谁引用 |
| --- | --- | --- | --- |
| `installerIcon.ico` | 安装器图标（标题栏 + 资源管理器） | 多尺寸 256/128/64/48/32/16 · ICO | `electron-builder.yml` → `nsis.installerIcon` |
| `uninstallerIcon.ico` | 卸载器图标（与安装器同源，视觉一致） | 同上 | `nsis.uninstallerIcon` |
| `installerSidebar.bmp` | 欢迎页 / 完成页左侧品牌侧图 | 164×314 · 24-bit BMP | `nsis.installerSidebar` |
| `uninstallerSidebar.bmp` | 卸载欢迎页 / 完成页左侧品牌侧图 | 164×314 · 24-bit BMP | `nsis.uninstallerSidebar` |
| `installerHeader.bmp` | 安装选项 / 目录 / 进度页页眉右侧小标 | 150×57 · 24-bit BMP | `nsis.installerHeader` |
| `installer.nsh` | NSIS include 钩子：MUI 文案 + 静默守卫欢迎页(Tier1.5) + **Tier2 nsDialogs `PageEx custom`「准备安装」品牌摘要页**（`customPageAfterChangeDir`） | NSIS 脚本（UTF-8 无 BOM） | `nsis.include` |
| `generate_installer_assets.py` | 上述位图/图标的可复现生成器 | Python + Pillow | 手动重新生成时运行 |

> ICO/BMP 为**已提交产物**（构建时直接使用，无需运行 Python）。生成器只用于重新出图，
> 保证过程可追溯、不依赖手工。

## 重新生成

```bash
python apps/electron/resources/installer/generate_installer_assets.py
```

依赖：`Pillow`（与 `resources/logo/export_pngs.py` 同一工具链）。
输入（均为已提交品牌源素材）：
- `../logo/appicon/light.png`（1024，圆角底板应用图标）→ `.ico` 与侧图/页眉的「应用图标瓦」
- `../logo/mark/light.png`（1024，纯标，备用）

品牌色板（与 `export_pngs.py` 一致）：
- 青绿强调色 `#6A9694`（侧图左侧 6px 条 / 标的青绿面 / 对勾徽章）
- 应用图标底板 `#F2F3F4`（侧图「应用图标瓦」）
- 侧图浅冷渐变 `#ECF0F3 → #F4F6F8`（与向导白内容区分隔，与底板区分）
- 页眉底色 `#FFFFFF`（与向导页眉区融合）

设计取向：现代、克制、浅色原生桌面；直接复用 app icon（圆角底板 + 标）作侧图/页眉
「应用图标瓦」，与 `.ico`、关于页同源，最大化品牌识别。无位图文字（文案由 MUI 以系统
字体在右侧渲染，避免字体不可复现）。

## 页面 → 品牌要素对照

| 向导页 | 品牌呈现 |
| --- | --- |
| 欢迎页（`customWelcomePage` 注入，Tier1.5） | 侧图（应用图标瓦 + 青绿条）+ 品牌「欢迎安装 TAgent」标题/正文 + 标题栏 .ico |
| 安装选项（per-user/per-machine） | 页眉小标（应用图标瓦）+ 标题栏 .ico（默认 multiUser 页，保留 UAC 语义） |
| 目录 | 页眉小标 + 「选择 TAgent 的安装位置：」+ 标题栏 .ico |
| **准备安装（`customPageAfterChangeDir` 注入，Tier2）** | **nsDialogs `PageEx custom` 自定义版式**：自定义字体大标题「准备安装 TAgent」+ 安装位置/安装范围/快捷方式运行期摘要 + 标题栏 .ico |
| 进度（InstFiles） | 页眉小标 + 标题栏 .ico + 底栏 `TAgent ${version}` |
| 完成 | 侧图 + 品牌「安装完成」标题/正文 + 「立即运行 TAgent」复选框 + 标题栏 .ico |
| 卸载欢迎 / 完成 | 卸载侧图（同源）+ 品牌「卸载 TAgent / 卸载完成」文案 + 卸载 .ico |

## Silent / Update 安全契约（修改本目录文件时必须保持）

`installer.nsh` 必须**不引入**任何会在 silent/update 模式阻塞的交互：

1. **MUI 文本 `!define`**（编译期，运行期不产生交互）用于完成/目录/卸载页文案。
2. **两处自定义页**，PRE 均在 `${Silent}` 或 `${isUpdated}` 时 `Abort` 跳过：
   - `customWelcomePage`（Tier1.5）：注入标准 `MUI_PAGE_WELCOME`，PRE = `TagentWelcomePre`。
   - `customPageAfterChangeDir`（Tier2）：nsDialogs `PageEx custom`「准备安装」品牌摘要页，
     PRE = `TagentReadyPre`；`nsDialogs::Create`/`${NSD_CreateLabel}`/`CreateFont`/
     `SendMessage 0x0030` 等均在 PRE 守卫之后，silent 跳过即不创建任何控件。
   - electron-updater 自动更新走 `/S --updated`：`/S` 静默本身跳过所有 MUI 页 +
     `PageEx custom` 页；两道 PRE 守卫为双保险。
3. **禁止 `MessageBox`**（阻塞对话框）。nsDialogs **仅允许**用于 `customPageAfterChangeDir`
   这类「PRE 带 silent 守卫、只读展示、不修改安装状态」的自定义页；不得用于会阻塞
   silent/update 的交互。
4. `installer.nsh` 经 electron-builder 的 `sharedHeader` 先于 `MUI2.nsh` 引入，故**顶层
   只允许 `!define`**；需要 LogicLib（`${If}`）/ nsDialogs 的代码必须放在 `customWelcomePage` /
   `customPageAfterChangeDir` 宏体内（这两个宏在 `MUI2.nsh` / `multiUserUi.nsh` 引入之后才展开，
   LogicLib / nsDialogs / `${StrContains}` 方可用）。
5. **自定义页只读**：`customPageAfterChangeDir` 宏体不得含 `CreateShortCut`/`WriteReg*`/
   `SetOutPath`/`File`/`RMDir`/`Section`——只读展示安装摘要，不修改任何安装状态。

契约由静态测试守护：`apps/electron/test/installer-branding.test.ts`（26 项：校验无
`MessageBox`、两处 `${Silent}` 守卫、nsDialogs/PageEx custom/自定义字体标题/运行期摘要/
只读不修改安装/include 顺序、配置路径与资源存在、双配置继承）。

## NSIS 边界（本方案未越界）

- **Tier2 仅「新增」一个 nsDialogs 自定义页**（`customPageAfterChangeDir`，目录页后/InstFiles 前），
  **不替换** `MUI_PAGE_DIRECTORY` / `MUI_PAGE_INSTFILES` / `MUI_PAGE_FINISH`（保留 electron-builder
  默认逻辑：可改目录、`instFilesPre` 目录规整、run-after-finish + `--updated` 处理）。
- **不替换 per-user/per-machine 选择页**（`multiUserUi.nsh` 的 `PAGE_INSTALL_MODE`）：该页含
  UAC 提权 + shield 逻辑，替换危及静默 per-machine 提权路径；`perMachine` 未设 → 显示选择页，
  `selectPerMachineByDefault` 未设 → 默认当前用户，与既有升级路径兼容。
- 不改自动更新协议 / blockmap / 发布源；不引入新安装器内核（仍为 NSIS + portable）。
- 详见 `docs/dev/windows-installer-branding-FINDINGS.md`（§4.4 / §6 / §7）。
