// interchange.test.mjs — 降级规则与导出降级清单单测（纯函数）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEGRADATION_RULES,
  summarizeDegradations,
  exportDegradations,
} from '../lib/convert/index.mjs'

test('summarizeDegradations: 只列 count > 0 的降级项，kind/策略映射正确', () => {
  const out = summarizeDegradations({ toolResultFallback: 3, attachmentSkipped: 1, branchCollapsed: 0 })
  assert.deepEqual(out.map((d) => d.id), ['tool-result-missing', 'attachment-skipped'])
  assert.equal(out[0].strategy, 'skip-placeholder')
  assert.equal(out[0].count, 3)
  assert.equal(out[1].count, 1)
  assert.deepEqual(summarizeDegradations({}), [])
})

test('DEGRADATION_RULES: 规则 id 唯一、kind 唯一、策略三态合法', () => {
  const ids = new Set()
  const kinds = new Set()
  for (const rule of DEGRADATION_RULES) {
    assert.ok(!ids.has(rule.id), '重复 id ' + rule.id)
    ids.add(rule.id)
    assert.ok(!kinds.has(rule.kind), '重复 kind ' + rule.kind)
    kinds.add(rule.kind)
    assert.ok(['lossless', 'text-fallback', 'skip-placeholder'].includes(rule.strategy), rule.id)
  }
})

test('exportDegradations: 序列化器计数 → 结构化降级清单（导出结果字段）', () => {
  const out = exportDegradations({ droppedToolResults: 2, skippedInjections: 1, skippedBlocks: 0 })
  assert.deepEqual(out.map((d) => d.id), ['injection-skipped', 'orphan-tool-result'])
  assert.equal(out[1].strategy, 'skip-placeholder')
  assert.equal(out[1].count, 2)
  // 全零 → undefined（不占结果键）
  assert.equal(exportDegradations({ droppedToolResults: 0, skippedInjections: 0, skippedBlocks: 0 }), undefined)
  assert.equal(exportDegradations({}), undefined)
})