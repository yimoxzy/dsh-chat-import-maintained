// test/all-import-render.test.mjs — /import-all 的结果文案（lib/command.mjs 的 formatAllImport）
//
// 纯函数，直接喂 runChatImportAll 的结果对象：计数取舍、扫描失败的来源点名、逐条失败明细
// 的封顶与省略行、以及「什么都没扫到」返回 error 而不是读起来像处理完了。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatAllImport } from '../lib/command.mjs'

function summary(over = {}) {
  return { mode: 'batch', scanned: 0, imported: 0, appended: 0, skipped: 0, failed: 0, errors: [], results: [], warnings: [], ...over }
}

test('formatAllImport：只列非零计数，一条一行结论', () => {
  const out = formatAllImport(summary({ scanned: 3, imported: 1, appended: 2 }))
  assert.equal(out.kind, 'success')
  assert.equal(out.text, '/import-all 完成：扫描 3 个会话，新增 1，续写 2')
})

test('formatAllImport：跳过与失败各自成词，顺序固定', () => {
  const out = formatAllImport(summary({ scanned: 5, imported: 1, appended: 1, skipped: 2, failed: 1 }))
  assert.ok(out.text.startsWith('/import-all 完成：扫描 5 个会话，新增 1，续写 1，跳过 2，失败 1'), out.text)
})

test('formatAllImport：扫描失败的来源点名（此前命令面静默丢掉）', () => {
  const out = formatAllImport(summary({
    scanned: 1,
    imported: 1,
    warnings: [
      { format: 'trae', target: 'D:\\demo\\Trae', error: 'file is not a database' },
      { format: 'hermes', target: 'D:\\demo\\.hermes', error: 'EACCES' },
    ],
  }))
  assert.ok(out.text.includes('! trae 扫描失败（D:\\demo\\Trae）：file is not a database'), out.text)
  assert.ok(out.text.includes('! hermes 扫描失败（D:\\demo\\.hermes）：EACCES'), out.text)
})

test('formatAllImport：逐条失败明细最多 5 条，其余折成省略行', () => {
  const errors = Array.from({ length: 8 }, (_, i) => ({ sourcePath: 'p' + i, error: 'e' + i }))
  const out = formatAllImport(summary({ scanned: 8, failed: 8, errors }))
  assert.ok(out.text.includes('  - p0：e0'), out.text)
  assert.ok(out.text.includes('  - p4：e4'), out.text)
  assert.ok(!out.text.includes('  - p5：e5'), out.text)
  assert.ok(out.text.includes('… 另有 3 条失败明细未列出'), out.text)
})

test('formatAllImport：一条也没扫到时返回 error，不装作处理完了', () => {
  const out = formatAllImport(summary())
  assert.equal(out.kind, 'error')
  assert.equal(out.text, '/import-all 完成：扫描 0 个会话')
})

test('formatAllImport：有扫描失败但零计数时仍是 error（失败要看得见）', () => {
  const out = formatAllImport(summary({ warnings: [{ format: 'trae', target: 'x', error: 'boom' }] }))
  assert.equal(out.kind, 'error')
  assert.ok(out.text.includes('! trae 扫描失败'), out.text)
})

test('formatAllImport：warnings / errors 缺省不炸（服务面结果字段可省）', () => {
  const out = formatAllImport({ scanned: 1, imported: 1 })
  assert.equal(out.kind, 'success')
  assert.equal(out.text, '/import-all 完成：扫描 1 个会话，新增 1')
})
