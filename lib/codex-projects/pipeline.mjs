// Project migration owns a separate ledger; existing stock-import history is never rewritten.
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, isAbsolute, resolve } from 'node:path'
import { scanCodexProjects, loadCodexProjectSession } from './source.mjs'
import { convertGenericJson } from '../convert/generic.mjs'
import { createSession, readSessionRecord, prepareHostEvents, hostNativeFormatVersion } from '../host-session.mjs'

const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value
const digest = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const sourceKey = (root, id) => digest([resolve(root), id])
let tail = Promise.resolve()

export function conversationDigest(events) {
  return digest(events.filter((event) => ['user/message', 'assistant/message', 'tool/call', 'tool/result'].includes(event.type))
    .map((event) => ({ type: event.type, data: event.data })))
}

export function migrationDirectory(input = {}) {
  return input.stateDirectory || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-chat-import-maintained', 'codex-projects')
}

async function readLedger(directory) {
  try {
    const value = JSON.parse(await readFile(join(directory, 'ledger.json'), 'utf8'))
    if (value.version !== 1 || !value.sessions || typeof value.sessions !== 'object') throw new Error('Unsupported migration ledger')
    return value
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, sessions: {} }
    throw error
  }
}

async function saveLedger(directory, ledger) {
  await mkdir(directory, { recursive: true })
  const temporary = join(directory, 'ledger.' + randomUUID() + '.tmp')
  await writeFile(temporary, JSON.stringify(ledger, null, 2), { mode: 0o600, flag: 'wx' })
  await rename(temporary, join(directory, 'ledger.json'))
}

function selectSessions(scan, input) {
  const projects = input.projectIds?.length ? new Set(input.projectIds) : null
  const sessions = input.sessionIds?.length ? new Set(input.sessionIds) : null
  if (projects) for (const id of projects) if (!scan.projects.some((project) => project.id === id)) throw new Error('Unknown project id: ' + id)
  if (sessions) for (const id of sessions) if (!scan.sessions.some((session) => session.id === id)) throw new Error('Unknown session id: ' + id)
  return scan.sessions.filter((session) => (!projects || projects.has(session.projectId)) && (!sessions || sessions.has(session.id)))
}

function remapCwd(cwd, rules = []) {
  const normalize = (value) => value.replaceAll('\\', '/').replace(/\/$/, '')
  const original = normalize(cwd)
  const match = [...rules].sort((a, b) => b.from.length - a.from.length)
    .find((rule) => original === normalize(rule.from) || original.startsWith(normalize(rule.from) + '/'))
  return match ? match.to + original.slice(normalize(match.from).length) : cwd
}

async function validateDestination(ctx, cwd) {
  if (!cwd || !isAbsolute(cwd)) throw new Error('Project directory must be an existing absolute path; supply cwdRemap when moving projects')
  const target = await ctx.fs.resolve(cwd)
  const info = await ctx.fs.stat(target)
  if (!info || info.type !== 'directory') throw new Error('Project directory is unavailable; supply cwdRemap: ' + cwd)
}

export async function verifyProjectSession(ctx, sessionId, expected) {
  const record = await readSessionRecord(ctx, sessionId)
  if (!record) throw new Error('Native persistence cannot read imported session: ' + sessionId)
  if (expected.events) {
    const nativeVersion = await hostNativeFormatVersion(ctx)
    const shaped = prepareHostEvents(expected.events, sessionId, record.meta.version, nativeVersion)
    if (conversationDigest(shaped) !== conversationDigest(record.events)) throw new Error('Persisted conversation differs from the complete source conversion')
  }
  const title = record.events.findLast((event) => event.type === 'session/title')?.data?.title
  if (title !== expected.title) throw new Error('Imported title differs from source')
  const workspace = await ctx.get('workspaceRegistry').resolveByPath(expected.cwd)
  if (!workspace?.sessionIds.includes(sessionId) || workspace.title !== expected.projectName) throw new Error('Project membership or name differs from source')
  const cache = ctx.get('sessionProjectionCache')
  let projectionVerified = false
  if (cache?.coldSnapshot) {
    const snapshot = await cache.coldSnapshot(record.meta, 0, record.events)
    const titleValue = snapshot.values?.title
    if (titleValue !== undefined && titleValue !== expected.title) throw new Error('Sidebar title projection differs from source')
    projectionVerified = true
  }
  return { record, title, workspaceId: workspace.id, conversationHash: conversationDigest(record.events), projectionVerified }
}

export async function synchronizeProjectList(ctx, expected) {
  const controller = ctx.get('sessionController')
  if (!controller?.list) return { supported: false, verified: false, missing: [], broadcast: 0 }
  const response = await controller.list({})
  const items = Array.isArray(response) ? response : response.items
  if (!Array.isArray(items)) throw new Error('Unsupported native session list response')
  const byId = new Map(items.map((item) => [item.sessionId, item]))
  const archived = new Set(ctx.get('workspaceRegistry').archivedSessionIds || [])
  const missing = []
  let broadcast = 0
  for (const entry of expected) {
    const item = byId.get(entry.sessionId)
    if (!item || item.blank || item.origin === 'subagent' || archived.has(entry.sessionId)) { missing.push(entry.sessionId); continue }
    const title = item.projections?.values?.title
    if (title !== entry.title) { missing.push(entry.sessionId); continue }
    ctx.emit('api-session/added', item)
    broadcast++
  }
  return { supported: true, verified: missing.length === 0, missing, broadcast }
}

async function execute(ctx, input) {
  const scan = await scanCodexProjects({ codexHome: input.codexHome, includeInferred: input.includeInferred !== false, signal: input.signal })
  const selected = selectSessions(scan, input)
  const summary = { preview: input.preview !== false, scanned: selected.length, imported: 0, alreadyImported: 0, failed: 0,
    results: [], warnings: [...(scan.warnings || [])], missing: scan.missing || [], projects: scan.projects.map(({ id, name, cwd, sessions }) => ({ id, name, cwd, sessions: sessions?.length || 0 })) }
  const directory = migrationDirectory(input)
  const ledger = await readLedger(directory)
  const expectedList = []
  for (const session of selected) {
    input.signal?.throwIfAborted()
    const item = { sourceId: session.id, projectId: session.projectId, projectName: session.projectName, title: session.title }
    summary.results.push(item)
    try {
      const loaded = await loadCodexProjectSession(scan, session.id, { signal: input.signal })
      if (loaded?.warnings?.length) {
        item.warnings = loaded.warnings
        summary.warnings.push({ sourceId: session.id, warnings: loaded.warnings })
      }
      if (loaded?.diagnostics) item.diagnostics = loaded.diagnostics
      if (!loaded?.document) throw new Error('No readable source conversation body')
      const document = loaded.document
      const project = scan.projects.find((value) => value.id === session.projectId)
      const projectName = session.projectName || project?.name
      const title = session.title || document.title
      const cwd = remapCwd(document.meta.cwd || session.cwd || project?.cwd, input.cwdRemap)
      item.projectName = projectName
      item.title = title
      item.cwd = cwd
      const fingerprint = digest([loaded.sourceHash || document, cwd, title, projectName])
      const key = sourceKey(scan.codexHome, session.id)
      const known = ledger.sessions[key]
      if (summary.preview) { item.status = known?.sourceHash === fingerprint ? 'already-imported' : 'would-import'; item.turns = document.turns.length; continue }
      if (!ctx.get('workspaceRegistry')) throw new Error('workspaceRegistry service is required for project migration')
      await validateDestination(ctx, cwd)
      if (!input.force && known?.sourceHash === fingerprint) {
        const verified = await verifyProjectSession(ctx, known.sessionId, { title, cwd, projectName })
        item.status = 'already-imported'; item.sessionId = known.sessionId; item.projectionVerified = verified.projectionVerified
        summary.alreadyImported++; expectedList.push({ sessionId: known.sessionId, title }); continue
      }
      // Changed source always creates a new immutable copy. User replies in a previous import remain untouched.
      const id = 'codex-project-' + key.slice(0, 24) + '-' + randomUUID().slice(0, 8)
      item.sessionId = id // A failed verification must still identify any created artifact.
      document.meta = { ...document.meta, id, cwd }
      document.title = title
      const converted = convertGenericJson(JSON.stringify(document), { budget: 1, sessionId: id })
      if (converted.trimmed || !converted.compacted) throw new Error('Complete-history conversion must retain all source turns and a bounded checkpoint')
      converted.events.push({ type: 'session/title', seq: converted.events.length, time: converted.events.at(-1)?.time || converted.meta.createdAt,
        data: { title, messageSeqs: [], source: { kind: 'user' } } })
      const workspace = await ctx.get('workspaceRegistry').resolveByPath(cwd) || await ctx.get('workspaceRegistry').create(cwd, projectName)
      if (workspace.title !== projectName) await workspace.setTitle(projectName)
      await createSession(ctx, { ...converted.meta, id, cwd }, converted.events)
      await ctx.sessionPersistence.flush?.()
      await workspace.attachSession(id)
      const verified = await verifyProjectSession(ctx, id, { title, cwd, projectName, events: converted.events })
      item.sessionId = id; item.status = 'imported'; item.projectionVerified = verified.projectionVerified
      ledger.sessions[key] = { sourceId: session.id, sourceHash: fingerprint, sessionId: id, title, cwd, projectName,
        conversationHash: verified.conversationHash, importedAt: new Date().toISOString(),
        copies: [...(known?.copies || []), ...(known ? [{ sessionId: known.sessionId, sourceHash: known.sourceHash }] : [])] }
      await saveLedger(directory, ledger)
      summary.imported++; expectedList.push({ sessionId: id, title })
    } catch (error) { item.status = 'failed'; item.error = String(error.message || error); summary.failed++ }
  }
  if (!summary.preview) {
    try { summary.verification = await synchronizeProjectList(ctx, expectedList) }
    catch (error) {
      summary.verification = { supported: true, verified: false, missing: expectedList.map((entry) => entry.sessionId), broadcast: 0 }
      summary.warnings.push({ code: 'list-service-error', message: String(error.message || error) })
    }
    if (summary.failed > 0 || expectedList.length !== selected.length) summary.verification.verified = false
    if (summary.verification.supported && !summary.verification.verified) summary.warnings.push({ code: 'list-verification-failed', missing: summary.verification.missing })
  }
  return summary
}

export function importCodexProjects(ctx, input = {}) {
  const task = () => execute(ctx, input)
  if (input.preview !== false) return task()
  const operation = tail.then(task, task)
  tail = operation.catch(() => {}) // Failed operations must not block subsequent explicit imports.
  return operation
}
