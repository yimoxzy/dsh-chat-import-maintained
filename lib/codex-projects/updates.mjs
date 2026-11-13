// Append verified source suffixes while preserving every previous log event.
import { convertGenericJson } from '../convert/generic.mjs'
import { prepareHostEvents, hostNativeFormatVersion, normalizeHostCheckpointTokens } from '../host-session.mjs'
import { hashValue, sourceTurns } from './history.mjs'

export const turnHashes = (document) => sourceTurns(document).map((turn) => {
  const clean = globalThis.structuredClone(turn)
  delete clean.shadowed
  delete clean.compaction
  return hashValue(clean)
})

function retainedSurface(events, isSurfaceEvent) {
  const surface = []
  for (const event of events) {
    if (!isSurfaceEvent(event)) continue
    if (event.surfaceOp === 'append') surface.push(event.seq)
    else {
      const start = event.surfaceOp.startSeq ?? event.surfaceOp.start
      const end = event.surfaceOp.endSeq ?? event.surfaceOp.end
      const first = surface.indexOf(start), last = surface.indexOf(end)
      if (first < 0 || last < first) throw new Error('Cannot determine current history surface')
      surface.splice(first, last - first + 1, event.seq)
    }
  }
  return surface
}

async function commitVerifiedEvents(ctx, sessionId, record, events) {
  const sp = ctx.get('sessionPersistence')
  const live = ctx.get('sessions')?.get(sessionId)
  if (live) {
    const { Session } = await import('@deepseek-ai/dsh-session')
    Session.create(sessionId, [...record.events, ...events], record.meta, 0)
    // No await between the identity check and synchronous appends: no concurrent user task can interleave.
    if (ctx.get('sessions').get(sessionId) !== live || hashValue(live.snapshotEvents()) !== hashValue(record.events)) throw new Error('Live target changed during update')
    if (ctx.get('agents')?.get(sessionId)?.status === 'running') throw new Error('Target started running; update refused')
    for (const event of events) live.append(event.type, event.data, {
      ...(event.surfaceOp === undefined ? {} : { surfaceOp: event.surfaceOp }),
      ...(event.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: event.sourceEventSeqs }),
    })
    await sp.flush?.()
    return
  }
  const handle = await sp.open(sessionId, 'write')
  try {
    const latest = await handle.read(0, Number.MAX_SAFE_INTEGER)
    if (hashValue(latest.events) !== hashValue(record.events)) throw new Error('Target changed during update; nothing was appended')
    await handle.append(events)
    await handle.flush()
  } finally { await handle.close() }
}

export async function appendSourceSuffix(ctx, sessionId, record, document, previousTurnCount) {
  const sp = ctx.get('sessionPersistence')
  if (!sp?.open) throw new Error('Safe in-place update requires an exclusive native persistence handle')
  if (ctx.get('agents')?.get(sessionId)?.status === 'running') throw new Error('Target session is running; source update was not appended')
  const turns = sourceTurns(document).slice(previousTurnCount).map((turn) => {
    const value = globalThis.structuredClone(turn)
    delete value.shadowed
    delete value.compaction
    return value
  })
  if (!turns.length) throw new Error('No append-only source turns; create a reviewed copy for changed historical turns')
  const converted = convertGenericJson(JSON.stringify({ ...document, meta: { ...document.meta, id: sessionId }, turns }), { budget: 0, sessionId })
  const nativeVersion = await hostNativeFormatVersion(ctx)
  const shaped = prepareHostEvents(converted.events, sessionId, record.meta.version, nativeVersion)
  const skip = (event) => event.type === 'system/message' || event.type === 'session/title'
    || (event.type === 'user/message' && event.data.source?.kind !== 'user')
  const selected = shaped.filter((event) => !skip(event))
  const seqMap = new Map(selected.map((event, index) => [event.seq, record.events.length + index]))
  const turnOffset = Math.max(0, ...record.events.map((event) => event.data?.turn || 0))
  const suffix = selected.map((event) => {
    const next = globalThis.structuredClone(event)
    next.seq = seqMap.get(event.seq)
    if (typeof next.data?.turn === 'number') next.data.turn += turnOffset
    if (next.sourceEventSeqs) next.sourceEventSeqs = next.sourceEventSeqs.map((seq) => seqMap.get(seq)).filter((seq) => seq !== undefined)
    return next
  })
  // Derive exact retained nodes using the host implementation loaded by the installed peer.
  const { isSurfaceEvent } = await import('@deepseek-ai/dsh-session')
  const all = [...record.events, ...suffix]
  const nodes = retainedSurface(all, isSurfaceEvent).filter((seq) => {
    const event = all[seq]
    return event.type !== 'system/message' && !(event.type === 'user/message' && event.data.source?.kind?.startsWith('plugin'))
  })
  if (!nodes.length) throw new Error('Cannot checkpoint an empty appended history')
  const previousCheckpoint = record.events.findLast((event) => event.type === 'compaction/summary')
  if (!previousCheckpoint) throw new Error('A verified bounded-history checkpoint is required for source updates')
  const summary = 'Codex source update: complete previous history and appended source turns remain in this log. This archive notice is not a semantic summary.'
  const compactionId = 'codex-update-' + sessionId + '-' + all.length
  const time = Math.max(Date.now(), all.at(-1)?.time || 0)
  const push = (type, data, extra = {}) => { const event = { type, seq: record.events.length + suffix.length, time, data, ...extra }; suffix.push(event); return event }
  push('compaction/start', { compactionId, turn: null })
  const start = nodes[0], end = nodes.at(-1)
  push('compaction/summary', { ...globalThis.structuredClone(previousCheckpoint.data), compactionId,
    summary: [{ type: 'text', text: summary }], shadowedRange: { start, end }, shadowedSeqs: nodes, shadowedTokenCount: 0 })
  push('user/message', { id: compactionId + ':checkpoint', role: 'user', content: [{ type: 'text', text: summary }],
    source: nativeVersion >= 4 ? { kind: 'compact-checkpoint', compactionId } : { kind: 'plugin', plugin: 'compact', compactionId } },
  { surfaceOp: nativeVersion >= 4 ? { op: 'replace', startSeq: start, endSeq: end } : { op: 'replace', start, end }, sourceEventSeqs: nodes })
  push('compaction/end', { compactionId, turn: null })
  push('session/title', { title: document.title, messageSeqs: [], source: { kind: 'user' } })
  const oldCalls = new Set(record.events.filter((event) => event.type === 'tool/call').map((event) => event.data.callId))
  for (const event of suffix) if (event.type === 'tool/call') {
    if (oldCalls.has(event.data.callId)) throw new Error('Source suffix reuses an existing tool id; reviewed copy required')
    oldCalls.add(event.data.callId)
  }
  const priced = await normalizeHostCheckpointTokens(ctx, suffix, { hostVersion: nativeVersion, prefixEvents: record.events })
  await commitVerifiedEvents(ctx, sessionId, record, priced)
  return { appendedTurns: turns.length, appendedEvents: priced.length }
}

export async function appendSourceMetadata(ctx, sessionId, record, title) {
  const sp = ctx.get('sessionPersistence')
  if (!sp?.open) throw new Error('Safe metadata update requires an exclusive native persistence handle')
  if (ctx.get('agents')?.get(sessionId)?.status === 'running') throw new Error('Target is running; no metadata update was written')
  await commitVerifiedEvents(ctx, sessionId, record, [{ type: 'session/title', seq: record.events.length, time: Date.now(), data: { title, messageSeqs: [], source: { kind: 'user' } } }])
  return { appendedTurns: 0, appendedEvents: 1 }
}
