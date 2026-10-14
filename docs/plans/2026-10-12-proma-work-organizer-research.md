# 参考 Proma：TAgent 日程、工作记录与日报方案

调研日期：2026-10-12。参考范围为本地 `F:\Proma` 的源码与仓库内截图，未运行其桌面应用。本次只做调研和方案，不复制源码、不移植组件、不修改 Proma。

后续范围已扩展：用户要求把轻笔记、知识库、待办、日程和日报统一为「工作台」。入口名称与第一阶段范围以 [统一工作台方案](F:/TAgent-Desktop/docs/plans/2026-10-12-unified-workbench.md) 为准；本文保留 Proma 的调研依据。

## 结论

Proma 最值得参考的是把待办、日程、定时任务及 Agent 会话连起来的工作流。TAgent 应在此基础上补上自己的工作记录和日报归档，让“计划做什么 → 实际做了什么 → 日报如何总结”有连续入口。

建议新增一级入口「我的工作」，内含「今天 / 日程 / 待办 / 工作记录 / 日报」。WPS 连接留在设置中，采集和业务结果在「我的工作」查看。已有自动化入口继续管理执行规则；日历只展示其计划执行时间，不再维护第二份规则。

## 核实到的 Proma 功能

| 功能 | 本地证据 | 借鉴方式 |
| --- | --- | --- |
| Todo、日程、定时任务集中在任务/日程入口 | [PlanningView](F:/Proma/apps/electron/src/renderer/components/planning/PlanningView.tsx:35) | 把个人工作操作集中，避免全部藏在设置和聊天中 |
| 今天、未来七天、全部、已完成、分组等待办视图 | [TodoWorkspace](F:/Proma/apps/electron/src/renderer/components/planning/PlanningView.tsx:672) | 以今天为默认入口，保留完整列表和历史，不只有看板 |
| 待办选择执行项目后启动 Agent，并关联会话 | [startTodoInWorkspace](F:/Proma/apps/electron/src/renderer/components/planning/PlanningView.tsx:625)、[会话关联类型](F:/Proma/packages/shared/src/types/planning.ts:132) | 待办可交给 Agent，返回待办可继续原会话 |
| 周/月日历汇总日程、待办日期及自动任务 | [CalendarWorkspace](F:/Proma/apps/electron/src/renderer/components/planning/CalendarWorkspace.tsx:164) | 同屏查看安排，但保持三种数据独立；截止时间不能冒充工作时长 |
| 周视图拖选时间段创建日程 | [finishTimeDrag](F:/Proma/apps/electron/src/renderer/components/planning/CalendarWorkspace.tsx:946) | 后续实现快捷排期；本次未验证拖动已有日程改期，不把它计为已核实能力 |
| 聊天可显式引用待办与日程，并重新读取最新状态 | [planning-reference-state](F:/Proma/apps/electron/src/renderer/components/agent/planning-reference-state.ts:71)、[引用上下文](F:/Proma/apps/electron/src/main/lib/planning-reference-context.ts:90) | 让用户把确定的工作对象交给 Agent，而非每次重述内容 |
| 到期通知、常驻提醒、确认和推迟处理 | [提醒调度器](F:/Proma/apps/electron/src/main/lib/planning-reminder-scheduler.ts:1)、[提醒 UI](F:/Proma/apps/electron/src/renderer/components/planning/PlanningReminderRail.tsx:74) | 通知不是唯一记录，错过后仍能查看和处理 |
| 系统日历/提醒事项同步 | [平台判断](F:/Proma/apps/electron/src/main/lib/planning-native-sync-service.ts:16) | 这是 macOS 14+ EventKit 能力，不能当成 Windows/WPS 同步方案 |

截图证据：[仓库内日历引导图](F:/Proma/apps/electron/src/renderer/assets/onboarding/guide-automation-calendar.png)。截图展示了日历中的自动任务；源码补充了待办、日程和 Agent 引用关系。

在本次检索的相关实现中，没有发现与上述 Planning 平级的独立工作记录/日报归档模块。设计文档中提到 Daily report 不等于功能已实现。因此，Proma 主要提供计划与执行的参考，工作记录和日报仍需按 TAgent 的需求独立设计。

## TAgent 当前差距

| 当前能力 | 已有内容 | 用户实际缺少的入口 |
| --- | --- | --- |
| WPS 接入 | 登录、本人聊天/文档证据采集及缺口诊断 | 按日期查看来源、判断哪些信息纳入工作记录 |
| 日报 | Agent 证据读取工具、部分证据总结、定时生成及最近七天补报 | 日报列表、编辑、定稿、导出和重新生成后的版本保留 |
| 自动化 | 执行规则、启停、模型配置等 | 今天何时执行、与个人日程如何并排查看 |
| 任务看板 | Agent 工人派工、依赖、验收等编排任务 | 个人待办、截止时间和手动勾选完成 |
| WPS 日历 | 共享类型仍有日历 IPC 常量 | 本次未查到对应主进程/预加载业务实现；常量不代表已接入 |

核实位置：[WPS 设置入口](F:/TAgent-Desktop/apps/electron/src/renderer/components/settings/SettingsPage.tsx:158)、[WPS Agent 工具](F:/TAgent-Desktop/apps/electron/src/main/lib/wps/wps-agent-tools.ts:16)、[采集快照](F:/TAgent-Desktop/apps/electron/src/main/lib/wps/wps-service.ts:195)、[日报运行记录](F:/TAgent-Desktop/apps/electron/src/main/lib/wps/wps-report-runner.ts:21)、[自动化页面](F:/TAgent-Desktop/apps/electron/src/renderer/components/automation/AutomationMainView.tsx:19)、[看板类型](F:/TAgent-Desktop/packages/shared/src/types/kanban.ts:1)。

现有 WPS 快照只在内存中按会话保留；原始证据和日报可能随聊天历史保存。日报 receipt 是运行去重记录，不能作为长期日报库。新增模块应建立业务归档，不要求用户翻聊天找日报。

## 建议的用户流程

### 今天

页面显示选定日期的日程、待办、工作记录摘要和日报状态。提供「记一笔」「新增待办」「生成日报」，并明确最近一次 WPS 采集时间与缺口。日历可切换历史日期；不默认塞满统计卡片。

例如上午安排“排查 SVN 中文乱码”；下午记下“定位到编码转换，尚待回归验证”，关联对应 Agent 会话。晚间日报自动引用该记录和相关 WPS 沟通，不把“正在排查”写成“问题已解决”。

### 日程与待办

日程表达时间占用，待办表达要完成的事情。一个待办可以关联多个日程时段，但排过时间不代表已完成。自动化在日历中显示执行时点/窗口，使用单独的图标与文字标记，点击回到现有自动化详情。

待办支持项目、说明、截止时间、优先级、完成状态及关联会话。可「交给 Agent」或「继续处理」，Agent 回合结束不自动等同于待办完成。个人待办与现有 Agent 编排看板各自持久化，只建立关联。

### 工作记录

提供按天的时间线，可手动快速记一笔、从选定 Agent 结果记录、从 WPS 采集结果整理候选条目。内容包括事情、进展/结果、阻塞、关联项目及来源。

WPS 消息先作为候选来源，不把每条聊天自动变成一项成果；同一事项的连续沟通可以聚合。用户能排除闲聊、修正文案、合并重复记录。Agent 成功输出只能证明回合完成；文档可访问只能证明访问能力，都不能直接证明用户完成了一项工作。

### 日报

日报是可编辑的业务文档，有日期、账号、证据版本、生成状态、草稿/定稿状态及缺口。显示完成事项、沟通推进、阻塞与下一步；事实可点击查看来源，建议与已确认计划区分。

支持「重新采集」「重新生成」「手动编辑」「定稿」「导出 Markdown」。重新生成产生新草稿版本，保留用户已编辑/定稿的内容。某个来源失败仍生成已有证据支持的部分草稿，单独显示缺口。

明日待办可由日报中的下一步转入，但转入待办不意味着创建 WPS 远端日程或邀请他人。

## 最小业务数据与边界

以下是拟新增的本地业务实体，不是现有 WPS API 名称，也不是 Proma 类型移植。

| 业务实体 | 必须保留的信息 |
| --- | --- |
| 个人待办 | 所属项目、截止时间、状态、关联会话、完成时间 |
| 日程 | 起止时间、时区/全天语义、关联待办、来源及远端标识（若已同步） |
| 工作记录 | 实际发生时间、记入时间、内容、活动/完成/阻塞分类、来源、用户确认状态 |
| 日报 | 目标日期、账号、版本、正文、引用、来源完整性、生成状态、定稿状态 |
| 采集批次 | 账号与企业、采集范围、目标日期、时间、稳定来源标识、错误和重试状态 |

日程、活动记录、报告都使用稳定 ID；同一 WPS 来源重复采集不重复生成记录。用户手动修正与平台再次采集分开保存。重连换账号后隔离原账号的记录和来源，历史内容不能混入新账号日报。

自动采集不意味着永久保存所有聊天正文。工作记录归档与证据留存范围需要清楚展示；仅存定位信息可能导致以后无法复核，保存所需来源摘录则应提供清理能力。日报生成只发送本次需要的证据给用户选择的模型。

继续使用 Pi 执行内核及 HTTP 模型渠道。内部业务工具调用本地服务；WPS 远端接口另做适配。不得因为 Proma 使用 macOS 同步就添加对应 Windows 假接口，也不得把已有 WPS IPC 常量视为可用接口。

## 实施顺序与验收

### 第一阶段：先让工作有地方记录、日报有地方查看

新增「我的工作」入口，交付今天的简洁列表、个人待办、手动工作记录、WPS 候选来源、日报列表与编辑/导出。复用现有采集和定时生成能力，把结果归入独立日报实体，并保留原会话入口。此阶段先用日程列表和本地新增，避免完整周历拖拽阻塞整个模块。

验收：不用进入设置或翻聊天就能记录工作、查看指定日期日报；重启后仍存在；相同来源再次采集不重复；缺权限仍有明确标注的部分草稿；重新生成不覆盖已编辑/定稿版本。

### 第二阶段：完善计划与 Agent 协作

交付周/月日历、待办截止日期与自动化时间叠加、时间段快捷创建、提醒及推迟、聊天引用和待办关联会话。局部更新记录，避免采集或提醒到来导致整页闪动。

验收：排期不改变完成状态；逾期任务可以回看；引用内容修改后 Agent 读取最新版本；修改自动化只有一个权威入口；应用退出期间不承诺本地提醒，恢复后按策略处理漏过提醒。

### 第三阶段：验证并接入 WPS 日历

按当时官方文档和真实账号逐项核对日历列表、事件读取、时间范围/时区、分页及权限。先做明确范围的只读展示，再按用户需要实现写回、去重与冲突处理。每个远端接口都留下官方页面、真实请求形状与验收结果，不再凭权限命名猜接口。

验收：断网不影响本地记录；同步显示最近成功时间与失败状态；远端事件与本地事项来源明确；本地操作是否写回 WPS 有可理解的提示；循环事件、全天事件及账号切换有实际验证。

## 设计约束

沿用 TAgent 的主题与布局，只借鉴功能关系。选择态采用整行底色；不把圆角选择态与左侧强调竖线组合使用。窄窗口中详情改为抽屉，避免强制多栏挤压正文和时间线。连接配置、业务内容和自动化执行状态分别放在适合的入口，但保留相互跳转。

本次未安装新依赖、未运行 Proma、未复用其源文件或截图作为 TAgent 产品素材；尚未实现以上新模块。
