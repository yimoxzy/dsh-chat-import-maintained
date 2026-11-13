#!/usr/bin/env node
// Development only: link an explicitly selected installed host without installing packages.
import { readFile, realpath, stat, lstat, mkdir, symlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REQUIRED = ['@deepseek-ai/dsh-tools', '@deepseek-ai/cordis', '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-token-meter', '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-session-format-v3-to-v4', 'zod']
const OPTIONAL = ['react']
const defaultWorkspace = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function supportedVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value || '')
  if (!match) return false
  const parts = match.slice(1, 4).map(Number)
  for (let i = 0; i < 3; i++) {
    if (parts[i] !== [0, 2, 2][i]) return parts[i] > [0, 2, 2][i]
  }
  if (!match[4]) return true
  const ids = match[4].split('.')
  if (ids[0] !== 'rc') return ids[0] > 'rc'
  return /^\d+$/.test(ids[1] || '') && Number(ids[1]) >= 1
}

async function metadata(root) {
  const info = await stat(root)
  if (!info.isDirectory()) throw new Error('Package target must be a directory: ' + root)
  return JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
}

async function packageRoot(name, anchors) {
  for (const anchor of anchors) {
    const require = createRequire(join(anchor, 'package.json'))
    let candidate
    try { candidate = dirname(require.resolve(name + '/package.json')) }
    catch {
      try { candidate = dirname(require.resolve(name)) }
      catch { continue } // Try the next selected-host anchor; never install missing peers.
    }
    while (true) {
      try {
        const pkg = await metadata(candidate)
        if (pkg.name === name) return await realpath(candidate)
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error
      }
      const parent = dirname(candidate)
      if (parent === candidate) break
      candidate = parent
    }
  }
  return null
}

/** Read-only plan: validate every required target before creating any local directories. */
export async function planLinkTargets(runtimeRoot, workspaceRoot = defaultWorkspace) {
  if (typeof runtimeRoot !== 'string' || !isAbsolute(runtimeRoot)) throw new Error('--runtime-root must be an absolute installed @deepseek-ai/dsh package directory')
  if (!isAbsolute(workspaceRoot)) throw new Error('Workspace root must be absolute')
  const runtime = await realpath(runtimeRoot)
  const pkg = await metadata(runtime)
  if (pkg.name !== '@deepseek-ai/dsh') throw new Error('Runtime package must be @deepseek-ai/dsh')
  if (!supportedVersion(pkg.version)) throw new Error('Runtime requires @deepseek-ai/dsh >=0.2.2-rc.1; found ' + pkg.version)
  const workspace = await realpath(workspaceRoot)
  const anchors = [runtime]
  const links = [{ name: pkg.name, target: runtime, destination: join(workspace, 'node_modules', '@deepseek-ai', 'dsh'), optional: false }]
  for (const name of REQUIRED) {
    const target = await packageRoot(name, anchors)
    if (!target) throw new Error('Required host peer is unavailable: ' + name)
    links.push({ name, target, destination: join(workspace, 'node_modules', ...name.split('/')), optional: false })
    anchors.push(target)
  }
  const skipped = []
  for (const name of OPTIONAL) {
    const target = await packageRoot(name, anchors)
    if (target) links.push({ name, target, destination: join(workspace, 'node_modules', ...name.split('/')), optional: true })
    else skipped.push({ name, reason: 'Optional browser peer is not installed in this runtime' })
  }
  return { runtimeRoot: runtime, runtimeVersion: pkg.version, workspaceRoot: workspace, links, skipped }
}

async function existingTarget(destination) {
  try { await lstat(destination) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
  try { return await realpath(destination) }
  catch { throw new Error('Existing path cannot be resolved; refusing replacement: ' + destination) }
}

/** Idempotent, non-destructive application. Existing different paths are never removed. */
export async function executeLinkPlan(plan) {
  for (const entry of plan.links) {
    const target = await realpath(entry.target)
    if (target !== entry.target) throw new Error('Package target changed since planning: ' + entry.name)
    const pkg = await metadata(target)
    if (pkg.name !== entry.name) throw new Error('Package identity changed since planning: ' + entry.name)
    const existing = await existingTarget(entry.destination)
    if (existing !== null && existing !== target) throw new Error('Existing path differs; refusing replacement: ' + entry.destination)
  }
  const results = []
  for (const entry of plan.links) {
    const existing = await existingTarget(entry.destination)
    if (existing === entry.target) { results.push({ name: entry.name, status: 'already-linked' }); continue }
    if (existing !== null) throw new Error('Existing path differs; refusing replacement: ' + entry.destination)
    await mkdir(dirname(entry.destination), { recursive: true })
    // Recheck the real directory immediately before creation; symlink itself fails on EEXIST.
    if (await realpath(entry.target) !== entry.target) throw new Error('Package target changed: ' + entry.name)
    await symlink(entry.target, entry.destination, process.platform === 'win32' ? 'junction' : 'dir')
    results.push({ name: entry.name, status: 'linked' })
  }
  return { ...plan, results }
}

export async function main(args = process.argv.slice(2), env = process.env) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node scripts/link-host-peers.mjs --runtime-root <absolute installed @deepseek-ai/dsh directory>\n'
      + 'Or set DSH_RUNTIME_ROOT. Run npm ci --legacy-peer-deps --ignore-scripts first.\n'
      + 'Links matching host peers into this checkout; never installs packages or replaces existing paths.\n'
      + 'React is optional and is skipped when absent from the selected runtime.')
    return
  }
  let root = env.DSH_RUNTIME_ROOT
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--runtime-root' || !args[i + 1]) throw new Error('Unknown or incomplete option: ' + args[i])
    root = args[++i]
  }
  const result = await executeLinkPlan(await planLinkTargets(root))
  console.log(JSON.stringify({ runtimeVersion: result.runtimeVersion, results: result.results, skipped: result.skipped }, null, 2))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1 })
}
