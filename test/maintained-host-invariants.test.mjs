import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { normalizeCheckpointTokens } from '../lib/host-invariants.mjs'
import { normalizeHostCheckpointTokens, prepareHostEvents, prepareHostMeta, createSession, writeSession, appendHostEvents } from '../lib/host-session.mjs'
import { convertGenericJson } from '../lib/convert/generic.mjs'

const surfaceTypes = new Set(['system/message', 'user/message', 'assistant/message', 'tool/result'])
const callbacks = {
  isSurfaceEvent: (event) => surfaceTypes.has(event.type),
  deriveMessage: (event) => event.type === 'user/message' ? event.data : event.data.message,
  estimateMessage: (message) => 4 + (message.content || []).reduce((n, b) => n + 4 + Math.ceil((b.text || b.arguments || '').length / 4), 0),
}
const msg = (seq, text, type = 'user/message') => ({
  type, seq, time: seq, surfaceOp: 'append',
  data: type === 'user/message' ? { role: 'user', content: [{ type: 'text', text }] }
    : { message: { role: type === 'tool/result' ? 'tool' : 'system', content: [{ type: 'text', text }] } },
})
const summary = (seq, seqs) => ({ type: 'compaction/summary', seq, time: seq,
  data: { shadowedSeqs: seqs, shadowedRange: { start: seqs[0], end: seqs.at(-1) }, shadowedTokenCount: 999999 } })
const replace = (seq, startSeq, endSeq) => ({ ...msg(seq, 'checkpoint'), surfaceOp: { op: 'replace', startSeq, endSeq } })

function sampleDocument() {
  return { interchange: 'dsh-chat-import', version: 1, meta: { id: 'synthetic', createdAt: 1700000000000 }, turns: [
    { prompt: 'Keep all text', shadowed: true, steps: [{ content: [{ type: 'text', text: 'Calling' }], toolCalls: [{ id: 'call-1', name: 'read', arguments: { path: 'fixture.txt' } }], toolResults: [{ toolCallId: 'call-1', content: [{ type: 'text', text: 'Exact synthetic result' }] }] }] },
    { compaction: { summary: 'Synthetic archive notice' }, steps: [] },
  ] }
}

test('exact prices include blocks and tool results across multiple retained checkpoints without mutation', () => {
  const events = [msg(0, 'protected', 'system/message'), msg(1, 'hello'), msg(2, 'tool output', 'tool/result'), summary(3, [1, 2]), replace(4, 1, 2), msg(5, 'tail'), summary(6, [4, 5]), replace(7, 4, 5)]
  const before = JSON.parse(JSON.stringify(events))
  const result = normalizeCheckpointTokens(events, callbacks)
  assert.equal(result[3].data.shadowedTokenCount, callbacks.estimateMessage(events[1].data) + callbacks.estimateMessage(events[2].data.message))
  assert.equal(result[6].data.shadowedTokenCount, callbacks.estimateMessage(events[4].data) + callbacks.estimateMessage(events[5].data))
  assert.deepEqual(events, before)
  assert.deepEqual(result.map(e => [e.seq, e.type]), events.map(e => [e.seq, e.type]))
  assert.equal(result[1], events[1])
  assert.equal(result[4], events[4])
  assert.deepEqual(normalizeCheckpointTokens(result, callbacks), result)
})

test('incremental checkpoint uses retained prefix and rejects dropped or protected references', () => {
  const prefixEvents = [msg(0, 'protected', 'system/message'), msg(1, 'prefix')]
  const out = normalizeCheckpointTokens([summary(2, [1]), replace(3, 1, 1)], { ...callbacks, prefixEvents })
  assert.equal(out[0].data.shadowedTokenCount, callbacks.estimateMessage(prefixEvents[1].data))
  assert.throws(() => normalizeCheckpointTokens([summary(2, [0, 1])], { ...callbacks, prefixEvents }), /protected/)
  assert.throws(() => normalizeCheckpointTokens([summary(2, [7])], { ...callbacks, prefixEvents }), /retained surface/)
  assert.throws(() => normalizeCheckpointTokens([summary(2, [1, 1])], { ...callbacks, prefixEvents }), /unique/)
  assert.throws(() => normalizeCheckpointTokens([summary(2, [1])]), /running host/)
})

test('range ordering follows retained surface position after partial replacements', () => {
  const events = [msg(0, 'head', 'system/message'), msg(1, 'first'), msg(2, 'second'), summary(3, [1]), replace(4, 1, 1), summary(5, [4, 2]), replace(6, 4, 2)]
  const out = normalizeCheckpointTokens(events, callbacks)
  assert.equal(out[5].data.shadowedTokenCount, callbacks.estimateMessage(events[4].data) + callbacks.estimateMessage(events[2].data))
})

test('generic explicit tool calls win conflicts and advertise exactly once', () => {
  const doc = sampleDocument()
  doc.turns[0].steps[0].content.push({ type: 'tool-call', id: 'call-1', name: 'wrong', arguments: 'wrong' }, { type: 'tool-call', id: 'call-1', name: 'duplicate', arguments: '{}' })
  const converted = convertGenericJson(doc, { budget: 0 })
  const calls = converted.events.filter(e => e.type === 'tool/call')
  const blocks = converted.events.filter(e => e.type === 'assistant/message').flatMap(e => e.data.message.content).filter(b => b.type === 'tool-call')
  assert.equal(calls.length, 1)
  assert.equal(blocks.length, 1)
  assert.deepEqual(blocks[0], { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"fixture.txt"}' })
  assert.equal(calls[0].data.arguments, blocks[0].arguments)
})

test('V4 checkpoint write fails before mutation without host estimator; old native host remains compatible', async () => {
  const events = convertGenericJson(sampleDocument(), { budget: 0 }).events
  let mutations = 0
  const sp = { formatVersion: 4, create: async () => { mutations++ } }
  const ctx = { get: name => name === 'sessionPersistence' ? sp : undefined }
  await assert.rejects(createSession(ctx, { id: 'fixture', createdAt: 1 }, events), /tokenMeter/)
  await assert.rejects(writeSession(ctx, { id: 'fixture', version: 4, createdAt: 1 }, events), /tokenMeter/)
  assert.equal(mutations, 0)
  assert.equal(await normalizeHostCheckpointTokens(ctx, events, { hostVersion: 3 }), events)
  const empty = []
  assert.equal(await normalizeHostCheckpointTokens(ctx, empty), empty)
  const appendCtx = { ...ctx, sessionPersistence: { ...sp, append: async () => { mutations++ } } }
  await assert.rejects(appendHostEvents(appendCtx, 'fixture', events), /Cannot read retained surface|tokenMeter/)
  assert.equal(mutations, 0)
})

test('modern append uses a flushed exclusive handle when direct append is unavailable', async () => {
  const actions = []
  const sp = {
    formatVersion: 4,
    open: async (id, access) => {
      actions.push([id, access])
      return { append: async (events) => actions.push(events.length), flush: async () => actions.push('flush'), close: async () => actions.push('close') }
    },
  }
  const ctx = { sessionPersistence: sp, get: name => name === 'sessionPersistence' ? sp : undefined }
  await appendHostEvents(ctx, 'synthetic-target', [])
  assert.deepEqual(actions, [['synthetic-target', 'write'], 0, 'flush', 'close'])
})

async function nativeRuntime() {
  const anchors = [import.meta.url]
  if (process.env.DSH_PROFILE_DIR) anchors.push(pathToFileURL(join(process.env.DSH_PROFILE_DIR, 'package.json')).href)
  for (const anchor of anchors) {
    try {
      const require = createRequire(anchor)
      return {
        session: await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session')).href),
        meter: await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-token-meter/estimate')).href),
        validator: await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-format-v3-to-v4')).href),
      }
    } catch { /* Optional native integration is skipped when host peers are absent. */ }
  }
  return null
}
const native = await nativeRuntime()
test('native estimator and released V4 validator accept explicit tools and repeated checkpoints', { skip: !native }, () => {
  const doc = sampleDocument()
  doc.turns.push({ prompt: 'Another preserved turn', shadowed: true, steps: [{ content: [{ type: 'text', text: 'Another reply' }] }] }, { compaction: { summary: 'Second synthetic checkpoint' }, steps: [] })
  const out = convertGenericJson(doc, { budget: 0 })
  const prepared = prepareHostEvents(out.events, out.meta.id, 4, 4)
  const events = normalizeCheckpointTokens(prepared, { deriveMessage: native.session.deriveEventMessage, isSurfaceEvent: native.session.isSurfaceEvent, estimateMessage: native.meter.estimateMessage })
  const checkpoint = events.find(e => e.type === 'compaction/summary')
  const exact = checkpoint.data.shadowedSeqs.reduce((n, seq) => n + native.meter.estimateMessage(native.session.deriveEventMessage(events[seq])), 0)
  assert.equal(checkpoint.data.shadowedTokenCount, exact)
  native.validator.assertReleasedV4Relationships({ header: prepareHostMeta(out.meta, 4), events, inheritedEventCount: 0 }, new Set(events.map(e => e.type)))
})
