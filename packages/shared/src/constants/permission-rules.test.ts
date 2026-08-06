import { describe, expect, test } from 'vitest'

import {
  isAutoModeAutoAllowTool,
  isChatModeBlockedTool,
  isChatModeHardStopTool,
  CHAT_MODE_BLOCK_REASON,
  CHAT_MODE_BLOCK_USER_MESSAGE,
  CHAT_MODE_BLOCK_USER_TITLE,
  isDangerousCommand,
  isProjectLocalReadOnlyBash,
  isProjectScopedNonDestructiveBash,
  hasWriteStructure,
  requiresAutoModeConfirmation,
  resolveSdkPermissionModeForTAgent,
  PERMISSION_TIMEOUT_MS,
} from './permission-rules'

describe('resolveSdkPermissionModeForTAgent', () => {
  test('PERMISSION_TIMEOUT_MS is 120 seconds', () => {
    expect(PERMISSION_TIMEOUT_MS).toBe(120_000)
  })

  test('auto 映射为 default，由 TAgent canUseTool 审批', () => {
    expect(resolveSdkPermissionModeForTAgent('auto')).toBe('default')
  })

  test('bypassPermissions 映射为 default，避免 SDK classifier 硬拒', () => {
    expect(resolveSdkPermissionModeForTAgent('bypassPermissions')).toBe('default')
  })

  test('plan 保持 plan', () => {
    expect(resolveSdkPermissionModeForTAgent('plan')).toBe('plan')
  })
})

describe('isProjectLocalReadOnlyBash', () => {
  const cwd = 'F:/TAgent_General'

  test('cwd 内 cat 相对路径 → 放行', () => {
    expect(isProjectLocalReadOnlyBash('cat README.md', cwd)).toBe(true)
    expect(isProjectLocalReadOnlyBash('cat src/index.ts', cwd)).toBe(true)
  })

  test('cwd 内 cat 绝对路径（cwd 前缀）→ 放行', () => {
    expect(isProjectLocalReadOnlyBash('cat F:/TAgent_General/CLAUDE.md', cwd)).toBe(true)
    expect(isProjectLocalReadOnlyBash('cat F:\\TAgent_General\\package.json', cwd)).toBe(true)
  })

  test('cwd 外 cat 绝对路径 → 拒绝', () => {
    expect(isProjectLocalReadOnlyBash('cat /etc/passwd', cwd)).toBe(false)
    expect(isProjectLocalReadOnlyBash('cat ~/.ssh/id_rsa', cwd)).toBe(false)
    expect(isProjectLocalReadOnlyBash('cat C:/Windows/System32/drivers/etc/hosts', cwd)).toBe(false)
  })

  test('父目录路径 → 拒绝（保守，避免越界）', () => {
    expect(isProjectLocalReadOnlyBash('cat ../package.json', cwd)).toBe(false)
    expect(isProjectLocalReadOnlyBash('find .. -name foo', cwd)).toBe(false)
  })

  test('find cwd 内 → 放行', () => {
    expect(isProjectLocalReadOnlyBash('find . -name "*.ts"', cwd)).toBe(true)
    expect(isProjectLocalReadOnlyBash('find src -type f', cwd)).toBe(true)
  })

  test('find cwd 外 → 拒绝', () => {
    expect(isProjectLocalReadOnlyBash('find / -name "*.env"', cwd)).toBe(false)
    expect(isProjectLocalReadOnlyBash('find ~ -name ".ssh"', cwd)).toBe(false)
  })

  test('写结构 → 拒绝（即使路径在 cwd 内）', () => {
    expect(isProjectLocalReadOnlyBash('cat README.md > /tmp/out', cwd)).toBe(false)
    expect(isProjectLocalReadOnlyBash('find . -exec rm {} \\;', cwd)).toBe(false)
    expect(isProjectLocalReadOnlyBash('find . -delete', cwd)).toBe(false)
    expect(isProjectLocalReadOnlyBash('cat file | tee /tmp/x', cwd)).toBe(false)
  })

  test('只读管道 / 串联 → 放行（| 与 && 本身不写盘）', () => {
    expect(isProjectLocalReadOnlyBash('ls | head', cwd)).toBe(true)
    expect(isProjectLocalReadOnlyBash('cat README.md | head -20', cwd)).toBe(true)
    expect(isProjectLocalReadOnlyBash('cd src && ls', cwd)).toBe(true)
    expect(isProjectLocalReadOnlyBash('find . -type f | head', cwd)).toBe(true)
  })

  test('Windows 项目内只读 → 放行', () => {
    expect(isProjectLocalReadOnlyBash('dir /s', cwd)).toBe(true)
    expect(isProjectLocalReadOnlyBash('type package.json', cwd)).toBe(true)
    expect(isProjectLocalReadOnlyBash('Get-ChildItem -Recurse', cwd)).toBe(true)
    expect(isProjectLocalReadOnlyBash('Get-Content README.md', cwd)).toBe(true)
  })

  test('echo 无重定向 → 放行', () => {
    expect(isProjectLocalReadOnlyBash('echo hello', cwd)).toBe(true)
    expect(isProjectLocalReadOnlyBash('echo "foo bar"', cwd)).toBe(true)
  })

  test('echo 带重定向 → 拒绝（危险结构）', () => {
    expect(isProjectLocalReadOnlyBash('echo x > file.txt', cwd)).toBe(false)
    expect(isProjectLocalReadOnlyBash('echo y >> log.txt', cwd)).toBe(false)
  })

  test('sed -n 只读模式 → 放行', () => {
    expect(isProjectLocalReadOnlyBash('sed -n "1,10p" README.md', cwd)).toBe(true)
  })

  test('sed -i 原地编辑 → 拒绝（不匹配只读模式）', () => {
    expect(isProjectLocalReadOnlyBash('sed -i "s/foo/bar/g" file.ts', cwd)).toBe(false)
  })

  test('未提供 cwd → 保守拒绝（无法判断路径边界）', () => {
    expect(isProjectLocalReadOnlyBash('cat README.md')).toBe(false)
    expect(isProjectLocalReadOnlyBash('find . -name "*.ts"')).toBe(false)
  })

  test('写命令（rm/mv/cp）→ 拒绝（不匹配只读模式）', () => {
    expect(isProjectLocalReadOnlyBash('rm file.txt', cwd)).toBe(false)
    expect(isProjectLocalReadOnlyBash('mv a b', cwd)).toBe(false)
    expect(isProjectLocalReadOnlyBash('mkdir newdir', cwd)).toBe(false)
  })
})

describe('isAutoModeAutoAllowTool（带 cwd）', () => {
  const cwd = 'F:/TAgent_General'

  test('Read / Glob / Grep → 永远静默放行（读操作默认授权）', () => {
    expect(isAutoModeAutoAllowTool('Read', { path: 'any' }, cwd)).toBe(true)
    expect(isAutoModeAutoAllowTool('Glob', { pattern: '**/*' }, cwd)).toBe(true)
    expect(isAutoModeAutoAllowTool('Grep', { pattern: 'foo' }, cwd)).toBe(true)
    expect(isAutoModeAutoAllowTool('Read', { path: '/etc/passwd' })).toBe(true)
  })

  test('Bash cat cwd 内文件 → 静默放行', () => {
    expect(isAutoModeAutoAllowTool('Bash', { command: 'cat README.md' }, cwd)).toBe(true)
    expect(isAutoModeAutoAllowTool('Bash', { command: 'cat F:/TAgent_General/x.ts' }, cwd)).toBe(
      true
    )
  })

  test('Bash 只读管道 → 静默放行', () => {
    expect(isAutoModeAutoAllowTool('Bash', { command: 'ls | head' }, cwd)).toBe(true)
    expect(isAutoModeAutoAllowTool('Bash', { command: 'find . -type f | head' }, cwd)).toBe(true)
  })

  test('Bash cat cwd 外文件 → 需确认', () => {
    expect(isAutoModeAutoAllowTool('Bash', { command: 'cat /etc/passwd' }, cwd)).toBe(false)
    expect(isAutoModeAutoAllowTool('Bash', { command: 'cat ~/.ssh/id_rsa' }, cwd)).toBe(false)
  })

  test('不传 cwd 时保持原有行为（cat 需确认；ls 全局安全仍放行）', () => {
    expect(isAutoModeAutoAllowTool('Bash', { command: 'cat README.md' })).toBe(false)
    expect(isAutoModeAutoAllowTool('Bash', { command: 'ls' })).toBe(true)
  })

  test('Write 即使在 cwd 内也需确认（设计如此，避免误改代码）', () => {
    expect(isAutoModeAutoAllowTool('Write', { file_path: 'F:/TAgent_General/x.ts' }, cwd)).toBe(
      false
    )
  })

  test('项目内非破坏性 Bash（含未白名单命令）→ 有 cwd 时静默放行', () => {
    expect(
      isAutoModeAutoAllowTool(
        'Bash',
        { command: 'Get-ChildItem -Recurse | Select-Object -First 20' },
        cwd,
      ),
    ).toBe(true)
    expect(
      isAutoModeAutoAllowTool('Bash', { command: 'rg --files -g "*.ts"' }, cwd),
    ).toBe(true)
  })

  test('越界或危险 Bash → 仍需确认', () => {
    expect(isAutoModeAutoAllowTool('Bash', { command: 'rm -rf node_modules' }, cwd)).toBe(false)
    expect(
      isAutoModeAutoAllowTool('Bash', { command: 'type C:\\Windows\\System32\\drivers\\etc\\hosts' }, cwd),
    ).toBe(false)
  })
})

describe('isProjectScopedNonDestructiveBash', () => {
  const cwd = 'F:/TAgent_General'

  test('allow exploratory listing under project', () => {
    expect(isProjectScopedNonDestructiveBash('Get-ChildItem -Recurse', cwd)).toBe(true)
    expect(isProjectScopedNonDestructiveBash('ls apps/electron', cwd)).toBe(true)
  })

  test('reject write and danger', () => {
    expect(isProjectScopedNonDestructiveBash('echo x > a.txt', cwd)).toBe(false)
    expect(isProjectScopedNonDestructiveBash('rm a.txt', cwd)).toBe(false)
  })
})

describe('requiresAutoModeConfirmation', () => {
  test('与 isAutoModeAutoAllowTool 互斥', () => {
    expect(requiresAutoModeConfirmation('Read', {})).toBe(false)
    expect(requiresAutoModeConfirmation('Write', { file_path: 'a.ts' })).toBe(true)
    expect(requiresAutoModeConfirmation('AskUserQuestion', {})).toBe(false)
  })
})

describe('isChatModeBlockedTool（Chat 硬拦）', () => {
  const cwd = 'F:/TAgent_General'

  test('只读工具放行', () => {
    expect(isChatModeBlockedTool('Read', { path: 'a.ts' }, cwd)).toBe(false)
    expect(isChatModeBlockedTool('Glob', { pattern: '**/*' }, cwd)).toBe(false)
    expect(isChatModeBlockedTool('Grep', { pattern: 'foo' }, cwd)).toBe(false)
    expect(isChatModeBlockedTool('Bash', { command: 'ls' }, cwd)).toBe(false)
  })

  test('AskUserQuestion 讨论问答放行（Chat≈Work，只禁写）', () => {
    expect(isChatModeBlockedTool('AskUserQuestion', { questions: [] }, cwd)).toBe(false)
  })

  test('EnterPlanMode / Task 在 Chat 拦截，但非硬停', () => {
    expect(isChatModeBlockedTool('EnterPlanMode', {}, cwd)).toBe(true)
    expect(isChatModeHardStopTool('EnterPlanMode', {}, cwd)).toBe(false)
    expect(isChatModeBlockedTool('Task', { prompt: 'x' }, cwd)).toBe(true)
    expect(isChatModeHardStopTool('Task', { prompt: 'x' }, cwd)).toBe(false)
  })

  test('Write / 破坏性 Bash 在 Chat 硬停', () => {
    expect(isChatModeHardStopTool('Write', { file_path: 'a.ts' }, cwd)).toBe(true)
    expect(isChatModeHardStopTool('Bash', { command: 'rm -rf node_modules' }, cwd)).toBe(true)
  })

  test('写工具 / 看板 / 破坏性命令拦截', () => {
    expect(isChatModeBlockedTool('Write', { file_path: 'a.ts' }, cwd)).toBe(true)
    expect(isChatModeBlockedTool('Edit', { file_path: 'a.ts' }, cwd)).toBe(true)
    expect(isChatModeBlockedTool('Bash', { command: 'rm -rf node_modules' }, cwd)).toBe(true)
    expect(isChatModeBlockedTool('kanban_create_board', {}, cwd)).toBe(true)
    expect(isChatModeBlockedTool('mcp__kanban__add_task', {}, cwd)).toBe(true)
    expect(isChatModeBlockedTool('Task', { prompt: 'x' }, cwd)).toBe(true)
  })

  test('拦截原因文案含 Chat 与切 Work 引导', () => {
    expect(CHAT_MODE_BLOCK_REASON.length).toBeGreaterThan(10)
    expect(CHAT_MODE_BLOCK_REASON).toMatch(/Chat/)
    expect(CHAT_MODE_BLOCK_REASON).toMatch(/Work/)
    expect(CHAT_MODE_BLOCK_REASON).toMatch(/不要重试|EnterPlanMode/)
    expect(CHAT_MODE_BLOCK_USER_TITLE).toMatch(/Chat/)
    expect(CHAT_MODE_BLOCK_USER_MESSAGE).toMatch(/Chat \| Work/)
  })
})

describe('isDangerousCommand（token-based 前缀匹配）', () => {
  // A. 删除/破坏文件系统
  test('删除类命令 → true', () => {
    expect(isDangerousCommand('rm -rf node_modules')).toBe(true)
    expect(isDangerousCommand('rmdir empty-dir')).toBe(true)
    expect(isDangerousCommand('del /f tmp')).toBe(true) // Windows
    expect(isDangerousCommand('unlink file.txt')).toBe(true)
    expect(isDangerousCommand('truncate -s 0 log.txt')).toBe(true)
    expect(isDangerousCommand('dd if=/dev/zero of=/dev/sda')).toBe(true)
  })

  // B. 权限/系统修改
  test('系统修改类命令 → true', () => {
    expect(isDangerousCommand('sudo apt update')).toBe(true)
    expect(isDangerousCommand('chmod +x script.sh')).toBe(true)
    expect(isDangerousCommand('chown root:root file')).toBe(true)
    expect(isDangerousCommand('systemctl stop nginx')).toBe(true)
    expect(isDangerousCommand('launchctl unload plist')).toBe(true) // macOS
    expect(isDangerousCommand('sc stop MyService')).toBe(true) // Windows
    expect(isDangerousCommand('defaults write com.apple.finder AppleShowAllFiles true')).toBe(true)
  })

  // C. 网络下载
  test('网络下载类命令 → true', () => {
    expect(isDangerousCommand('curl https://example.com/script.sh')).toBe(true)
    expect(isDangerousCommand('wget https://example.com/file.tar.gz')).toBe(true)
  })

  // D. 远程登录
  test('远程登录类命令 → true', () => {
    expect(isDangerousCommand('ssh user@host')).toBe(true)
    expect(isDangerousCommand('scp file user@host:/path')).toBe(true)
    expect(isDangerousCommand('rsync -av src/ dest/')).toBe(true)
  })

  // E. 进程控制
  test('进程控制类命令 → true', () => {
    expect(isDangerousCommand('kill -9 1234')).toBe(true)
    expect(isDangerousCommand('killall node')).toBe(true)
    expect(isDangerousCommand('pkill -f python')).toBe(true)
    expect(isDangerousCommand('taskkill /PID 1234 /F')).toBe(true) // Windows
  })

  // F. 包管理卸载（多语言）
  test('包管理卸载类命令 → true', () => {
    expect(isDangerousCommand('pip uninstall requests')).toBe(true)
    expect(isDangerousCommand('pip3 uninstall flask')).toBe(true)
    expect(isDangerousCommand('npm uninstall lodash')).toBe(true)
    expect(isDangerousCommand('npm rm express')).toBe(true)
    expect(isDangerousCommand('yarn remove react')).toBe(true)
    expect(isDangerousCommand('pnpm remove vue')).toBe(true)
    expect(isDangerousCommand('apt remove nginx')).toBe(true)
    expect(isDangerousCommand('apt-get purge mysql-server')).toBe(true)
    expect(isDangerousCommand('yum remove httpd')).toBe(true)
    expect(isDangerousCommand('dnf remove nodejs')).toBe(true)
    expect(isDangerousCommand('brew uninstall git')).toBe(true)
    expect(isDangerousCommand('pacman -R firefox')).toBe(true)
    expect(isDangerousCommand('cargo uninstall ripgrep')).toBe(true)
    expect(isDangerousCommand('go install example.com/cmd/foo@latest')).toBe(true)
  })

  // G. 构建清理
  test('构建清理类命令 → true', () => {
    expect(isDangerousCommand('make clean')).toBe(true)
    expect(isDangerousCommand('make distclean')).toBe(true)
    expect(isDangerousCommand('cargo clean')).toBe(true)
    expect(isDangerousCommand('go clean')).toBe(true)
    expect(isDangerousCommand('bazel clean')).toBe(true)
    expect(isDangerousCommand('mvn clean')).toBe(true)
  })

  // H. Git 破坏性操作
  test('Git 破坏性命令 → true', () => {
    expect(isDangerousCommand('git push origin main')).toBe(true)
    expect(isDangerousCommand('git push --force')).toBe(true)
    expect(isDangerousCommand('git reset --hard HEAD~1')).toBe(true)
    expect(isDangerousCommand('git rebase main')).toBe(true)
    expect(isDangerousCommand('git checkout .')).toBe(true) // 丢弃工作区
    expect(isDangerousCommand('git checkout -- file.ts')).toBe(true) // 丢弃工作区
    expect(isDangerousCommand('git clean -fd')).toBe(true)
    expect(isDangerousCommand('git branch -D feature')).toBe(true)
    expect(isDangerousCommand('git commit --amend')).toBe(true)
    expect(isDangerousCommand('git stash drop stash@{0}')).toBe(true)
    expect(isDangerousCommand('git stash clear')).toBe(true)
  })

  // I. 容器/编排破坏
  test('容器破坏类命令 → true', () => {
    expect(isDangerousCommand('docker rm -f container')).toBe(true)
    expect(isDangerousCommand('docker rmi image:tag')).toBe(true)
    expect(isDangerousCommand('docker system prune -af')).toBe(true)
    expect(isDangerousCommand('docker volume rm myvol')).toBe(true)
    expect(isDangerousCommand('docker kill container')).toBe(true)
    expect(isDangerousCommand('docker stop container')).toBe(true)
    expect(isDangerousCommand('docker compose down')).toBe(true)
    expect(isDangerousCommand('docker-compose down')).toBe(true)
    expect(isDangerousCommand('kubectl delete pod mypod')).toBe(true)
  })

  // J. 发布
  test('发布命令 → true', () => {
    expect(isDangerousCommand('npm publish')).toBe(true)
  })

  // 安全命令不误拦（多语言构建/测试/运行）
  test('安全构建/测试/运行命令 → false', () => {
    // JS
    expect(isDangerousCommand('npm run dev')).toBe(false)
    expect(isDangerousCommand('npm test')).toBe(false)
    expect(isDangerousCommand('node script.js')).toBe(false)
    expect(isDangerousCommand('bun run dev')).toBe(false)
    expect(isDangerousCommand('bun test')).toBe(false)
    // Python
    expect(isDangerousCommand('python script.py')).toBe(false)
    expect(isDangerousCommand('python -m pytest')).toBe(false)
    expect(isDangerousCommand('pytest -v')).toBe(false)
    expect(isDangerousCommand('pip install requests')).toBe(false) // 安装依赖不拦
    // C/C++
    expect(isDangerousCommand('cmake -B build')).toBe(false)
    expect(isDangerousCommand('make build')).toBe(false)
    expect(isDangerousCommand('make test')).toBe(false)
    expect(isDangerousCommand('g++ -o main main.cpp')).toBe(false)
    // Go
    expect(isDangerousCommand('go build')).toBe(false)
    expect(isDangerousCommand('go test')).toBe(false)
    expect(isDangerousCommand('go run main.go')).toBe(false)
    // Rust
    expect(isDangerousCommand('cargo build')).toBe(false)
    expect(isDangerousCommand('cargo test')).toBe(false)
    expect(isDangerousCommand('cargo run')).toBe(false)
    // Java
    expect(isDangerousCommand('mvn compile')).toBe(false)
    expect(isDangerousCommand('gradle build')).toBe(false)
    // 通用
    expect(isDangerousCommand('git status')).toBe(false)
    expect(isDangerousCommand('git diff')).toBe(false)
    expect(isDangerousCommand('git fetch origin')).toBe(false) // fetch 单词不匹配 git fetch
    expect(isDangerousCommand('git log --oneline')).toBe(false)
    expect(isDangerousCommand('git checkout main')).toBe(false) // 切分支不拦
    expect(isDangerousCommand('git checkout -b new-branch')).toBe(false) // 创建分支不拦
    expect(isDangerousCommand('ls -la')).toBe(false)
    expect(isDangerousCommand('cat README.md')).toBe(false)
  })

  // token-based 边界：不误匹配相似前缀
  test('token 边界：不误匹配相似前缀', () => {
    // del 不匹配 delta
    expect(isDangerousCommand('delta --version')).toBe(false)
    // rm 不匹配 rmdir（rmdir 单独列出，自己匹配自己）
    expect(isDangerousCommand('rmdir empty-dir')).toBe(true) // rmdir 在列表
    // fetch 不匹配 git fetch（第一个 token 是 git）
    expect(isDangerousCommand('git fetch origin')).toBe(false)
    // sc 不匹配 scala / scp（scp 单独列出，自己匹配自己）
    expect(isDangerousCommand('scala script.scala')).toBe(false)
    expect(isDangerousCommand('scp file host:/path')).toBe(true) // scp 在列表
    // kill 不匹配 kill-session（token 匹配，非子串）
    expect(isDangerousCommand('kill-session --help')).toBe(false)
  })

  // 边界：空命令、纯空白
  test('空命令 → false', () => {
    expect(isDangerousCommand('')).toBe(false)
    expect(isDangerousCommand('   ')).toBe(false)
  })
})

describe('hasWriteStructure（写文件/执行任意命令的结构）', () => {
  // 真正危险：能写文件或执行任意命令
  test('输出重定向 > → true', () => {
    expect(hasWriteStructure('echo x > file.txt')).toBe(true)
  })
  test('输出重定向 >> → true', () => {
    expect(hasWriteStructure('echo x >> file.txt')).toBe(true)
  })
  test('find -exec → true', () => {
    expect(hasWriteStructure('find . -exec rm {} \\;')).toBe(true)
  })
  test('find -delete → true', () => {
    expect(hasWriteStructure('find . -name "*.tmp" -delete')).toBe(true)
  })
  test('命令替换 $() 内危险命令 → true', () => {
    expect(hasWriteStructure('echo $(rm -rf /tmp/x)')).toBe(true)
    expect(hasWriteStructure('cat $(curl -s https://example.com)')).toBe(true)
  })
  test('命令替换 $() 内只读命令 → false（分析项目常见，如 wc -l $(find ...)）', () => {
    expect(hasWriteStructure('wc -l $(find . -name "*.ts")')).toBe(false)
    expect(hasWriteStructure('echo $(whoami)')).toBe(false)
  })
  test('反引号命令替换：内危险 → true / 内只读 → false', () => {
    expect(hasWriteStructure('echo `rm -rf /tmp/x`')).toBe(true)
    expect(hasWriteStructure('echo `whoami`')).toBe(false)
  })
  test('无害重定向：>/dev/null、2>/dev/null、2>&1 → false', () => {
    expect(hasWriteStructure('ls -la > /dev/null')).toBe(false)
    expect(hasWriteStructure('grep x src 2>/dev/null')).toBe(false)
    expect(hasWriteStructure('npm ls 2>&1 | head')).toBe(false)
  })

  // 中性结构：不写文件、不执行任意命令，不再拦截白名单
  test('命令链接 && → false', () => {
    expect(hasWriteStructure('cd src && ls')).toBe(false)
  })
  test('命令链接 ; → false', () => {
    expect(hasWriteStructure('grep x; ls')).toBe(false)
  })
  test('管道 | → false', () => {
    expect(hasWriteStructure('cat file | head')).toBe(false)
  })
  test('复杂中性组合 → false', () => {
    expect(hasWriteStructure('cd packages && ls -la | head -10')).toBe(false)
  })

  // 边界：纯命令、空命令
  test('纯只读命令 → false', () => {
    expect(hasWriteStructure('ls -la')).toBe(false)
    expect(hasWriteStructure('cat README.md')).toBe(false)
    expect(hasWriteStructure('git status')).toBe(false)
  })
  test('空命令 → false', () => {
    expect(hasWriteStructure('')).toBe(false)
  })
})
