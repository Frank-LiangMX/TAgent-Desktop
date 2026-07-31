/**
 * Smoke-check dist/main.cjs: Pi ESM packages must be bundled, not required.
 * Exit 1 if require('@earendil-works/...') or require('@tagent/pi-core') remains.
 */
const fs = require('fs')
const path = require('path')

const mainPath = path.join(__dirname, '..', 'dist', 'main.cjs')
if (!fs.existsSync(mainPath)) {
  console.error('missing dist/main.cjs — run build:main first')
  process.exit(1)
}

const s = fs.readFileSync(mainPath, 'utf8')
const reqs = [...s.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((m) => m[2])
const banned = [...new Set(reqs)].filter(
  (x) =>
    x === '@tagent/pi-core' ||
    x.startsWith('@tagent/pi-core/') ||
    x.startsWith('@earendil-works/'),
)
const allowed = [...new Set(reqs)].filter(
  (x) => x === 'electron' || x === 'better-sqlite3' || x === 'node-pty' || x.startsWith('@anthropic-ai/'),
)

console.log('allowed-ish requires:', allowed.sort().join(', ') || '(none)')
if (banned.length) {
  console.error('FAIL: ESM-only packages still required at runtime:', banned.join(', '))
  process.exit(1)
}
console.log('OK: no runtime require of pi-ai / pi-agent-core / pi-core')
