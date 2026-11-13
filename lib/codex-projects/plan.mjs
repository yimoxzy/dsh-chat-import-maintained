// Read-only decisions are shared by the stock panel and actual import execution.
import { convertGenericJson } from '../convert/generic.mjs'
import { readSessionRecord } from '../host-session.mjs'
import { atomHashes, hashValue, isPrefix } from './history.mjs'
import { turnHashes } from './updates.mjs'
import { verifyAdoption } from './adoption.mjs'

export function documentEvidence(document) {
  const converted = convertGenericJson(JSON.stringify(document), { budget: 0 })
  const boundaries = []
  let turnEvents = [], atomCount = 0
  for (const event of converted.events) {
    turnEvents.push(event)
    if (event.type === 'turn/end') { atomCount += atomHashes(turnEvents).length; boundaries.push(atomCount); turnEvents = [] }
  }
  return { sourceAtoms: atomHashes(converted.events), sourceTurns: turnHashes(document), sourceTurnCount: turnHashes(document).length, turnAtomBoundaries: boundaries }
}

export async function classifyProjectSession(ctx, session, document, fingerprint, known, candidates) {
  const evidence = documentEvidence(document)
  if (known) {
    const record = await readSessionRecord(ctx, known.sessionId)
    if (!record) return { migrationAction: 'ambiguous', reason: 'recorded-target-unreadable', existingSessionId: known.sessionId, evidence }
    if (known.sourceHash === fingerprint) return { migrationAction: 'unchanged', reason: 'source-unchanged', record, known, evidence, existingSessionId: known.sessionId }
    const targetAtoms = atomHashes(record.events)
    const targetUnchanged = known.targetAtoms && hashValue(targetAtoms) === hashValue(known.targetAtoms)
    const appendOnlySource = known.sourceTurns && isPrefix(known.sourceTurns, evidence.sourceTurns)
    if (targetUnchanged && appendOnlySource && !known.continued && known.cwd === session.cwd) {
      return { migrationAction: 'update', reason: known.sourceTurns.length === evidence.sourceTurns.length ? 'source-metadata-changed' : 'source-grew-target-unchanged',
        existingSessionId: known.sessionId, record, known, evidence, previousTurnCount: known.sourceTurns.length }
    }
    return { migrationAction: 'conflict', reason: !targetUnchanged || known.continued ? 'continued-or-edited-in-dsh' : 'source-history-rewritten',
      existingSessionId: known.sessionId, record, known, evidence }
  }
  const adoption = await verifyAdoption(ctx, session, document, candidates)
  if (adoption.kind === 'ambiguous' || adoption.kind === 'unverified') return { migrationAction: 'ambiguous', reason: adoption.reason,
    existingSessionId: adoption.sessionId, candidates: adoption.candidates, evidence }
  if (adoption.kind === 'verified') {
    const baseline = adoption.sourceAtoms
    const target = adoption.targetAtoms
    const sameSource = hashValue(baseline) === hashValue(evidence.sourceAtoms)
    const targetContinued = hashValue(target) !== hashValue(baseline)
    if (sameSource) return { migrationAction: 'adoptable', reason: targetContinued ? 'verified-legacy-with-dsh-continuation' : 'verified-legacy-identical',
      existingSessionId: adoption.sessionId, resolvedCwd: adoption.resolvedCwd, record: adoption.record, adoption, continued: targetContinued, evidence }
    const boundary = evidence.turnAtomBoundaries.indexOf(baseline.length)
    if (!targetContinued && baseline.length > 0 && isPrefix(baseline, evidence.sourceAtoms) && boundary >= 0 && boundary + 1 < evidence.sourceTurnCount) {
      return { migrationAction: 'update', reason: 'verified-legacy-source-grew', existingSessionId: adoption.sessionId,
        resolvedCwd: adoption.resolvedCwd, record: adoption.record, adoption, previousTurnCount: boundary + 1, evidence }
    }
    return { migrationAction: 'conflict', reason: targetContinued ? 'legacy-source-and-dsh-changed' : 'legacy-source-changed-needs-reviewed-copy',
      existingSessionId: adoption.sessionId, resolvedCwd: adoption.resolvedCwd, record: adoption.record, adoption, evidence }
  }
  return { migrationAction: 'new', reason: 'no-existing-import-evidence', evidence }
}
