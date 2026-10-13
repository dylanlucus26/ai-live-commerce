import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('dashboard never subscribes to a freshly allocated Zustand fallback', () => {
  const source = readFileSync(new URL('../src/pages/LiveWorkbench/index.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /useCommerceMetrics\(\s*\w+\s*=>\s*\w+\.accounts\[[^\]]+\]\s*\?\?\s*\[\s*\]/)
  assert.match(source, /const EMPTY_METRICS:\s*CommerceMetric\[\]\s*=\s*\[\]/)
  assert.match(source, /const metricAccounts = useCommerceMetrics\(s => s\.accounts\)/)
})

test('built macOS package must be explicitly signed and checked', () => {
  const builder = JSON.parse(readFileSync(new URL('../electron-builder.json', import.meta.url), 'utf8'))
  assert.equal(builder.mac.identity, null)
  assert.equal(builder.afterPack, 'scripts/adhoc-sign-after-pack.cjs')
  assert.ok(builder.mac.entitlements)
  const actions = readFileSync(new URL('../.github/workflows/build.yml', import.meta.url), 'utf8')
  assert.match(actions, /verify-macos-signatures\.sh/)
  assert.match(actions, /test:smoke/)
})
