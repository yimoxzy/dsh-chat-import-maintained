import test from 'node:test'
import assert from 'node:assert/strict'
import { convertCodexProjectItems } from '../lib/codex-projects/convert.mjs'
import { convertGenericJson } from '../lib/convert/generic.mjs'

const source = { id: 'synthetic-execution', title: 'Execution metadata', cwd: '/synthetic/project', projectName: 'Synthetic', createdAt: 1000 }
const convert = (execution) => convertCodexProjectItems([
  { item_json: JSON.stringify({ type: 'userMessage', content: [{ type: 'text', text: 'Run synthetic command' }] }) },
  { item_json: JSON.stringify({ type: 'commandExecution', id: 'command-one', command: 'echo synthetic', ...execution }) },
], source)

test('null command output preserves factual status exit code and duration while reporting missing output', () => {
  const result = convert({ aggregatedOutput: null, exitCode: null, status: 'running', durationMs: 0 })
  assert.equal(result.diagnostics.missingToolResults, 1)
  const step = result.document.turns[0].steps[0]
  assert.deepEqual(JSON.parse(step.toolResults[0].content[0].text), { output: null, exitCode: null, status: 'running', durationMs: 0 })
  const events = convertGenericJson(JSON.stringify(result.document), { budget: 0 }).events
  const call = events.find((event) => event.type === 'tool/call')
  const assistant = events.find((event) => event.type === 'assistant/message')
  assert.ok(assistant.data.message.content.some((block) => block.type === 'tool-call' && block.id === call.data.callId))
  assert.equal(events.filter((event) => event.type === 'tool/result').length, 1)
})

test('missing command output does not fabricate output but retains an explicit failed exit status', () => {
  const result = convert({ exitCode: 7, status: 'failed', durationMs: 25 })
  const metadata = JSON.parse(result.document.turns[0].steps[0].toolResults[0].content[0].text)
  assert.equal('output' in metadata, false)
  assert.equal(metadata.exitCode, 7)
  assert.equal(metadata.durationMs, 25)
  assert.equal(result.document.turns[0].steps[0].toolResults[0].isError, true)
  assert.equal(result.diagnostics.missingToolResults, 1)
})

test('command activity with no result metadata remains missing rather than inventing a result', () => {
  const result = convert({})
  assert.equal(result.document.turns[0].steps[0].toolResults, undefined)
  assert.equal(result.diagnostics.missingToolResults, 1)
})
