// Codex project discovery reads metadata only; load explicitly reads one selected body.
// SQLite files and desktop state are always opened read-only. No registry or source writes.
import { readdir, readFile, open, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, win32 } from 'node:path'
import { createHash } from 'node:crypto'
import { withReadOnlyDb, columnsOf, tableNames } from '../sources/sqlite.mjs'
import { codexSubagentMarker } from '../convert/codex.mjs'
import { convertCodexProjectItems, convertCodexProjectRollout } from './convert.mjs'

const nonempty = (v) => typeof v === 'string' && v.length > 0
const warning = (warnings, code, error, path) => warnings.push({ code, ...(path ? { path } : {}), ...(error ? { message: String(error.message || error) } : {}) })
const normalPath = (value) => {
  const text = String(value || '').replace(/^\\\\\?\\/, '').replaceAll('\\', '/').replace(/\/+$/, '')
  return /^[a-z]:\//i.test(text) || text.startsWith('//') ? text.toLowerCase() : text
}
const timestamp = (row) => Number.isSafeInteger(row.created_at_ms) ? row.created_at_ms
  : Number.isFinite(row.created_at) ? Math.round(row.created_at * 1000) : 0
const selectColumns = (available, wanted) => wanted.filter((name) => available.has(name)).map((name) => '"' + name + '"').join(', ')
const sha = (value) => createHash('sha256').update(value).digest('hex')
const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v

async function optionalJson(path, warnings) {
  try { return JSON.parse(await readFile(path, 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') warning(warnings, 'invalid-desktop-state', error, path); return {} }
}

async function highestDb(home, prefix, warnings) {
  let entries
  try { entries = await readdir(home) }
  catch (error) { warning(warnings, 'codex-home-unreadable', error, home); return null }
  const re = new RegExp('^' + prefix + '_(\\d+)\\.sqlite$')
  return entries.map((name) => ({ name, version: Number(name.match(re)?.[1] ?? -1) }))
    .filter((e) => e.version >= 0).sort((a, b) => b.version - a.version).map((e) => join(home, e.name))[0] || null
}

function readMetadata(path, warnings) {
  if (!path) { warning(warnings, 'state-database-missing'); return { threads: [], projects: [], roots: [], children: [] } }
  try {
    return withReadOnlyDb(path, (db) => {
      const tables = tableNames(db)
      const rows = { threads: [], projects: [], roots: [], children: [] }
      if (tables.has('threads')) {
        const cols = columnsOf(db, 'threads')
        if (!cols.has('id')) warning(warnings, 'threads-schema-missing-id', null, path)
        else rows.threads = db.prepare('SELECT ' + selectColumns(cols, ['id', 'cwd', 'title', 'name', 'model', 'source', 'thread_source', 'project_id', 'created_at', 'created_at_ms', 'updated_at', 'updated_at_ms', 'rollout_path', 'attached_thread_parent_id', 'parent_thread_id', 'archived']) + ' FROM threads').all()
      } else warning(warnings, 'threads-table-missing', null, path)
      if (tables.has('projects')) rows.projects = db.prepare('SELECT * FROM projects').all()
      if (tables.has('project_roots')) rows.roots = db.prepare('SELECT * FROM project_roots').all()
      if (tables.has('thread_spawn_edges')) {
        const cols = columnsOf(db, 'thread_spawn_edges')
        const child = ['child_thread_id', 'child_id', 'child'].find((c) => cols.has(c))
        if (child) rows.children = db.prepare('SELECT "' + child + '" AS id FROM thread_spawn_edges').all().map((r) => r.id)
        else warning(warnings, 'spawn-edges-schema-unsupported', null, path)
      }
      return rows
    })
  } catch (error) { warning(warnings, 'state-database-unreadable', error, path); return { threads: [], projects: [], roots: [], children: [] } }
}

function readHistoryCounts(path, warnings) {
  if (!path) { warning(warnings, 'history-database-missing'); return new Map() }
  try {
    return withReadOnlyDb(path, (db) => {
      const cols = columnsOf(db, 'thread_items')
      if (!cols.has('thread_id') || !cols.has('item_json')) { warning(warnings, 'thread-items-schema-unsupported', null, path); return new Map() }
      // No item_json is selected during preview, even for very large databases.
      return new Map(db.prepare('SELECT thread_id, COUNT(*) AS count FROM thread_items GROUP BY thread_id').all().map((r) => [r.thread_id, r.count]))
    })
  } catch (error) { warning(warnings, 'history-database-unreadable', error, path); return new Map() }
}

async function readTitleIndex(home, warnings) {
  const titles = new Map(), path = join(home, 'session_index.jsonl')
  let raw
  try { raw = await readFile(path, 'utf8') }
  catch (error) { if (error.code !== 'ENOENT') warning(warnings, 'title-index-unreadable', error, path); return titles }
  let malformed = 0
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    try { const row = JSON.parse(line); if (nonempty(row.id) && nonempty(row.thread_name)) titles.set(row.id, row.thread_name) }
    catch { malformed++ }
  }
  if (malformed) warnings.push({ code: 'title-index-malformed-lines', count: malformed, path })
  return titles
}

async function rolloutMetadata(home, warnings, signal) {
  const records = new Map()
  const walk = async (dir, depth = 0) => {
    signal?.throwIfAborted()
    if (depth > 8) { warning(warnings, 'rollout-depth-limit', null, dir); return }
    let files
    try { files = await readdir(dir, { withFileTypes: true }) }
    catch (error) { if (error.code !== 'ENOENT') warning(warnings, 'rollout-directory-unreadable', error, dir); return }
    for (const entry of files) {
      signal?.throwIfAborted()
      const path = join(dir, entry.name)
      if (entry.isDirectory()) { await walk(path, depth + 1); continue }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      let handle
      try {
        handle = await open(path, 'r')
        const buf = Buffer.alloc(65536), { bytesRead } = await handle.read(buf, 0, buf.length, 0)
        const lines = buf.subarray(0, bytesRead).toString('utf8').split('\n')
        let meta
        for (const line of lines) {
          try { const r = JSON.parse(line); if (r.type === 'session_meta') { meta = r.payload; break } }
          catch { /* Bounded head may end midway through the last JSONL line. */ }
        }
        if (!nonempty(meta?.id)) { warning(warnings, 'rollout-session-meta-missing', null, path); continue }
        const record = records.get(meta.id) || { ...meta, id: meta.id, rolloutPaths: [] }
        record.rolloutPaths.push(path)
        records.set(meta.id, record)
      } catch (error) { warning(warnings, 'rollout-unreadable', error, path) }
      finally { if (handle) await handle.close() }
    }
  }
  await walk(join(home, 'sessions'))
  await walk(join(home, 'archived_sessions'))
  return records
}

function excludedThread(thread, childIds) {
  if (childIds.has(thread.id) || thread.attached_thread_parent_id || thread.parent_thread_id) return 'child-thread'
  if (/subagent|guardian/i.test(String(thread.thread_source || ''))) return 'subagent-or-guardian'
  let source = thread.source
  if (typeof source === 'string') { try { source = JSON.parse(source) } catch { /* Plain source labels (cli/vscode/exec) are not JSON. */ } }
  if (codexSubagentMarker({ ...thread, source }) || /guardian/i.test(typeof source === 'string' ? source : JSON.stringify(source || {}))) return 'subagent-or-guardian'
  return null
}

function buildProjects(desktop, metadata, warnings) {
  const projects = new Map(), aliases = new Map()
  for (const [key, value] of Object.entries(desktop['local-projects'] || {})) {
    if (!value || typeof value !== 'object') continue
    const roots = (Array.isArray(value.rootPaths) ? value.rootPaths : []).filter(nonempty)
    if (!roots.length) { warnings.push({ code: 'project-root-missing', projectId: key }); continue }
    const id = value.id || key
    projects.set(id, { id, name: value.name || roots[0].split(/[\\/]/).at(-1), cwd: roots[0], roots, sessions: [], evidence: ['desktop-local-project'] })
    aliases.set(key, id)
  }
  for (const project of metadata.projects) {
    const roots = metadata.roots.filter((r) => r.project_id === project.id).sort((a, b) => (a.position || 0) - (b.position || 0)).map((r) => r.path).filter(nonempty)
    if (!roots.length) continue
    const existing = [...projects.values()].find((p) => p.id === project.id || p.roots.some((r) => roots.some((root) => normalPath(r) === normalPath(root))))
    if (existing) { aliases.set(project.id, existing.id); continue }
    projects.set(project.id, { id: project.id, name: project.name || roots[0].split(/[\\/]/).at(-1), cwd: roots[0], roots, sessions: [], evidence: ['database-project'] })
  }
  return { projects, aliases }
}

/**
 * Discover project/session metadata only. No history bodies are read here.
 * `missing` contains selected sessions whose database and rollout body are both absent.
 * Root inference is explicit evidence, never claimed to be a native project assignment.
 */
export async function scanCodexProjects({ codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'), includeInferred = true, signal } = {}) {
  signal?.throwIfAborted()
  const home = resolve(codexHome), warnings = [], missing = [], excluded = []
  const desktop = await optionalJson(join(home, '.codex-global-state.json'), warnings)
  const stateDatabase = await highestDb(home, 'state', warnings), historyDatabase = await highestDb(home, 'thread_history', warnings)
  const metadata = readMetadata(stateDatabase, warnings), counts = readHistoryCounts(historyDatabase, warnings)
  const titles = await readTitleIndex(home, warnings), rollouts = await rolloutMetadata(home, warnings, signal)
  const { projects, aliases } = buildProjects(desktop, metadata, warnings)
  const assignments = new Map()
  for (const [id, assignment] of Object.entries(desktop['thread-project-assignments'] || {})) {
    if (assignment && typeof assignment === 'object' && assignment.projectId) assignments.set(id, { projectId: assignment.projectId, kind: 'desktop-assignment' })
  }
  for (const [projectId, order] of Object.entries(desktop['sidebar-project-thread-orders'] || {})) {
    for (const id of Array.isArray(order?.threadIds) ? order.threadIds : []) if (!assignments.has(id)) assignments.set(id, { projectId, kind: 'desktop-sidebar-order' })
  }
  const rows = new Map(metadata.threads.map((r) => [r.id, r]))
  for (const [id, rollout] of rollouts) if (!rows.has(id)) rows.set(id, rollout)
  for (const id of assignments.keys()) if (!rows.has(id)) rows.set(id, { id })
  const childIds = new Set(metadata.children), projectless = new Set(desktop['projectless-thread-ids'] || [])
  const sessions = []
  for (const thread of rows.values()) {
    signal?.throwIfAborted()
    const rollout = rollouts.get(thread.id)
    const reason = excludedThread(thread, childIds) || (rollout && excludedThread(rollout, childIds))
    if (reason) { excluded.push({ id: thread.id, reason }); continue }
    const explicit = assignments.get(thread.id) || (thread.project_id ? { projectId: thread.project_id, kind: 'database-assignment' } : null)
    let project = explicit ? projects.get(aliases.get(explicit.projectId) || explicit.projectId) : null
    let evidence = explicit ? explicit.kind : null
    if (explicit && !project) { warnings.push({ code: 'unknown-project-assignment', sessionId: thread.id, projectId: explicit.projectId }); continue }
    if (!project && includeInferred && !projectless.has(thread.id) && (thread.thread_source === 'user' || (!thread.thread_source && ['cli', 'exec', 'vscode'].includes(thread.source)))) {
      const cwd = normalPath(thread.cwd || rollout?.cwd)
      const matches = [...projects.values()].filter((p) => p.roots.some((r) => normalPath(r) === cwd))
      if (matches.length === 1) { project = matches[0]; evidence = 'unique-project-root' }
      else if (matches.length > 1) warnings.push({ code: 'ambiguous-project-root', sessionId: thread.id })
    }
    if (!project) continue
    const paths = [...(rollout?.rolloutPaths || [])]
    if (nonempty(thread.rollout_path)) {
      const path = /^[a-z]:[\\/]/i.test(thread.rollout_path) || thread.rollout_path.startsWith('\\\\') ? win32.normalize(thread.rollout_path) : resolve(home, thread.rollout_path)
      try { if ((await stat(path)).isFile() && !paths.some((p) => normalPath(p) === normalPath(path))) paths.push(path) }
      catch (error) { if (error.code !== 'ENOENT') warning(warnings, 'indexed-rollout-unreadable', error, path) }
    }
    const hasDatabaseBody = (counts.get(thread.id) || 0) > 0
    const session = { id: thread.id, title: titles.get(thread.id) || thread.name || thread.title || thread.id,
      titleSource: titles.has(thread.id) ? 'session-index' : thread.name ? 'database-name' : thread.title ? 'database-title' : 'session-id',
      cwd: project.cwd, projectId: project.id, projectName: project.name, createdAt: timestamp(thread),
      ...(thread.model ? { model: thread.model } : {}), archived: !!thread.archived,
      evidence: { kind: evidence, explicit: evidence !== 'unique-project-root', inferred: evidence === 'unique-project-root' },
      source: { kind: hasDatabaseBody ? 'database' : paths.length ? 'rollout' : 'missing', stateDatabase, historyDatabase, rolloutPaths: paths.sort(), itemCount: counts.get(thread.id) || 0 },
      hasBody: hasDatabaseBody || paths.length > 0 }
    if (!session.hasBody) missing.push({ id: session.id, sessionId: session.id, projectId: project.id, projectName: project.name, reason: 'body-missing' })
    sessions.push(session)
    project.sessions.push(session)
  }
  for (const project of projects.values()) {
    try { project.directoryExists = (await stat(project.cwd)).isDirectory() }
    catch (error) { project.directoryExists = false; if (error.code !== 'ENOENT') warning(warnings, 'project-directory-unreadable', error, project.cwd) }
  }
  return { codexHome: home, stateDatabase, historyDatabase, projects: [...projects.values()], sessions, warnings, missing, excluded,
    counts: { projects: projects.size, sessions: sessions.length, missingBodies: missing.length, inferred: sessions.filter((s) => s.evidence.inferred).length } }
}

/** Load one body from a prior scan, freshly re-reading its SQLite rows or rollout pages. */
export async function loadCodexProjectSession(scan, sessionId, options = {}) {
  options.signal?.throwIfAborted()
  const session = scan.sessions.find((s) => s.id === sessionId)
  if (!session) throw new Error('Codex project session not in scan: ' + sessionId)
  const warnings = []
  let result, body
  if (session.source.historyDatabase) {
    try {
      body = withReadOnlyDb(session.source.historyDatabase, (db) => {
        const cols = columnsOf(db, 'thread_items')
        if (!cols.has('thread_id') || !cols.has('item_json')) throw new Error('thread_items requires thread_id and item_json')
        const order = ['rollout_ordinal', 'created_at_ms', 'item_id'].filter((c) => cols.has(c)).map((c) => '"' + c + '"').join(', ')
        return db.prepare('SELECT ' + selectColumns(cols, ['thread_id', 'item_id', 'item_json', 'created_at_ms', 'started_at_ms', 'rollout_ordinal'])
          + ' FROM thread_items WHERE thread_id = ?' + (order ? ' ORDER BY ' + order : '')).all(sessionId)
      })
      if (body.length) result = convertCodexProjectItems(body, session, options)
    } catch (error) { warning(warnings, 'session-history-read-failed', error, session.source.historyDatabase) }
  }
  if (!result?.document.turns.length && session.source.rolloutPaths.length) {
    const pages = []
    for (const path of session.source.rolloutPaths) { options.signal?.throwIfAborted(); pages.push(await readFile(path, 'utf8')) }
    body = pages.join('\n')
    if (result) warnings.push(...result.warnings)
    result = convertCodexProjectRollout(body, session, options)
  }
  if (!result?.document.turns.length) return { sessionId, document: null, sourceHash: null,
    warnings: [...warnings, ...(result?.warnings || []), { code: 'session-body-unavailable', sessionId }],
    diagnostics: { ...(result?.diagnostics || {}), missingBody: true } }
  // Hash actual body + authoritative metadata, not WAL/SQLite file timestamps.
  const sourceHash = sha(JSON.stringify(canonical({ id: session.id, title: session.title, cwd: session.cwd,
    createdAt: session.createdAt, model: session.model || null, body })))
  return { ...result, sessionId, sourceHash, warnings: [...warnings, ...result.warnings] }
}
