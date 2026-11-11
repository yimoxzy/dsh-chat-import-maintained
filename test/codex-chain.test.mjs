// codex-chain.test.mjs — Codex 分页 rollout（issue #57）链解析与拼接单测
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  codexThreadIdFromName, codexNameTimestamp, groupCodexThreads, sortCodexPages,
  codexChainStat, codexSessionsAncestor, resolveCodexChain,
} from '../lib/sources/codex.mjs'
import { convertCodexJsonl } from '../lib/convert/codex.mjs'

const THREAD = '0f1e2d3c-4b5a-6978-8901-2abcdef01234'
const PAGE_B = '7c6d5e4f-0011-2233-4455-66778899aabb'

const metaLine = (id, extra = {}) => JSON.stringify({
  timestamp: '2026-09-14T10:54:34.000Z', type: 'session_meta',
  payload: { id, cwd: '/home/u/proj', timestamp: '2026-09-14T10:54:34.000Z', ...extra },
})
const userItem = (text, ts) => JSON.stringify({ timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })
const asstItem = (text, ts) => JSON.stringify({ timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } })

test('codexThreadIdFromName：取文件名第一个 UUID（分页后缀在前 UUID 之后）', () => {
  assert.equal(codexThreadIdFromName(`rollout-2026-09-14T10-54-33-${THREAD}.jsonl`), THREAD)
  assert.equal(codexThreadIdFromName(`rollout-2026-09-15T19-55-00-${THREAD}_${PAGE_B}.jsonl`), THREAD)
  assert.equal(codexThreadIdFromName('a.jsonl'), undefined)
})

test('codexNameTimestamp：取文件名内嵌时间戳；无则 null', () => {
  assert.equal(codexNameTimestamp(`rollout-2026-09-14T10-54-33-${THREAD}.jsonl`), '2026-09-14T10-54-33')
  assert.equal(codexNameTimestamp('a.jsonl'), null)
})

test('groupCodexThreads：同 thread 的分页归一组；无 UUID 文件各自成单页组', () => {
  const groups = groupCodexThreads([
    { path: '/s/2026/09/15/rollout-2026-09-15T19-55-00-' + THREAD + '_' + PAGE_B + '.jsonl', name: 'rollout-2026-09-15T19-55-00-' + THREAD + '_' + PAGE_B + '.jsonl' },
    { path: '/s/2026/09/14/rollout-2026-09-14T10-54-33-' + THREAD + '.jsonl', name: 'rollout-2026-09-14T10-54-33-' + THREAD + '.jsonl' },
    { path: '/s/2026/09/16/a.jsonl', name: 'a.jsonl' },
  ])
  assert.equal(groups.size, 2)
  const chain = groups.get(THREAD)
  // 页序：按文件名时间戳升序（首页在前）
  assert.deepEqual(chain.map((p) => p.nameTs), ['2026-09-14T10-54-33', '2026-09-15T19-55-00'])
  assert.ok(groups.has('file:/s/2026/09/16/a.jsonl'))
})

test('sortCodexPages：mtime 回退（无文件名时间戳时）', () => {
  const sorted = sortCodexPages([
    { path: '/b', name: 'b.jsonl', nameTs: null },
    { path: '/a', name: 'a.jsonl', nameTs: null },
  ], (p) => (p.path === '/a' ? 100 : 200))
  assert.deepEqual(sorted.map((p) => p.path), ['/a', '/b'])
})

test('codexChainStat：size 求和、version 拼接（新增一页即变化）', () => {
  const s1 = codexChainStat([{ size: 10, version: 'v-a' }, { size: 20, version: 'v-b' }])
  assert.equal(s1.size, 30)
  assert.equal(s1.version, 'v-a|v-b')
  const s2 = codexChainStat([{ size: 10, version: 'v-a' }, { size: 20, version: 'v-b' }, { size: 5, version: 'v-c' }])
  assert.notEqual(s1.version, s2.version)
  assert.notEqual(s1.size, s2.size)
})

test('codexSessionsAncestor：向上找 sessions 目录；找不到返回 null（调用方退化处理）', () => {
  assert.equal(codexSessionsAncestor('/home/u/.codex/sessions/2026/09/14/rollout-x.jsonl'), '/home/u/.codex/sessions')
  assert.equal(codexSessionsAncestor('/tmp/rollout-x.jsonl'), null)
})

test('拼接转换：两页合成一个会话（第二条 session_meta 被忽略、轮次连续）', () => {
  const pageA = [
    metaLine(THREAD),
    userItem('第一问', '2026-09-14T10:55:00.000Z'),
    asstItem('答一', '2026-09-14T10:55:10.000Z'),
  ].join('\n')
  const pageB = [
    metaLine(THREAD, {
      history_mode: 'paginated',
      history_base: { thread_id: THREAD, end_ordinal_exclusive: 3, end_byte_offset: 300 },
    }),
    userItem('第二问', '2026-09-15T19:56:00.000Z'),
    asstItem('答二', '2026-09-15T19:56:10.000Z'),
  ].join('\n')

  const out = convertCodexJsonl(pageA + '\n' + pageB, { sourcePath: '/s/rollout-a.jsonl' })
  assert.equal(out.meta.id, 'import-' + THREAD)
  assert.equal(out.turns.length, 2)
  assert.deepEqual(out.turns.map((t) => t.prompt), ['第一问', '第二问'])
  // 会话时间取首页 meta 的 timestamp（第二页的 meta 被忽略）
  assert.equal(out.meta.createdAt, Date.parse('2026-09-14T10:54:34.000Z'))
})

// 极简 fs 面：目录 → 子项名（以 / 结尾视为子目录）；未列出的目录按不可读处理。
// 用来钉住链解析的遍历口径——真实磁盘上的条目顺序不可控，只有这个夹具能稳定复现。
function chainFs(dirs, heads = {}) {
  return {
    listDir: async (dir) => {
      const names = dirs[dir]
      if (!names) throw new Error('ENOENT: ' + dir)
      return names.map((n) => (n.endsWith('/')
        ? { name: n.slice(0, -1), type: 'directory', target: { targetKey: dir + '/' + n.slice(0, -1), displayPath: dir + '/' + n.slice(0, -1) } }
        : { name: n, type: 'file' }))
    },
    readHead: async (p) => heads[p] ?? null,
  }
}

const ROOT = '/u/.codex/sessions'
const PAGE_A_NAME = `rollout-2026-09-14T10-54-33-${THREAD}.jsonl`
const PAGE_B_NAME = `rollout-2026-09-15T19-55-00-${THREAD}_${PAGE_B}.jsonl`
const PAGE_C_NAME = `rollout-2026-09-15T20-41-00-${THREAD}_9a8b7c6d.jsonl`
const CHAIN_A = `${ROOT}/2026/09/14/${PAGE_A_NAME}`
const CHAIN_B = `${ROOT}/2026/09/15/${PAGE_B_NAME}`
const CHAIN_C = `${ROOT}/2026/09/15/${PAGE_C_NAME}`

// 无关 rollout 排在链所在目录**之前**：按文件数截断的旧口径会先被它们填满，
// 轮不到本 thread 的分页（链解析必须是按 thread 过滤、按目录项数计预算）
function bulkTree(bulkCount) {
  return {
    [ROOT]: ['bulk/', '2026/'],
    [`${ROOT}/bulk`]: Array.from({ length: bulkCount }, (_, i) => `rollout-2026-08-01T00-00-${String(i).padStart(2, '0')}-11111111-2222-3333-4444-555555555555.jsonl`),
    [`${ROOT}/2026`]: ['09/'],
    [`${ROOT}/2026/09`]: ['14/', '15/'],
    [`${ROOT}/2026/09/14`]: [PAGE_A_NAME],
    [`${ROOT}/2026/09/15`]: [PAGE_B_NAME, PAGE_C_NAME],
  }
}

test('resolveCodexChain：无关 rollout 再多也按 thread 收全链（页序 = 文件名时间戳升序）', async () => {
  const fs = chainFs(bulkTree(600), { [CHAIN_A]: metaLine(THREAD) + '\n', [CHAIN_B]: metaLine(THREAD) + '\n' })
  const pages = await resolveCodexChain(fs, CHAIN_B)
  assert.deepEqual(pages.map((p) => p.path), [CHAIN_A, CHAIN_B, CHAIN_C])
  // headPayload 只对收集到的分页读一次（无关文件不读头部）
  assert.equal(pages[0].headPayload.id, THREAD)
  assert.equal(pages[2].headPayload, null)
})

test('resolveCodexChain：文件名无 thread id（改名副本）→ null，交回单文件路径', async () => {
  const renamed = `${ROOT}/2026/09/15/copy.jsonl`
  const fs = chainFs({ ...bulkTree(1), [`${ROOT}/2026/09/15`]: ['copy.jsonl'] })
  assert.equal(await resolveCodexChain(fs, renamed), null)
})

test('resolveCodexChain：预算触顶抛错，绝不返回半截链', async () => {
  const fs = chainFs(bulkTree(600))
  await assert.rejects(() => resolveCodexChain(fs, CHAIN_B, { maxEntries: 3 }), /目录树超过 3 个目录项/)
  await assert.rejects(() => resolveCodexChain(fs, CHAIN_B, { maxPages: 1 }), /本链分页超过 1 页/)
})
