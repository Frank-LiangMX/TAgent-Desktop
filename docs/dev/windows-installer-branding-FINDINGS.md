# Windows Installer Branding — FINDINGS

> 执行：本地 `kscc / glm-5.2`　总监验收：主线
> 日期：2026-08-11　对应 brief：`docs/dev/windows-installer-branding-brief.md`
> 修订：Tier2（2026-08-11）——在 Tier1.5 图片品牌 + MUI 文案 + 静默守卫欢迎页之上，
> 新增真正的 nsDialogs `PageEx custom` 自定义「准备安装」品牌摘要页（见 §0、§4.4）。

## 0. Tier2 增量（相对 Tier1.5）

Tier1.5 只做了图片品牌 + MUI 文案 + 一个**标准** `MUI_PAGE_WELCOME`（经 `customWelcomePage`
注入）。brief 明确要求「不能只提交图标/侧图后仍保留整套默认观感」，且至少欢迎页或
安装模式/选项页中要有一个**真正的自定义 NSIS/nsDialogs 版式与控件**——Tier1.5 未达成
（其欢迎页仍是标准 MUI 页，无自定义控件/版式）。

Tier2 的交付：**经 `customPageAfterChangeDir` 钩子新增一个真正的 nsDialogs `PageEx custom`
「准备安装」品牌摘要页**（目录页之后、InstFiles 之前）。

- **真正的自定义版式 + 控件**：`nsDialogs::Create 1018` + 多个按对话框单位精确定位的
  `${NSD_CreateLabel}` 标签；大标题经 `CreateFont "MS Shell Dlg" 22 700` +
  `WM_SETFONT(0x0030)` 应用 22px/粗体字体，与正文形成层级——非标准 MUI 页。
- **运行期摘要（真交互价值）**：读取 `$INSTDIR`（目录页后已定）与 `$installMode`
  （multiUser 页后已定），展示**实际安装位置**（与 `instFilesPre` 规整逻辑一致：用
  `${StrContains}` 判定 `$INSTDIR` 是否已含 `${APP_FILENAME}`，避免重复追加）与
  **安装范围**（为所有用户 / 仅当前用户）+ 快捷方式说明。只读展示，不修改任何安装状态。
- **源码级证据**：`app-builder-lib@26.15.3` `templates/nsis/assistedInstaller.nsh` 行 42-44
  `!ifmacrodef customPageAfterChangeDir / !insertmacro customPageAfterChangeDir / !endif`。
- **silent/update 安全**：PRE 在 `${Silent}` 或 `${isUpdated}` 时 `Abort` 跳过整页；`/S`
  本就跳过 `PageEx custom` 页，PRE 守卫为双保险；无 MessageBox。
- **契约保留**：不触碰 multiUser 选择页（UAC 提权/shield 逻辑，替换危及静默 per-machine
  提权）、目录页、InstFiles、完成页（run-after-finish/--updated）语义；不强制 perMachine。
- **未替换 multiUser 页的取舍**：`multiUserUi.nsh` 的 `PAGE_INSTALL_MODE`（assistedInstaller
  行 19）本身已是 nsDialogs `PageEx custom`，含 `UAC_RunElevated` + `BCM_SETSHIELD` +
  注册表预选 + inner/outer instance 逻辑；安全替换需完整复刻 UAC 流，风险高于收益。
  brief 的 fallback「选择另一个能覆盖且价值高的关键页」即本 Tier2 的 `customPageAfterChangeDir`。

**Tier2 未改 `electron-builder.yml`**：`nsis.include` 已指向 `installer/installer.nsh`，
新宏加在 .nsh 内即可被 `assistedInstaller.nsh` 的 `!ifmacrodef` 拾取。

## 1. 总览

把 electron-builder 默认 NSIS 辅助向导改造成统一可识别的 TAgent 品牌安装器。
做法落在 electron-builder 原生能力范围内：**图片品牌（.ico / 侧图 / 页眉 BMP）+
MUI 文案 + 经 `include` 钩子注入的静默安全欢迎页**（Tier1.5）**+ 真正的 nsDialogs
`PageEx custom` 自定义「准备安装」品牌摘要页**（Tier2），不引入阻塞 MessageBox /
新安装器内核。内网双核包与 external 包共用同一套品牌资源（external 经 `extends`
继承，不复制逻辑）。

## 2. 修改文件

| 文件 | 性质 | 说明 |
| --- | --- | --- |
| `apps/electron/electron-builder.yml` | 改 | `nsis` 块新增品牌键（见 §3），其余键不动 |
| `apps/electron/resources/installer/generate_installer_assets.py` | 新增 | 可复现素材生成器（Pillow，同 `export_pngs.py` 工具链） |
| `apps/electron/resources/installer/installerIcon.ico` | 新增（生成产物） | 安装器图标，多尺寸 256/128/64/48/32/16 |
| `apps/electron/resources/installer/uninstallerIcon.ico` | 新增（生成产物） | 卸载器图标（与安装器同源） |
| `apps/electron/resources/installer/installerSidebar.bmp` | 新增（生成产物） | 164×314 24-bit，欢迎/完成页侧图 |
| `apps/electron/resources/installer/uninstallerSidebar.bmp` | 新增（生成产物） | 164×314 24-bit，卸载欢迎/完成页侧图 |
| `apps/electron/resources/installer/installerHeader.bmp` | 新增（生成产物） | 150×57 24-bit，安装选项/目录/进度页页眉右侧小标 |
| `apps/electron/resources/installer/installer.nsh` | 新增(Tier1.5)→改(Tier2) | NSIS `include` 钩子：MUI 文案 + 静默守卫欢迎页(Tier1.5) + **Tier2 新增 `customPageAfterChangeDir` nsDialogs `PageEx custom`「准备安装」品牌摘要页**（UTF-8 无 BOM） |
| `apps/electron/resources/installer/README.md` | 新增 | 素材说明 + 重新生成命令 + silent 契约 |
| `apps/electron/test/installer-branding.test.ts` | 新增(Tier1.5)→改(Tier2) | 静态校验（vitest，无依赖）：配置路径/资源存在性/silent 守卫/双配置继承 + **Tier2 自定义页契约（nsDialogs/PageEx custom/自定义字体标题/运行期摘要/只读不修改安装/include 顺序）**，26 项 |
| `docs/dev/windows-installer-branding-FINDINGS.md` | 新增(Tier1.5)→改(Tier2) | 本文件（Tier2 增量见 §0、§4.4、§6、§7、§8） |

> 产物（.ico/.bmp）为**已提交产物**，构建直接使用，无需运行 Python；生成器仅用于可追溯地重新出图。

**Tier2 清理**：移除 untracked 的 `apps/electron/out-internal-bak/`（Tier1.5 做 external
打包时备份的内网产物 ~258MB，含 `TAgent-...-internal.exe`/portable-internal/`latest-internal.yml`，
可再生，已删）。brief 提到的 `apps/electron/scripts/_tmp_pe_icon.mjs` **本工作树不存在**
（Tier1.5 已清或从未落盘），`apps/electron/scripts/` 经核对无 `tmp`/`pe_icon` 残留。

**未触碰**：应用运行时 UI、打包脚本、CI 工作流、`electron-builder.external.yml`（靠 `extends`
继承）、portable 配置、自动更新协议/blockmap/发布源。工作区中由主代理并行的渲染器改动
（`DockTab.tsx` / `CliWorkersSettingsSection.tsx` / `TabBarItem.tsx` /
`agent-behavior-settings.css` 及 `docs/dev/ux/FIX-*`）与本任务无关，未修改。

## 3. electron-builder.yml `nsis` 增量

```yaml
nsis:
  oneClick: false                          # 辅助向导（既有）
  allowToChangeInstallationDirectory: true # 既有
  createDesktopShortcut: always             # 既有
  createStartMenuShortcut: true             # 既有
  installerIcon: installer/installerIcon.ico
  uninstallerIcon: installer/uninstallerIcon.ico
  installerHeader: installer/installerHeader.bmp
  installerSidebar: installer/installerSidebar.bmp
  uninstallerSidebar: installer/uninstallerSidebar.bmp
  installerLanguages:
    - zh_CN
  language: "2052"
  include: installer/installer.nsh
```

- `perMachine` **未设** → 保留 per-user/per-machine 选择页（既有契约，未静默改成强制管理员）。
- `installerLanguages: [zh_CN]` → 中文为默认且唯一语言（见 §5 取舍）。
- `language: "2052"` → 版本信息 LCID = zh-CN（仅影响文件属性版本信息，不影响 UI/静默）。
- 路径相对 `buildResources`（`resources/`），即 `resources/installer/...`。

> **Tier2 未改 `electron-builder.yml`**：`nsis.include` 已指向 `installer/installer.nsh`，
> Tier2 的 `customPageAfterChangeDir` 宏写在 .nsh 内，由 `assistedInstaller.nsh` 的
> `!ifmacrodef` 自动拾取，无需改配置。external 经 `extends` 继承同一 `include`，同样获得 Tier2 页。

## 4. 设计 / 技术选择

### 4.1 图片品牌（纯视觉，零 silent 风险）

| 资源 | NSIS 定义 | 出现页 |
| --- | --- | --- |
| `installerIcon.ico` | `MUI_ICON`（+ 卸载 `MUI_UNICON` 默认同源） | 标题栏 / 资源管理器 / 任务栏 |
| `uninstallerIcon.ico` | `MUI_UNICON` + `UNINSTALLER_ICON` | 卸载器标题栏 / 控制面板 |
| `installerSidebar.bmp` | `MUI_WELCOMEFINISHPAGE_BITMAP`（164×314） | 欢迎页 + 完成页左侧 |
| `uninstallerSidebar.bmp` | `MUI_UNWELCOMEFINISHPAGE_BITMAP` | 卸载欢迎/完成页左侧 |
| `installerHeader.bmp` | `MUI_HEADERIMAGE` + `MUI_HEADERIMAGE_RIGHT`（150×57） | 安装选项 / 目录 / 进度页右上 |

- 侧图设计：浅冷渐变 `#ECF0F3→#F4F6F8` + 左侧 6px 青绿强调条 `#6A9694` + 居中「应用图标瓦」
  （直接复用 `appicon/light.png` 的圆角底板 + 标，与 `.ico`/关于页同源）。
- 页眉：白底 + 右对齐「应用图标瓦」缩小版（与向导页眉白区融合，仅留品牌标）。
- 直接用 app icon 而非裸标：标的白色面在浅底会融入（黑描边 + 青绿面/对勾勾勒形状，
  这本就是 app icon 的既有呈现）；用带底板的 app icon 瓦最大化品牌识别，且与 `.ico` 一致。
- 无位图文字：文案由 MUI 以系统字体在右侧渲染，避免位图字体不可复现（满足 brief
  「生成过程可复现，避免手工不可追溯文件」）。
- BMP 一律 24-bit 无 alpha（NSIS MUI 位图的安全格式；侧图/页眉均为不透明底）。

### 4.2 NSIS `include` 钩子（`installer.nsh`）

只做两件事，均编译期/非阻塞：

1. **MUI 文案 `!define`**（完成/目录/卸载欢迎/卸载完成）：
   - 完成：`安装完成` / `TAgent 已安装完成...` / `立即运行 TAgent`（复选框）
   - 目录：`选择 TAgent 的安装位置：`
   - 卸载欢迎：`卸载 TAgent` / `将从你的电脑移除 TAgent...`
   - 卸载完成：`卸载完成` / `TAgent 已从你的电脑移除。`
2. **品牌欢迎页**：默认辅助向导**无欢迎页**，经 `customWelcomePage` 宏注入一个标准
   `MUI_PAGE_WELCOME`（配 `MUI_WELCOMEPAGE_TITLE/TEXT`），其 PRE 函数 `TagentWelcomePre`
   在 `${Silent}` 或 `${isUpdated}` 时 `Abort` 跳过该页。

文案产品化、简短、无开发术语。Tier1.5 未替换 `MUI_PAGE_DIRECTORY`/`MUI_PAGE_INSTFILES`/
`MUI_PAGE_FINISH` 为 nsDialogs 自定义页（保留 electron-builder 默认：可改目录、
`instFilesPre` 目录规整、run-after-finish + `--updated` 处理）。**Tier2 在目录页与
InstFiles 之间新增了一个 nsDialogs 自定义页（`customPageAfterChangeDir`，见 §4.4），
是「新增」而非「替换」上述默认页**——故目录/进度/完成页的既有逻辑零改动。

### 4.3 顺序约束（实现要点）

`installer.nsh` 经 electron-builder `sharedHeader` **先于 `MUI2.nsh`** 引入（见
`NsisTarget.computeCommonInstallerScriptHeader`）。故：
- 顶层只用 `!define`（预处理指令，不依赖 LogicLib）。
- 需要 LogicLib 的 PRE 函数（`${If} ${Silent}`）必须定义在 `customWelcomePage` 宏体内——
  该宏在 `assistedInstaller.nsh` 的页面区展开，此时 `MUI2.nsh`（LogicLib）已引入。
- MUI 文案 `!define` 设在顶层即可：finish/directory/uninstall 页在其后才展开消费，
  welcome 页文案在宏内 `MUI_PAGE_WELCOME` 之前定义。

`isUpdated` / `Silent` 均为始终可用的 LogicLib 条件（`flags(...)` 在 sharedHeader 先于
include 注入；`Silent` 为 NSIS 内建）。

### 4.4 Tier2 自定义 nsDialogs「准备安装」页（`customPageAfterChangeDir`）

这是 Tier2 的核心交付，对应 brief「至少欢迎页或安装模式/选项页中一个关键交互页使用
真正的自定义 NSIS/nsDialogs 版式与控件」。落在 electron-builder 文档化的可覆盖宏
`customPageAfterChangeDir`（`assistedInstaller.nsh` 行 42-44，目录页之后、InstFiles 之前）。

**版式与控件**（`PageEx custom` + `nsDialogs::Create 1018`）：
- `${NSD_CreateLabel}` 标签若干，按对话框单位精确定位（0u/12u 起，宽 300u/288u，高 16-30u）。
- 大标题 `准备安装 TAgent`：`CreateFont $R2 "MS Shell Dlg" 22 700` + `SendMessage $R1 0x0030 $R2 0`
  （`WM_SETFONT=0x0030`，用数字避免依赖 `WinMessages.nsh`）→ 22px/粗体，与正文 13px 默认字体形成层级。
  > `CreateFont` 真实签名经 makensis 实测（§8 harness）：`CreateFont $(user_var) face_name
  > [height weight /ITALIC /UNDERLINE /STRIKE]`——italic 是 `/ITALIC` 标志位而非数字；故 height=22、
  > weight=700，不带 italic 标志（非斜体）。早期据网络示例写成 `... 22 700 0`（数字 italic）经
  > harness `-WX` 编译捕获并修正。
- 副标题、安装位置、安装范围、快捷方式、底部提示各一标签。

**运行期摘要（真交互价值，非纯装饰）**：
- 安装位置：`${StrContains} $R3 "${APP_FILENAME}" $INSTDIR` → 已含则显示 `$INSTDIR`，
  否则 `$INSTDIR\${APP_FILENAME}`——与 `instFilesPre`（assistedInstaller 行 33-38）规整逻辑
  完全一致，避免「用户选了 `...\TAgent` 时显示成 `...\TAgent\TAgent`」的双拼错位。
- 安装范围：`${If} $installMode == "all"` → 为所有用户 / 仅当前用户（`$installMode` 由
  multiUser 页 `setInstallModePerAllUsers/PerUser` 设置，先于本页）。
- 只读展示：本页**不** `CreateShortCut`/`WriteReg*`/`SetOutPath`/`File`/`RMDir`/`Section`
  （静态测试守护，见 §8）——不修改任何安装状态，silent 跳过即无副作用。

**silent/update 守卫**：`TagentReadyPre` 在 `${Silent}` 或 `${isUpdated}` 时 `Abort` 跳过整页。
`/S` 本就跳过 `PageEx custom` 页（NSIS 内建），PRE 为双保险。无 MessageBox。

**关键技术约束与证据**：
- `customPageAfterChangeDir` 在 `assistedInstaller.nsh` 页面区展开（行 43），此时 `MUI2.nsh`
  （LogicLib，installer.nsi 行 9）与 `multiUserUi.nsh`（nsDialogs，行 19 的 `PAGE_INSTALL_MODE`）
  均已引入；`${StrContains}` 由 `StrContains.nsh`（`allowToChangeInstallationDirectory` 分支，行 23）
  先 include。故宏内可用 LogicLib / nsDialogs / StrContains。
- `!include "nsDialogs.nsh"` 在宏内幂等再 include（multiUserUi 已先 include，有头文件守卫）。
- `PageCallbacks TagentReadyPre TagentReadyLeave` + `Caption " "` 与 `multiUserUi.nsh` 行 20-23
  用法一致；`TagentReadyLeave` 仅 `Return`（本页无需读取状态，且保证函数非空规避 `-WX` 空函数告警）。
- `$installMode` 由 `multiUser.nsh`（installer.nsi 行 10）声明，先于本宏展开；`$INSTDIR` 为 NSIS 内建。
- `CreateFont` 签名经 makensis 实测：`CreateFont $(user_var) face_name [height weight /ITALIC /UNDERLINE /STRIKE]`
  （face name 第 2 必填参；italic 为 `/ITALIC` 标志位，非数字 0/1）。

## 5. 取舍与边界

| 决策 | 取舍 |
| --- | --- |
| `installerLanguages: [zh_CN]` 单语言 | 中文为默认且唯一语言，最贴合 brief「中文为默认语言」、最产品化。代价：非中文系统用户也看到中文安装器（TAgent 为中文向产品，可接受）。多语言会给非中文系统混用中/英（MUI 文案为语言无关单串）。 |
| `language: "2052"` | 仅版本信息 LCID，不影响 UI/静默。 |
| 不加语言选择器 | `displayLanguageSelector` 官方「不推荐」，且会引入额外交互页（需额外 silent 守卫），违背「文案简短、克制」。 |
| 不加 EULA | brief 未要求 license；既有无 license，保持。 |
| 用 app icon 瓦而非裸标 | 最大化识别、与 `.ico` 一致；标的白色面在浅底融入是既有 app icon 呈现。 |
| 不自定义进度页/目录页控件 | 原生控件安全重绘边界见 §6；保留 electron-builder 默认逻辑。 |

## 6. 未能定制的 NSIS 边界

- **进度页（InstFiles）进度条/文案**：NSIS 原生进度控件无法在 electron-builder 安全钩子内
  重绘；仅以页眉小标 + 底栏 `BrandingText “TAgent ${version}”`（`common.nsh` 既有）做品牌。
  未尝试自绘进度条（会破坏 `ShowInstDetails nevershow` 既有行为与 blockmap/尺寸校验链路）。
- **per-user/per-machine 选择页（multiUser）控件本身仍为默认**：使用 electron-builder
  `assistedMessages.yml` 的 `zh_CN` 既有翻译（`安装选项`/`为哪位用户安装该应用？`/`仅为我安装`/
  `为使用这台电脑的任何人安装` 等），**未替换该页控件**（`multiUserUi.nsh` 的 `PAGE_INSTALL_MODE`）。
  Tier2 评估后保留默认：该页本身已是 nsDialogs `PageEx custom`，但内含 `UAC_RunElevated` +
  `BCM_SETSHIELD` + 注册表预选 + inner/outer instance 逻辑（`multiUserUi.nsh` 行 30-191）；
  安全替换需完整复刻 UAC 提权流，错一处即危及**静默 per-machine 提权路径**（installer.nsi
  Section 内 `${Silent}` + `UAC_RunElevated`，行 99-120）与 contract #3/#4。brief 的 fallback
  「选择另一个能覆盖且价值高的关键页」即 Tier2 选择的 `customPageAfterChangeDir`（§4.4）。
- **完成页（Finish）控件仍为默认 MUI**：`customFinishPage`（assistedInstaller 行 47-64）会
  整页替换 `MUI_PAGE_FINISH`，丢失 `run-after-finish` + `--updated` 的 `StartApp` 逻辑
  （assistedInstaller 行 51-63），需完整复刻，风险高于收益，故未用；仅以 MUI 文案品牌。
- **目录页（Directory）控件仍为默认 MUI**：保留 `instFilesPre` 目录规整（assistedInstaller 行 33-38）。
- **3 条罕见错误文案的英文回退**：electron-builder 自带 `messages.yml` 的
  `decompressionFailed` / `uninstallFailed` / `appClosing` 未提供 `zh_CN`，单语言
  安装器在**罕见错误路径**（解压失败/卸载失败/应用关闭提示）会回退英文。
  主动用 LangString 覆盖会与 electron-builder 版本耦合（升级后若其补全 zh_CN 会
  “LangString already defined” 编译失败），故未覆盖。主流程（欢迎/安装选项/目录/准备安装/进度/完成/卸载）全中文。

> **Tier2 已定制的边界**：`customPageAfterChangeDir` 位（目录页后/InstFiles 前的「准备安装」
> 品牌摘要页，nsDialogs 自定义版式+控件，§4.4）。其余关键页（欢迎=标准 MUI+侧图、安装选项=
> 默认 multiUser、目录/进度/完成=默认 MUI）保持 Tier1.5 状态，仅以图片+文案品牌。

## 7. Silent / Update 安全

- `installer.nsh` 代码级（去注释后）**无 `MessageBox`**（静态测试守护）。
- **nsDialogs 仅用于 Tier2 的 `customPageAfterChangeDir`「准备安装」页**（Tier1.5 不含 nsDialogs）；
  该页 PRE `TagentReadyPre` 在 `${Silent}` 或 `${isUpdated}` 时 `Abort` 跳过整页。Tier1.5 的
  `MUI_PAGE_WELCOME` 欢迎页 PRE `TagentWelcomePre` 同样 `${Silent}`/`${isUpdated}` 守卫。
  即两处自定义页 PRE 各有一道守卫（静态测试断言 `${Silent}` 出现 ≥2 次）。
- electron-updater 自动更新走 `/S --updated`：`/S` 静默本就跳过所有 MUI 页 + `PageEx custom` 页
  （NSIS 内建）；两处 PRE 守卫为双保险。
- **自定义页只读、不修改安装状态**：`customPageAfterChangeDir` 宏体无 `CreateShortCut`/
  `WriteReg*`/`SetOutPath`/`File`/`RMDir`/`Section`（静态测试守护，§8）——silent 跳过即零副作用。
- 未触碰 `run-after-finish`、`--updated` 启动参数、`packElevateHelper`、per-machine 静默提权
  （`installer.nsi` Section 内既有 `${Silent}` + `UAC_RunElevated` 逻辑原样保留）。
- 卸载器：`MUI_UNPAGE_WELCOME/FINISH` 为标准 MUI 页，`/S` 静默卸载自动跳过；无自定义交互。

## 8. 验证结果

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 静态校验（Tier1.5） | `node node_modules/vitest/vitest.mjs run apps/electron/test/installer-branding.test.ts` | ✅ 17/17 passed（Tier1.5 基线） |
| 静态校验（Tier2） | 同上 | ✅ **26/26 passed**（+9：Tier2 自定义页契约 8 + include 顺序 1） |
| 全量测试 | `node node_modules/vitest/vitest.mjs run` | ✅ **1444 passed (121 files)**（Tier1.5 的 1435 + Tier2 新增 9，零回归） |
| 类型检查 | `node node_modules/.bun/typescript@5.9.3/node_modules/typescript/lib/tsc.js -p apps/electron/tsconfig.json --noEmit` | ✅ exit 0（test/ 不在 src/**/*，不参与 tsc；Tier2 未改 src） |
| 空白检查 | `git diff --check` | ✅ exit 0 |
| 内网包 `package:win` | — | ⏸ **本轮未运行**（brief：先完成代码+快速测试，避免超时；下一轮命令见 §13） |
| external 包 `package:win:external` | — | ⏸ 本轮未运行（同上） |
| 二进制品牌校验 | — | ⏸ 随 package:win 下一轮补（Tier1.5 已证 PE 嵌品牌图标，§9） |
| makensis 独立编译（Tier2 harness） | `<nsis-3.0.4.1>/Bin/makensis.exe -WX -INPUTCHARSET UTF8 _tier2_compile_check.nsi` | ✅ **exit 0，exe 生成，-WX 零警告**（修正 `CreateFont` 签名后；首次编译捕获并修正 `... 22 700 0`→`... 22 700`，见 §4.4） |

### 8.1 Tier2 harness 编译校验（可复现；文件已删，留存结构）

makensis 缓存路径（本机）：`C:\Users\<user>\AppData\Local\electron-builder\Cache\nsis\nsis-3.0.4.1`
（含 `Bin/makensis.exe`、`Include/{MUI2,nsDialogs,LogicLib,WinMessages}.nsh`、
`Plugins/x86-unicode/nsDialogs.dll`）。harness `.nsi` 结构（重建后即可复跑）：

```nsis
!define APP_FILENAME "TAgent"
!define PRODUCT_NAME "TAgent"
!define VERSION "2.0.0-dev.1"
!define BUILD_RESOURCES_DIR "<repo>\apps\electron\resources"
Unicode true
; isUpdated flag 桩（真实构建由 electron-builder flags() 经 StdUtils 注入）
!macro _isUpdated _a _b _t _f
  StrCmp "false" "true" `${_f}` `${_f}`
!macroend
!define isUpdated `"" isUpdated ""`
Var installMode
!addincludedir "<app-builder-lib>/templates/nsis/include"   ; StrContains.nsh
!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!include "StrContains.nsh"
!include "<repo>\apps\electron\resources\installer\installer.nsh"
!insertmacro customPageAfterChangeDir     ; 只展 Tier2 自定义页（不展 customWelcomePage）
Page instfiles                              ; 承载 Section（真实构建由 MUI_PAGE_INSTFILES 提供）
Function .onInit
  StrCpy $installMode "current"            ; 模拟 multiUser 设置 $installMode
FunctionEnd
OutFile "<out>\_tier2_compile_check.exe"
Section "" SecDummy
  Nop
SectionEnd
```

运行：`NSISDIR=<nsis-3.0.4.1> <nsis-3.0.4.1>/Bin/makensis.exe -WX -INPUTCHARSET UTF8 harness.nsi`
→ 预期 `exit 0`、`Install: 2 pages`（`PageEx custom` + `instfiles`）、`-WX` 零警告。
harness `.nsi`/`.exe` 为临时校验产物，已删除（绝对路径不可移植，不入库）。

> 本机环境：bun 1.3.13、electron 43.3.0（dist/electron.exe 已装）、NSIS 3.0.4.1 +
> nsis-resources 3.4.1 + 7zip + winCodeSign 均已本地缓存、better-sqlite3 已 MSVC 编译。
>
> 环境复原（礼貌性）：`package:win:external` 首跑以 `TAGENT_EXTERNAL=1` 重建 `dist/`
> 为 external-stub 变体；为避免污染 dev 的 `bun run dev`（electronmon 热重载），
> 已跑 `node scripts/build-main.mjs`（不带 `TAGENT_EXTERNAL`）把 `dist/main.cjs`
> 恢复为双核版（日志确认 `[build-main] ok → dist/main.cjs (dual-core)`）。

## 9. 打包验证

### 9.1 内网包 `bun run package:win`（base `electron-builder.yml`）

- 退出码 **0**，全流程成功：`rebuild:native` → `build` → `electron-builder --win --x64`。
- NSIS 编译 **`building target=nsis file=out\TAgent-2.0.0-dev.1-x64.exe archs=x64 oneClick=false perMachine=false`**
  成功 → 说明 `installer.nsh`（MUI 文案 + 静默守卫欢迎页）在 `warningsAsErrors=true` 下
  无警告无报错通过 makensis 编译，所有品牌资源路径解析正确。
- blockmap 生成（自动更新契约保留）、portable 生成、latest.yml 生成均成功。
- **非侵入式二进制校验**：解析 `out\TAgent-2.0.0-dev.1-x64.exe` 的 PE 资源，
  `RT_GROUP_ICON` = 1 组、`type=1`、`count=6`、`sizes=[16,32,48,64,128,256]`，
  与 `installerIcon.ico` 完全一致 → 品牌图标确已嵌入安装器二进制。
  （机器 `0x14c` = i386 PE32，NSIS unicode 安装器为 32 位 PE，符合预期。）

### 9.2 external 包 `bun run package:win:external`（`electron-builder.external.yml`）

- 继承确认：构建日志显式输出
  `loaded configuration file=...electron-builder.external.yml` +
  `loaded parent configuration file=...electron-builder.yml` → `extends` 继承生效，
  external 自动获得 base 的 `nsis` 品牌配置（不复制两套逻辑，满足产品契约 #5）。
- 首次运行在 7z 归档阶段报 `.\resources\app.asar` 被占用
  （Windows 共享违例：「另一个程序正在使用此文件」），构建退出码 1。
  **排查**：本机运行中的 `TAgent.exe` 来自 `D:\Program Files\TAgent`（独立安装版）、
  dev `electron.exe` 来自 `node_modules\...electron\dist`（dev 模式），二者均**不**占用
  `out\win-unpacked`；该占用为新创建的 `app.asar` 被杀软即时扫描的瞬时竞态（非持久进程锁，
  与品牌/配置无关）。重跑打包步骤（`node electron-builder/cli.js --win --x64 --publish never
  --config electron-builder.external.yml`，复用已 external-stub 的 dist）绕过瞬时锁。
- **重跑成功，退出码 0**：`building target=nsis file=out\TAgent-2.0.0-dev.1-x64.exe archs=x64
  oneClick=false perMachine=false` → blockmap → portable → 全部签名完成。
- **非侵入式二进制校验**：external `TAgent-2.0.0-dev.1-x64.exe` 的 `RT_GROUP_ICON` =
  1 组、`count=6`、`sizes=[16,32,48,64,128,256]`，与 `installerIcon.ico` 完全一致
  → **external 安装器同样嵌入了品牌图标**，`extends` 继承确实把品牌资源送到了 external 产物。
- 体积佐证：external `TAgent-2.0.0-dev.1-x64.exe` = **129 MB**，内网 = **181 MB**；
  external `portable` = 128 MB。external 明显更小，符合 `electron-builder.external.yml`
  的 `files` 排除 `@anthropic-ai/claude-agent-sdk*`（含 claude.exe 原生包）的预期，
  同时品牌资源未变 → 双配置「同品牌、不同内核」契约成立。
- portable 图标：`TAgent-2.0.0-dev.1-x64-portable.exe` 的 `RT_GROUP_ICON` = 7 尺寸
  `[16,24,32,48,64,128,256]`（electron-builder 由 `win.icon`/`icon`=
  `logo/appicon/light.png` 自动转 .ico，含 24 这档），与 installerIcon 同源
  （`appicon/light.png` 即 installerIcon.ico 的生成源）→ portable 亦为品牌图标。

> 无论 external 最终打包是否被瞬时锁阻塞，其**品牌继承链**已被：① 构建日志
> （loaded parent configuration）② 静态测试（external 无 nsis 覆盖 → 继承）
> ③ electron-builder `extends` 深合并代码路径（`doMergeConfigs([...parentConfigs, config])`，
> 子配置后置优先；external 未设 `nsis` → 完整继承 base 的 nsis 品牌键）三重验证。

## 10. 产物绝对路径

内网包（`bun run package:win` 成功产物）：

| 产物 | 绝对路径 | 大小 |
| --- | --- | --- |
| NSIS 安装器 | `F:\TAgent-Desktop\apps\electron\out\TAgent-2.0.0-dev.1-x64.exe` | 181,068,450 B (~173 MiB) |
| blockmap | `F:\TAgent-Desktop\apps\electron\out\TAgent-2.0.0-dev.1-x64.exe.blockmap` | 186,720 B |
| portable | `F:\TAgent-Desktop\apps\electron\out\TAgent-2.0.0-dev.1-x64-portable.exe` | 180,794,306 B (~172 MiB) |
| 更新清单 | `F:\TAgent-Desktop\apps\electron\out\latest.yml` | 355 B |
| 调试清单 | `F:\TAgent-Desktop\apps\electron\out\builder-debug.yml` | 6,289 B |
| 解包目录 | `F:\TAgent-Desktop\apps\electron\out\win-unpacked\` | （中间产物） |

external 包产物路径同名（artifactName 继承），见 §9.2：

| 产物 | 绝对路径 | 大小 |
| --- | --- | --- |
| NSIS 安装器（external） | `F:\TAgent-Desktop\apps\electron\out\TAgent-2.0.0-dev.1-x64.exe` | 129,061,867 B (~123 MiB) |
| blockmap（external） | `F:\TAgent-Desktop\apps\electron\out\TAgent-2.0.0-dev.1-x64.exe.blockmap` | 133,634 B |
| portable（external） | `F:\TAgent-Desktop\apps\electron\out\TAgent-2.0.0-dev.1-x64-portable.exe` | 128,787,727 B (~123 MiB) |

> 注：external 构建复用了首次失败时已 external-stub 的 `dist/`，重跑的是 electron-builder
> 打包步骤（等价于 `package:win:external` 的最后一步），绕过了 `app.asar` 瞬时锁。
> 内网与 external 产物同名同目录，后构建者覆盖前者；本表为 external 最终产物。

## 11. 仍需人工目视验收

1. 安装器 `out/TAgent-2.0.0-dev.1-x64.exe` 双击：欢迎/安装选项/目录/进度/完成页品牌层、
   侧图、页眉小标、标题栏图标、底栏文字、中文文案是否统一可识别。
2. **Tier2「准备安装」页**（目录页点「下一步」后出现）：自定义版式是否正常——大标题
   `准备安装 TAgent`（22px/粗体）与正文层级、安装位置/安装范围/快捷方式摘要文案、
   底部「点击「下一步」开始安装」、`PageEx custom` 页眉是否显示品牌页眉小标。
3. **Tier2 摘要正确性**：分别测 ① 默认目录（`...\TAgent`，已含 APP_FILENAME）→ 显示
   `安装位置：...\TAgent`（无双拼）；② 自定义目录 `C:\MyApps`（不含 APP_FILENAME）→
   显示 `安装位置：C:\MyApps\TAgent`（与 instFilesPre 实际安装位置一致）。
4. 卸载器 `Uninstall TAgent.exe`（安装后）：卸载欢迎/完成页侧图、卸载图标、中文文案。
5. 静默安装 `TAgent-...exe /S`：**无任何自定义页面/弹窗**（含 Tier2 准备安装页）；安装后产物与快捷方式正常。
6. 静默卸载 `"Uninstall TAgent.exe" /S`：无交互。
7. `TAgent-...exe --updated`（模拟 electron-updater）：跳过欢迎页与准备安装页，不阻塞。
8. per-user / per-machine 两条路径：目录选择、桌面/开始菜单快捷方式、控制面板卸载项不退化；
   准备安装页的「安装范围」一行正确反映所选（为所有用户 / 仅当前用户）。
9. portable `TAgent-2.0.0-dev.1-x64-portable.exe`：图标为品牌 .ico（portable 用同一 app icon）。
10. 资源管理器中安装器/卸载器图标缩略图（多尺寸 256/48/32/16）显示正常。

## 12. 剩余风险

- **罕见错误文案英文回退**：见 §6。属 electron-builder 自带 `messages.yml` 覆盖不全，
  非 TAgent 引入；仅罕见错误路径可见。
- **未签名链路**：按 brief 不处理代码签名；未签名安装器在 SmartScreen 仍有常规警告，
  本改造未恶化（图标/品牌不影响签名状态）。
- **侧图视觉对比度**：app icon 底板 `#F2F3F4` 与侧图渐变差异较小，靠 1px 描边明确边界；
  若总监希望更醒目，可改用裸标线稿或加深侧图渐变（生成器可复现重出）。
- **`installerLanguages` 单语言**：非中文系统用户看到中文安装器（产品向取舍，见 §5）。
- **electron-builder 升级耦合**：未覆盖 `messages.yml` 缺失项以避免 LangString 冲突；
  若未来 electron-builder 补全 `zh_CN`，本方案无需改动即可全中文。
- **Tier2 nsDialogs 自定义页已通过独立 makensis `-WX` 编译**（harness，见 §8）：用本机缓存
  NSIS 3.0.4.1 以 `warningsAsErrors=true`（`-WX`）+ `-INPUTCHARSET UTF8` 编译 `installer.nsh` 的
  `customPageAfterChangeDir` 宏，**exit 0、零警告、exe 生成**。该编译首次即捕获并修正了
  `CreateFont` 签名错误（`... 22 700 0`→`... 22 700`，italic 是 `/ITALIC` 标志位非数字，见 §4.4）。
  剩余仅 §11 人工目视（字体/坐标/DPI）；`package:win` 的完整产物编译为最终确认。
  > harness 非产物（绝对路径含本机 NSIS 缓存与 .bun 带版本哈希的 node_modules 路径，不可移植），
  > 已删除；§8 记录其结构与命令以便复现。
- **Tier2 字体/坐标**：`CreateFont "MS Shell Dlg"` 在不同 Windows 版本映射到系统 UI 字体
  （Vista+ → Segoe UI 系），与向导其余页一致；22px 标题在极高 DPI 下可能偏大或偏小，
  坐标基于 1018 标准内容矩形的对话框单位，需 §11 目视后按需微调（生成器/坐标均为可复现改动）。
- **Tier2 多一屏交互**：准备安装页位于目录页与 InstFiles 之间，向导多一屏；brief 明确接受
  「使用 nsDialogs 改善关键页面」带来的更多品牌页，且该页提供真实安装摘要价值（位置+范围）。

## 13. 下一轮打包命令（Tier2 编译 + 目视验收）

```bash
# 内网双核包（含 Tier2 自定义页的 -WX makensis 编译校验 + 产物）
cd apps/electron && bun run package:win

# 对外版（external 经 extends 继承同一 installer.nsh，应同样获得 Tier2 页）
cd apps/electron && bun run package:win:external
```

预期：`building target=nsis file=out\TAgent-2.0.0-dev.1-x64.exe archs=x64 oneClick=false
perMachine=false` 在 `warningsAsErrors=true`（`-WX`）下无警告无报错通过 → 最终确认
`installer.nsh` 的 Tier2 nsDialogs 代码在完整 electron-builder 产物链路中编译合法
（独立 harness `-WX` 已先行通过，见 §8）。随后按 §11 人工目视。

> `CreateFont` 签名风险已由 harness 编译消除（§4.4）。若完整 `package:win` 仍报与
> Tier2 相关的 makensis 告警，优先核查 §4.4「关键技术约束」所列签名与用法
> （`PageCallbacks` 二参用法与 `multiUserUi.nsh` 一致；`CreateFont` 为
> `$(user_var) face_name [height weight /ITALIC /UNDERLINE /STRIKE]`）。

---

## 14. 第二轮独立构建验证（Tier2 全量 `package:win` 实测回填）

> 第二轮接续代理（本地 kscc/glm-5.2）执行 §13 两条延后命令的实测结果。本节为**追加**，
> 不改前文 §1-13（第一轮维护）。以**产物时间戳 + 构建日志 + 图标 MD5** 为准。

### 14.1 内网双核包 `bun run package:win`（Tier2 全量）

- 命令：`cd apps/electron && rm -rf out && bun run package:win`（前置清 `out/` 规避遗留
  `win-unpacked` 的 `electron.exe→TAgent.exe` 改名 ENOENT，见 §14.4）。
- 退出码 **0**，无 makensis 报错/告警。`building target=nsis file=out\TAgent-2.0.0-dev.1-x64.exe
  archs=x64 oneClick=false perMachine=false` 通过并继续签名 → **Tier2 nsDialogs `PageEx custom`
  「准备安装」页在完整 electron-builder 链路、`warningsAsErrors=true`（-WX）下编译合法**
  （harness 之外的全量佐证）。构建所用 `installer.nsh` 为 10:46:46 已修版（`CreateFont … 22 700`）。
- 产物（`F:\TAgent-Desktop\apps\electron\out\`，后被 §14.2 external 同名覆盖，此处记证据）：

| 文件 | 大小 | mtime |
| --- | --- | --- |
| `TAgent-2.0.0-dev.1-x64.exe`（NSIS 内网） | 181,068,629 B | 2026-08-11 10:48:00 |
| `TAgent-2.0.0-dev.1-x64-portable.exe` | 180,794,115 B | 2026-08-11 10:48:09 |
| `TAgent-2.0.0-dev.1-x64.exe.blockmap` | 186,385 B | 2026-08-11 10:48:08 |
| `latest.yml` | 355 B | 2026-08-11 10:48:09 |

- **二进制品牌校验**：抽出内网 NSIS 安装器 PE `RT_GROUP_ICON` 重建 `.ico` = 57,577 B
  （= `installerIcon.ico`），256×256 RGBA MD5 `af7b288a84ad718331a6fa7134585a6d` ==
  `installerIcon.ico`（像素差 0）→ 内网安装器图标确为品牌 TAgent 图标，非默认 NSIS 图标。

### 14.2 对外版 `bun run package:win:external`（Tier2 全量）

- 命令：`cd apps/electron && rm -rf out && bun run package:win:external`（`bunx electron-builder` 本轮未 fork 失败）。
- 退出码 **0**，无 makensis 报错。日志 `loaded configuration …electron-builder.external.yml` +
  `loaded parent configuration …electron-builder.yml`（extends 继承生效，external 获同一 Tier2 `include`）；
  `building target=nsis … oneClick=false perMachine=false` 通过 → external 同样编译 Tier2 nsDialogs 页。
- 产物（`F:\TAgent-Desktop\apps\electron\out\`，当前最新）：

| 文件 | 大小 | mtime |
| --- | --- | --- |
| `TAgent-2.0.0-dev.1-x64.exe`（NSIS external） | 129,066,827 B | 2026-08-11 10:53:04 |
| `TAgent-2.0.0-dev.1-x64-portable.exe` | 128,792,316 B | 2026-08-11 10:53:12 |
| `TAgent-2.0.0-dev.1-x64.exe.blockmap` | 133,609 B | 2026-08-11 10:53:11 |
| `latest.yml` | 355 B | 2026-08-11 10:53:12 |

- **二进制品牌校验**：external NSIS 安装器图标 = 57,577 B，256×256 MD5 `af7b288a…` ==
  `installerIcon.ico`（像素差 0）→ **external 安装器同样品牌化**，`extends` 把品牌资源送到了 external 产物。
- **体积**：external NSIS 129 MB < 内网 181 MB，差 ≈52 MB ≈ claude.exe 原生包（内网含、external 排除），
  与 §10 一致，「同品牌、不同内核」契约成立。

### 14.3 观察（非安装器品牌化范围，供第一轮/主线裁定）

- **external `win-unpacked` 残留完整 `claude.exe`（225,108,640 B）**：external.yml `files` 的
  `!node_modules/@anthropic-ai/claude-agent-sdk-*/**/*` 似未清掉 `app.asar.unpacked` 下
  `claude-agent-sdk-win32-x64/claude.exe`（10:26 Tier1.5 external 同位置无此目录，10:53 Tier2 external 有）。
  external NSIS 安装器体积 129 MB 表明**安装器本身不含** claude.exe（已排除），但 win-unpacked 中间产物残留 225 MB。
  属 external 构建/stub 链路（第一轮域）；建议主线确认 external 安装后运行时确无 claude.exe，并视需要清理 unpacked 残留。
- **type-fix（第二轮，`apps/electron/test/installer-branding.test.ts`）**：项目严格 `tsconfig`
  （`noUncheckedIndexedAccess:true`）下，该测试原有 **6 个 TS 错误**（正则分组 `kv[1]/kv[2]/item[1]`
  与 `buf[off]` 的 `T|undefined`）。已改显式 `undefined` 守卫（行为不变）：vitest 仍 26/26；
  scoped `tsc`（仅含该文件，extends 根 tsconfig）修复后 exit 0。注：`apps/electron/tsconfig.json`
  `include:["src/**/*"]` 不含 `test/**`，故该文件不参与常规 tsc；此修复为严格模式防御性正确性。
  全量根 `tsc --noEmit` 另有 36 个 `packages/ui` `@/lib/utils` 别名错误（别名仅在
  `apps/electron/tsconfig`/`vitest.config` 配，未在根 tsconfig paths），与本任务无关。

### 14.4 脏 `out/` 复发风险（已遇两次）

`bun run package:win` 若 `out/` 非空且含旧 `win-unpacked`（已有 `TAgent.exe` 无 `electron.exe`），
electron-builder 跳过重新解压 → `ENOENT rename electron.exe→TAgent.exe` 失败。第二轮已两次经
`rm -rf out` 规避。建议打包脚本前置 `rm -rf out` 或 CI 干净 checkout（非本任务范围，未改脚本）。

### 14.5 第二轮验证汇总

| 项 | 结果 |
| --- | --- |
| `bun run package:win`（Tier2 内网全量） | ✅ exit 0；NSIS 181 MB（10:48）+ portable；图标 MD5 `af7b288a…` 像素一致 |
| `bun run package:win:external`（Tier2 对外全量） | ✅ exit 0；NSIS 129 MB（10:53）+ portable；图标 MD5 `af7b288a…` 像素一致；extends 继承 Tier2 |
| Tier2 nsDialogs `PageEx custom` 编译 | ✅ 内网+对外全量构建均过 `building target=nsis` 行无报错 |
| installer-branding 静态测试 | ✅ 26/26（含 Tier2 nsDialogs 契约） |
| `tsc -p apps/electron/tsconfig.json --noEmit` | ✅ exit 0（src 干净；test/ 不在范围） |
| `git diff --check` | ✅ exit 0 |
| 素材生成器可复现 | ✅ `md5sum -c` 全 OK（Pillow 10.4.0） |
| type-fix（test/installer-branding.test.ts） | ✅ 6→0 TS 错误（行为不变） |

> §13「预期」已由本节实测落实：完整 `package:win`/`package:win:external` 在 `-WX` 下零告警通过，
> Tier2 nsDialogs 代码编译合法。§11 人工目视仍需进行（准备安装页版式/字体/摘要正确性等）。
> 本节为第二轮追加；若第一轮再覆写本文件，以**产物时间戳 + 构建日志 + 图标 MD5** 为准。
