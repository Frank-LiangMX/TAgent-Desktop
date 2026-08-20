# TAgent Desktop 受管浏览器标签页

## 目标

把网页作为 TAgent Desktop 的一级 Dockview 标签页。它可以和会话、文件预览一样拖拽、分屏和关闭；浏览器不是右侧固定面板，也不写入会话标签真相源。

## 设计原则

- 使用 Electron WebContentsView 承载真实 Chromium 页面。
- 每个 Agent 会话使用独立的持久 partition，登录态只在该会话的浏览器空间内复用。
- 默认只允许 http、https 和 about:blank，禁止 file、data、javascript 等本地或脚本协议。
- 不伪造 User-Agent，不注入反检测脚本，不修改 Canvas、WebGL、时区或指纹。
- 失败、登录、验证码和风控挑战由页面状态反馈给用户；需要时由 Agent 调用 browser_takeover，用户在网页标签中完成操作后调用 browser_resume。
- 页面元素引用带有 generation，导航或重新观察后旧引用自动失效，避免点击到错误元素。

## 运行链路

Agent tool
  -> BrowserController (main)
  -> WebContentsView (Chromium)
  -> state/open IPC
  -> WorkspaceDock
  -> BrowserPane (Dockview split tab)

主进程负责页面生命周期、URL 策略、持久会话、元素观察和操作。渲染进程只负责标签页、地址栏、状态提示和视图边界同步，网页本身不经过 React 渲染。

## Agent 工具

- browser_open：创建/聚焦浏览器标签页并打开 URL。
- browser_navigate：导航到 http(s) URL。
- browser_observe：返回可交互元素和短期引用。
- browser_click / browser_type：按引用点击和输入。
- browser_scroll：滚动页面。
- browser_screenshot：生成受限尺寸截图并在浏览器标签页中查看。
- browser_takeover / browser_resume：人工接管和恢复自动操作。

Pi 和 KSCC 都使用同一个主进程控制器，避免两条 Agent 内核产生不同的浏览器行为。

## Bot 检测边界

这个功能的价值是“真实浏览器 + 可持续登录态 + 人机协同”，不是绕过检测。网页仍然可以识别 Electron/Chromium 环境、网络出口、Cookie、行为轨迹和验证码。遇到挑战时，产品提供清晰的人工接管路径，而不是尝试规避站点安全机制。

## 后续增强

- 在用户明确允许后增加站点级权限策略。
- 增加浏览器空间的清理和导出入口。
- 对截图、DOM 观察和操作结果增加体积预算与审计记录。
- 为跨分屏的浏览器视图增加更细粒度的激活状态同步。
