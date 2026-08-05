/**
 * Smoke-check dist/main.cjs:
 * - Pi ESM packages must be bundled, not required.
 * - 对外版（TAGENT_EXTERNAL=1 构建后）：不得再 require claude-agent-sdk。
 * Exit 1 on failure.
 *
 * 用法：
 *   node scripts/verify-main-bundle.cjs
 *   TAGENT_EXTERNAL=1 node scripts/verify-main-bundle.cjs   # 对外包校验
 */
const fs = require('fs')
const path = require('path')

const mainPath = path.join(__dirname, '..', 'dist', 'main.cjs')
if (!fs.existsSync(mainPath)) {
  console.error('missing dist/main.cjs — run build:main first')
  process.exit(1)
}

const expectExternal =
  process.env.TAGENT_EXTERNAL === '1' || process.env.TAGENT_EXTERNAL === 'true'

const s = fs.readFileSync(mainPath, 'utf8')
const reqs = [...s.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((m) => m[2])
const uniqueReqs = [...new Set(reqs)]

const banned = uniqueReqs.filter(
  (x) =>
    x === '@tagent/pi-core' ||
    x.startsWith('@tagent/pi-core/') ||
    x.startsWith('@earendil-works/'),
)

const claudeSdkReqs = uniqueReqs.filter(
  (x) => x === '@anthropic-ai/claude-agent-sdk' || x.startsWith('@anthropic-ai/claude-agent-sdk/'),
)

const allowed = uniqueReqs.filter(
  (x) =>
    x === 'electron' ||
    x === 'better-sqlite3' ||
    x === 'node-pty' ||
    x.startsWith('@anthropic-ai/'),
)

console.log('mode:', expectExternal ? 'external (Pi-only)' : 'dual-core / default')
console.log('allowed-ish requires:', allowed.sort().join(', ') || '(none)')

if (banned.length) {
  console.error('FAIL: ESM-only packages still required at runtime:', banned.join(', '))
  process.exit(1)
}

const dynamicSdkImport = /import\(["']@anthropic-ai\/claude-agent-sdk["']\)/.test(s)
const hasStub =
  s.includes('kscc-external-stub') ||
  s.includes('EXTERNAL_MSG') ||
  // esbuild 常把中文编成 \uXXXX
  s.includes('\\u5BF9\\u5916\\u53D1\\u884C\\u7248') ||
  s.includes('对外发行版')

if (expectExternal) {
  if (claudeSdkReqs.length || dynamicSdkImport) {
    console.error(
      'FAIL: external build must not load claude-agent-sdk at runtime:',
      claudeSdkReqs.join(', ') || '(dynamic import remains)',
    )
    process.exit(1)
  }
  if (s.includes('claude-agent-adapter.ts') || s.includes('[kscc adapter]')) {
    console.error('FAIL: external build still contains real kscc adapter sources')
    process.exit(1)
  }
  if (!hasStub) {
    console.error('FAIL: external stub not found in main.cjs — set TAGENT_EXTERNAL=1 for build:main')
    process.exit(1)
  }
  console.log('OK: external stub present; no claude-agent-sdk import/require')
} else {
  console.log('OK: no runtime require of pi-ai / pi-agent-core / pi-core')
  if (dynamicSdkImport) {
    console.log('note: dual-core keeps dynamic import("@anthropic-ai/claude-agent-sdk") (packaged via node_modules)')
  }
}
