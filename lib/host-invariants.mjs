// Native shadow prices are a persistence invariant, not a source-format estimate.
// Callers supply the running host's message interpretation and token estimator.
export function hasCheckpointEvents(events) {
  return events.some((event) => event.type === 'compaction/summary' || event.type === 'compaction/prune')
}

/** Reprice exact retained surface ranges without modifying source events or content. */
export function normalizeCheckpointTokens(events, { deriveMessage, estimateMessage, isSurfaceEvent, prefixEvents = [] } = {}) {
  if (!hasCheckpointEvents(events)) return events
  if (![deriveMessage, estimateMessage, isSurfaceEvent].every((fn) => typeof fn === 'function')) {
    throw new Error('Checkpoint writes require the running host message and token estimators')
  }
  const retained = new Map()
  let protectedHead
  const fold = (event, normalize) => {
    let next = event
    if (event.type === 'compaction/summary' || event.type === 'compaction/prune') {
      const seqs = event.data?.shadowedSeqs
      const range = event.data?.shadowedRange
      if (!Array.isArray(seqs) || !seqs.length || new Set(seqs).size !== seqs.length || !range) {
        throw new Error('Checkpoint requires a nonempty unique retained surface range at seq ' + event.seq)
      }
      const keys = [...retained.keys()]
      const first = keys.indexOf(range.start), last = keys.indexOf(range.end)
      const rangeSeqs = first < 0 || last < first ? [] : keys.slice(first, last + 1)
      if (rangeSeqs.length !== seqs.length || rangeSeqs.some((seq, i) => seq !== seqs[i])) {
        throw new Error('Checkpoint shadowedSeqs do not match the retained surface range at seq ' + event.seq)
      }
      if (seqs.includes(protectedHead)) throw new Error('Checkpoint cannot shadow the protected system head')
      let tokens = 0
      for (const seq of seqs) {
        const node = retained.get(seq)
        if (!node) throw new Error('Checkpoint references a missing surface node: ' + seq)
        const message = deriveMessage(node)
        const count = message === null ? 0 : estimateMessage(message)
        if (!Number.isSafeInteger(count) || count < 0) throw new Error('Native token estimator returned an invalid count')
        tokens += count
      }
      if (!Number.isSafeInteger(tokens)) throw new Error('Checkpoint native token total exceeds the safe integer range')
      if (normalize && event.data.shadowedTokenCount !== tokens) next = { ...event, data: { ...event.data, shadowedTokenCount: tokens } }
    }
    if (isSurfaceEvent(event)) {
      const op = event.surfaceOp
      if (op === 'append') {
        if (protectedHead === undefined && event.type === 'system/message' && retained.size === 0) protectedHead = event.seq
        retained.set(event.seq, next)
      } else if (op?.op === 'replace') {
        const start = op.startSeq ?? op.start
        const end = op.endSeq ?? op.end
        const keys = [...retained.keys()]
        const first = keys.indexOf(start), last = keys.indexOf(end)
        if (first < 0 || last < first) throw new Error('Surface replacement does not name retained endpoints at seq ' + event.seq)
        const replaced = keys.slice(first, last + 1)
        if (replaced.includes(protectedHead)) {
          if (event.type !== 'system/message' || replaced.length !== 1) throw new Error('Surface replacement shadows protected system head')
          protectedHead = event.seq
        }
        // Replacements occupy the original range's position, not the tail.
        const entries = [...retained.entries()]
        retained.clear()
        for (let i = 0; i < entries.length; i++) {
          if (i === first) retained.set(event.seq, next)
          if (i < first || i > last) retained.set(...entries[i])
        }
      } else throw new Error('Surface event has no supported operation at seq ' + event.seq)
    }
    return next
  }
  for (const event of prefixEvents) fold(event, false)
  return events.map((event) => fold(event, true))
}
