import { defineTool } from '@deepseek-ai/dsh-tools'
import { importCodexProjects } from './pipeline.mjs'

export function registerCodexProjects(ctx) {
  const tool = defineTool({
    name: 'codex_project_migrate',
    description: 'Preview or import the same Codex source shown in the Import panel. Classify existing imports, verified adoption, unchanged history, safe source updates and conflicting continuations. Never match by title alone. Default preview is read-only.',
    parameters: {
      codexHome: { type: 'string', description: 'Codex root; default CODEX_HOME or ~/.codex.' },
      includeInferred: { type: 'boolean', description: 'Include ordinary threads in one exact project root, excluding projectless and child threads; default true.' },
      projectIds: { type: 'array', items: { type: 'string' }, description: 'Selected source project ids; empty means all.' },
      sessionIds: { type: 'array', items: { type: 'string' }, description: 'Selected source session ids; empty means all.' },
      preview: { type: 'boolean', description: 'Default true. Set false only for a requested import or update.' },
      force: { type: 'boolean', description: 'Create a reviewed new copy; ambiguous identity is still refused.' },
      adoptionManifest: { type: 'string', description: 'Optional existing migration mapping JSON; candidates still require source-id, workspace and content proof.' },
      cwdRemap: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { from: { type: 'string', required: true }, to: { type: 'string', required: true } } }, description: 'Moved project path prefixes. Never creates missing source directories.' },
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
    execute: (args) => importCodexProjects(ctx, args),
  })
  ctx.effect(() => ctx.tools.register(tool))
}
