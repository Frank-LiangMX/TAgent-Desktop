# FINDINGS：设置「会诊 + 圆桌」合并为「MOA」

## 结论

侧栏 Agent 行为现为 **MOA / 子代理 / 班组**。会诊与圆桌为**对等双子模块**，下方「共用班底」为共享基础设施。

## 页结构

1. Intro：两种对等协作，共用班底  
2. 双子网格：`会诊` | `圆桌`（同级 SettingsSection）  
3. 共用班底 CRUD

## 实现要点

- tab id 仍为 `agent-roundtable`；`agent` / `agent-discuss` 归一
- `MoaSettings` 编排对等模块；`AgentDiscussSettings variant="module"`
- prefs / moa IPC / 班组页未改
