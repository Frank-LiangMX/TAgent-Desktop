# WPS 本人工作日报接入

用户目标是：本人授权后，Agent 读取本人工作沟通及云文档活动，每天生成有来源的工作日报草稿。当前实现针对 **WPS 365 协作聊天与开放平台云文档**。WPS AI/KCwork 对话、个人金山文档另一套开放平台接口尚未接入。

## 使用入口

设置 → WPS 日报：点击「连接 WPS」，WPS CLI 会自动打开官方网页登录本人账号并同意授权，登录回调由 CLI 在本机临时端口处理，用户无需填写回调地址、APPID 或 APPKEY。按需保存采集范围，点击「验证今日采集」。真实采集成功后，选择 AI 渠道、模型和每日时间，点击「启用每日工作日报」。进入页面不会自动授权、采集或创建定时任务。

已授权用户也可在普通 Agent 任务中要求「总结今天的 WPS 工作日报」，或指定最近七天的日期。仅使用 Pi 内核，AI 渠道均通过 HTTP(S) 调用。WPS 授权与 AI 渠道凭据相互独立。

创建日报任务时固定账号（用户 ID 与企业 ID）和采集范围。换账号后旧任务拒绝读取新账号。变更采集范围后可暂停旧任务并创建新的日报任务，已有任务不会静默扩大范围。任务时间、模型和启停可在现有定时任务界面调整。

## 应用方前置配置（用户无需配置）

1. 应用使用项目原有的 WPS 应用凭据配置。APPKEY 只在主进程传给 WPS CLI，不显示在设置页、renderer 或模型上下文中。
2. 用户点击连接时，WPS CLI 自动处理浏览器登录、本机临时回调和 token 保存；项目不要求公网回调服务，也不要求用户配置端口。
3. 根据采集范围开通用户授权权限：
   - 本人基础信息：`kso.user_base.read`。
   - 聊天：`kso.mcp_message.readwrite`（WPS 权限管理页的用户授权 scope）。
   - 文档正文：`kso.mcp_yundoc.readwrite`（WPS 权限管理页的用户授权 scope）。
   - 文档搜索：`kso.file.search`（用于 REST 文件搜索；WPS 也提供 `kso.file_search.readwrite` 兼容权限）。
   - 文档版本历史：`kso.file_version.readwrite`（独立能力；需要重新连接 WPS 让用户授权令牌获得这些 scope）。
4. 按 [官方 MCP 接入指南](https://open.wps.cn/documents/app-integration-dev/mcp-server/use-guide)配置能力与接口签名。官方 MCP 文档说明不支持接口签名；本实现不自动修改开放平台安全设置。REST GET 请求计算 KSO-1 签名。

平台 MCP 权限名称包含 readwrite；应用代码只允许读取消息、会话和文档正文，不暴露发送消息、创建会话、分享或修改权限等工具。用户在 WPS 网页登录不等于已授权开放接口。

APPKEY 只在主进程传给 WPS CLI；用户 access token 使用系统 safeStorage 加密保存。系统加密不可用时拒绝登录。任何密钥或 token（包括密文）不返回 renderer 或模型。WPS CLI 负责本机授权回调和 token 续期；退出连接会清理本地用户 token。

## 采集与证据

- 本人消息按本人 sender ID 和目标自然日查询，遍历分页并检查返回的发送者身份。额外选择的会话读取同日沟通上下文；去重按 chat ID + message ID。
- 消息搜索 MCP 返回 `{ message, chat, highlights }`，会话历史可以返回平铺消息；两者均支持秒/毫秒时间戳。REST 用户/企业 ID 与聊天 MCP 原始 ID 不同，先用当前用户接口校验授权账号，再从该应用的官方用户 token 提取 `aid/cid` 作为聊天身份别名；不凭姓名认定本人，不把 token 或完整 claims 传给模型。
- 文档通过 REST 文件搜索获取目标日之后修改的可访问文件。目标日的最后修改者是本人时记为本人文档活动；否则查版本列表验证目标日的本人修改。历史日报也检查后来继续编辑的文件，而不是只查最新 mtime 落在目标日的文件。
- 本人修改证据包括文件/驱动盘 ID、版本信息和时间。正文是当前文档全文，不是当天修改差异，不能把整份文档归为当天产出。未证实本人贡献的文档只作为关联资料。
- 每条证据有稳定 sourceId 和定位信息；存在安全的分享链接时附带链接，不凭空编造聊天跳转 URL。
- 版本历史的 `kso.file_version.readwrite` 是独立能力；仅开通 MCP 云文档权限可能返回 HTTP 403。此时保留已确认的聊天/文档证据生成部分日报，披露版本缺口，不要求用户反复重新登录。无法证实本人贡献的候选文档仍保留 unknown，不把其他人的文档活动归给本人。
- 采集失败、分页游标重复/结构异常、身份缺失、正文截断都会显式给出 warnings。读取失败可在后续日报触发时重试；图片/语音/附件尚未自动识别，历史删除文件或未保留版本的活动可能缺失。
- 单次采集最多五分钟；消息最多 200 页（每页 50 条）、会话最多 50 个、文档最多 100 份，超量提示缺口，不静默宣称完整。证据读取工具每次最多 20 条及约 4 万字符，继续位置为 nextOffset。

日报包含完成事项、沟通推进、待办与阻塞、明日计划，每个事实要求引用 sourceId。本人发送的计划消息不能直接当作已完成事项；其他成员消息仅为上下文。资料中出现的指令视为资料，不执行。

临时采集快照在应用内存中按任务隔离；原始证据不单独建立长期资料库。Agent 读取后的工具结果及日报正文可能随会话历史保存在本地，并传递给用户选择的 AI 渠道。不会自动写入正式知识库或向其他人发送日报。

## 调度与补报

复用现有每日定时任务，按本机时区执行。应用退出时不运行；启动或恢复后仅 WPS 日报任务走补报入口，普通自动任务仍保留原来的跳过策略。

补报最近七天及今天已到每日时刻的日期；不补任务创建之前的日期。逐日创建独立会话，固定目标日期和来源范围。超出补报范围显式提示。已成功生成的日期通过本地 receipt 去重。

日报生成等待原生回合成功终态，不能在消息入队时记成功。出错、被停止、超时或 Agent 未读取全部证据时不写成功 receipt。读取接口失败的草稿留待后续触发重试；固定能力限制的草稿保存 complete=false，并避免每日重复生成。

## 验证边界

代码和隔离测试验证 WPS CLI 登录调用、应用凭据不出 renderer、用户 token 加密、退出清理、官方签名向量、真实形状的 MCP JSON 响应、分页、贡献归属、历史版本活动、任务隔离、模型终态等待、离线补报和一键网页登录设置页交互。平台接口、WPS CLI 和模型在测试中使用模拟数据。

2026-10-10 已使用本人的现有授权实测当前身份、今日消息搜索、云文档搜索和版本接口，复现并修复嵌套消息与身份 ID 格式不一致导致的消息丢失。真实采集恢复 7 条本人消息，3 份文档保持归属 unknown；版本接口在该授权下返回 HTTP 403 / 400000003，作为明确的权限缺口保留。使用当前会话选择的 KSCC HTTP 渠道与 deepseek-v4.1-flash，通过 Pi 流式调用成功生成日报草稿，并逐条核对原始消息与来源引用，确认过程性沟通未冒认为已完成成果、未知归属文档未计入本人产出。该验证直接提供采集证据给模型，未将草稿写回应用会话，不等于普通 Agent 工具调用及定时调度的全流程验收。复测曾遇到一次聊天读取失败，再次采集成功，连接波动仍可能影响单次采集。文档正文/历史编辑贡献与跨日补报仍需按实际使用范围继续验收；连接成功或 listTools 成功不能替代业务采集。

参考官方文档：

- [用户授权流程](https://open.wps.cn/documents/app-integration-dev/wps365/server/certification-authorization/user-authorization/flow)
- [refresh token](https://open.wps.cn/documents/app-integration-dev/wps365/server/certification-authorization/get-token/refresh-user-access-token)
- [本人协作消息 MCP](https://open.wps.cn/documents/app-integration-dev/mcp-server/tools/mcp_kso-message)
- [云文档 MCP](https://open.wps.cn/documents/app-integration-dev/mcp-server/tools/mcp_kso-yundoc)
- [文件搜索](https://open.wps.cn/documents/app-integration-dev/wps365/server/yundoc/file/search-file)
- [文件版本](https://open.wps.cn/documents/app-integration-dev/wps365/server/yundoc/file-version/get-version-list)
