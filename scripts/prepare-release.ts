/**
 * 发版准备脚本（发版流程自动化）
 *
 * 用法：bun run scripts/prepare-release.ts <版本号>
 * 例：bun run scripts/prepare-release.ts 2.0.0-beta.1
 *
 * 做的事：
 * 1. 校验版本号格式（语义化）
 * 2. 跑 typecheck（必须过）
 * 3. 跑 test（必须过）
 * 4. 检查工作区干净
 * 5. 检查 release-notes/vX.Y.Z.md 是否已有真实内容（不是空模板）
 * 6. 更新 apps/electron/package.json version
 * 7. 生成 release-notes/vX.Y.Z.md 模板（如不存在）
 * 8. 校验 version 与 release-notes 文件名一致
 * 9. 提示后续手动步骤（写 CHANGELOG / commit / tag / push）
 *
 * 见 docs/RELEASE_PROCESS.md
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')

const version = process.argv[2]
if (!version) {
  console.error('用法：bun run scripts/prepare-release.ts <版本号>  例：2.0.0-beta.1')
  process.exit(1)
}

// 1. 校验版本号
const semverRegex = /^v?\d+\.\d+\.\d+(-[a-z0-9.]+)?$/i
if (!semverRegex.test(version)) {
  console.error(`版本号格式错误：${version}（应为语义化，如 2.0.0 / 2.0.0-beta.1）`)
  process.exit(1)
}
const ver = version.replace(/^v/, '')
const tag = `v${ver}`

console.log(`\n=== 准备发版 ${tag} ===\n`)

// 2. 检查工作区干净
const status = execSync('git status --short', { cwd: root, encoding: 'utf8' }).trim()
if (status) {
  console.error('工作区不干净，先提交或暂存：')
  console.error(status)
  process.exit(1)
}

// 3. typecheck
console.log('跑 typecheck...')
try {
  execSync('bun run typecheck', { cwd: root, encoding: 'utf8', stdio: 'inherit' })
} catch {
  console.error('typecheck 失败，不发版')
  process.exit(1)
}

// 4. test
console.log('跑 test...')
try {
  execSync('bun run test', { cwd: root, encoding: 'utf8', stdio: 'inherit' })
} catch {
  console.error('test 失败，不发版')
  process.exit(1)
}

// 5. 更新 package.json version
const pkgPath = path.join(root, 'apps/electron/package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))

// 8. 校验 version 与已有 release-notes 文件名一致
const rnDir = path.join(root, 'release-notes')
const rnPath = path.join(rnDir, `${tag}.md`)
const rnExists = existsSync(rnPath)

if (rnExists) {
  // 5. 检查已有 release notes 是否有真实内容
  const rnContent = readFileSync(rnPath, 'utf8')
  const rnLines = rnContent.split('\n').filter((l) => l.trim().length > 0)
  const rnChars = rnContent.trim().length

  if (rnLines.length < 5) {
    console.error(`release-notes/${tag}.md 内容太少（${rnLines.length} 行），请填充后再发版`)
    process.exit(1)
  }

  if (rnChars < 100) {
    console.error(`release-notes/${tag}.md 内容太少（${rnChars} 字节），请填充后再发版`)
    process.exit(1)
  }

  // 检查是否还是未填写的模板（包含空 bullet point 且行数少）
  const hasEmptyBullets = rnContent.includes('-\n') || rnContent.includes('- \n')
  if (hasEmptyBullets && rnLines.length < 10) {
    console.error(`release-notes/${tag}.md 看起来是未填写的模板（有空 bullet point），请填充后再发版`)
    process.exit(1)
  }

  console.log(`release-notes/${tag}.md 已有内容（${rnLines.length} 行，${rnChars} 字节）`)
} else {
  // 7. 生成 release-notes 模板
  const template = `# TAgent ${tag} 更新

## 新功能
-

## Bug 修复
-

## 其他优化
-

## 下载
- **Windows** — TAgent-${ver}-x64.exe
- **macOS Apple Silicon** — TAgent-${ver}-arm64.dmg
- **macOS Intel** — TAgent-${ver}-x64.dmg
- **Linux** — TAgent-${ver}-x86_64.AppImage
`
  writeFileSync(rnPath, template, 'utf8')
  console.log(`已生成 release-notes/${tag}.md 模板（请填充内容）`)
  console.error(`\n⚠️  请先填充 release-notes/${tag}.md 的内容，再继续发版！`)
  console.error(`   填好后重新运行: bun run scripts/prepare-release.ts ${ver}\n`)
  process.exit(0)
}

// 6. 更新 version
if (pkg.version !== ver) {
  pkg.version = ver
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  console.log(`已更新 apps/electron/package.json version → ${ver}`)
} else {
  console.log(`apps/electron/package.json version 已是 ${ver}`)
}

// CI 直接读取版本化 release note，不生成容易过期的根目录副本。
const branch = execSync('git branch --show-current', { cwd: root, encoding: 'utf8' }).trim() || 'main'

// 9. 提示后续
console.log(`\n=== ✅ 所有前置检查通过 ===`)
console.log(`\n=== 接下来手动做 ===`)
console.log(`1. 最后确认 release-notes/${tag}.md 内容（已验证非空）`)
console.log(`2. 在 CHANGELOG.md 顶部追加 [${ver}] 段`)
console.log(`3. git add -A && git commit -m "release: ${tag}"`)
console.log(`4. git tag ${tag}`)
console.log(`5. git push origin ${branch} --tags  → 触发 CI 三端构建发版`)
console.log(`\n预发布版本（含 -）会自动标 GitHub prerelease。`)
console.log(`CI 会校验三平台产物完整性和 release notes 内容，不完整会自动阻止发版。`)
