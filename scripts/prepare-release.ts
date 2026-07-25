/**
 * 发版准备脚本（发版流程自动化）
 *
 * 用法：bun run scripts/prepare-release.ts <版本号>
 * 例：bun run scripts/prepare-release.ts 2.0.0-beta.1
 *
 * 做的事：
 * 1. 校验版本号格式（语义化）
 * 2. 跑 typecheck（必须过）
 * 3. 检查工作区干净
 * 4. 更新 apps/electron/package.json version
 * 5. 生成 release-notes/vX.Y.Z.md 模板（如不存在）
 * 6. 拷贝该版本 release note 到根 RELEASE_NOTES.md（CI 用）
 * 7. 提示后续手动步骤（写 CHANGELOG / commit / tag / push）
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

// 4. 更新 package.json version
const pkgPath = path.join(root, 'apps/electron/package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
pkg.version = ver
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
console.log(`已更新 apps/electron/package.json version → ${ver}`)

// 5. 生成 release-notes 模板
const rnDir = path.join(root, 'release-notes')
const rnPath = path.join(rnDir, `${tag}.md`)
if (!existsSync(rnPath)) {
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
- **Linux** — TAgent-${ver}-amd64.AppImage
`
  writeFileSync(rnPath, template, 'utf8')
  console.log(`已生成 release-notes/${tag}.md 模板（请填充内容）`)
} else {
  console.log(`release-notes/${tag}.md 已存在，保留`)
}

// 6. 同步 RELEASE_NOTES.md（CI 用）
const rnContent = readFileSync(rnPath, 'utf8')
writeFileSync(path.join(root, 'RELEASE_NOTES.md'), rnContent, 'utf8')
console.log('已同步根 RELEASE_NOTES.md（CI 发版用）')

// 7. 提示后续
console.log(`\n=== 接下来手动做 ===`)
console.log(`1. 填充 release-notes/${tag}.md 的内容`)
console.log(`2. 在 CHANGELOG.md 顶部追加 [${ver}] 段`)
console.log(`3. git add -A && git commit -m "release: ${tag}"`)
console.log(`4. git tag ${tag}`)
console.log(`5. git push origin main --tags  → 触发 CI 三端构建发版`)
console.log(`\n预发布版本（含 -）会自动标 GitHub prerelease。`)
