import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { scanCodexProjects, loadCodexProjectSession } from '../lib/codex-projects/source.mjs'
import { codexProjectDocument, convertCodexProjectItems } from '../lib/codex-projects/convert.mjs'
import { convertGenericJson } from '../lib/convert/generic.mjs'

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'codex-project-source-'))
  const cwd = join(home, 'project-a')
  await mkdir(cwd)
  const state = new DatabaseSync(join(home, 'state_5.sqlite'))
  state.exec(`CREATE TABLE threads(id TEXT PRIMARY KEY,cwd TEXT,title TEXT,name TEXT,project_id TEXT,
    source TEXT,thread_source TEXT,created_at INTEGER,rollout_path TEXT,attached_thread_parent_id TEXT);
    CREATE TABLE projects(id TEXT,name TEXT);
    CREATE TABLE project_roots(project_id TEXT,position INTEGER,path TEXT);
    CREATE TABLE thread_spawn_edges(parent_thread_id TEXT,child_thread_id TEXT);`)
  const history = new DatabaseSync(join(home, 'thread_history_1.sqlite'))
  history.exec(`CREATE TABLE thread_items(thread_id TEXT,item_id TEXT,item_json TEXT,rollout_ordinal INTEGER,created_at_ms INTEGER);`)
  t.after(async () => { state.close(); history.close(); await rm(home, { recursive: true, force: true }) })
  const thread = (id, values = {}) => state.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, values.cwd ?? cwd,
    values.title ?? 'Database title', values.name ?? null, values.project_id ?? null, values.source ?? 'vscode', values.thread_source ?? 'user', 1000, null, values.parent ?? null)
  const item = (id, ordinal, value) => history.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?)').run(id, 'i' + ordinal, JSON.stringify(value), ordinal, 1000000 + ordinal)
  const desktop = async (extra = {}) => writeFile(join(home, '.codex-global-state.json'), JSON.stringify({
    'local-projects': { p: { id: 'p', name: 'Project A', rootPaths: [cwd] } }, ...extra,
  }))
  const rollout = async (id, values = {}) => {
    const dir = join(home, 'sessions', '2026', '01', '01')
    await mkdir(dir, { recursive: true })
    const path = join(dir, 'rollout-' + id + '.jsonl')
    await writeFile(path, [
      { type: 'session_meta', timestamp: '2026-01-01T00:00:00Z', payload: { id, cwd, source: 'cli', thread_source: 'user', ...values } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Rollout question' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Rollout answer' }] } },
    ].map(JSON.stringify).join('\n'))
    return path
  }
  return { home, cwd, state, history, thread, item, desktop, rollout }
}

test('Codex project discovery merges migrated null-project metadata, explicit order and safe root inference', async (t) => {
  const f = await fixture(t)
  await f.desktop({
    'thread-project-assignments': { explicit: { projectId: 'p' }, absent: { projectId: 'p' }, guardian: { projectId: 'p' } },
    'sidebar-project-thread-orders': { p: { threadIds: ['sidebar'] } },
    'projectless-thread-ids': ['loose'],
  })
  for (const id of ['explicit', 'sidebar', 'inferred', 'loose', 'guardian', 'child', 'attached', 'agent-child']) f.thread(id,
    id === 'guardian' ? { thread_source: 'guardian_review' } : id === 'attached' ? { parent: 'explicit' }
      : id === 'agent-child' ? { source: '{"subagent":{"thread_spawn":{}}}' } : {})
  f.state.prepare('INSERT INTO thread_spawn_edges VALUES(?,?)').run('explicit', 'child')
  for (const id of ['explicit', 'sidebar', 'inferred']) f.item(id, 1, { type: 'userMessage', content: [{ type: 'text', text: id }] })
  f.state.prepare('INSERT INTO projects VALUES(?,?)').run('db-p', 'Legacy project alias')
  f.state.prepare('INSERT INTO project_roots VALUES(?,?,?)').run('db-p', 0, f.cwd)
  const scan = await scanCodexProjects({ codexHome: f.home })
  assert.deepEqual(scan.sessions.map((s) => s.id).sort(), ['absent', 'explicit', 'inferred', 'sidebar'])
  assert.equal(scan.projects.length, 1)
  assert.equal(scan.projects[0].sessions.length, 4)
  assert.equal(scan.sessions.find((s) => s.id === 'inferred').evidence.inferred, true)
  assert.equal(scan.missing.length, 1)
  assert.equal(scan.missing[0].id, 'absent')
  assert.equal(scan.excluded.length, 4)
  const strict = await scanCodexProjects({ codexHome: f.home, includeInferred: false })
  assert.equal(strict.sessions.some((s) => s.id === 'inferred'), false)
})

test('Codex projects use latest title-index name, highest DB generations and deduplicate rollout IDs', async (t) => {
  const f = await fixture(t)
  await f.desktop({ 'thread-project-assignments': { both: { projectId: 'p' }, named: { projectId: 'p' } } })
  f.thread('both', { name: 'Named title' })
  f.thread('named', { name: 'Name wins database prompt' })
  f.item('both', 1, { type: 'userMessage', content: [{ type: 'text', text: 'DB body' }] })
  await f.rollout('both')
  await writeFile(join(f.home, 'session_index.jsonl'), [
    { id: 'both', thread_name: 'Old name' }, { id: 'both', thread_name: 'Exact new name  两个空格' },
  ].map(JSON.stringify).join('\n'))
  const lower = new DatabaseSync(join(f.home, 'state_1.sqlite'))
  lower.exec('CREATE TABLE irrelevant(x)'); lower.close()
  const scan = await scanCodexProjects({ codexHome: f.home })
  assert.equal(scan.stateDatabase, join(f.home, 'state_5.sqlite'))
  assert.equal(scan.sessions.filter((s) => s.id === 'both').length, 1)
  assert.equal(scan.sessions.find((s) => s.id === 'both').title, 'Exact new name  两个空格')
  assert.equal(scan.sessions.find((s) => s.id === 'named').title, 'Name wins database prompt')
  const loaded = await loadCodexProjectSession(scan, 'both')
  assert.equal(loaded.document.title, 'Exact new name  两个空格')
  assert.equal(loaded.document.turns[0].prompt, 'DB body')
  assert.equal(loaded.document.meta.cwd, f.cwd)
  const hash = loaded.sourceHash
  await utimes(join(f.home, 'thread_history_1.sqlite'), new Date(1000), new Date(2000))
  assert.equal((await loadCodexProjectSession(scan, 'both')).sourceHash, hash)
  f.item('both', 2, { type: 'agentMessage', text: 'New body' })
  assert.notEqual((await loadCodexProjectSession(scan, 'both')).sourceHash, hash)
})

test('Codex database conversion preserves long bodies, ordered tools and source limitations without fabricating summaries', async (t) => {
  const f = await fixture(t)
  await f.desktop({ 'thread-project-assignments': { x: { projectId: 'p' } } })
  f.thread('x')
  const text = '完整正文'.repeat(10000)
  // Insertion order differs from source order.
  f.item('x', 3, { type: 'commandExecution', id: 'call1', command: 'echo test', cwd: f.cwd, aggregatedOutput: text, exitCode: 0, status: 'completed' })
  f.item('x', 1, { type: 'userMessage', content: [{ type: 'text', text }, { type: 'image', image_url: 'file:///missing.png' }] })
  f.item('x', 2, { type: 'reasoning', summary: ['reasoning'], content: [] })
  f.item('x', 4, { type: 'contextCompaction', id: 'compacted' })
  f.item('x', 5, { type: 'fileChange', changes: [{ path: 'a.txt', diff: '+source' }] })
  f.item('x', 6, { type: 'agentMessage', text: 'Done' })
  const scan = await scanCodexProjects({ codexHome: f.home })
  const out = await loadCodexProjectSession(scan, 'x')
  const doc = out.document
  assert.equal(doc.turns[0].promptBlocks[0].text, text)
  assert.equal(doc.turns[0].steps[0].content[0].text, 'reasoning')
  const tool = doc.turns[0].steps[1]
  assert.deepEqual(tool.content[0], { type: 'tool-call', ...tool.toolCalls[0] })
  assert.equal(JSON.parse(tool.toolResults[0].content[0].text).output, text)
  assert.equal(out.diagnostics.compactionSummaryMissing, 1)
  assert.equal(out.diagnostics.attachmentMetadata, 1)
  assert.match(doc.turns[0].steps[2].content[0].text, /Codex activity record/)
  assert.equal(doc.turns[0].shadowed, true)
  assert.match(doc.turns.at(-1).compaction.summary, /not a semantic summary/)
  const generic = convertGenericJson(JSON.stringify(doc), { budget: 500 })
  assert.equal(generic.trimmed, undefined)
  assert.equal(generic.droppedToolResults || 0, 0)
  assert.ok(JSON.stringify(generic.events).includes(text))
})

test('Codex rollout fallback loads one selected body and does not duplicate database source', async (t) => {
  const f = await fixture(t)
  await f.desktop({ 'sidebar-project-thread-orders': { p: { threadIds: ['rollout-only'] } } })
  await f.rollout('rollout-only')
  const scan = await scanCodexProjects({ codexHome: f.home })
  assert.equal(scan.sessions[0].source.kind, 'rollout')
  const out = await loadCodexProjectSession(scan, 'rollout-only')
  assert.equal(out.document.meta.id, 'codex-project-rollout-only')
  assert.equal(out.document.turns[0].prompt, 'Rollout question')
  assert.equal(out.document.turns[0].steps[0].content[0].text, 'Rollout answer')
  assert.equal(scan.missing.length, 0)
  await assert.rejects(loadCodexProjectSession(scan, 'unknown'), /not in scan/)
})

test('Codex scanner reports unsupported schemas and missing bodies without aborting the whole project', async (t) => {
  const f = await fixture(t)
  await f.desktop({ 'thread-project-assignments': { missing: { projectId: 'p' } } })
  f.history.exec('DROP TABLE thread_items; CREATE TABLE thread_items(other TEXT)')
  const scan = await scanCodexProjects({ codexHome: f.home })
  assert.equal(scan.missing.length, 1)
  assert.ok(scan.warnings.some((w) => w.code === 'thread-items-schema-unsupported'))
  const out = await loadCodexProjectSession(scan, 'missing')
  assert.equal(out.document, null)
  assert.ok(out.warnings.some((w) => w.code === 'session-history-read-failed'))
  assert.equal(out.diagnostics.missingBody, true)
})

test('Codex item parser reports malformed records and pairs mcp/dynamic tools without inventing empty results', () => {
  const out = convertCodexProjectItems([
    { item_json: '{bad' },
    { item_json: JSON.stringify({ type: 'userMessage', content: [{ type: 'text', text: 'Question' }] }) },
    { item_json: JSON.stringify({ type: 'mcpToolCall', id: 'm', server: 'server', tool: 'read', arguments: { path: 'x' }, result: { content: [{ type: 'text', text: 'actual' }] } }) },
    { item_json: JSON.stringify({ type: 'dynamicToolCall', id: 'd', namespace: 'native', tool: 'run', arguments: {}, status: 'running' }) },
    { item_json: JSON.stringify({ type: 'collabAgentToolCall', id: 'c', prompt: 'Delegate text' }) },
  ], { id: 'x', projectName: 'Project', cwd: '/project', createdAt: 0, title: 'Name' })
  assert.equal(out.diagnostics.malformedItems, 1)
  assert.equal(out.diagnostics.missingToolResults, 1)
  const steps = out.document.turns[0].steps
  assert.equal(steps[0].toolResults[0].toolCallId, 'm')
  assert.equal(steps[1].toolResults, undefined)
  assert.match(steps[2].content[0].text, /Delegate text/)
})

test('Codex scanner honors explicit codexHome and CODEX_HOME default without touching source bytes', async (t) => {
  const f = await fixture(t)
  await f.desktop({ 'thread-project-assignments': { x: { projectId: 'p' } } })
  f.thread('x'); f.item('x', 1, { type: 'userMessage', content: [{ type: 'text', text: 'hello' }] })
  const before = await readFile(join(f.home, 'state_5.sqlite'))
  const previous = process.env.CODEX_HOME
  process.env.CODEX_HOME = f.home
  try { assert.equal((await scanCodexProjects()).codexHome, f.home) }
  finally { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous }
  assert.deepEqual(await readFile(join(f.home, 'state_5.sqlite')), before)
})

test('Codex native database projects work without desktop state and ambiguous roots are never inferred', async (t) => {
  const f = await fixture(t)
  f.state.prepare('INSERT INTO projects VALUES(?,?)').run('native', 'Native project')
  f.state.prepare('INSERT INTO project_roots VALUES(?,?,?)').run('native', 0, f.cwd)
  f.thread('native-user', { project_id: 'native', cwd: join(f.home, 'different') })
  f.item('native-user', 1, { type: 'userMessage', content: [{ type: 'text', text: 'Question' }] })
  const scan = await scanCodexProjects({ codexHome: f.home })
  assert.equal(scan.sessions[0].evidence.kind, 'database-assignment')
  assert.equal(scan.sessions[0].cwd, f.cwd)
  assert.equal(scan.sessions[0].projectName, 'Native project')
  await f.desktop({ 'local-projects': {
    one: { id: 'one', name: 'One', rootPaths: [f.cwd] },
    two: { id: 'two', name: 'Two', rootPaths: [f.cwd] },
  } })
  f.thread('ambiguous', { source: 'cli' })
  const ambiguous = await scanCodexProjects({ codexHome: f.home })
  assert.equal(ambiguous.sessions.some((s) => s.id === 'ambiguous'), false)
  assert.ok(ambiguous.warnings.some((w) => w.code === 'ambiguous-project-root'))
})

test('Codex preview does not parse malformed history bodies and a missing-body load reports diagnostics', async (t) => {
  const f = await fixture(t)
  await f.desktop({ 'thread-project-assignments': { x: { projectId: 'p' } } })
  f.thread('x')
  f.history.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?)').run('x', 'bad', 'invalid JSON', 1, 1000001)
  const scan = await scanCodexProjects({ codexHome: f.home })
  assert.equal(scan.sessions[0].hasBody, true)
  assert.equal(scan.warnings.some((w) => w.code === 'malformedItems'), false)
  const load = await loadCodexProjectSession(scan, 'x')
  assert.equal(load.document, null)
  assert.ok(load.warnings.some((w) => w.code === 'session-body-unavailable'))
  assert.ok(load.warnings.some((w) => w.code === 'malformedItems'))
  assert.equal(load.diagnostics.malformedItems, 1)
})

test('Codex source compaction payload remains archived verbatim rather than being silently discarded', () => {
  const compaction = { summary: 'Actual source summary', provider: 'codex', time: 1000000 }
  const doc = codexProjectDocument({ id: 'x', title: 'Title', cwd: '/project', projectName: 'Project', createdAt: 0 }, [
    { prompt: 'Before', steps: [] }, { prompt: 'After', compaction, steps: [] },
  ])
  assert.ok(doc.turns[1].steps[0].content[0].text.includes(JSON.stringify(compaction)))
  assert.equal(doc.turns[1].compaction, undefined)
  assert.equal(doc.turns[1].shadowed, true)
  assert.ok(doc.turns.at(-1).compaction)
})
