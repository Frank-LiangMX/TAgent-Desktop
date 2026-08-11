# FIX：消息区左侧留白（避开刻度轨）— DONE

> 日期：2026-08-11  
> 对照：Codex 左 gutter（刻度与正文之间有呼吸）

## 改动

| 位置 | 前 | 后 |
| --- | --- | --- |
| `ConversationContent` | `px-4`（左右各 16px） | 改由 `.session-conversation-pad` 控制 |
| `.session-conversation-pad` | 无规则 | 左 ≈54px（轨宽 28 + 间隙 14 + 12），右 20px |
| `.tagent-thread` | `padding-left/right: 5px` | `8px`（对称；刻度占位不在此层） |

## 文件

- `apps/electron/src/renderer/styles/chat.css`
- `apps/electron/src/renderer/components/chat/Chat.tsx`
