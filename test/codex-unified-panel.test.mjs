import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createCodexPanelBridge, buildCodexPanelRows, codexProjectPath, parseCodexProjectPath } from '../lib/codex-projects/panel-bridge.mjs'
import { scanCodexProjects } from '../lib/codex-projects/source.mjs'
import { registerPanelRoutes } from '../lib/panel.mjs'
import { makeCtx } from './_support/fake-host.mjs'

function previewFixture(home) {
  return { scan: { codexHome: home, projects: [{ id: 'p', name: 'Project' }], sessions: [
    { id: 'a', title: 'Exact source title', cwd: home, projectId: 'p', projectName: 'Project', hasBody: true },
    { id: 'b', title: 'Updated source', cwd: home, projectId: 'p', projectName: 'Project', hasBody: true },
  ] }, results: [{ sourceId: 'a', migrationAction: 'adoptable', existingSessionId: 'already-here' }, { sourceId: 'b', migrationAction: 'update', reason: 'source-grew' }], warnings: [], missing: [], counts: { adoptable: 1, update: 1 } }
}

test('stock Codex bridge exposes classification and bounded scan cache through existing pagination contracts', async () => {
  const home = join(tmpdir(), 'codex-unified-root')
  let calls = 0
  const bridge = createCodexPanelBridge({}, { preview: async () => { calls++; return previewFixture(home) } })
  const first = await bridge.sessions({ source: 'codex', after: 0, epoch: 1 })
  assert.equal(first.sessions.length, 2)
  assert.equal(first.sessions[0].migrationAction, 'adoptable')
  assert.equal(first.sessions[0].importStatus, 'partial')
  assert.equal(first.sessions[1].migrationAction, 'update')
  assert.equal(first.done, true)
  assert.equal(first.cursor, 2)
  await bridge.sessions({ source: 'codex', after: 2, epoch: 1 })
  assert.equal(calls, 1)
  const filtered = await bridge.sessions({ source: 'codex', query: 'Updated', after: 0, epoch: 1 })
  assert.equal(filtered.total, 1)
  assert.equal(calls, 1)
  await bridge.sessions({ source: 'codex', after: 0, epoch: 2 })
  assert.equal(calls, 2)
  assert.equal(await bridge.sessions({ source: 'claude-code' }), null)
  assert.deepEqual(parseCodexProjectPath(first.sessions[0].sourcePath), { codexHome: home, sessionId: 'a' })
  assert.throws(() => parseCodexProjectPath('codex-project://bad/../x'), /Invalid/)
  assert.equal(buildCodexPanelRows(previewFixture(home), 'updated').length, 1)
})

test('project bridge revalidates selected source ids and imports only selected sessions', async () => {
  const home = join(tmpdir(), 'codex-unified-import')
  const calls = []
  const bridge = createCodexPanelBridge({}, { preview: async () => previewFixture(home), migrate: async (input) => {
    calls.push(input)
    return { results: input.sessionIds.map((sourceId) => ({ sourceId, status: 'imported', sessionId: 'target-' + sourceId })) }
  } })
  const result = await bridge.importRows({ items: [{ source: 'codex', sessionId: 'b', sourcePath: codexProjectPath(home, 'b'), cwd: '/forged' }], target: 'dsh4' })
  assert.deepEqual(calls[0].sessionIds, ['b'])
  assert.equal(calls[0].preview, false)
  assert.equal(calls[0].cwd, undefined)
  assert.equal(result.results[0].sourcePath, codexProjectPath(home, 'b'))
  await assert.rejects(bridge.importRows({ items: [{ source: 'codex', sessionId: 'absent', sourcePath: codexProjectPath(home, 'absent') }] }), /no longer available/)
  await assert.rejects(bridge.importRows({ items: [{ source: 'codex', sessionId: 'a', sourcePath: codexProjectPath(home, 'a') }, { source: 'claude-code', sourcePath: '/other' }] }), /separately/)
  await assert.rejects(bridge.importRows({ items: [{ source: 'codex', sessionId: 'wrong', sourcePath: codexProjectPath(home, 'a') }] }), /mismatch/)
  assert.equal(calls.length, 1)
})

test('Codex modern metadata and exact title reach stock rows without source writes', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'codex-unified-source-'))
  t.after(async () => rm(home, { recursive: true, force: true }))
  const cwd = join(home, 'project')
  await mkdir(cwd)
  const db = new DatabaseSync(join(home, 'state_5.sqlite'))
  db.exec('CREATE TABLE threads(id TEXT,cwd TEXT,name TEXT,source TEXT,thread_source TEXT)')
  db.prepare('INSERT INTO threads VALUES(?,?,?,?,?)').run('db-only', cwd, 'Original title', 'cli', 'user')
  db.close()
  const history = new DatabaseSync(join(home, 'thread_history_1.sqlite'))
  history.exec('CREATE TABLE thread_items(thread_id TEXT,item_json TEXT)')
  history.prepare('INSERT INTO thread_items VALUES(?,?)').run('db-only', JSON.stringify({ type: 'userMessage', content: [{ type: 'text', text: 'Synthetic modern conversation' }] }))
  history.close()
  const desktop = join(home, '.codex-global-state.json')
  await writeFile(desktop, JSON.stringify({ 'local-projects': { p: { id: 'p', name: 'Exact project', rootPaths: [cwd] } } }))
  const before = await readFile(desktop)
  const bridge = createCodexPanelBridge({}, { preview: async (input) => ({ scan: await scanCodexProjects(input), results: [{ sourceId: 'db-only', migrationAction: 'new' }], warnings: [] }) })
  const output = await bridge.sessions({ source: 'codex', path: home })
  assert.equal(output.sessions.length, 1)
  assert.equal(output.sessions[0].title, 'Original title')
  assert.equal(output.sessions[0].project, 'Exact project')
  assert.deepEqual(await readFile(desktop), before)
  const host = makeCtx({}, { real: true })
  const registryDir = join(home, 'isolated-registry')
  registerPanelRoutes(host.ctx, host.ctx.webServer, registryDir)
  const route = host.webRoutes.find((entry) => entry.path === '/api-import/sessions')
  const request = { async *[Symbol.asyncIterator]() { yield JSON.stringify({ source: 'codex', path: home, epoch: 7 }) } }
  const response = { writeHead(status) { this.status = status }, end(text) { this.body = JSON.parse(text) } }
  await route.handler(request, response)
  assert.equal(response.status, 200, JSON.stringify(response.body))
  assert.equal(response.body.sessions.length, 1)
  assert.equal(response.body.sessions[0].migrationAction, 'new')
  assert.equal(response.body.sessions[0].sourcePath, codexProjectPath(home, 'db-only'))
  assert.deepEqual(await readFile(desktop), before)
  const direct = join(home, 'rollout.jsonl')
  await writeFile(direct, '{}')
  assert.equal(await bridge.sessions({ source: 'codex', path: direct }), null)
})

test('stock file action routes refuse opaque project identities without filesystem access', async () => {
  const { ctx, webRoutes } = makeCtx({})
  registerPanelRoutes(ctx, ctx.webServer, join(tmpdir(), 'codex-unified-registry'))
  const sourcePath = codexProjectPath(join(tmpdir(), 'codex-home'), 'a')
  for (const path of ['/api-import/preview', '/api-import/hide', '/api-import/unhide', '/api-import/delete-source']) {
    const route = webRoutes.find((entry) => entry.path === path)
    const body = { source: 'codex', sourcePath, sessionId: 'a', items: [{ source: 'codex', sourcePath, sessionId: 'a' }], confirm: true }
    const request = { async *[Symbol.asyncIterator]() { yield JSON.stringify(body) } }
    const response = { writeHead(status) { this.status = status }, end(text) { this.body = JSON.parse(text) } }
    await route.handler(request, response)
    assert.equal(response.status, 400, path)
    assert.match(response.body.error, /not standalone files/, path)
  }
})

test('Codex classification streams only verified rows before full scan completion', async () => {
  let finish, notify
  const wait = new Promise((resolve) => { finish = resolve })
  const scan = { codexHome: join(tmpdir(), 'stream-home'), sessions: [{ id: 'a', title: 'One', projectName: 'Project', projectId: 'p', hasBody: true }] }
  const bridge = createCodexPanelBridge({}, { preview: async (input) => { notify = input.onDecision; return wait } })
  const first = await bridge.sessions({ source: 'codex', after: 0 })
  assert.equal(first.done, false)
  assert.equal(first.sessions.length, 0)
  notify({ sourceId: 'a', migrationAction: 'adoptable' }, scan)
  const progress = await bridge.sessions({ source: 'codex', after: 0 })
  assert.equal(progress.sessions[0].migrationAction, 'adoptable')
  assert.equal(progress.done, false)
  finish({ scan, results: [{ sourceId: 'a', migrationAction: 'adoptable' }], warnings: [] })
  const final = await bridge.sessions({ source: 'codex', after: 1 })
  assert.equal(final.done, true)
  assert.equal(final.sessions.length, 0)
  assert.equal(final.total, 1)
})
