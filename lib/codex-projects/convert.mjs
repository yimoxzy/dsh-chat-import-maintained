// Codex Desktop history items -> interchange v1. Pure: no filesystem or host services.
// Original activity without a reconstructable tool contract stays labelled source JSON.
import { convertCodexJsonl } from '../convert/codex.mjs'

const textBlock = (text) => ({ type: 'text', text })
const jsonText = (value) => JSON.stringify(value)
const optionalTime = (value) => Number.isSafeInteger(value) && value >= 0 ? value : undefined

function activity(step, item) {
  step.content.push(textBlock('[Codex activity record] ' + jsonText(item)))
}

function addTool(step, item, row, diagnostics) {
  let name, args, result
  if (item.type === 'commandExecution') {
    name = 'exec_command'
    args = { cmd: item.command, cwd: item.cwd }
    result = { output: item.aggregatedOutput, exitCode: item.exitCode, status: item.status, durationMs: item.durationMs }
  } else if (item.type === 'mcpToolCall') {
    name = [item.server, item.tool].filter(Boolean).join('__')
    args = item.arguments
    result = { result: item.result, error: item.error, status: item.status }
  } else {
    name = [item.namespace, item.tool].filter(Boolean).join('__')
    args = item.arguments
    result = { contentItems: item.contentItems, success: item.success, status: item.status }
  }
  const id = item.id || row.item_id
  if (typeof id !== 'string' || !id || !name) {
    diagnostics.unstructuredTools++
    activity(step, item)
    return
  }
  const argumentsText = typeof args === 'string' ? args : jsonText(args ?? {})
  const call = { id, name, arguments: argumentsText }
  step.content.push({ type: 'tool-call', ...call })
  step.toolCalls = [call]
  // Only include result fields present in the source. An unfinished activity is not a result.
  const hasOutput = item.type === 'commandExecution' && item.aggregatedOutput !== undefined && item.aggregatedOutput !== null
  const hasResult = item.type === 'commandExecution'
    ? ['aggregatedOutput', 'exitCode', 'status', 'durationMs'].some((key) => Object.hasOwn(item, key))
    : item.type === 'mcpToolCall' ? (item.result !== null && item.result !== undefined) || (item.error !== null && item.error !== undefined)
      : (item.contentItems !== null && item.contentItems !== undefined) || item.success !== undefined
  // A null/missing output is not invented output. Preserve explicit execution
  // status/duration/exit metadata as factual source data, and report its absence.
  if (item.type === 'commandExecution' && !hasOutput && hasResult) diagnostics.missingToolResults++
  if (hasResult) step.toolResults = [{ toolCallId: id, content: [textBlock(jsonText(result))],
    ...(item.status === 'failed' || item.success === false ? { isError: true } : {}),
    ...(step.time === undefined ? {} : { time: step.time }) }]
  else diagnostics.missingToolResults++
}

/** Convert ordered thread_items rows. Empty encrypted reasoning has no recoverable text. */
export function convertCodexHistoryItems(rows) {
  const turns = []
  const diagnostics = { malformedItems: 0, emptyReasoning: 0, attachmentMetadata: 0,
    compactionSummaryMissing: 0, activityRecords: 0, unstructuredTools: 0, missingToolResults: 0, types: {} }
  let turn
  const current = () => {
    if (!turn) { turn = { steps: [] }; turns.push(turn) }
    return turn
  }
  for (const row of rows) {
    let item
    try { item = typeof row.item_json === 'string' ? JSON.parse(row.item_json) : row.item_json ?? row }
    catch { diagnostics.malformedItems++; continue }
    if (!item || typeof item !== 'object' || typeof item.type !== 'string') { diagnostics.malformedItems++; continue }
    diagnostics.types[item.type] = (diagnostics.types[item.type] || 0) + 1
    const time = optionalTime(row.created_at_ms ?? row.started_at_ms)
    if (item.type === 'userMessage') {
      const blocks = []
      for (const block of Array.isArray(item.content) ? item.content : []) {
        if (block.type === 'text' && typeof block.text === 'string') blocks.push(textBlock(block.text))
        else {
          diagnostics.attachmentMetadata++
          blocks.push(textBlock('[Codex attachment metadata; bytes not recovered] ' + jsonText(block)))
        }
      }
      turn = { prompt: blocks.map((b) => b.text).join('\n'), promptBlocks: blocks, steps: [], ...(time === undefined ? {} : { time }) }
      turns.push(turn)
      continue
    }
    const step = { content: [], ...(time === undefined ? {} : { time }) }
    if (item.type === 'agentMessage' || item.type === 'plan') {
      if (typeof item.text === 'string') step.content.push(textBlock(item.text))
      else { activity(step, item); diagnostics.activityRecords++ }
    } else if (item.type === 'reasoning') {
      const parts = [...(Array.isArray(item.summary) ? item.summary : []), ...(Array.isArray(item.content) ? item.content : [])]
      for (const part of parts) {
        const text = typeof part === 'string' ? part : part?.text
        if (typeof text === 'string' && text) step.content.push({ type: 'reasoning', text })
        else if (part !== null && part !== undefined) { activity(step, part); diagnostics.activityRecords++ }
      }
      if (!step.content.length) { diagnostics.emptyReasoning++; continue }
    } else if (item.type === 'contextCompaction') {
      // This database projection commonly has only an id. Never invent its lost summary.
      activity(step, item)
      if (!item.summary && !item.text) diagnostics.compactionSummaryMissing++
      diagnostics.activityRecords++
    } else if (['commandExecution', 'mcpToolCall', 'dynamicToolCall'].includes(item.type)) {
      addTool(step, item, row, diagnostics)
    } else { activity(step, item); diagnostics.activityRecords++ }
    current().steps.push(step)
  }
  return { turns: turns.filter((t) => t.prompt || t.steps.length), diagnostics }
}

/** Preserve full source IR in the log; a truthful notice bounds the active model context. */
export function codexProjectDocument(session, turns, { archiveNotice = true } = {}) {
  const preserved = JSON.parse(JSON.stringify(turns))
  // Existing JSONL converters may have explicit lists; always advertise those same calls.
  for (const turn of preserved) {
    // A parser may retain a source checkpoint even in full-history mode. Keep its
    // actual text as an activity note before replacing only its context semantics.
    if (turn.compaction) {
      turn.steps ??= []
      turn.steps.unshift({ content: [textBlock('[Codex source compaction record] ' + jsonText(turn.compaction))] })
    }
    delete turn.compaction
    delete turn.shadowed
    for (const step of turn.steps || []) {
      step.content ??= []
      for (const tc of step.toolCalls || []) {
        const args = typeof tc.arguments === 'string' ? tc.arguments : jsonText(tc.arguments ?? {})
        tc.arguments = args
        if (!step.content.some((b) => b.type === 'tool-call' && b.id === tc.id)) step.content.push({ type: 'tool-call', id: tc.id, name: tc.name, arguments: args })
      }
    }
  }
  if (archiveNotice && preserved.length) {
    for (const turn of preserved) turn.shadowed = true
    preserved.push({ compaction: { summary: 'Codex project history archive: all ' + preserved.length
      + ' source turns are retained before this checkpoint without clipping. This notice is not a semantic summary. Project: '
      + session.projectName + '. Read the archived history when prior details are needed.', provider: 'codex-project-history' }, steps: [] })
  }
  return { interchange: 'dsh-chat-import', version: 1,
    meta: { id: 'codex-project-' + session.id, createdAt: session.createdAt ?? 0, cwd: session.cwd },
    title: session.title || session.id, provider: 'codex', ...(session.model ? { model: session.model } : {}), turns: preserved }
}

/** Reuse the existing rollout parser, without source compaction or budget clipping. */
export function convertCodexProjectRollout(raw, session, options = {}) {
  const converted = convertCodexJsonl(raw, { budget: 0, fullHistory: true })
  const warnings = []
  for (const key of ['skipped', 'skippedLines', 'secrets', 'imagesDegraded', 'droppedMalformedArgs', 'droppedMalformedOutputs']) {
    const value = converted[key]
    if ((Array.isArray(value) && value.length) || (typeof value === 'number' && value)) warnings.push({ code: 'rollout-' + key, count: Array.isArray(value) ? value.length : value })
  }
  if (converted.skipReason) warnings.push({ code: 'rollout-skipped', reason: converted.skipReason })
  return { document: codexProjectDocument(session, converted.turns || [], options), diagnostics: { format: 'rollout', sourceTurns: converted.turns?.length || 0 }, warnings }
}

/** Pure database entry point; source hash is calculated by the IO layer. */
export function convertCodexProjectItems(rows, session, options = {}) {
  const { turns, diagnostics } = convertCodexHistoryItems(rows)
  const warnings = Object.entries(diagnostics).filter(([key, value]) => key !== 'types' && typeof value === 'number' && value > 0)
    .map(([code, count]) => ({ code, count }))
  return { document: codexProjectDocument(session, turns, options), diagnostics, warnings }
}
