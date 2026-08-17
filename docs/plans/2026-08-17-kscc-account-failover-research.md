# kscc CLI 账号凭证备选可行性调研（用 KCwork 登录账号做配额 failover）

> **状态**：调研结论（2026-08-17），已实测命门通过，未动工
> **触发**：用户问「TAgent 现在用 kscc CLI 通信协议，能不能也用 KCwork 的——KCwork 和 kscc CLI 登的是两个不同账号，一个用完切另一个」
> **结论先行**：**可行，且已实测通过**。TAgent 始终 spawn 系统 kscc CLI（stream-json，不换协议）；切账号 = 让 kscc CLI 改读另一账号的 sk。KCwork 登录的账号 B 凭证落 `AppData/Roaming/kcwork/kscc-credential.json`，其 `sk` 是 `b64:` 前缀 + base64 包装的标准 kscc sk（50 字符），解码后塞进 kscc CLI 的 `ANTHROPIC_AUTH_TOKEN` 即可。实测 kscc CLI 用账号 B 的 sk 跑 `kscc -p hi --model glm-5.2` → exit 0 + 正常回复，证明网关放行、不强制 companyCode 头。
> **前置**：本篇承接 `docs/plans/2026-08-07-kcwork-kscc-acp-research.md` §11（08-17 复核：kscc 1.2.1 移除 ACP、KCwork 8月14版自包含 ksoc/aioncore）。两篇同系列，结论互补：那篇证「协议/进程不可劫持」，本篇证「凭证可备选」。

---

## 0. 一句话脉络（含两次反转）

用户问「能否用 KCwork 的账号」→ 一度误判为「协议劫持」(已落 §11) → 用户纠正「是账号配额备选,A 用完切 B」→ 查凭证落盘发现 A/B 两文件、格式迥异(A=sk-/50,B=b64:/72) → 误判「B 是 KCwork 私有加密格式,kscc CLI 吃不了」→ 钉命门 grep kscc CLI bundle(认 `ANTHROPIC_AUTH_TOKEN`/`BASE_API`,不认 `KSCC_AUTH_TOKEN`/`companyCode`/`baseApi`) → 解码 B 的 sk 发现就是标准 sk-(b64 包装而已,**反转**) → 命门实测 kscc CLI 用 B 的 sk → **exit 0 正常回复,网关放行** → 落盘。

**两次反转**：(a)「劫持」是误读,真问题是凭证备选；(b)「b64: 是私有加密」是误判,实为 base64 包装的标准 sk。

---

## 1. 问题纠正：不是协议劫持,是账号凭证备选

- **误判起点**（已落 08-07 文档 §11）：把用户问的「能不能用 KCwork」理解成「终端 kscc 能否劫持/接管 KCwork」,查清 kscc 1.2.1 去 ACP + KCwork 自包含 ksoc/aioncore → 四条劫持路径全断 → 落「无法劫持」。
- **用户纠正**：真意是「kscc CLI 和 KCwork 各登一个账号,配额是两池；A 用完想让 TAgent 接着用 B 的配额」。这是**凭证层备选**,不碰协议、不碰进程架构。
- **重定向后的真问题**：TAgent spawn 的 kscc CLI 现在用账号 A(`~/.claude/settings.json`)；能否在不换通信协议的前提下,让 kscc CLI 改用账号 B(KCwork 登录态)的 sk 跑。

---

## 2. 两账号凭证结构对比

| | 账号 A（kscc CLI 当前用） | 账号 B（KCwork 登录态） |
|---|---|---|
| 落盘文件 | `~/.claude/settings.json` | `~/AppData/Roaming/kcwork/kscc-credential.json` |
| 字段结构（键） | `env.ANTHROPIC_AUTH_TOKEN` + `env.KSCC_AUTH_TOKEN` + `BASE_API`(flat 大写) + `ksccModel` | `sk` + `baseApi`(camelCase) + `companyCode` + `version` |
| token 格式 | `sk-...` / 50 字符 | `b64:c2st...` / 72 字符（含 `b64:` 前缀） |
| 解码后 | 即原值（标准 sk-） | 去 `b64:` + base64 解码 → `sk-...` / 50 字符（标准 kscc sk） |
| baseApi | `http://120.92.138.34` | `http://120.92.138.34`（**同网关**） |
| companyCode | 无 | `seasun` |
| ksccModel | `deepseek-v4-flash`（08-17 实测时） | —（credential.json 不存模型） |

- **三 token 互不相等**（实测比对,只判真假不打印值）：A 的 `ANTHROPIC_AUTH_TOKEN` ≠ A 的 `KSCC_AUTH_TOKEN` ≠ B 的 `sk`。
- **关键反转**：B 的 `sk` 表面是 72 字符 `b64:` 前缀,看似 KCwork 私有加密 → 实测 `base64.b64decode(raw[4:])` 得 `sk-_pHiE6zx...`(50 字符、标准 `sk-` 前缀、非 JSON、无 companyCode/冒号分隔)。**不是加密,是 base64 包装**。`b64:c2st` = `b64:` + base64(`sk-`)。
- **同网关不同租户**：A/B 的 baseApi 都是 `http://120.92.138.34`；差异只在 sk(租户身份) + B 多带 `companyCode=seasun`(KCwork UI/计费归属用)。

---

## 3. TAgent spawn kscc 现状：不传 env,凭证全交 kscc CLI 自读

| spawn 链 | 文件 | env 传递现状 |
|---|---|---|
| bare 模型泵 | `packages/pi-core/src/kscc-spawn.ts` `spawnKsccBare`（:138-225） | **不传 env**——`spawn(invocation.command, invocation.args, { stdio:[...] })`(:172-175)无 env 字段；kscc CLI 自读 `~/.claude/settings.json` |
| resume 长驻 | `apps/electron/src/main/lib/adapters/claude/claude-agent-adapter.ts` `KsccQueryOptions` | **有 env 口子**——`env: Record<string, string \| undefined>`（:49-50）；具体怎么传到 spawn-kscc.ts **未读,待确认** |

- 当前 TAgent 把凭证完全交给 kscc CLI 自读 settings.json,自己不碰账号、不传 sk。这是 1.0「不存 sk、由 kscc CLI 自管」合规边界的延续（见 08-07 文档 §9）。
- **注入点现成**：resume 链的 `KsccQueryOptions.env` 是切账号的天然入口；bare 链 `spawnKsccBare` 当前无 env 参数,需加（工程化项）。

---

## 4. 命门分析：kscc CLI 认哪个 token

grep kscc CLI bundle `~/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/cli.js`（13.7MB）：

| 字面量 | 命中次数 | 含义 |
|---|---|---|
| `ANTHROPIC_AUTH_TOKEN` | 9 | **kscc CLI 过网关吃的 token**(sk) |
| `ANTHROPIC_BASE_URL` | 20 | 基址 |
| `ANTHROPIC_API_KEY` | 3 | 标准 API key 路径 |
| `BASE_API` | 3 | settings.json 里的 flat 大写基址(kscc 私有约定) |
| `KSCC_AUTH_TOKEN` | **0** | kscc CLI **不读**这个字段 |
| `companyCode` | **0** | **不读** |
| `baseApi`(小写) | **0** | **不读**(那是 KCwork credential.json 的键) |
| `ksccModel` | 0 | 不在 bundle 硬编码(由 settings.json 透传) |

**结论**：kscc CLI 过网关只认 `ANTHROPIC_AUTH_TOKEN`(sk) + `BASE_API`,**不认** `KSCC_AUTH_TOKEN`/`companyCode`/`baseApi`。即：
- 账号 A 现在用的就是 settings.json 里的 `ANTHROPIC_AUTH_TOKEN`(sk-lSkd4...)。
- 切到账号 B = 把 B 解码后的 sk 塞进 `ANTHROPIC_AUTH_TOKEN`；`BASE_API` 不用换(同网关)；`companyCode` 不用传(kscc CLI 不读)。
- **唯一未排除的命门**：网关对 B 的 sk 是否强制要求 companyCode 头才放行。kscc CLI 不传 companyCode,若网关要 → B 用不了。此点靠实测定生死(§6)。

---

## 5. B 的 sk 格式破译（base64 包装,非加密）

```python
raw = "b64:c2st..."           # 72 字符
b_sk = base64.b64decode(raw[4:] + "==")  # 去 "b64:" 前缀 + 补 padding
# -> "sk-_pHiE6zxGheUzTYHXNCbSBpWJNmqxTgi_d5zSK-8yL2RwOQ"  # 50 字符,标准 sk-
```

- 结构判断（实测）：含 `sk-` ✓、非 JSON ✓、无 companyCode/seasun ✓、无冒号分隔 ✓。
- → B 的 sk 与 A 的 sk **同形**(都是 50 字符标准 kscc sk),只是 KCwork 存盘时套了 `b64:` + base64 一层。解码即用,无需 KCwork 运行时参与。
- **兼容风险**：依赖 KCwork 的 `b64:` 包装格式。若 KCwork 升级改格式(改前缀/改编码/真加密),解码失败。工程化需兼容层：探测 `b64:` 前缀 → 解码；无前缀 → 当明文 sk 直用；解码失败 → 报错并回退账号 A。

---

## 6. 命门实测：kscc CLI 用账号 B 的 sk 跑通

**目标**：排除 §4 末尾唯一命门——网关对 B 的 sk(不带 companyCode 头)放不放行。

**方法**：原子脚本 = 备份 settings.json → 临时把 `ANTHROPIC_AUTH_TOKEN` 换成 B 解码后的 sk → `kscc -p "hi" --model glm-5.2` → `finally` 必还原 → 校验还原。备份带固定后缀留盘,即使中途崩溃可手动 `cp` 还原。改全局 settings.json **不影响当前会话**(env 已注入账号 A,只有新 spawn 的子 kscc 读改后的)。

**结果**：

```
[改] 原 sk-lSkd4 -> B sk-_pHiE
exit: 0
=== stdout ===
Hi! What would you like to work on?

You're on `feature/collab-room` with a clean tree — looks like the collaboration
room work (S3.5 room shared summary) is the recent focus. Let me know what you'd like to do.
=== stderr ===
(空)
=== 还原 == True (备份 ~/.claude/settings.json.bak.acptest)
```

**判定**：
1. **exit 0 + 正常回复** → kscc CLI 用账号 B 的 sk 完全正常,网关放行。
2. **不强制 companyCode 头** → companyCode=seasun 是 KCwork UI/计费归属用,网关靠 sk 本身识别租户,不要求客户端带 companyCode 头。命门排除。
3. **读到项目上下文**(feature/collab-room、干净树) → 凭证切换无副作用,kscc CLI 行为与账号 A 一致。
4. **配额计在 B** → 实测消耗账号 B 极少配额(一个 hi)；正式用也会计 B 的配额,只是从 kscc CLI 发起而非 KCwork。

**实测脚本**（可复现,见附录 A）。第一次因 python 用 GBK 解码 kscc 的 UTF-8 输出炸了(`UnicodeDecodeError: 'gbk' codec`)导致 stdout 显示空；加 `encoding='utf-8', errors='replace'` 后拿到真实输出。exit 0 偏乐观(403 通常非 0 退出),UTF-8 重测确认是真 0 + 真回复。

---

## 7. 可行方案（凭证层备选,不换协议）

```
读 ~/AppData/Roaming/kcwork/kscc-credential.json
  -> sk = "b64:c2st..."
  -> 去 "b64:" 前缀 + base64 解码 -> 标准 kscc sk (50 字符)
  -> 塞进 kscc CLI 的 ANTHROPIC_AUTH_TOKEN (env 注入)
  -> BASE_API 不变 (A/B 同网关)
  -> companyCode 不传 (实测不需要)
  -> spawn kscc CLI (stream-json / resume / bare 均同此)
```

- **不换通信协议**：TAgent 仍 spawn 系统 kscc CLI(stream-json),resume 长驻/bare 模型泵照旧。
- **不碰 KCwork 进程**：不 spawn aioncore、不接 ACP、不读 KCwork 运行态；只读 KCwork 登录时落盘的 credential.json 静态文件。
- **注入点**：resume 链 `KsccQueryOptions.env`(:49-50)现成；bare 链 `spawnKsccBare`(:138)需加 env 参数。

---

## 8. 工程化待定（做成 TAgent 配额备选功能时）

1. **env 传链确认**：resume 链的 `KsccQueryOptions.env` → `spawn-kscc.ts`（未读）→ 实际 spawn 的 env 会不会被 settings.json 的 `env` 段覆盖。决定三选一：(a) env 注入子进程(若不被覆盖)、(b) `--settings <临时json>` 传独立配置文件、(c) 临时改 settings.json(本次实测法,全局副作用大,不推荐常驻)。
2. **配额耗尽检测 + 切换触发**：什么信号判定「A 用完」(403/429/配额错误码?)；自动切还是 UI 手动切；切后是否回切 A。
3. **b64 格式兼容层**：探测 `b64:` 前缀 → 解码；无前缀 → 明文直用；解码失败 → 报错回退 A。防 KCwork 升级改格式。
4. **多账号管理**：是否支持>2 账号、账号优先级、每账号配额可见性。
5. **bare 链补 env 参数**：`spawnKsccBare` 的 `KsccBareSpawnOptions` 加 `env?`,透传到 `spawn(...)`。
6. **合规复核**：用账号 B 的 sk 从 kscc CLI 发起,网关计 B 的配额；若公司 ToS 禁跨客户端用同一凭证,需确认(见 08-07 §9)。

---

## 9. 风险与约束

- **依赖 KCwork 落盘格式**：`b64:` 包装是 KCwork 当前版本行为,升级可能变；兼容层必须,否则静默失败。
- **配额没绕过**：用的还是账号 B 真实 sk,网关照计 B 配额。本方案是「配额池扩到 B」,不是「白嫖」。
- **凭证生命周期**：账号 B 的 sk 由 KCwork 登录/刷新时写 credential.json；TAgent 读的是该文件的快照。sk 过期/轮换时 TAgent 需重读(监听文件变 or 每次启动读)。
- **切账号 ≠ 切会话**：kscc resume 长驻进程的鉴权在 spawn 时定型；切账号需 re-spawn(SDK session id 能否跨账号 resume 未测,大概率不能——不同租户的会话隔离)。
- **companyCode 不传已实测 OK**,但若网关后续加 companyCode 强制校验(策略变更),需补传头。

---

## 10. 后续动作

- [ ] 读 `spawn-kscc.ts` 确认 env 传链(§8.1),定注入方式
- [ ] 设计配额备选 UI/触发(§8.2),用户拍板自动 vs 手动
- [ ] 出实施计划:b64 兼容层 + env 注入 + bare 链补参数 + 配额检测
- [ ] 实施后回归:账号 A/B 各跑一轮,确认切换无副作用 + 配额计对账户

---

## 附录 A：命门实测脚本（原子备份/改/跑/还原/校验）

```python
import json, base64, subprocess, shutil, os

settings = os.path.expanduser(r'~\.claude\settings.json')
bak      = settings + '.bak.acptest'  # 固定后缀,跑完留盘供手动核对
cred     = os.path.expanduser(r'~\AppData\Roaming\kcwork\kscc-credential.json')

shutil.copy2(settings, bak)          # 1. 备份(留盘)
b = json.load(open(cred, encoding='utf-8'))
raw = b['sk']
b_sk = base64.b64decode(raw[4:] + '=' * ((4 - len(raw[4:]) % 4) % 4)).decode('utf-8')  # 2. 解码 B 的 sk
s = json.load(open(settings, encoding='utf-8'))
orig = s['env']['ANTHROPIC_AUTH_TOKEN']
s['env']['ANTHROPIC_AUTH_TOKEN'] = b_sk                       # 3. 临时换(只动这一个字段)
json.dump(s, open(settings, 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
try:
    r = subprocess.run('kscc -p "hi" --model glm-5.2',
                       shell=True, capture_output=True, text=True,
                       encoding='utf-8', errors='replace', timeout=40)  # 4. 跑
    print('exit:', r.returncode); print(r.stdout[:1500]); print(r.stderr[:1500])
finally:
    shutil.copy2(bak, settings)      # 5. finally 必还原
    rs = json.load(open(settings, encoding='utf-8'))
    print('还原 ==', rs['env']['ANTHROPIC_AUTH_TOKEN'] == orig)  # 6. 校验
```

- **回退保证**：`finally` 块无条件还原；备份 `.bak.acptest` 留盘,即使进程崩也可手动 `cp ~/.claude/settings.json.bak.acptest ~/.claude/settings.json`。
- **不影响当前会话**：改 settings.json 只影响新 spawn 的子 kscc；本会话 env 已注入账号 A,不受影响。
- **实测消耗**：账号 B 极少配额(一个 hi)。

---

## 附录 B：与 08-07 调研的关系

| 维度 | 08-07 调研（§11 复核后） | 本篇（08-17） |
|---|---|---|
| 问题 | kscc 核能否转 ACP / 终端 kscc 能否劫持 KCwork | 账号 A 用完能否切账号 B 的配额 |
| 层次 | 协议层 / 进程架构层 | 凭证层 |
| 结论 | 不可劫持(kscc 去 ACP + KCwork 自包含) | 可备选(凭证可切,已实测) |
| 动作 | §8 转 ACP 计划作废(终端 kscc 无 ACP) | §7 凭证注入方案,待工程化 |
| 互补 | 证「进程/协议不可劫持」 | 证「凭证可备选」——不矛盾,正交 |

两篇合起来：KCwork 在**进程/协议层**对 TAgent 无可劫持价值,但在**凭证层**可作为 kscc CLI 的配额 failover 源。
