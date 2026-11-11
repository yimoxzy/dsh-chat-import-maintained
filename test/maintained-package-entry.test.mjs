import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('maintained bundle resolves its own module rather than an installed upstream copy', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const moduleName = patch.match(/^\s+name:\s*(\S+)\s*$/m)?.[1]
  assert.equal(moduleName, pkg.name)
  assert.equal(moduleName, 'dsh-chat-import-maintained')
  const entry = await readFile(new URL('../lib/index.mjs', import.meta.url), 'utf8')
  assert.match(entry, /registerCodexProjects\(ctx\)/)
})
