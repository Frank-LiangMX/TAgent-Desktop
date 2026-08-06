# Changelog

本项目变更记录，遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [2.0.0-dev.1] - 2026-08-06

首个公开预发布版本。双核可拔插 + 会话进程长驻 + 模块化 monorepo，含子代理、Cursor 式时间线、自动更新、权限体系等完整桌面体验。

### 新增
- **双核可拔插** — kscc 核（内网渠道）+ Pi 核（外部渠道），按渠选核。
- **会话=进程长驻** — 多轮复用不重放历史。
- **子代理（SubAgent）** — 内置 code-reviewer / explorer / researcher，支持并发。
- **Cursor 式运行容器** — 阶段工作块简洁时间线。
- **富内容分屏预览** — 代码 / 图片 / 文件分屏预览。
- **上下文容量按模型显示** — 实时 token 用量展示。
- **文件查找增强** — 模块化，超大目录跳过。
- **自动更新** — 应用内检查与升级。
- **权限模式运行中切换** — auto / bypass / plan 三模式。
- **真实渠道检测** — HTTP 真实连接测试。
- **桌面打包** — electron-builder 三平台打包与 CI 门禁。
- **核心回归测试** — 74 文件 / 739 测试。

### 体验优化
- 简洁时间线：过程区轻量逐步可见，自动折叠已完成阶段。
- 流式输出硬化：单真源流式 + idle 看门狗 + 权限超时倒计时。
- 侧栏改进：工作区和时间线独立折叠，搜索自动展开。
- 运行计时跨会话保持。
- Windows 全平台兼容。

## [2.0.0-dev.7] - 2026-07-26

工具循环基础设施：工作区 MCP store + 权限审批 service + PermissionBanner。两核接通留下轮。

### 新增
- **工作区 MCP store** — `mcp-store.ts` 读写 `projects/{slug}/mcp.json`（CRUD + getEnabledMcpServers）；`mcp-service.ts` IPC（GET/SAVE/TEST_MCP）+ preload。复用 shared McpServerEntry/WorkspaceMcpConfig。
- **权限审批 service** — `permission-service.ts`：createCanUseTool（kscc）+ createBeforeToolCall（Pi）。bypass 全放行 / auto 只读静默放行（isAutoModeAutoAllowTool）+ 写操作弹框 / plan 写拒绝；危险命令标记；会话白名单。IPC PERMISSION_REQUEST/RESPOND + preload。
- **PermissionBanner** — `permission/PermissionBanner.tsx`：motion 弹确认横幅（工具名+参数+危险标记+允许/拒绝/始终），挂 Chat composer 上方，30s 超时拒绝。

### 变更
- shared 加 PERMISSION_REQUEST 通道；复用已有 MCP/PERMISSION 通道名。
- main 起 McpService + PermissionService；preload/App 类型声明同步。

### 已知缺口（下轮接两核）
- Pi 核接通（tools/mcp/systemPrompt/cwd + beforeToolCall + kscc bare descriptors + bashTool cwd）
- kscc 核接通（mcpServers + canUseTool + permissionMode 非硬编码 + allowDangerouslySkipPermissions:!canUseTool）
- 权限模式切换 UI + 运行中切换；MCP 配置 UI；白名单精确 key

## [2.0.0-dev.6] - 2026-07-26

会话 sidebar 重构（motion 丝滑动效）+ 三点菜单 + 打开项目按钮。

### 新增
- **会话 sidebar 丝滑动效（motion）** — `layout` spring 平滑重排、`layoutId` 选中指示条平滑滑动、`AnimatePresence` 新建/删除弹性进出 + 让位、组折叠 height spring、组头箭头 rotate spring。替代生硬 CSS keyframes。见 `SessionSidebar.tsx`。
- **三点菜单（重命名/置顶/删除）** — hover 显竖向三点：重命名（inline input）、置顶（togglePin + 图标）、删除（confirm + 乐观移除 + exit）。主进程 `UPDATE_SESSION_META` + `TOGGLE_PIN` IPC + preload。见 `session-service.ts`、`preload/index.ts`。
- **打开项目按钮** — sidebar 顶部 FolderOpen 图标（创建工作区）；WorkspaceSelector 移除。
- **会话项样式重构** — hover/选中 primary tint + 过渡、字号层次、ChatsCircle 图标、组头 CaretRight + count badge。

### 修复
- 副行规律（模型左 + 时间右，轮数移标题旁）；指示条歪斜（top/bottom inset 撑高，避 layout transform 冲突）；三点让位（absolute + pr-7 预留）。

### 变更
- 加 `motion@12.42.2`（Framer Motion）；agent-thread.css 撤生硬 keyframes（motion 接管）。

### 已知缺口
- 虚拟化细化待超长会话实测；layoutId 跨组可能跳；工具循环/MCP 未接；材质/记忆/错误恢复 未接。

## [2.0.0-dev.5] - 2026-07-26

超长会话虚拟化 + 顶栏清理 + 自定义窗口栏 + 会话轮数标注。

### 新增
- **超长会话虚拟化** — 只渲染最近 20 条，旧消息 idle 帧递增补齐（40/批），防超长会话卡顿。底部对话区永远全量 + 流式实时追加 + 自动钉底（对话丝滑零损耗）；顶部"正在加载更早的 X 条"提示常驻；`scrollReady` 门控（分批期间不恢复滚动，全挂完才恢复）。见 `Chat.tsx`。待超长会话实测。
- **自定义窗口栏** — `titleBarStyle: hidden`（Windows 隐藏系统栏）+ `WindowControls`（最小化/最大化/关闭 SVG，close hover 红色）+ 主进程 IPC（is-maximized/minimize/maximize/close/resize）+ preload。对齐 TAgent_General。见 `components/WindowControls.tsx`、`main/index.ts`、`preload/index.ts`。
- **会话轮数标注** — `AgentSessionMeta.turnCount`，发 user 消息增量 +1，SessionSidebar 副行显"X 轮"。见 `session-service.ts`、`SessionSidebar.tsx`。旧会话无 turnCount 显空。

### 变更
- **顶栏清理** — 顶栏保留为单独一行（窗口栏，40px 浮顶 + 下方 16px 间隙 + nav），内容清空（渠道/主题移 rail），对齐旧版顶栏"安静"。
- **渠道/主题移 rail** — rail 加渠道图标（PlugsConnected 开 ChannelManager）+ 主题入口（ThemeSettings 改 rail 图标样式）。
- **AppShell** — 始终渲染顶栏条（含 WindowControls），scene padding-top:40px，nav margin-top:band-inset-top 间隙。

### 已知缺口（后续补）
- 虚拟化细化（向上滚补齐 / minimap 未挂载标记 / 补齐淡入）待超长会话实测后做
- 虚拟化超长会话实测（当前无 20+ 轮会话）
- 旧会话 turnCount 补算 / WorkspaceSelector 移 sidebar
- 工具循环（canUseTool/MCP/Skill）未接
- 材质系统 / 记忆系统 / 错误恢复 未接

## [2.0.0-dev.4] - 2026-07-26

全局浮岛布局（AppShell）+ 多会话标签栏，对齐 TAgent_General 桌面版视觉与交互。

### 新增
- **全局浮岛布局（AppShell）** — main 透 scene，rail + sidebar 玻璃浮岛浮在上面，顶栏 absolute 浮顶。flex 行布局 + 玻璃材质（fill 用 glass-rgb 直接拼避开 Electron calc 嵌套）。见 `components/AppShell.tsx`、`styles/app-shell.css`。
- **Rail 左导航轨** — 玻璃胶囊浮岛，上下两胶囊拆分（上 logo/会话/主题，下 设置），中间透 scene。phosphor 图标（Sparkle/ChatsCircle/Palette/GearSix，size:18 weight:regular）。见 `components/Rail.tsx`。
- **多会话标签栏（TabBar）** — 浏览器式多会话 tab，点切 ×关，顶对齐 rail/sidebar。见 `components/TabBar.tsx`、`atoms/tabs.ts`（tabsAtom + activeTabIdAtom + openTab/closeTab）。
- **切换滑动动画** — 滑动底板 active-plate：JS 测 active tab 位置驱动 transform/width 平滑滑动（对齐旧版 updateActivePlate）；tab 选中时透明，只 primary 文字/icon。
- **SessionSidebar 玻璃面板** — `.app-nav-sidebar` 玻璃浮岛（圆角 22 + panel-blur + scene 透出）。
- **顶栏浮顶** — absolute + blur 24 + 玻璃底，渠道管理/WorkspaceSelector/ThemeSettings 重排。

### 修复
- **输入框出画** — main 改 flex flex-col + TabBar shrink-0 + Chat flex-1，composer 不再出画。
- **rail/sidebar/输入框底对齐** — 去 rail padding 顶底齐 sidebar；composer bottom 对齐 nav 底。

### 变更
- **图标** — 加 `@phosphor-icons/react@2.1.10`（electron devDep），rail/tab 图标换 phosphor 对齐旧版。
- **工程** — globals 加浮岛几何 token；app-shell.css 加 tab 栏样式（strip/tab/选中态/plate/close/状态点）。

### 已知缺口（后续补）
- 超长会话虚拟占位/分批挂载（防卡顿）未接（下个做）
- 工具循环（canUseTool/MCP/Skill）未接
- tab 持久化 / preview / draft / LRU / 拖拽 未做
- 材质系统 / 记忆系统 / 错误恢复 未接

## [2.0.0-dev.3] - 2026-07-26

会话页面 UI 细化 + 主题系统，对齐 TAgent_General 桌面版视觉（干净重写，不搬其屎山 CSS）。

### 新增
- **主题系统** — 6 色系（default/ocean/forest/slate/orange/purple）× 浅/深/跟随系统；localStorage 持久化 + matchMedia 系统明暗。token 复用同库 tokens.css（12 套 `.theme-*` class 已预生成），纯 CSS class 切换。见 `renderer/atoms/theme.ts`、`ThemeInitializer`、`ThemeSettings`。
- **scene 主题背景** — 会话页背景换主题 scene 弥散场（三光斑径向渐变），换主题自动换色。用 `--scene-*-rgb` 直接拼不嵌套 color-mix（绕开 Electron 多层 color-mix+calc 解析失败）。
- **composer 玻璃浮岛** — 输入框浮岛布局（消息从下方滚过透出）+ 玻璃质感（透明底 + scene-a 顶光 + blur + 顶高光 + 向下柔影 + 聚焦 ring），对齐 TAgent_General `chat-input-glass`。见 `styles/app-shell.css`。
- **用户气泡 / 模型名胶囊** — 中性玻璃板气泡（右下尖角 + 顶高光 + 向下柔影）；assistant 9px 玻璃胶囊铭牌。见 `styles/agent-thread.css`、`MessageView`。
- **自绘滚动条 + 消息导航** — 接入 `ScrollMinimap`（右侧自绘 thumb + 左侧鱼眼刻度 + minimap 面板），原生 webkit 滚动条整条隐藏（避开 Chromium 箭头按钮顽疾）。搬全 `message-nav-*` + `scroll-progress-thumb` CSS。
- **滚动位置记忆** — `ScrollPositionManager`（对齐旧版 `useScrollPositionMemory`）：useLayoutEffect + stopScroll + 直接设 scrollTop，无动画无可见滚动过程；记忆每会话距底距离，切回恢复不打断查历史。
- **ModelSelector** — 输入框尾部 Popover pill 选渠道，会话绑核后锁定。

### 修复
- **会话页布局** — 滚不到底/输入框盖内容：改浮岛布局（消息区 `absolute inset-0` + 输入区 `absolute` 底部）+ 补 `min-h-0` 链。
- **TooltipProvider** — App 根补 TooltipProvider（ScrollMinimap 内 Tooltip 缺 Provider 炸白屏）。
- **minimap 面板** — agent 气泡撑满宽度右贴面板右缘与用户气泡右对齐；anchor 标示改气泡变色（去描边去底色条）；minimap items 按 user 分组带 replyPreview（之前只填 preview 致助手气泡不渲染、全右对齐）。

### 变更
- **工程** — electron 加 `use-stick-to-bottom` devDep（ScrollPositionManager 用其 context）；`globals.css` 加几何 token + scene 背景 + `scrollbar-none`/`scrollbar-thin`；新建 `styles/agent-thread.css`（精简）+ `styles/app-shell.css`（composer）。

### 已知缺口（后续版本补）
- 工具循环（canUseTool/MCP/Skill 注入）未接
- Xfast/MoA/MCP 已封装未接入 agent 循环
- 记忆系统（Nudge/L0-L5）未接
- 错误恢复（进程崩溃 fallback / prompt_too_long compaction）未接
- 材质系统（frosted/glass/soft 切换）未接（先固定 frosted）
- settings.json 持久化 + 主进程 nativeTheme 监听未接（localStorage 够用）

## [2.0.0-dev.2] - 2026-07-26

从 dev.1 的"能对话骨架"推进到"可配置多渠道、按项目组织工作区、kscc 核与 Pi 核均可跑"。本版含 dev.1 之后已提交的渲染层/持久化工作 + 本次渠道管理/工作区/Pi 核接入。

### 新增
- **渠道管理** — 渠道 CRUD（`~/.tagent[-dev]/channels.json`）+ API Key 加密（Electron safeStorage，OS 级）+ 启动 seed `kscc-internal` 内置渠道（OAuth，不可删，按 provider 识别）+ 渠道管理 UI。见 `main/lib/channel/`、`renderer/components/ChannelManager.tsx`。
- **工作区** — 项目目录=工作区，数据对齐 kscc 模式 `~/.tagent[-dev]/projects/{sanitizedPath}/`；打开项目目录创建/切换工作区，会话 JSONL 按项目分目录存储。见 `main/lib/workspace/`、`renderer/components/WorkspaceSelector.tsx`。
- **Pi 核接入（@tagent/pi-core）** — 可复用 Pi 内核库：kscc bare / HTTP 直连 streamFn、antml 协议、工具(Read/Write/Edit/Bash)、权限、Xfast 竞争调度、MoA 多模型、MCP 桥（Xfast/MoA/MCP 库就绪，尚未接入 agent 循环）。`pi-agent-adapter` 重写为单例 `Map<sessionId, Agent>`，AgentEvent→SDKMessage 转译，Pi Agent 天然常驻无需长驻改造。见 `packages/pi-core/`、`main/lib/adapters/pi/`。
- **双核会话服务** — `session-service` 按 channelId 选核（`kscc-internal`→kscc 核，其余→Pi 核）+ 会话绑核（首条绑定，kscc↔external 互斥，核内换模型自由）+ workspace-aware JSONL 持久化 + cwd 解析为 workspace 项目目录。
- **会话持久化** — JSONL 落盘 + resume 续历史（kscc 核首条 spawn 带 `resumeSessionId`，SDK 读 JSONL 一次，之后靠子进程内存）。见 `main/lib/agent/session-store.ts`。
- **TAgentMessage IR 渲染层（重写，双核统一）** — `sdkMessageToIR` 统一转译，renderer 拆 `ContentBlockView`/`ToolResultView`/`ChatInput` 组件。
- **会话列表侧栏** — 按工作区分组的会话列表 + 切回会话读 JSONL 加载历史。

### 修复
- **SessionSidebar 防御** — `listSessions` 返回非数组时防御 + 主进程日志。

### 变更
- **构建** — 新增 `build:pi-core`（ESM 单独打包，外部化 pi-ai/pi-agent-core/MCP SDK）；main bundle 外部化 `@tagent/pi-core`/`pi-agent-core`/`pi-ai`。
- **依赖** — 新增 `@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`、`@tagent/pi-core`（workspace）。
- **工程** — pi-core 补 `typecheck` 脚本 + `typescript` devDep，纳入工作区 `bun run typecheck`（5 包全绿）；`.gitignore` 增 `*.bak`/`*.tsbuildinfo`/嵌套 pi-core 重复目录。

### 已知缺口（后续版本补）
- 工具循环（canUseTool/MCP/Skill 注入）未接
- Xfast/MoA/MCP 已封装未接入 agent 循环
- 记忆系统（Nudge/L0-L5）未接
- 错误恢复（进程崩溃 fallback / prompt_too_long compaction）未接
- 渠道连接测试/拉模型（外部渠道真实 HTTP）占位
- 知识库体系（设计已定，未实现）

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
