# Brief · 重设计「Agent 行为」设置 UI（去渠道化）

> `kscc -p --model glm-5.2 --dangerously-skip-permissions`  
> 总监定调如下；**禁止**再套用 `channel-*` / `ChannelsSettings` 结构。  
> 逻辑 CRUD / IPC **保留**；只换信息架构 + 视觉 + 编辑交互外壳。

## 问题

当前 `AgentBehaviorSettings.tsx` 明确「视觉对齐 ChannelsSettings」、复用 `channel-settings-page` / `channel-row` / `channel-list`… → 用户反馈：**难看，而且像渠道页**。

## 设计定调（必须遵守）

1. **不是连接管理**：渠道页 = 供应商 / Key / 连通测试。Agent 行为 = **协作策略 / 班底剧本**。  
2. **一个页面一个气质**：偏「策略板」——轻、透、少描边；多座位芯片，少表格行。  
3. **禁用**：`channel-settings-*`、`channel-row*`、`channel-list*`、`channel-notice*`、`channel-empty`、`channel-tag`、`channel-status-*` 等一切渠道类名。新建前缀 **`agent-behavior-*`**（CSS 放 `settings-shell.css` 末尾或 `agent-behavior-settings.css` 并在 globals 引入）。  
4. **占位节不要假卡片墙**：班组 / 圆桌用一条低调「即将推出」轨（虚线或淡底 + 一行说明），不要整块 `SettingsCard` 空壳连排。  
5. **会诊班底 = 剧本卡**：每条预置一张卡：  
   - 标题 + 启用开关  
   - **座位条**：参考席 chip（名 · 模型）→ 箭头/「汇」→ 汇总 chip  
   - 次要 meta（超时）小号字  
   - 操作：编辑 / 删除（图标或文字按钮，勿复制渠道「测试连通」空位）  
6. **编辑交互**：优先 **同页展开 / 侧滑面板感**（仍在 Agent 行为页内），避免整页变成「渠道编辑器」那种返回箭头 + EditorSection 堆栈。可用轻量 `Sheet`/`Dialog` 若项目已有；否则同页 `agent-behavior-editor` 面板。字段逻辑不变（名称、启用、参考≥2、汇总、超时、模型下拉）。  
7. **Intro**：保留 Settings 页顶栏品牌体系即可；正文用短 kicker「协作策略」+ 一句说明，勿再套 `channel-settings-heading`。  
8. **主题**：用现有 CSS 变量 / glass / muted；避免紫霓虹、大阴影、圆角胶囊堆砌、emoji。尊重用户前端规则：少卡片嵌套；会诊卡是**交互容器**才允许轻微表面。

## 必做

1. 重写 `AgentBehaviorSettings.tsx` 结构与 class（功能对等：list/add/edit/delete/toggle/校验报错）。  
2. 新增样式，与渠道页并排打开时应**一眼不像**。  
3. 班组/圆桌占位按 §4 做低调轨。  
4. 手测清单写进 `docs/dev/moa-roundtable/REDESIGN-AGENT-BEHAVIOR-UI-FINDINGS.md`（改了啥、截图可用文字线框描述）。  
5. typecheck 无新增错；禁止 commit。

## 不做

- 班组/圆桌真表单  
- 改 IPC / `moa-preset-service` 校验规则  
- 改 Settings 侧栏其它 tab  
- 大改 `@tagent/ui` 原子组件  

## 验收

- [ ] 源码中无 `channel-` 类名残留于本文件  
- [ ] 列表为座位芯片剧本卡，非 channel-row  
- [ ] 编辑非「整页渠道编辑器」复刻  
- [ ] CRUD 仍可用；非法保存仍中文错  
