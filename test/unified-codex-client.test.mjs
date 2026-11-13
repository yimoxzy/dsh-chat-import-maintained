import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'

const fragment = await readFile(new URL('../src/client/migration-actions.js', import.meta.url), 'utf8')
const dictionary = await readFile(new URL('../src/client/i18n.js', import.meta.url), 'utf8')
const tabs = await readFile(new URL('../src/client/tabs.js', import.meta.url), 'utf8')
const discovery = await readFile(new URL('../src/client/discovery.js', import.meta.url), 'utf8')
const utils = await readFile(new URL('../src/client/utils.js', import.meta.url), 'utf8')
function harness(language = 'zh') {
  const context = vm.createContext({ COLORS: { border: 'border', dim: 'dim', error: 'error' },
    h: (type, props, ...children) => ({ type, props, children }) })
  vm.runInContext(dictionary + fragment + `
    this.api = { codexMigrationActionLabel, codexMigrationTip, codexMigrationSummary,
      CodexMigrationBadge, CodexMigrationSummary, translate: (key, params) => fill(DICT[${JSON.stringify(language)}][key], params) };`, context)
  return context.api
}
const actions = ['new', 'unchanged', 'update', 'conflict', 'adoptable', 'ambiguous', 'missing']
const rows = actions.map((migrationAction, index) => ({ format: 'codex', migrationAction,
  sourcePath: '/codex/state.sqlite', sessionId: 'session-' + index, title: 'Original source title' }))

test('stock Import remains the only import tab and keeps its normal discovery flow', () => {
  assert.doesNotMatch(tabs, /CodexProjectsPanel|codex-projects|codexProjects\.tab/)
  assert.match(tabs, /tabBtn\("import", t\("tab\.import"\)\)/)
  assert.match(tabs, /h\(DiscoveryPanel, null\)/)
  assert.match(discovery, /postJson\("\/api-import\/sessions", \{ source, query, epoch, after \}/)
  assert.match(discovery, /postJson\("\/api-import\/import", \{/)
  assert.doesNotMatch(discovery, /api-import\/codex-projects/)
})

test('every Codex action has bilingual row badges while other sources remain unaffected', () => {
  for (const language of ['zh', 'en']) {
    const api = harness(language)
    for (const row of rows) {
      const label = api.codexMigrationActionLabel(row, api.translate)
      assert.ok(label && !label.startsWith('migration.'))
      const badge = api.CodexMigrationBadge({ session: row, t: api.translate })
      assert.equal(badge.props['aria-label'], label)
      assert.equal(badge.children[0], label)
    }
    assert.equal(api.CodexMigrationBadge({ session: { format: 'claude', migrationAction: 'new' }, t: api.translate }), null)
    assert.equal(api.CodexMigrationBadge({ session: { format: 'codex' }, t: api.translate }), null)
  }
})

test('action preview counts selected sessions, does not write, and names existing targets in tooltips', () => {
  const api = harness()
  assert.equal(api.codexMigrationSummary(rows, api.translate), '未变化跳过 1 · 可更新 1 · 冲突保留副本 1 · 可认领 1 · 新增导入 1 · 归属待确认 1 · 正文缺失 1')
  const selected = new Map([['one', rows[1]], ['two', rows[2]]])
  const panel = api.CodexMigrationSummary({ source: 'codex', sessions: rows, selected, t: api.translate })
  assert.match(JSON.stringify(panel), /未变化跳过 1 · 可更新 1/)
  assert.doesNotMatch(JSON.stringify(panel), /新增导入 1/)
  assert.match(JSON.stringify(panel), /当前仅预览/)
  assert.equal(api.CodexMigrationSummary({ source: 'claude', sessions: rows, selected, t: api.translate }), null)
  const tip = api.codexMigrationTip({ ...rows[4], migrationReason: 'exact source match', existingSessionId: 'existing-dsh' }, api.translate)
  assert.match(tip, /可认领.*exact source match/)
  assert.match(tip, /existing-dsh/)
  assert.doesNotMatch(fragment, /postJson|fetch\(|onClick|preview:\s*false/)
})

test('selected modern Codex rows keep stock import payload without trusting action metadata', () => {
  const expression = utils.match(/const toItem = \(s\) => \(\{[\s\S]*?\n    \}\);/)[0]
  const context = vm.createContext({ FORMAT_SOURCE: { codex: 'codex' } })
  vm.runInContext(expression + '\nthis.toItem = toItem;', context)
  const selected = rows.filter((row) => ['update', 'adoptable'].includes(row.migrationAction))
  const payload = JSON.parse(JSON.stringify(selected.map((row) => context.toItem({ ...row, cwd: '/project', existingSessionId: 'existing' }))))
  assert.deepEqual(payload, selected.map((row) => ({ source: 'codex', sourcePath: row.sourcePath, sessionId: row.sessionId, cwd: '/project' })))
  assert.match(discovery, /doImport\(\[\.\.\.selected\.values\(\)\]\.map\(toItem\)\)/)
  assert.match(discovery, /h\(CodexMigrationSummary, \{ source, sessions: filteredItems, selected, t \}\)/)
  assert.match(discovery, /h\(CodexMigrationBadge, \{ session: s, t: props\.t \}\)/)
})

test('adopted and updated successes render distinct counts for individual and batch results', () => {
  const context = vm.createContext({});
  const resultFunctions = utils.slice(utils.indexOf('    function ignoreReasonsOf('), utils.indexOf('    // 健壮 JSON'));
  vm.runInContext(dictionary + resultFunctions + '\nthis.renderResult = (results, language) => fmtImportResult(results, (key, params) => fill(DICT[language][key], params));', context);
  for (const language of ['zh', 'en']) {
    const single = context.renderResult([{ status: 'adopted' }, { status: 'updated' }], language);
    const batch = context.renderResult([{ mode: 'batch', adopted: 2, updated: 3, imported: 1 }], language);
    assert.match(single, language === 'zh' ? /认领已有会话 1.*更新已有会话 1/ : /1 existing sessions adopted.*1 existing sessions updated/);
    assert.match(batch, language === 'zh' ? /新增 1.*认领已有会话 2.*更新已有会话 3/ : /1 imported.*2 existing sessions adopted.*3 existing sessions updated/);
    assert.doesNotMatch(single, language === 'zh' ? /跳过|无变化/ : /skipped|no change/);
  }
  const api = harness();
  assert.match(api.codexMigrationTip(rows[3], api.translate), /点击导入将创建新副本/);
});
