import test from 'node:test'
import assert from 'node:assert/strict'
import { codexPanelWarnings } from '../lib/codex-projects/warnings.mjs'

test('nested source limitations are aggregated with real reasons instead of failed targets', () => {
  const result = codexPanelWarnings({ warnings: [
    { sourceId: 'a', warnings: [{ code: 'emptyReasoning', count: 5 }, { code: 'activityRecords', count: 2 }] },
    { sourceId: 'b', warnings: [{ code: 'emptyReasoning', count: 3 }] },
  ] }, '/synthetic/codex')
  assert.equal(result.length, 2)
  assert.ok(result.every((warning) => warning.severity === 'info'))
  assert.equal(result[0].count, 8)
  assert.equal(result[0].sessions, 2)
  assert.match(result[0].error, /没有可恢复正文/)
  assert.ok(!JSON.stringify(result).includes('Codex project scan warning'))
})

test('real scan exceptions remain errors and missing-body diagnostics are not duplicated', () => {
  const result = codexPanelWarnings({ warnings: [{ code: 'state-database-unreadable', message: 'Synthetic read failure' },
    { sourceId: 'a', warnings: [{ code: 'session-body-unavailable', count: 1 }] }], missing: [{ id: 'a' }] }, '/synthetic/codex')
  assert.equal(result.length, 2)
  assert.equal(result[0].severity, 'error')
  assert.equal(result[0].error, 'Synthetic read failure')
  assert.equal(result[1].severity, 'info')
})
