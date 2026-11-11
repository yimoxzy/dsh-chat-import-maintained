import { defineTool } from '@deepseek-ai/dsh-tools'
import { scanCodexProjects } from './source.mjs'
import { importCodexProjects } from './pipeline.mjs'

const parameters = {
  codexHome: { type: 'string', description: 'Optional Codex data root; defaults to CODEX_HOME or ~/.codex.' },
  includeInferred: { type: 'boolean', description: 'Include ordinary user threads whose unique project root matches exactly; never include projectless or child threads. Defaults true.' },
  projectIds: { type: 'array', items: { type: 'string' }, description: 'Select source project ids from the scan; empty selects all.' },
  sessionIds: { type: 'array', items: { type: 'string' }, description: 'Select source session ids; empty selects all in selected projects.' },
  preview: { type: 'boolean', description: 'Defaults true: read-only preview. Set false only when the user requested importing the selected projects.' },
  force: { type: 'boolean', description: 'Create another copy even if source content is unchanged; default false.' },
  cwdRemap: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { from: { type: 'string', required: true }, to: { type: 'string', required: true } } }, description: 'Rewrite moved project roots. Missing directories are reported; never silently created.' },
}

async function bodyOf(request) {
  let text = ''
  for await (const chunk of request) {
    text += chunk.toString()
    if (text.length > 1024 * 1024) throw new Error('Request exceeds 1 MiB')
  }
  const body = JSON.parse(text || '{}')
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Request must be an object')
  return body
}

function publicInput(body) {
  // The server owns ledger placement; HTTP callers cannot choose arbitrary state files.
  return Object.fromEntries(Object.keys(parameters).filter((key) => body[key] !== undefined).map((key) => [key, body[key]]))
}

export function registerCodexProjects(ctx) {
  const tool = defineTool({
    name: 'codex_project_migrate',
    description: 'Preview or import Codex desktop projects from SQLite and JSONL. Preserves original project/session names and full stored history, uses bounded native checkpoints, protects earlier DSH conversations, verifies native lists and broadcasts sidebar updates. Default preview is read-only.',
    parameters,
    output: { schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
    execute: (args) => importCodexProjects(ctx, args),
  })
  ctx.effect(() => ctx.tools.register(tool))
  ctx.inject(['webServer'], (webCtx) => {
    for (const [path, run] of [
      ['/api-import/codex-projects/scan', (body) => scanCodexProjects({ codexHome: body.codexHome, includeInferred: body.includeInferred !== false })],
      ['/api-import/codex-projects/import', (body) => importCodexProjects(ctx, publicInput(body))],
    ]) {
      webCtx.effect(() => webCtx.webServer.register({ kind: 'exact', path, handler: async (request, response) => {
        if (request.method !== 'POST') { response.writeHead(405); response.end(); return }
        try {
          const result = await run(await bodyOf(request))
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ ok: true, ...result }))
        } catch (error) {
          response.writeHead(400, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ ok: false, error: String(error.message || error) }))
        }
      } }))
    }
  })
}
