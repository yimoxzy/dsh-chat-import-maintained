import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, realpath, lstat, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { planLinkTargets, executeLinkPlan, main } from '../scripts/link-host-peers.mjs'

const required = ['dsh-tools', 'cordis', 'schemastery', 'dsh-session', 'dsh-token-meter', 'dsh-client-locale', 'dsh-session-format-v3-to-v4']
async function fixture(t, { version = '0.2.2-rc.1', react = false, missing } = {}) {
  const temporary = await mkdtemp(join(tmpdir(), 'host-peer-setup-'))
  const runtime = join(temporary, 'runtime'), workspace = join(temporary, 'workspace')
  await mkdir(runtime); await mkdir(workspace)
  const pkg = async (root, name, extra = {}) => {
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'package.json'), JSON.stringify({ name, version: '0.2.2-rc.1', main: 'index.js', ...extra }))
    await writeFile(join(root, 'index.js'), 'module.exports = {}\n')
  }
  await pkg(runtime, '@deepseek-ai/dsh', { version })
  for (const name of required) if (name !== missing) await pkg(join(runtime, 'node_modules', '@deepseek-ai', name), '@deepseek-ai/' + name)
  await pkg(join(runtime, 'node_modules', 'zod'), 'zod')
  if (react) await pkg(join(runtime, 'node_modules', '@deepseek-ai', 'dsh-tools', 'node_modules', 'react'), 'react')
  const intended = await realpath(temporary)
  t.after(async () => {
    assert.equal(await realpath(temporary), intended)
    await rm(intended, { recursive: true, force: true })
  })
  return { runtime, workspace, temporary }
}

test('read-only planning resolves selected runtime peers and skips unavailable optional React', async (t) => {
  const f = await fixture(t)
  const plan = await planLinkTargets(f.runtime, f.workspace)
  assert.equal(plan.links.length, 9)
  assert.equal(plan.links[0].name, '@deepseek-ai/dsh')
  assert.deepEqual(plan.skipped.map((entry) => entry.name), ['react'])
  await assert.rejects(lstat(join(f.workspace, 'node_modules')), { code: 'ENOENT' })
  for (const entry of plan.links) assert.equal(entry.target, await realpath(entry.target))
})

test('links are usable directories and repeated execution is idempotent', async (t) => {
  const f = await fixture(t, { react: true })
  const plan = await planLinkTargets(f.runtime, f.workspace)
  assert.equal(plan.skipped.length, 0)
  assert.equal(plan.links.find((entry) => entry.name === 'react').optional, true)
  const first = await executeLinkPlan(plan)
  assert.ok(first.results.every((entry) => entry.status === 'linked'))
  for (const entry of plan.links) assert.equal(await realpath(entry.destination), entry.target)
  const again = await executeLinkPlan(plan)
  assert.ok(again.results.every((entry) => entry.status === 'already-linked'))
})

test('an existing different dependency is preserved and all preflight conflicts block writes', async (t) => {
  const f = await fixture(t)
  const destination = join(f.workspace, 'node_modules', '@deepseek-ai', 'dsh-session')
  await mkdir(destination, { recursive: true })
  await writeFile(join(destination, 'keep.txt'), 'existing dependency')
  const plan = await planLinkTargets(f.runtime, f.workspace)
  await assert.rejects(executeLinkPlan(plan), /refusing replacement/)
  assert.equal(await readFile(join(destination, 'keep.txt'), 'utf8'), 'existing dependency')
  await assert.rejects(lstat(join(f.workspace, 'node_modules', '@deepseek-ai', 'dsh')), { code: 'ENOENT' })
})

test('dangling existing links are not replaced', async (t) => {
  const f = await fixture(t)
  const destination = join(f.workspace, 'node_modules', '@deepseek-ai', 'dsh')
  await mkdir(join(f.workspace, 'node_modules', '@deepseek-ai'), { recursive: true })
  await symlink(join(f.temporary, 'missing'), destination, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(executeLinkPlan(await planLinkTargets(f.runtime, f.workspace)), /refusing replacement/)
  assert.ok((await lstat(destination)).isSymbolicLink())
})

test('missing required peer fails planning without mutating the workspace', async (t) => {
  const f = await fixture(t, { missing: 'dsh-session-format-v3-to-v4' })
  await assert.rejects(planLinkTargets(f.runtime, f.workspace), /Required host peer.*dsh-session-format/)
  await assert.rejects(lstat(join(f.workspace, 'node_modules')), { code: 'ENOENT' })
})

test('runtime identity, absolute path and minimum release version are checked', async (t) => {
  const f = await fixture(t, { version: '0.2.2-rc.0' })
  await assert.rejects(planLinkTargets('relative', f.workspace), /absolute/)
  await assert.rejects(planLinkTargets(f.runtime, f.workspace), />=0.2.2-rc.1/)
  for (const version of ['0.1.9', '0.2.2-beta.9', 'invalid']) {
    await writeFile(join(f.runtime, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }))
    await assert.rejects(planLinkTargets(f.runtime, f.workspace), /Runtime requires/)
  }
  for (const version of ['0.2.2', '0.2.2-rc.2', '0.2.3-rc.1']) {
    await writeFile(join(f.runtime, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }))
    assert.equal((await planLinkTargets(f.runtime, f.workspace)).runtimeVersion, version)
  }
  await writeFile(join(f.runtime, 'package.json'), JSON.stringify({ name: 'another-package', version: '1.0.0' }))
  await assert.rejects(planLinkTargets(f.runtime, f.workspace), /must be @deepseek-ai\/dsh/)
})

test('changed package identity is rejected before link creation; CLI help is import-safe', async (t) => {
  const f = await fixture(t)
  const plan = await planLinkTargets(f.runtime, f.workspace)
  await writeFile(join(plan.links[1].target, 'package.json'), JSON.stringify({ name: 'wrong-name' }))
  await assert.rejects(executeLinkPlan(plan), /identity changed/)
  await assert.rejects(lstat(join(f.workspace, 'node_modules')), { code: 'ENOENT' })
  await main(['--help'], {})
  await assert.rejects(main([], {}), /absolute/)
  await assert.rejects(main(['--unknown'], {}), /Unknown or incomplete/)
})
