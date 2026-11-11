import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.mjs'
import { runChatImportAll } from '../lib/chat-import-service.mjs'
import { makeCtx } from './_support/fake-host.mjs'
import { freshDshHome } from './_support/tmp-db.mjs'
import { hostAbs } from './_support/host-path.mjs'

beforeEach(() => {
  process.env.DSH_HOME = freshDshHome('dsh-home-')
})

test('chatImport service delegates to the import_chat pipeline and returns its result', async () => {
  const path = 'D:\\demo\\proj\\service-session.jsonl'
  const raw = [
    JSON.stringify({ sessionId: 'service-session', type: 'user', cwd: hostAbs('D:/demo/proj'), message: { role: 'user', content: '你好' } }),
    JSON.stringify({ sessionId: 'service-session', type: 'assistant', message: { role: 'assistant', content: '你好！' } }),
  ].join('\n') + '\n'
  const env = makeCtx({ [path]: raw })
  let provided
  env.ctx.provide = (name, service) => {
    if (name === 'chatImport') provided = service
  }

  apply(env.ctx)

  assert.equal(typeof provided?.importPath, 'function')
  const result = await provided.importPath({ format: 'claude', path })
  assert.equal(result.status, 'imported')
  assert.equal(result.mode, 'single')
  assert.equal(result.sessionId, 'import-service-session')
  assert.equal(env.persistence.sessions.size, 1)
})

test('chatImport service validates the public input', async () => {
  const env = makeCtx()
  let provided
  env.ctx.provide = (name, service) => {
    if (name === 'chatImport') provided = service
  }
  apply(env.ctx)

  await assert.rejects(() => provided.importPath({ format: 'claude' }), /path is required/)
  await assert.rejects(() => provided.importPath({ format: 'unknown', path: 'x' }), /未知格式/)
})

test('chatImport service exposes discovery and handoff summaries', async () => {
  const path = 'D:\\demo\\proj\\service-session.jsonl'
  const raw = [
    JSON.stringify({ sessionId: 'service-session', type: 'user', cwd: hostAbs('D:/demo/proj'), message: { role: 'user', content: '继续修复登录' } }),
    JSON.stringify({ sessionId: 'service-session', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '我会继续检查。' }] } }),
  ].join('\n') + '\n'
  const env = makeCtx({ [path]: raw })
  let provided
  env.ctx.provide = (name, service) => {
    if (name === 'chatImport') provided = service
  }

  apply(env.ctx)

  assert.equal(typeof provided?.scanDiscover, 'function')
  assert.equal(typeof provided?.resumeSummary, 'function')
  const found = await provided.scanDiscover({ format: 'claude', path })
  assert.equal(found.total, 1)
  assert.equal(found.sessions[0].sessionId, 'service-session')
  const handoff = await provided.resumeSummary({ format: 'claude', path, sessionId: 'service-session' })
  assert.match(handoff.summary, /继续修复登录/)
  assert.equal(handoff.lastUserPrompt, '继续修复登录')
})

test('chatImport service imports all discovered sessions with structured results', async () => {
  const path = 'D:\\demo\\proj\\batch-session.jsonl'
  const raw = [
    JSON.stringify({ sessionId: 'batch-session', type: 'user', cwd: hostAbs('D:/demo/proj'), message: { role: 'user', content: '批量导入我' } }),
    JSON.stringify({ sessionId: 'batch-session', type: 'assistant', message: { role: 'assistant', content: '已导入' } }),
  ].join('\n') + '\n'
  const env = makeCtx({ [path]: raw })
  let provided
  env.ctx.provide = (name, service) => {
    if (name === 'chatImport') provided = service
  }

  apply(env.ctx)

  const result = await provided.importAll({ format: 'claude', path })
  assert.equal(result.mode, 'batch')
  assert.equal(result.scanned, 1)
  assert.equal(result.imported, 1)
  assert.equal(result.failed, 0)
  assert.equal(result.results[0].result.sessionId, 'import-batch-session')
})

// 命令面（/import-all）与服务面（chatImport.importAll）必须落在同一个批量编排上：同一次运行里
// 直接调 runChatImportAll 与服务方法，聚合结果逐字段相同——编排被内联回命令或服务任一处，
// 两份副本的计数 / warnings / errors 迟早分叉（D21：同口径逻辑只留一份）。
test('批量编排只有一份：服务 importAll 与 runChatImportAll 同口径', async () => {
  const path = 'D:\\demo\\proj\\shared-batch.jsonl'
  const raw = [
    JSON.stringify({ sessionId: 'shared-batch', type: 'user', cwd: hostAbs('D:/demo/proj'), message: { role: 'user', content: '同一份编排' } }),
    JSON.stringify({ sessionId: 'shared-batch', type: 'assistant', message: { role: 'assistant', content: '好的' } }),
  ].join('\n') + '\n'
  const env = makeCtx({ [path]: raw })
  const registryDir = freshDshHome('dsh-home-')
  let provided
  env.ctx.provide = (name, service) => {
    if (name === 'chatImport') provided = service
  }
  apply(env.ctx)

  const direct = await runChatImportAll(env.ctx, registryDir, { format: 'claude', path })
  const viaService = await provided.importAll({ format: 'claude', path })
  // 两条入口都落在同一份编排上：同一目标、同一发现口径（scanned / warnings 相等），
  // 第二次走到已导入的幂等分支（状态不同是 idempotency，不是两份实现的漂移）。
  assert.equal(direct.mode, 'batch')
  assert.equal(direct.mode, viaService.mode)
  assert.equal(direct.scanned, 1)
  assert.equal(direct.scanned, viaService.scanned)
  assert.deepEqual(direct.warnings, viaService.warnings)
  assert.equal(direct.results.length, viaService.results.length)
  assert.equal(direct.results[0].sourcePath, viaService.results[0].sourcePath)
  assert.equal(direct.results[0].sourceSessionId, viaService.results[0].sourceSessionId)
  assert.notEqual(direct.results[0].status, viaService.results[0].status, '第二次应走幂等分支')
  assert.equal(direct.failed, 0)
  assert.equal(viaService.failed, 0)
  assert.equal(env.persistence.sessions.size, 1, '两次批量导入只落一个会话（幂等）')
})

test('chatImport service rejects non-object batch input', async () => {
  const env = makeCtx()
  let provided
  env.ctx.provide = (name, service) => {
    if (name === 'chatImport') provided = service
  }
  apply(env.ctx)
  await assert.rejects(() => provided.importAll([]), /input must be an object/)
  await assert.rejects(() => provided.scanDiscover('claude'), /input must be an object/)
  await assert.rejects(() => provided.resumeSummary({ format: 'codex' }), /path is required/)
})
