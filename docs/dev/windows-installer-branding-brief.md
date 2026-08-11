# Windows Installer Branding Brief

> 角色：主线总监负责范围与验收；本地 `kscc / glm-5.2` 负责全部实现和验证。
> 日期：2026-08-11

## 目标

将当前 Electron Builder 默认 NSIS 辅助安装向导改造成明显可识别的 TAgent 品牌安装器。不是只替换图标；欢迎、安装选项/目录、进度、完成页需要形成统一视觉。保留现有 NSIS 安装、卸载、静默更新、blockmap 与内外双构建链路。

## 设计方向

- 现代、克制、浅色原生桌面风格，沿用仓库现有 TAgent Logo、颜色和字体气质。
- 不做弹跳或花哨动画；NSIS 页面以清晰层级、留白、品牌插图和稳定状态反馈为主。
- 中文为默认语言；文案简短、产品化，不出现开发术语。
- 欢迎页、主要安装页、进度页、完成页在页眉、侧图、Logo、文案和间距上保持一致。
- 不能只提交 `installerIcon/headerImage/sidebarImage` 后仍保留整套默认观感；应在 electron-builder 支持范围内使用自定义 `.nsh`/MUI/nsDialogs 改善关键页面。若某个原生控件无法安全重绘，在 FINDINGS 中明确边界。

## 必须保留的产品契约

1. 保留 `nsis` 与 `portable` 两类 Windows 产物，产物命名契约不变。
2. 保留桌面快捷方式、开始菜单快捷方式、可选安装目录。
3. 保留当前“所有用户/当前用户”的能力；如果技术上必须调整，先选择兼容既有升级路径的方案，并在交付说明中列出行为变化，禁止静默改成强制管理员安装。
4. 自定义页面和 MessageBox 必须在 silent/update 模式安全跳过，不能阻塞 `electron-updater` 的 `/S --updated` 路径。
5. `electron-builder.external.yml` 继承基础配置；品牌资源和脚本必须同时适用于内网版与 external 版，不复制两套逻辑。
6. 不改应用运行时 UI，不顺手重构打包系统，不引入新的安装器内核。

## 实现范围

- 审计最新 `apps/electron/electron-builder.yml`、`electron-builder.external.yml`、打包脚本与 CI 契约。
- 在 `apps/electron/resources/installer/`（或更合理的同级目录）建立可维护的安装器素材与说明。
- 提供 Windows 多尺寸 `.ico`、NSIS 需要的无损/兼容图片，并复用现有品牌源素材；生成过程应可复现，避免手工不可追溯文件。
- 配置 installer/uninstaller icon、header/sidebar/welcome 相关资源和简体中文。
- 用 electron-builder `include` 钩子及安全的 NSIS/MUI/nsDialogs 能力定制关键页面；所有自定义逻辑须有 silent 守卫。
- 保持卸载器视觉与主安装器一致。
- 添加必要的静态校验或测试，至少能检查配置路径、资源存在性、silent 守卫和双配置继承契约。
- 输出 `docs/dev/windows-installer-branding-FINDINGS.md`，记录实际效果、未能定制的 NSIS 边界、验证结果和剩余风险。

## 验收

1. `bun run package:win` 成功，生成 NSIS 与 portable 产物。
2. 若环境允许，`bun run package:win:external` 成功；若受外部依赖阻塞，提供完整错误证据，不能用“未测试”带过。
3. 安装器打开后不再呈现截图中纯默认 NSIS 观感：至少欢迎/安装/完成关键页有统一 TAgent 品牌层、图标、文案和版式。
4. 当前用户与所有用户路径、目录选择、快捷方式、卸载均不退化。
5. 静默安装/更新路径不会显示自定义页面或等待交互。
6. `git diff --check` 通过；相关测试、类型检查通过。
7. 不提交、不 push；返回修改文件、命令结果、产物路径和仍需人工目视验收的项目。

## 本轮不做

- 不切换 WiX/MSI/Inno Setup，不开发独立 Bootstrapper。
- 不修改自动更新协议、发布服务器或 blockmap 格式。
- 不处理代码签名证书采购；仅保证现有未签名链路不因本改造恶化。
- 不重设计 TAgent 应用本体 UI。
