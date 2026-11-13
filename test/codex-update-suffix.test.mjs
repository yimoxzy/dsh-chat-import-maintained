import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { convertGenericJson } from '../lib/convert/generic.mjs'
import { prepareHostEvents } from '../lib/host-session.mjs'
import { appendSourceSuffix, turnHashes } from '../lib/codex-projects/updates.mjs'
import { atomHashes, isPrefix } from '../lib/codex-projects/history.mjs'

const require = createRequire(import.meta.url)
const native = await import('@deepseek-ai/dsh-session')
const { estimateMessage } = await import('@deepseek-ai/dsh-token-meter/estimate')
const { assertReleasedV4Relationships } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-format-v3-to-v4')).href)
const source = (texts) => ({ interchange: 'dsh-chat-import', version: 1, meta: { id: 'test', cwd: process.cwd(), createdAt: 1000 }, title: 'Exact title', provider: 'codex',
  turns: [...texts.map((text, index) => ({ prompt: text, time: 1000 + index, shadowed: true, steps: [{ content: [{ type: 'text', text: 'Answer ' + text }] }] })),
    { compaction: { summary: 'Explicit source archive notice', provider: 'codex-project-history' }, steps: [] }] })
async function fixture() {
  const doc = source(['first'])
  const converted = convertGenericJson(JSON.stringify(doc), { budget: 1, sessionId: 'test' })
  let events = prepareHostEvents(converted.events, 'test', 4, 4)
  const { normalizeCheckpointTokens } = await import('../lib/host-invariants.mjs')
  events = normalizeCheckpointTokens(events, { deriveMessage: native.deriveEventMessage, estimateMessage, isSurfaceEvent: native.isSurfaceEvent })
  const meta = { version: 4, id: 'test', createdAt: 1000, cwd: process.cwd(), isSeeded: false, delegationDepth: 0 }
  const record = { meta, events: globalThis.structuredClone(events) }
  let appended = 0, closed = 0
  const persistence = { currentVersion: 4, formatVersion: 4, list: async () => [meta], open: async () => ({
    header: meta, read: async () => ({ events: globalThis.structuredClone(events) }),
    append: async (values) => { appended++; events.push(...values) }, flush: async () => {}, close: async () => { closed++ },
  }) }
  const ctx = { get: (name) => name === 'sessionPersistence' ? persistence : name === 'tokenMeter' ? { estimateMessage } : undefined }
  return { doc, record, ctx, get: () => ({ meta, events, appended, closed }), edit: () => events.push({ type: 'session/title', seq: events.length, time: 2000, data: { title: 'Concurrent edit', messageSeqs: [], source: { kind: 'user' } } }) }
}

test('safe source append preserves old events, rebuilds exact bounded checkpoint and is native-readable', async () => {
  const f = await fixture()
  const before = globalThis.structuredClone(f.record.events)
  const result = await appendSourceSuffix(f.ctx, 'test', f.record, source(['first', 'second']), 1)
  const actual = f.get()
  assert.equal(result.appendedTurns, 1)
  assert.equal(actual.appended, 1)
  assert.equal(actual.closed, 1)
  assert.deepEqual(actual.events.slice(0, before.length), before)
  assert.ok(isPrefix(atomHashes(before), atomHashes(actual.events)))
  assertReleasedV4Relationships({ header: actual.meta, events: actual.events, inheritedEventCount: 0 }, new Set(actual.events.map((event) => event.type)))
  assert.equal(actual.events.filter((event) => event.type === 'compaction/summary').length, 2)
})

test('exclusive lease rechecks target and refuses any concurrent change without appending', async () => {
  const f = await fixture()
  f.edit()
  await assert.rejects(appendSourceSuffix(f.ctx, 'test', f.record, source(['first', 'second']), 1), /changed during update/)
  assert.equal(f.get().appended, 0)
  assert.equal(f.get().closed, 1)
})

test('source turn evidence ignores archive flags but detects edited earlier content', () => {
  assert.equal(turnHashes(source(['first'])).length, 1)
  assert.ok(isPrefix(turnHashes(source(['first'])), turnHashes(source(['first', 'next']))))
  assert.equal(isPrefix(turnHashes(source(['first'])), turnHashes(source(['edited', 'next']))), false)
})
