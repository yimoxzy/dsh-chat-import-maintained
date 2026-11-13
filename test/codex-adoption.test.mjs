import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeCtx } from './_support/fake-host.mjs'
import { convertGenericJson } from '../lib/convert/generic.mjs'
import { loadAdoptionCandidates, verifyAdoption } from '../lib/codex-projects/adoption.mjs'
import { atomHashes } from '../lib/codex-projects/history.mjs'

const clone = (value) => JSON.parse(JSON.stringify(value))
const ID = '11111111-2222-4333-8444-555555555555'
const OTHER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
function document(id, cwd, answer = 'Original full answer') {
  return { interchange: 'dsh-chat-import', version: 1, meta: { id: 'codex-project-' + id, cwd, createdAt: 1000000 }, title: 'Same display name',
    turns: [{ prompt: 'Original question ' + '字'.repeat(18000), steps: [{ content: [{ type: 'text', text: answer }] }] }] }
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'codex-adoption-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = root
  t.after(async () => { if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome; await rm(root, { recursive: true, force: true }) })
  const cwd = join(root, 'project'), sourceFile = join(root, ID + '.jsonl')
  await mkdir(cwd)
  const doc = document(ID, cwd)
  await writeFile(sourceFile, JSON.stringify(doc))
  const session = { id: ID, cwd, projectName: 'Project name' }
  const workspace = { path: cwd, sessionIds: [] }
  const registry = { archivedSessionIds: [], resolveByPath: async (path) => path === cwd ? workspace : undefined }
  const host = makeCtx({}, { workspaceRegistry: registry })
  const seed = (id = 'import-codex-corrected-' + ID, value = doc, headerCwd = cwd) => {
    const converted = convertGenericJson(JSON.stringify(value), { budget: 0, sessionId: id })
    host.persistence.sessions.set(id, { meta: { ...converted.meta, id, cwd: headerCwd }, events: converted.events })
    workspace.sessionIds.push(id)
    return id
  }
  const stock = async (imports) => { await mkdir(join(root, 'dsh-chat-import'), { recursive: true }); await writeFile(join(root, 'dsh-chat-import', 'imports.json'), JSON.stringify({ version: 1, imports })) }
  const scan = { sessions: [session] }
  return { root, cwd, sourceFile, doc, session, host, seed, registry, workspace, stock, scan }
}

test('adoption recognizes stock source identity, excludes archived copies and reads no target bodies during indexing', async (t) => {
  const f = await fixture(t)
  const active = f.seed(), old = f.seed('import-codex-project-' + ID)
  f.registry.archivedSessionIds.push(old)
  await f.stock({ [f.sourceFile]: { kind: 'single', dshId: active, copies: [{ dshId: old }] } })
  const candidates = await loadAdoptionCandidates(f.host.ctx, f.scan)
  assert.equal(candidates.candidates.length, 1)
  assert.equal(candidates.candidates[0].sessionId, active)
  assert.equal(candidates.candidates[0].sourceFile, f.sourceFile)
  assert.ok(!f.host.persistence.calls.includes('readFrom'))
  const before = await readFile(f.sourceFile, 'utf8')
  const verified = await verifyAdoption(f.host.ctx, f.session, f.doc, candidates)
  assert.equal(verified.kind, 'verified')
  assert.deepEqual(verified.sourceAtoms, verified.targetAtoms)
  assert.equal(await readFile(f.sourceFile, 'utf8'), before)
})

test('manifest supports current dshId, relative sourceFile and moved workspace membership', async (t) => {
  const f = await fixture(t)
  const id = f.seed('custom-import-target', f.doc, join(f.root, 'old-project-root'))
  const manifest = join(f.root, 'manifest.json')
  await writeFile(manifest, JSON.stringify({ sessions: [{ id: ID, dshId: id, sourceFile: ID + '.jsonl', cwd: f.cwd, previousDshId: 'obsolete' }] }))
  const candidates = await loadAdoptionCandidates(f.host.ctx, f.scan, { adoptionManifest: manifest })
  const result = await verifyAdoption(f.host.ctx, f.session, f.doc, candidates)
  assert.equal(result.kind, 'verified')
  assert.equal(result.evidence.find((value) => typeof value === 'object' && 'workspaceMember' in value).workspaceMember, true)
})

test('full old source prefix verifies while DSH continuation remains detectable', async (t) => {
  const f = await fixture(t)
  const id = f.seed()
  const record = f.host.persistence.sessions.get(id)
  record.events.push({ type: 'user/message', seq: record.events.length, time: 2000000, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'DSH-only continuation' }] } })
  await f.stock({ [f.sourceFile]: { dshId: id } })
  const newer = clone(f.doc)
  newer.turns.push({ prompt: 'Codex changed separately', steps: [] })
  const out = await verifyAdoption(f.host.ctx, f.session, newer, await loadAdoptionCandidates(f.host.ctx, f.scan))
  assert.equal(out.kind, 'verified')
  assert.equal(out.reason, 'full-source-with-target-continuation')
  assert.equal(out.targetAtoms.length, out.sourceAtoms.length + 1)
  assert.equal(out.baselineEvents, record.events.length)
})

test('trimmed source import is never adopted as a complete matching baseline', async (t) => {
  const f = await fixture(t)
  const trimmed = clone(f.doc)
  trimmed.turns[0].prompt = 'Original question cropped'
  const id = f.seed(undefined, trimmed)
  await f.stock({ [f.sourceFile]: { dshId: id } })
  const out = await verifyAdoption(f.host.ctx, f.session, f.doc, await loadAdoptionCandidates(f.host.ctx, f.scan))
  assert.equal(out.kind, 'unverified')
  assert.equal(out.reason, 'full-source-prefix-mismatch')
})

test('same titles and filename guesses cannot override a contradictory document source ID', async (t) => {
  const f = await fixture(t)
  const id = f.seed()
  await writeFile(f.sourceFile, JSON.stringify(document(OTHER, f.cwd)))
  await f.stock({ [f.sourceFile]: { dshId: id } })
  const out = await verifyAdoption(f.host.ctx, f.session, f.doc, await loadAdoptionCandidates(f.host.ctx, f.scan))
  assert.equal(out.kind, 'unverified')
  assert.equal(out.reason, 'source-document-identity-mismatch')
})

test('multiple active matches are ambiguous even when only one has a matching body', async (t) => {
  const f = await fixture(t)
  f.seed()
  f.seed('import-codex-full-' + ID, document(ID, f.cwd, 'Other body'))
  const out = await verifyAdoption(f.host.ctx, f.session, f.doc, await loadAdoptionCandidates(f.host.ctx, f.scan))
  assert.equal(out.kind, 'ambiguous')
  assert.equal(out.evidence.length, 2)
})

test('without historical source document only a full current source prefix can verify', async (t) => {
  const f = await fixture(t)
  const id = f.seed()
  const candidates = await loadAdoptionCandidates(f.host.ctx, f.scan)
  const verified = await verifyAdoption(f.host.ctx, f.session, f.doc, candidates)
  assert.equal(verified.kind, 'verified')
  assert.deepEqual(verified.sourceAtoms, atomHashes(f.host.persistence.sessions.get(id).events))
  const grown = clone(f.doc)
  grown.turns.push({ prompt: 'New Codex turn', steps: [] })
  const unverified = await verifyAdoption(f.host.ctx, f.session, grown, candidates)
  assert.equal(unverified.kind, 'unverified')
})

test('wrong workspace, unreadable target, malformed manifests and unrelated names remain explicit', async (t) => {
  const f = await fixture(t)
  const id = f.seed('import-codex-full-' + ID, f.doc, join(f.root, 'other'))
  f.workspace.sessionIds = []
  const out = await verifyAdoption(f.host.ctx, f.session, f.doc, await loadAdoptionCandidates(f.host.ctx, f.scan))
  assert.equal(out.reason, 'workspace-mismatch')
  f.workspace.sessionIds.push(id)
  f.host.persistence.ghost(id)
  const unreadable = await verifyAdoption(f.host.ctx, f.session, f.doc, await loadAdoptionCandidates(f.host.ctx, f.scan))
  assert.equal(unreadable.reason, 'target-unreadable')
  const manifest = join(f.root, 'broken.json')
  await writeFile(manifest, '{not json')
  const broken = await loadAdoptionCandidates(f.host.ctx, f.scan, { adoptionManifest: manifest })
  assert.equal(broken.warnings[0].code, 'adoption-manifest-unreadable')
  const none = await verifyAdoption(f.host.ctx, { id: OTHER, cwd: f.cwd }, f.doc, broken)
  assert.equal(none.kind, 'none')
})

test('original Codex rollout identity can recognize a stock target with no conventional target id', async (t) => {
  const f = await fixture(t)
  const rollout = join(f.root, 'opaque.jsonl')
  await writeFile(rollout, [
    { type: 'session_meta', timestamp: '2026-01-01T00:00:00Z', payload: { id: ID, cwd: f.cwd } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: f.doc.turns[0].prompt }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Original full answer' }] } },
  ].map(JSON.stringify).join('\n'))
  const id = f.seed('opaque-target-id')
  await f.stock({ [rollout]: { dshId: id } })
  const candidates = await loadAdoptionCandidates(f.host.ctx, f.scan)
  assert.equal(candidates.candidates[0].sourceId, ID)
  const out = await verifyAdoption(f.host.ctx, f.session, f.doc, candidates)
  assert.equal(out.kind, 'verified')
})

test('known non-UUID source ids match only exact recognized imported suffixes', async (t) => {
  const f = await fixture(t)
  const session = { ...f.session, id: 'source-custom-id' }
  const doc = document(session.id, f.cwd)
  const id = f.seed('import-codex-project-source-custom-id', doc)
  f.seed('import-codex-project-source-custom-id-extra', doc)
  const candidates = await loadAdoptionCandidates(f.host.ctx, { sessions: [session] })
  assert.equal(candidates.candidates.length, 1)
  assert.equal(candidates.candidates[0].sessionId, id)
  assert.equal((await verifyAdoption(f.host.ctx, session, doc, candidates)).kind, 'verified')
})

test('malformed source blocks cannot become full-history proof and newly archived targets are excluded', async (t) => {
  const f = await fixture(t)
  const id = f.seed()
  const malformed = clone(f.doc)
  malformed.turns[0].steps[0].content.push({ type: 'unknown', text: 'Must not silently drop evidence' })
  await writeFile(f.sourceFile, JSON.stringify(malformed))
  await f.stock({ [f.sourceFile]: { dshId: id } })
  const candidates = await loadAdoptionCandidates(f.host.ctx, f.scan)
  assert.equal((await verifyAdoption(f.host.ctx, f.session, f.doc, candidates)).kind, 'unverified')
  f.registry.archivedSessionIds.push(id)
  assert.equal((await verifyAdoption(f.host.ctx, f.session, f.doc, candidates)).kind, 'none')
})

test('missing original directory resolves only through unique same-named retained workspace membership', async (t) => {
  const f = await fixture(t)
  const retainedCwd = join(f.root, 'retained')
  const id = f.seed(undefined, f.doc, retainedCwd)
  f.workspace.path = retainedCwd
  f.workspace.title = f.session.projectName
  f.registry.resolveByPath = async () => { throw Object.assign(new Error('Missing root'), { code: 'ENOENT' }) }
  f.registry.list = () => [f.workspace]
  const out = await verifyAdoption(f.host.ctx, f.session, f.doc, await loadAdoptionCandidates(f.host.ctx, f.scan))
  assert.equal(out.kind, 'verified')
  assert.equal(out.resolvedCwd, retainedCwd)
  assert.equal(out.sessionId, id)
  f.workspace.title = 'Different project'
  const refused = await verifyAdoption(f.host.ctx, f.session, f.doc, await loadAdoptionCandidates(f.host.ctx, f.scan))
  assert.equal(refused.reason, 'workspace-mismatch')
})

test('unavailable native session index cannot turn unknown existing imports into new sessions', async (t) => {
  const f = await fixture(t)
  f.host.persistence.list = async () => { throw new Error('Synthetic index failure') }
  const candidates = await loadAdoptionCandidates(f.host.ctx, f.scan)
  assert.equal(candidates.unavailable, true)
  assert.equal(candidates.warnings[0].code, 'existing-session-index-unavailable')
  const result = await verifyAdoption(f.host.ctx, f.session, f.doc, candidates)
  assert.equal(result.kind, 'unverified')
})
