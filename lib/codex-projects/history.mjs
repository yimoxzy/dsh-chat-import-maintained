// Identity-free conversation atoms support conservative matching across imported log formats.
import { createHash } from 'node:crypto'
export const stable = (value) => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value
export const hashValue = (value) => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
const text = (value) => {
  if (typeof value !== 'string') return value
  try { return JSON.stringify(stable(JSON.parse(value))) } catch { return value }
}
export function conversationAtoms(events) {
  const atoms = []
  for (const event of events) {
    const data = event.data || {}
    if (event.type === 'tool/call') { atoms.push({ type: 'call', name: data.name, arguments: text(data.arguments) }); continue }
    if (!['user/message', 'assistant/message', 'tool/result'].includes(event.type)) continue
    const message = event.type === 'user/message' ? data : data.message
    if (!message) continue
    const kind = message.source?.kind
    if (event.type === 'user/message' && kind !== 'user') continue
    const role = event.type === 'assistant/message' ? 'assistant' : event.type === 'tool/result' ? 'tool' : 'user'
    let blocks = message.content || []
    if (role === 'tool' && blocks[0]?.type === 'tool-result') blocks = blocks[0].content || []
    // Older project converters joined one user's text blocks with a newline;
    // current interchange retains those same blocks. Join only inside that one
    // user message, never across distinct prompts or image/nontext boundaries.
    if (role === 'user') {
      const joined = []
      for (const block of blocks) {
        const previous = joined.at(-1)
        if (block.type === 'text' && previous?.type === 'text') previous.text += '\n' + block.text
        else joined.push({ ...block })
      }
      blocks = joined
    }
    for (const block of blocks) {
      if (block.type === 'tool-call') continue // The following lifecycle event carries the same data.
      const value = block.text
      if ((block.type === 'text' || block.type === 'reasoning') && typeof value === 'string') {
        if (value.length === 0) continue // Empty source messages carry no text; whitespace remains meaningful.
        // Migration notices are provenance metadata, never used as identity evidence.
        if (/^\[Codex (?:context compaction event|source compaction record)/.test(value)) continue
        if (/^\[Codex activity record\] \{"type":"contextCompaction"/.test(value)) continue
        const normalized = value.replaceAll('[Codex attachment metadata; bytes not recovered]', '[Codex attachment metadata]')
        const atom = { type: role + ':' + block.type, value: text(normalized) }
        const previous = atoms.at(-1)
        if (block.type === 'reasoning' && previous?.type === atom.type) previous.value += '\n' + atom.value
        else atoms.push(atom)
      } else if (block.type !== 'tool-result') atoms.push({ type: role + ':' + block.type, value: stable(block) })
    }
  }
  return atoms
}
export const atomHashes = (events) => conversationAtoms(events).map(hashValue)
export const isPrefix = (prefix, values) => prefix.length <= values.length && prefix.every((value, index) => value === values[index])
export function sourceTurns(document) { return document.turns.filter((turn) => !turn.compaction || turn.prompt || turn.steps?.length) }
