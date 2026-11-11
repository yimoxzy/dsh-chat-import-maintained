import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../src/client/codex-projects.js', import.meta.url), 'utf8')

function harness(responses = []) {
  const state = [], refs = [], calls = []
  let cursor = 0, refCursor = 0
  const context = vm.createContext({
    DICT: { zh: {}, en: {} }, COLORS: {}, STYLES: {}, React: { Fragment: 'fragment' },
    useTranslate: () => (key, params = {}) => key + JSON.stringify(params),
    useState: (initial) => {
      const index = cursor++
      if (!(index in state)) state[index] = initial
      return [state[index], (next) => { state[index] = typeof next === 'function' ? next(state[index]) : next }]
    },
    useRef: (initial) => { const index = refCursor++; return refs[index] ||= { current: initial } },
    useEffect: (effect) => { effect() },
    h: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
    errorText: (error) => error.message,
    postJson: async (path, body) => { calls.push({ path, body }); return responses.shift() },
  })
  vm.runInContext(source + '\nthis.Panel = CodexProjectsPanel;', context)
  const render = () => { cursor = 0; refCursor = 0; return context.Panel() }
  const find = (node, predicate) => {
    if (!node || typeof node !== 'object') return undefined
    if (predicate(node)) return node
    for (const child of node.children || []) { const hit = find(child, predicate); if (hit) return hit }
    return undefined
  }
  const button = (tree, key) => find(tree, (node) => node.type === 'button' && node.children.some((child) => typeof child === 'string' && child.startsWith(key)))
  return { render, find, button, calls, context }
}

const scanned = { ok: true, data: { projects: [
  { id: 'project-a', name: 'Project A', cwd: '/workspace/a', sessions: [{ id: 'a', title: 'Original title', evidence: { inferred: true } }] },
  { id: 'project-b', name: 'Project B', cwd: '/workspace/b', sessions: [{ id: 'b', title: 'Other title' }] },
], warnings: ['read-only warning'], missing: [{ id: 'missing' }] } }

test('Codex migration scans only on click and imports the selected project IDs explicitly', async () => {
  const ui = harness([scanned, { ok: true, data: { scanned: 1, imported: 1, alreadyImported: 0, failed: 0, verification: { supported: true, verified: true, missing: [], broadcast: 1 } } }])
  let tree = ui.render()
  assert.equal(ui.calls.length, 0)
  assert.equal(ui.button(tree, 'codexProjects.import'), undefined)
  ui.find(tree, (node) => node.type === 'input').props.onChange({ target: { value: ' /custom/codex ' } })
  tree = ui.render()
  await ui.button(tree, 'codexProjects.scan').props.onClick()
  assert.equal(ui.calls[0].path, '/api-import/codex-projects/scan')
  assert.deepEqual(JSON.parse(JSON.stringify(ui.calls[0].body)), { includeInferred: true, codexHome: '/custom/codex' })
  tree = ui.render()
  assert.match(JSON.stringify(tree), /Original title/)
  assert.match(JSON.stringify(tree), /read-only warning/)
  const checkbox = ui.find(tree, (node) => node.type === 'input' && node.props.type === 'checkbox')
  checkbox.props.onChange()
  tree = ui.render()
  await ui.button(tree, 'codexProjects.import').props.onClick()
  assert.deepEqual(JSON.parse(JSON.stringify(ui.calls[1])), {
    path: '/api-import/codex-projects/import', body: { includeInferred: true, codexHome: '/custom/codex', projectIds: ['project-b'], preview: false },
  })
  assert.match(JSON.stringify(ui.render()), /codexProjects.verified/)
})

test('request failures stay visible and changing the root invalidates the preview', async () => {
  const ui = harness([scanned, { ok: false, error: 'Database unavailable' }])
  await ui.button(ui.render(), 'codexProjects.scan').props.onClick()
  await ui.button(ui.render(), 'codexProjects.import').props.onClick()
  let tree = ui.render()
  assert.match(JSON.stringify(tree), /Database unavailable/)
  ui.find(tree, (node) => node.type === 'input' && node.props.type === 'text').props.onChange({ target: { value: '/other/root' } })
  tree = ui.render()
  assert.equal(ui.button(tree, 'codexProjects.import'), undefined)
  assert.equal(ui.calls.length, 2)
})

test('an unchanged re-import reports skipped counts and does not claim verification without evidence', async () => {
  const ui = harness([scanned, { ok: true, data: { scanned: 2, imported: 0, alreadyImported: 2, failed: 0 } }])
  await ui.button(ui.render(), 'codexProjects.scan').props.onClick()
  await ui.button(ui.render(), 'codexProjects.import').props.onClick()
  const tree = JSON.stringify(ui.render())
  assert.match(tree, /\\"skipped\\":2/)
  assert.match(tree, /codexProjects.review/)
  assert.doesNotMatch(tree, /codexProjects.verified/)
})
