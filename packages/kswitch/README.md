# kswitch — kscc 账号切换 CLI 工具

在多个 kscc 账号间一键切换配额，无需退出登录。

## 安装

```bash
cd packages/kwitch
npm link    # 全局安装 kswitch 命令
```

或直接跑：
```bash
node packages/kswitch/bin/kswitch.js list
```

## 用法

```bash
# 添加账号
kswitch add main sk-lSkd4HdytpHaJtHr3oCgF8fCtoQWb0rIr_z7Gc3SImzjcz8

# 添加第二个账号
kswitch add backup sk-_pHiE6zxGheUzTYHXNCbSBpWJNmqxTgi_d5zSK-8yL2RwOQ

# 查看所有账号
kswitch list

# 切换到 backup
kswitch use backup

# 查看当前哪个账号生效
kswitch current

# 自动探测 KCwork 凭证并导入
kswitch import-kcwork

# 删除账号
kswitch rm backup

# 重命名
kswitch rename main 主账号
```

## 工作原理

kswitch 做的事很简单：

1. **记录**多个 kscc token 到 `~/.claude/.kscc-accounts.json`
2. **切换** = 原子修改 `~/.claude/settings.json` 的 `env.ANTHROPIC_AUTH_TOKEN`

改完后系统 kscc CLI 读到新 token，TAgent spawn 的 kscc CLI 也读到新 token——全面生效。

**原子性**：写 .tmp → fsync → 备份原文件 → rename，rename 是文件系统原子操作。崩溃不会损坏 settings.json。

**备份**：`~/.claude/settings.json.bak.kswitch` 始终保留切换前的文件，可手动回滚。

## 安全

- Token 明文存储在 `~/.claude/.kscc-accounts.json`（和 settings.json 一样在 home 目录）
- 删账号前需先切到其他账号（防止误删当前在用 token）
- KCwork 凭证只读不写，导入后由 kswitch 独立管理

## 命令参考

| 命令 | 说明 |
|------|------|
| `kswitch list` | 列出所有账号，*标记当前活跃 |
| `kswitch use <name>` | 切换到指定账号 |
| `kswitch current` | 显示当前在用账号 |
| `kswitch add <name> <token>` | 添加新账号 |
| `kswitch remove <name>` | 删除账号 |
| `kswitch rename <old> <new>` | 重命名账号 |
| `kswitch import-kcwork` | 从 KCwork 导入凭证 |
| `kswitch completions [shell]` | 生成 bash/zsh 自动补全脚本 |
| `kswitch help` | 显示帮助 |

## 补全设置

```bash
# Bash
source <(kswitch completions bash)

# Zsh
source <(kswitch completions zsh)
```

## 查看费用

kscc 有 `/mypage` 命令，打开费用页面：
https://kscc.ksyun.com/#/usage?cc=seasun

每个账号每月额度约 3000 元。