import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { makeCtx } from './_support/fake-host.mjs'
import { importCodexProjects, conversationDigest, synchronizeProjectList } from '../lib/codex-projects/pipeline.mjs'

async function setup(t) {
  const home = await mkdtemp(join(tmpdir(), 'codex-project-flow-'))
  const cwd = join(home, 'project')
  await mkdir(cwd)
  const state = new DatabaseSync(join(home, 'state_5.sqlite'))
  state.exec('CREATE TABLE threads(id TEXT,cwd TEXT,name TEXT,source TEXT,thread_source TEXT,created_at INTEGER)')
  state.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?)').run('session-a', cwd, '原始 会话标题 with long text', 'cli', 'user', 1000)
  state.close()
  const history = new DatabaseSync(join(home, 'thread_history_1.sqlite'))
  history.exec('CREATE TABLE thread_items(thread_id TEXT,item_json TEXT,rollout_ordinal INTEGER,created_at_ms INTEGER)')
  const insert = (ordinal, item) => history.prepare('INSERT INTO thread_items VALUES(?,?,?,?)').run('session-a', JSON.stringify(item), ordinal, 1000000 + ordinal)
  insert(1, { type: 'userMessage', content: [{ type: 'text', text: 'Question ' + '长'.repeat(20000) }] })
  insert(2, { type: 'agentMessage', text: 'Original answer' })
  await writeFile(join(home, '.codex-global-state.json'), JSON.stringify({ 'local-projects': { p: { id: 'p', name: 'Project original name', rootPaths: [cwd] } } }))
  const workspaces = new Map()
  const workspaceRegistry = { archivedSessionIds: [],
    resolveByPath: async (path) => workspaces.get(path),
    create: async (path, title) => {
      const workspace = { id: 'workspace-' + workspaces.size, path, title, sessionIds: [],
        setTitle: async (value) => { workspace.title = value },
        attachSession: async (id) => { if (!workspace.sessionIds.includes(id)) workspace.sessionIds.push(id) } }
      workspaces.set(path, workspace)
      return workspace
    } }
  const host = makeCtx({}, { real: true, workspaceRegistry })
  const notifications = []
  host.ctx.emit = (name, value) => notifications.push({ name, value })
  host.ctx.sessionController = { list: async () => ({ items: [...host.persistence.sessions].map(([id, record]) => ({ sessionId: id, blank: false,
    projections: { kind: 'cached', values: { title: record.events.findLast((event) => event.type === 'session/title')?.data.title } } })) }) }
  const originalGet = host.ctx.get
  host.ctx.get = (name) => name === 'sessionController' ? host.ctx.sessionController : originalGet(name)
  const input = { codexHome: home, stateDirectory: join(home, 'ledger'), preview: false }
  t.after(async () => { history.close(); await rm(home, { recursive: true, force: true }) })
  return { home, cwd, host, input, history, insert, notifications }
}

test('project preview writes no ledger or DSH session; import preserves full content and exact names', async (t) => {
  const f = await setup(t)
  const before = await readdir(f.home)
  const preview = await importCodexProjects(f.host.ctx, { ...f.input, preview: true })
  assert.equal(preview.failed, 0)
  assert.equal(f.host.persistence.sessions.size, 0)
  assert.deepEqual(await readdir(f.home), before)
  const out = await importCodexProjects(f.host.ctx, f.input)
  assert.equal(out.failed, 0, JSON.stringify(out))
  assert.equal(out.imported, 1)
  assert.equal(out.verification.verified, true)
  const stored = f.host.persistence.sessions.get(out.results[0].sessionId)
  assert.equal(stored.events.findLast((event) => event.type === 'session/title').data.title, '原始 会话标题 with long text')
  assert.ok(JSON.stringify(stored.events).includes('长'.repeat(20000)))
  assert.equal(stored.events.filter((event) => event.type === 'compaction/summary').length, 1)
  assert.equal(f.notifications[0].name, 'api-session/added')
})

test('unchanged import skips; changed source creates copy and preserves DSH user replies', async (t) => {
  const f = await setup(t)
  const first = await importCodexProjects(f.host.ctx, f.input)
  assert.equal(first.imported, 1, JSON.stringify(first))
  const id = first.results[0].sessionId
  const stored = f.host.persistence.sessions.get(id)
  stored.events.push({ type: 'user/message', seq: stored.events.length, time: 2000000,
    surfaceOp: 'append', data: { id: 'local', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'DSH user continuation' }] } })
  const oldHash = conversationDigest(stored.events)
  const repeat = await importCodexProjects(f.host.ctx, f.input)
  assert.equal(repeat.alreadyImported, 1)
  assert.equal(f.host.persistence.sessions.size, 1)
  f.insert(3, { type: 'userMessage', content: [{ type: 'text', text: 'New source question' }] })
  const changed = await importCodexProjects(f.host.ctx, f.input)
  assert.equal(changed.imported, 1, JSON.stringify(changed))
  assert.notEqual(changed.results[0].sessionId, id)
  assert.equal(conversationDigest(stored.events), oldHash)
  const ledger = JSON.parse(await readFile(join(f.input.stateDirectory, 'ledger.json'), 'utf8'))
  assert.equal(Object.values(ledger.sessions)[0].copies.length, 1)
})

test('unknown selection is rejected before importing; list misses are explicit', async (t) => {
  const f = await setup(t)
  await assert.rejects(importCodexProjects(f.host.ctx, { ...f.input, sessionIds: ['absent'] }), /Unknown session/)
  assert.equal(f.host.persistence.sessions.size, 0)
  const sync = await synchronizeProjectList(f.host.ctx, [{ sessionId: 'missing', title: 'missing' }])
  assert.equal(sync.verified, false)
  assert.deepEqual(sync.missing, ['missing'])
})

test('a failed destination cannot report an empty successful list verification', async (t) => {
  const f = await setup(t)
  await rm(f.cwd, { recursive: true })
  const out = await importCodexProjects(f.host.ctx, f.input)
  assert.equal(out.failed, 1)
  assert.equal(out.imported, 0)
  assert.equal(out.verification.verified, false)
  assert.equal(f.host.persistence.sessions.size, 0)
})

test('list service failure preserves successful import result and explicit retry warning', async (t) => {
  const f = await setup(t)
  f.host.ctx.sessionController.list = async () => { throw new Error('Synthetic list outage') }
  const out = await importCodexProjects(f.host.ctx, f.input)
  assert.equal(out.imported, 1)
  assert.equal(out.failed, 0)
  assert.equal(out.verification.verified, false)
  assert.ok(out.warnings.some((warning) => warning.code === 'list-service-error'))
  assert.equal(f.host.persistence.sessions.size, 1)
})
