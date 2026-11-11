// antigravity-tools.test.mjs — Antigravity 工具层回归（issue #67：导入路径崩溃
// "The 'path' argument must be of type string or an instance of Buffer or URL.
// Received undefined"）。
//
// 崩溃根因：derive.args 把路径字符串直传给 ctx.fs.readText/readDir，而宿主 fs 是
// 目标对象契约（只有 resolve 收路径字符串，readText/listDir 只收 resolve 出的
// { targetKey, displayPath } 目标），字符串目标在宿主内解出 undefined key 后由
// node:fs 抛上述错误——单文件与目录预览全灭。本测试用「字符串即抛」的严格 mock
// fs 复刻宿主契约：derive/collect/预览必须全部走 resolve → 目标对象，任何字符串
// 直传都会当场失败；同时验证 annotations/messages 缺失容错与目录批量只收
// canonical transcript.jsonl（transcript_full.jsonl / 杂散 JSONL 不入选）。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { registerTools } from '../lib/tools.mjs'
import { IMPORT_SPECS } from '../lib/toolkit.mjs'
import { previewDirectory, previewTranscript } from '../lib/import-core.mjs'
import { convertAntigravityJsonl } from '../lib/convert/antigravity.mjs'

// 路径归一（键与查询同口径：/ 分隔，兼容 Windows join 的混合分隔符）。
const norm = (p) => String(p).replace(/\\/g, '/')

// 严格宿主 fs mock：契约与 @deepseek-ai/dsh-fs-local 一致——resolve 只收字符串，
// stat/readText/listDir 只收目标对象；缺失文件/目录 readText/listDir 抛「not found」
//（宿主 FsError 语义），derive 的容错分支必须接得住。
function strictFs(tree) {
  const targetOf = (key) => ({ targetKey: key, displayPath: key })
  const requireTarget = (t) => {
    if (!t || typeof t !== 'object' || typeof t.targetKey !== 'string') {
      // 目标对象契约被破坏（字符串等直传）→ 宿主内 node:fs 同款错误，测试即失败
      throw new TypeError('The "path" argument must be of type string or an instance of Buffer or URL. Received undefined')
    }
  }
  return {
    tree,
    async resolve(path) {
      if (typeof path !== 'string' || path.trim() === '') throw new Error('file_path must be a non-empty string')
      return targetOf(norm(path))
    },
    processPath(target) {
      requireTarget(target)
      return target.targetKey
    },
    async stat(target) {
      requireTarget(target)
      const v = tree.get(norm(target.targetKey))
      if (!v) return undefined
      return v.type === 'dir' ? { type: 'directory' } : { type: 'file', size: v.text.length }
    },
    async readText(target) {
      requireTarget(target)
      const v = tree.get(norm(target.targetKey))
      if (!v || v.type !== 'file') throw new Error('cannot read "' + target.displayPath + '": not found')
      return v.text
    },
    async listDir(target) {
      requireTarget(target)
      const key = norm(target.targetKey)
      const v = tree.get(key)
      if (!v || v.type !== 'dir') throw new Error('cannot list "' + target.displayPath + '": not found')
      const prefix = key.endsWith('/') ? key : key + '/'
      const entries = []
      for (const [p, val] of tree) {
        if (!p.startsWith(prefix) || p === prefix) continue
        const rest = p.slice(prefix.length)
        if (!rest || rest.includes('/')) continue
        entries.push({ name: rest, type: val.type === 'dir' ? 'directory' : 'file', target: targetOf(p) })
      }
      return entries.sort((a, b) => a.name.localeCompare(b.name))
    },
  }
}

// 合成 Antigravity 2.0 布局（~/.gemini/antigravity，Windows 风格路径）：
// 一个带 annotation + messages 回执的完整会话 + 一个无伴生目录的极简会话。
const ROOT = 'C:/Users/MD Riaz/.gemini/antigravity'
const ID_FULL = '04120685-ffe8-4deb-a78a-34c646d26beb'
const ID_BARE = '032b924e-fdaf-4bef-8acc-dd64b3963dcb'
const j = (o) => JSON.stringify(o)
const userLine = (id) => j({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-01-02T03:04:05Z', content: '<USER_REQUEST>' + id + ' 提问</USER_REQUEST>' })

function buildTree() {
  const tree = new Map()
  // 键统一归一为 / 分隔（join 在 Windows 产混合分隔符，lookup 按 norm 对齐）
  const add = (p, v) => tree.set(norm(p), v)
  const dirOf = (p) => add(p, { type: 'dir' })
  const mkSession = (id, { annotation, messages }) => {
    const brain = join(ROOT, 'brain', id)
    dirOf(join(ROOT, 'conversations'))
    add(join(ROOT, 'conversations', id + '.db'), { type: 'file', text: '' })
    add(join(ROOT, 'conversations', id + '.pb'), { type: 'file', text: '' }) // 新旧并存，同 id
    dirOf(join(ROOT, 'brain'))
    dirOf(brain)
    dirOf(join(brain, '.system_generated'))
    dirOf(join(brain, '.system_generated', 'logs'))
    add(join(brain, '.system_generated', 'logs', 'transcript.jsonl'), {
      type: 'file',
      text: [
        userLine(id),
        j({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: '回复', tool_calls: [{ name: 'run_command', args: { CommandLine: '"ls"', Cwd: '"/home/u/demo"' } }] }),
        j({ step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', content: 'Task … finished' }),
      ].join('\n') + '\n',
    })
    // transcript_full 与其它伴生日志：同会话素材，不是独立会话
    add(join(brain, '.system_generated', 'logs', 'transcript_full.jsonl'), { type: 'file', text: userLine(id) + '\n' })
    if (annotation) {
      dirOf(join(ROOT, 'annotations'))
      add(join(ROOT, 'annotations', id + '.pbtxt'), { type: 'file', text: 'title:"权威标题"' })
    }
    if (messages) {
      dirOf(join(brain, '.system_generated', 'messages'))
      add(join(brain, '.system_generated', 'messages', 'task-1.json'), {
        type: 'file',
        text: j({ sourceMetadata: { tool: { stepIndex: 2 } }, content: '任务正文' }),
      })
      add(join(brain, '.system_generated', 'messages', 'bad.json'), { type: 'file', text: '{not json' })
    }
  }
  dirOf(ROOT)
  mkSession(ID_FULL, { annotation: true, messages: true })
  mkSession(ID_BARE, { annotation: false, messages: false })
  // 根下杂散 JSONL：不做会话素材（collect 必须过滤）
  dirOf(join(ROOT, 'scratch'))
  add(join(ROOT, 'scratch', 'notes.jsonl'), { type: 'file', text: userLine('noise') + '\n' })
  return tree
}

let ctx
let spec

beforeEach(async () => {
  const fs = strictFs(buildTree())
  ctx = {
    fs,
    get() { return undefined },
    tools: { register() { return () => {} } },
  }
  registerTools(ctx, '.antigravity-tools-test')
  spec = IMPORT_SPECS.get('antigravity')
  assert.ok(spec, 'antigravity spec 应已登记')
})

test('derive.args：走 resolve→readText/listDir 目标契约，取回 annotation 标题与任务回执', async () => {
  const target = await ctx.fs.resolve(join(ROOT, 'brain', ID_FULL, '.system_generated', 'logs', 'transcript.jsonl'))
  const derived = await spec.derive.args(target)
  assert.equal(derived.antigravityId, ID_FULL)
  assert.equal(derived.annotationTitle, '权威标题')
  assert.ok(derived.taskMessages instanceof Map)
  assert.deepEqual(derived.taskMessages.get(2), ['任务正文'])
  // 畸形回执被跳过（skipped 语义在转换层，这里不因坏文件失败）
})

test('derive.args：annotations / messages 缺失容错为无标题无回执（旧会话合法形态）', async () => {
  const target = await ctx.fs.resolve(join(ROOT, 'brain', ID_BARE, '.system_generated', 'logs', 'transcript.jsonl'))
  const derived = await spec.derive.args(target)
  assert.deepEqual(derived, { antigravityId: ID_BARE })
})

test('单文件预览：issue #67 的直传路径崩溃回归（readText 只收目标对象）', async () => {
  const target = await ctx.fs.resolve(join(ROOT, 'brain', ID_FULL, '.system_generated', 'logs', 'transcript.jsonl'))
  // 与执行器同构：derive 先合并进 args，再走只读转换
  const fileArgs = { ...(await spec.derive.args(target)) }
  const entry = await previewTranscript(ctx, target, fileArgs, spec.convert)
  assert.equal(entry.turns, 1)
  assert.equal(entry.messages, 3) // 1 提问 + 1 回复 + 1 工具结果
  assert.equal(entry.toolCalls, 1)
  assert.equal(entry.skipped, 0)
  assert.equal(entry.title, '权威标题')
})

test('目录预览：issue #67 的批量崩溃回归；只收集 canonical transcript.jsonl（排除 transcript_full 与杂散 JSONL）', async () => {
  const dirTarget = await ctx.fs.resolve(ROOT)
  const { total, results } = await previewDirectory(ctx, dirTarget, {}, {
    convert: spec.convert,
    deriveArgs: spec.derive.args,
    collect: spec.derive.collect,
  })
  assert.equal(total, 2, '两个会话各一条 canonical transcript，噪音文件不入选')
  const titles = results.map((r) => r.title).sort()
  assert.deepEqual(titles, ['032b924e-fdaf-4bef-8acc-dd64b3963dcb 提问', '权威标题'])
  for (const r of results) {
    assert.notEqual(r.status, 'failed', '预览条目不得失败：' + r.error)
    assert.ok(r.path.endsWith('transcript.jsonl'), '只收 canonical transcript：' + r.path)
    assert.ok(!r.path.includes('transcript_full.jsonl'))
    assert.ok(!r.path.includes('notes.jsonl'))
  }
})

test('转换链：derive 输出可直接喂转换器（落盘路径的完整 args 组装）', async () => {
  const target = await ctx.fs.resolve(join(ROOT, 'brain', ID_FULL, '.system_generated', 'logs', 'transcript.jsonl'))
  const derived = await spec.derive.args(target)
  const raw = await ctx.fs.readText(target)
  const out = convertAntigravityJsonl(raw, { ...derived, sourcePath: target.displayPath })
  assert.equal(out.title, '权威标题')
  assert.equal(out.turns.length, 1)
  assert.equal(out.turns[0].steps[0].toolResults.length, 1)
})