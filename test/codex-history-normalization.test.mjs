import test from 'node:test'
import assert from 'node:assert/strict'
import { atomHashes } from '../lib/codex-projects/history.mjs'

const user = (content) => ({ type: 'user/message', data: { source: { kind: 'user' }, role: 'user', content } })
const text = (value) => ({ type: 'text', text: value })

test('same user message legacy joined text and modern contiguous blocks normalize without losing separators', () => {
  assert.deepEqual(atomHashes([user([text('Question\nSecond part')])]), atomHashes([user([text('Question'), text('Second part')])]))
  assert.notDeepEqual(atomHashes([user([text('QuestionSecond part')])]), atomHashes([user([text('Question'), text('Second part')])]))
  assert.notDeepEqual(atomHashes([user([text('Question')]), user([text('Second part')])]), atomHashes([user([text('Question'), text('Second part')])]))
})

test('multiple equivalent attachment warning labels normalize while metadata and nontext boundaries remain significant', () => {
  const old = 'Question\n[Codex attachment metadata] {"path":"one"}\n[Codex attachment metadata] {"path":"two"}'
  const modern = [text('Question'), text('[Codex attachment metadata; bytes not recovered] {"path":"one"}'), text('[Codex attachment metadata; bytes not recovered] {"path":"two"}')]
  assert.deepEqual(atomHashes([user([text(old)])]), atomHashes([user(modern)]))
  const changed = modern.map((block) => ({ ...block, text: block.text.replace('"two"', '"different"') }))
  assert.notDeepEqual(atomHashes([user([text(old)])]), atomHashes([user(changed)]))
  assert.notDeepEqual(atomHashes([user([text('Question\nTail')])]), atomHashes([user([text('Question'), { type: 'image', url: 'image-one' }, text('Tail')])]))
})

test('tool result metadata with null output is never discarded as equivalent to an absent result', () => {
  const result = { type: 'tool/result', data: { message: { role: 'tool', content: [text('{"output":null,"exitCode":null,"status":"running","durationMs":0}')] } } }
  assert.notDeepEqual(atomHashes([result]), atomHashes([]))
  const changed = { ...result, data: { message: { role: 'tool', content: [text('{"output":null,"exitCode":1,"status":"failed","durationMs":0}')] } } }
  assert.notDeepEqual(atomHashes([result]), atomHashes([changed]))
})

test('zero-character assistant source messages have no atom but whitespace and meaningful content remain', () => {
  const assistant = (value) => ({ type: 'assistant/message', data: { message: { content: [text(value)] } } })
  assert.deepEqual(atomHashes([assistant('')]), atomHashes([]))
  assert.notDeepEqual(atomHashes([assistant(' ')]), atomHashes([]))
  assert.notDeepEqual(atomHashes([assistant('source message')]), atomHashes([]))
})
