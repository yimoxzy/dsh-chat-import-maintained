// Read-only recognition of historical imports. Names are never identity evidence.
import { readFile, open } from 'node:fs/promises'
import { basename, join, resolve, dirname } from 'node:path'
import { resolveRegistryDir, registryEntries } from '../imports.mjs'
import { persistedHeaderOf, readSessionRecord } from '../host-session.mjs'
import { convertGenericJson } from '../convert/generic.mjs'
import { convertCodexJsonl } from '../convert/codex.mjs'
import { atomHashes, hashValue, isPrefix } from './history.mjs'

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const legacyId = new RegExp('^import-codex-(?:project|full|corrected|title-recovered|missing-project)-(' + UUID + ')(?:-\\d+)?$', 'i')
const uuidFile = new RegExp('^(' + UUID + ')(?:\\.interchange)?\\.(?:jsonl|json)$', 'i')
const normalize = (value) => {
  const path = String(value || '').replace(/^\\\\\?\\/, '').replaceAll('\\', '/').replace(/\/+$/, '')
  return /^[a-z]:\//i.test(path) || path.startsWith('//') ? path.toLowerCase() : path
}
const samePath = (left, right) => !!left && !!right && normalize(left) === normalize(right)
const sourceIdOf = (value, ids) => {
  if (typeof value !== 'string') return null
  if (ids.has(value)) return value
  const match = value.match(/^(?:import-)?codex-(?:project|full|corrected|title-recovered|missing-project)-(.+)$/)
  return match && ids.has(match[1]) ? match[1] : null
}
const importedSourceId = (value, ids) => {
  if (typeof value !== 'string' || !/^import-codex-(?:project|full|corrected|title-recovered|missing-project)-/.test(value)) return null
  const exact = sourceIdOf(value, ids)
  if (exact) return exact
  const uuid = value.match(legacyId)?.[1]
  return uuid && ids.has(uuid) ? uuid : null
}
const warn = (warnings, code, path) => warnings.push({ code, ...(path ? { path } : {}) })

async function jsonFile(path, warnings, code) {
  try { return JSON.parse(await readFile(path, 'utf8')) }
  catch (error) {
    if (error.code !== 'ENOENT') warn(warnings, code, path)
    return null
  }
}

// Only a bounded metadata head is read while building the candidate index.
async function sourceMetadataId(path, ids) {
  let handle
  try {
    handle = await open(path, 'r')
    const buffer = Buffer.alloc(65536)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const head = buffer.subarray(0, bytesRead).toString('utf8')
    for (const line of head.split(/\r?\n/)) {
      try {
        const row = JSON.parse(line)
        if (row.type === 'session_meta' && ids.has(row.payload?.id)) return row.payload.id
      } catch { /* A bounded metadata head can end within a JSON record. */ }
    }
    if (/"interchange"\s*:\s*"dsh-chat-import"/.test(head)) {
      const id = head.match(/"meta"\s*:\s*\{[^}]*"(?:id|sourceId)"\s*:\s*"([^"\\]+)"/)?.[1]
      return sourceIdOf(id, ids)
    }
  } catch { /* Unavailable source files remain candidates only with other exact ID evidence. */ }
  finally { if (handle) await handle.close() }
  return null
}

/** Build active persisted candidates without loading their conversation bodies. */
export async function loadAdoptionCandidates(ctx, scan, input = {}) {
  const ids = new Set((scan.sessions || []).map((session) => session.id))
  const warnings = []
  const archived = new Set(ctx.get('workspaceRegistry')?.archivedSessionIds || [])
  let headers
  try {
    const persistence = ctx.get('sessionPersistence')
    if (!persistence?.list) throw new Error('Native session index is unavailable')
    const rows = await persistence.list()
    if (!Array.isArray(rows)) throw new Error('Unsupported native session index')
    headers = rows.map(persistedHeaderOf).filter(Boolean)
  } catch {
    return { candidates: [], unavailable: true, warnings: [{ code: 'existing-session-index-unavailable' }] }
  }
  const active = new Map(headers.filter((header) => !archived.has(header.id)).map((header) => [header.id, header]))
  const index = new Map()
  const add = (candidate, evidence) => {
    if (!ids.has(candidate.sourceId) || !active.has(candidate.sessionId)) return
    const key = candidate.sourceId + '\0' + candidate.sessionId
    const old = index.get(key)
    if (old) {
      old.evidence.push(evidence)
      if (!old.sourceFile && candidate.sourceFile) old.sourceFile = candidate.sourceFile
      return
    }
    index.set(key, { ...candidate, header: active.get(candidate.sessionId), evidence: [evidence] })
  }
  if (input.adoptionManifest) {
    const manifest = await jsonFile(input.adoptionManifest, warnings, 'adoption-manifest-unreadable')
    const rows = Array.isArray(manifest) ? manifest : manifest?.sessions
    if (manifest && !Array.isArray(rows)) warn(warnings, 'adoption-manifest-invalid-shape', input.adoptionManifest)
    for (const row of rows || []) {
      const sourceId = row.sourceId || row.id
      const sessionId = row.sessionId || row.dshId
      if (!ids.has(sourceId) || typeof sessionId !== 'string') continue
      const sourceFile = row.sourceFile && (resolve(dirname(input.adoptionManifest), row.sourceFile))
      add({ sourceId, sessionId, ...(sourceFile ? { sourceFile } : {}), cwd: row.cwd, project: row.project || row.projectName }, 'explicit-manifest')
    }
  }
  const registryPath = join(resolveRegistryDir(), 'imports.json')
  const registry = await jsonFile(registryPath, warnings, 'stock-registry-unreadable')
  const metadata = new Map()
  for (const entry of registryEntries(registry?.imports || {})) {
    if (!active.has(entry.dshId)) continue
    let sourceId = sourceIdOf(entry.subKey, ids)
    const recognized = importedSourceId(entry.dshId, ids)
    if (!sourceId && recognized && ids.has(recognized)) sourceId = recognized
    if (!sourceId) {
      const fileId = basename(entry.sourcePath.replaceAll('\\', '/')).match(uuidFile)?.[1]
      if (fileId && ids.has(fileId)) sourceId = fileId
    }
    if (!sourceId) {
      if (!metadata.has(entry.sourcePath)) metadata.set(entry.sourcePath, await sourceMetadataId(entry.sourcePath, ids))
      sourceId = metadata.get(entry.sourcePath)
    }
    if (sourceId) add({ sourceId, sessionId: entry.dshId, sourceFile: entry.sourcePath }, 'stock-registry')
  }
  for (const header of active.values()) {
    const id = importedSourceId(header.id, ids)
    if (id && ids.has(id)) add({ sourceId: id, sessionId: header.id }, 'persisted-source-id')
  }
  return { candidates: [...index.values()], warnings }
}

async function membership(ctx, session, header) {
  const registry = ctx.get('workspaceRegistry')
  let workspace
  try { workspace = registry?.resolveByPath ? await registry.resolveByPath(session.cwd) : null }
  catch { /* A moved/deleted source root can still have a verified retained workspace. */ }
  const member = !!workspace?.sessionIds?.includes(header.id)
  const headerCwdMatches = samePath(header.cwd, session.cwd)
  if (headerCwdMatches || member) return { valid: true, workspaceMember: member, headerCwdMatches,
    resolvedCwd: workspace?.path || header.cwd || session.cwd }
  const projectName = session.projectName || session.project
  const retained = projectName && typeof registry?.list === 'function'
    ? registry.list().filter((value) => value.title === projectName && value.sessionIds?.includes(header.id)
      && samePath(value.path, header.cwd)) : []
  if (retained.length === 1) return { valid: true, workspaceMember: true, headerCwdMatches: false,
    resolvedCwd: retained[0].path, retainedProjectName: retained[0].title }
  return { valid: false, workspaceMember: false, headerCwdMatches: false }
}

function convertDocument(document) {
  const converted = convertGenericJson(JSON.stringify(document), { budget: 0 })
  if (converted.skipReason || !converted.turns?.length
    || ['malformedTurns', 'malformedSteps', 'skippedBlocks', 'imagesDegraded', 'droppedToolResults'].some((key) => converted[key] > 0)) throw new Error('source-document-not-convertible')
  return converted
}

async function baselineFromFile(path, session) {
  const raw = await readFile(path, 'utf8')
  let document
  try { document = JSON.parse(raw) } catch { /* JSONL sources are parsed below record by record. */ }
  if (document?.interchange === 'dsh-chat-import') {
    if (sourceIdOf(document.meta?.id || document.meta?.sourceId, new Set([session.id])) !== session.id) throw new Error('source-document-identity-mismatch')
    const converted = convertDocument(document)
    return { atoms: atomHashes(converted.events), evidence: 'full-source-document', hash: hashValue(document) }
  }
  const rows = raw.split(/\r?\n/)
  let id
  for (const line of rows) {
    try { const row = JSON.parse(line); if (row.type === 'session_meta') { id = row.payload?.id; break } }
    catch { /* The converter reports malformed lines; identity needs one valid source metadata row. */ }
  }
  if (id !== session.id) throw new Error('source-document-identity-mismatch')
  const converted = convertCodexJsonl(raw, { budget: 0, fullHistory: true })
  if (converted.skipReason || converted.skipped > 0) throw new Error('source-document-not-convertible')
  return { atoms: atomHashes(converted.events), evidence: 'full-source-rollout', hash: hashValue(raw) }
}

/** Adopt only one active exact identity whose full prior source is a target prefix. */
export async function verifyAdoption(ctx, session, document, input) {
  const archived = new Set(ctx.get('workspaceRegistry')?.archivedSessionIds || [])
  const candidates = (Array.isArray(input) ? input : input?.candidates || []).filter((candidate) => candidate.sourceId === session.id && !archived.has(candidate.sessionId))
  if (!candidates.length && input?.unavailable) return { kind: 'unverified', reason: 'existing-session-index-unavailable', evidence: [] }
  if (!candidates.length) return { kind: 'none', reason: 'no-exact-source-mapping', evidence: [] }
  const eligible = []
  for (const candidate of candidates) {
    const location = await membership(ctx, session, candidate.header || { id: candidate.sessionId, cwd: candidate.cwd })
    if (location.valid) eligible.push({ ...candidate, location })
  }
  if (!eligible.length) return { kind: 'unverified', reason: 'workspace-mismatch', evidence: candidates.map((candidate) => candidate.sessionId) }
  if (eligible.length > 1) return { kind: 'ambiguous', reason: 'multiple-active-source-matches', evidence: eligible.map((candidate) => candidate.sessionId) }
  const candidate = eligible[0]
  const evidence = [...(candidate.evidence || []), candidate.location]
  const record = await readSessionRecord(ctx, candidate.sessionId)
  if (!record) return { kind: 'unverified', sessionId: candidate.sessionId, reason: 'target-unreadable', evidence }
  if (!(await membership(ctx, session, { ...record.meta, id: candidate.sessionId })).valid) return { kind: 'unverified', sessionId: candidate.sessionId, reason: 'workspace-mismatch', evidence }
  const targetAtoms = atomHashes(record.events)
  let sourceAtoms
  if (candidate.sourceFile) {
    try {
      const baseline = await baselineFromFile(candidate.sourceFile, session)
      sourceAtoms = baseline.atoms
      evidence.push({ kind: baseline.evidence, sourceHash: baseline.hash })
    } catch (error) {
      return { kind: 'unverified', record, sessionId: candidate.sessionId, targetAtoms, reason: error.code === 'ENOENT' ? 'source-file-unavailable' : String(error.message || error), evidence }
    }
  } else {
    try { sourceAtoms = atomHashes(convertDocument(document).events) }
    catch { return { kind: 'unverified', record, sessionId: candidate.sessionId, targetAtoms, reason: 'current-source-not-convertible', evidence } }
    evidence.push('current-full-source-only')
  }
  if (!sourceAtoms.length || !isPrefix(sourceAtoms, targetAtoms)) return { kind: 'unverified', record, sessionId: candidate.sessionId,
    sourceAtoms, targetAtoms, reason: 'full-source-prefix-mismatch', evidence }
  return { kind: 'verified', record, sessionId: candidate.sessionId, sourceAtoms, targetAtoms,
    resolvedCwd: candidate.location.resolvedCwd, baselineEvents: record.events.length, reason: sourceAtoms.length === targetAtoms.length ? 'full-source-equal' : 'full-source-with-target-continuation', evidence }
}
