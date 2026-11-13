// Stock panel adapter for project-backed Codex sessions. Opaque identities are never files.
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { codexPanelWarnings } from './warnings.mjs'

const PREFIX = 'codex-project://'
const CACHE_LIMIT = 8
const CACHE_IDLE_MS = 5 * 60_000
export const isCodexProjectPath = (value) => typeof value === 'string' && value.startsWith(PREFIX)
export const codexProjectPath = (home, id) => PREFIX + encodeURIComponent(resolve(home)) + '/' + encodeURIComponent(id)

export function parseCodexProjectPath(value) {
  if (!isCodexProjectPath(value)) return null
  const parts = value.slice(PREFIX.length).split('/')
  if (parts.length !== 2 || !parts.every(Boolean)) throw new Error('Invalid Codex project identity')
  const home = decodeURIComponent(parts[0]), id = decodeURIComponent(parts[1])
  if (!home || !id || codexProjectPath(home, id) !== value) throw new Error('Invalid Codex project identity')
  return { codexHome: home, sessionId: id }
}

function statusFor(action) {
  if (action === 'unchanged') return 'imported'
  if (['update', 'conflict', 'adoptable'].includes(action)) return 'partial'
  return 'not-imported'
}

export function buildCodexPanelRows(preview, query = '') {
  const classifications = new Map((preview.results || []).map((entry) => [entry.sourceId, entry]))
  const needle = query.toLocaleLowerCase()
  return (preview.scan.sessions || []).map((session) => {
    const classification = classifications.get(session.id) || {}
    const action = classification.migrationAction || (session.hasBody ? 'new' : 'missing')
    return { format: 'codex', sessionId: session.id, sourcePath: codexProjectPath(preview.scan.codexHome, session.id),
      title: session.title, project: session.projectName, cwd: classification.cwd || session.cwd,
      createdAt: session.createdAt ?? null, lastActiveAt: session.lastActiveAt ?? session.createdAt ?? null,
      importStatus: statusFor(action), migrationAction: action,
      ...(classification.existingSessionId ? { existingSessionId: classification.existingSessionId } : {}),
      ...(classification.reason ? { migrationReason: classification.reason } : {}),
      projectId: session.projectId, evidence: session.evidence }
  }).filter((row) => !needle || [row.title, row.project, row.cwd].some((value) => String(value || '').toLocaleLowerCase().includes(needle)))
}

export function createCodexPanelBridge(ctx, { preview = async (input) => (await import('./pipeline.mjs')).previewCodexProjects(ctx, input),
  migrate = async (input) => (await import('./pipeline.mjs')).importCodexProjects(ctx, input) } = {}) {
  const scans = new Map()
  async function accepts(body) {
    if (body.source !== 'codex') return false
    if (!body.path) return true
    if (isCodexProjectPath(body.path)) throw new Error('A project identity is not a Codex data directory')
    // Direct JSONL and other file imports retain the upstream route.
    try { return (await stat(body.path)).isDirectory() } catch { return false }
  }
  async function sessions(body) {
    if (!await accepts(body)) return null
    const codexHome = body.path || body.codexHome
    const epoch = Number.isFinite(body.epoch) ? Math.trunc(body.epoch) : 0
    const query = typeof body.query === 'string' ? body.query : ''
    const key = JSON.stringify([codexHome || '', epoch])
    const now = Date.now()
    for (const [cachedKey, entry] of scans) if (now - entry.active > CACHE_IDLE_MS) scans.delete(cachedKey)
    let entry = scans.get(key)
    if (!entry) {
      while (scans.size >= CACHE_LIMIT) scans.delete(scans.keys().next().value)
      entry = { active: now, partial: [], done: false, result: null, error: null }
      entry.promise = preview({ codexHome, includeInferred: true, onDecision: (decision, scan) => {
        const row = buildCodexPanelRows({ scan: { ...scan, sessions: scan.sessions.filter((session) => session.id === decision.sourceId) }, results: [decision] })[0]
        if (row) entry.partial.push(row)
      } }).then((result) => { entry.result = result; entry.done = true; return result })
        .catch((error) => { entry.error = String(error.message || error); entry.done = true; return null })
      scans.set(key, entry)
    }
    entry.active = now
    if (!Number.isFinite(body.after)) await entry.promise
    else await Promise.resolve() // Immediately resolved previews remain one-response scans.
    if (entry.done && entry.error) throw new Error(entry.error)
    const result = entry.result
    const needle = query.toLocaleLowerCase()
    const rows = result ? buildCodexPanelRows(result, query) : entry.partial.filter((row) => !needle || [row.title, row.project, row.cwd].some((value) => String(value || '').toLocaleLowerCase().includes(needle)))
    const warnings = codexPanelWarnings(result, result?.scan.codexHome || codexHome || 'Codex')
    if (Number.isFinite(body.after)) {
      const after = Math.max(0, Math.trunc(body.after)), cursor = Math.min(rows.length, after + 500)
      return { ok: true, sessions: rows.slice(after, cursor), cursor, done: entry.done && cursor >= rows.length, total: entry.done ? rows.length : null,
        warnings, counts: result?.counts, codexProjects: true }
    }
    const offset = Number.isFinite(body.offset) ? Math.max(0, Math.trunc(body.offset)) : 0
    const limit = Number.isFinite(body.limit) && body.limit > 0 ? Math.trunc(body.limit) : rows.length
    return { ok: true, sessions: rows.slice(offset, offset + limit), total: rows.length, offset, limit, warnings,
      counts: result.counts, codexProjects: true }
  }
  async function importRows(body) {
    const items = Array.isArray(body.items) ? body.items : []
    const modern = items.filter((item) => isCodexProjectPath(item?.sourcePath))
    if (!modern.length) return null
    if (modern.length !== items.length) throw new Error('Import Codex project rows separately from other source formats')
    if (body.replace) throw new Error('Codex project migration never replaces existing conversation history')
    if (body.workspaceId) throw new Error('Codex project rows retain their source project; use project cwdRemap when moving folders')
    if (body.target && !['dsh', 'dsh4'].includes(body.target)) throw new Error('Codex project rows import only to the native DSH session format')
    const groups = new Map()
    for (const item of modern) {
      if (item.source !== 'codex') throw new Error('Codex project identity requires the Codex source')
      const parsed = parseCodexProjectPath(item.sourcePath)
      if (item.sessionId !== parsed.sessionId) throw new Error('Codex project session identity mismatch')
      const ids = groups.get(parsed.codexHome) || new Set()
      ids.add(parsed.sessionId); groups.set(parsed.codexHome, ids)
    }
    // Revalidate selected ids against a fresh authoritative scan; body evidence and paths are not authority.
    const verified = []
    for (const [codexHome, ids] of groups) {
      const scan = await preview({ codexHome, includeInferred: true, sessionIds: [...ids], metadataOnly: true })
      const available = new Set((scan.scan.sessions || []).map((session) => session.id))
      for (const id of ids) if (!available.has(id)) throw new Error('Codex source session is no longer available; refresh the list')
      verified.push({ codexHome, ids })
    }
    const results = []
    for (const group of verified) {
      const output = await migrate({ codexHome: group.codexHome, includeInferred: true, sessionIds: [...group.ids], preview: false, force: body.force === true })
      for (const result of output.results || []) results.push({ ...result, format: 'codex', sourcePath: codexProjectPath(group.codexHome, result.sourceId), mode: 'single',
        status: result.status === 'unchanged' ? 'already-imported' : result.status })
    }
    scans.clear()
    return { ok: true, target: body.target || 'dsh', results, codexProjects: true }
  }
  return { sessions, importRows }
}

export function refuseCodexFileAction(body) {
  return isCodexProjectPath(body?.sourcePath) || (Array.isArray(body?.items) && body.items.some((item) => isCodexProjectPath(item?.sourcePath)))
}
export const CODEX_FILE_ACTION_ERROR = 'Codex project database rows are not standalone files; preview, content search, hide and source deletion are unavailable for this row'
