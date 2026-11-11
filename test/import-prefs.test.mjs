// import-prefs.test.mjs — 导入偏好命名空间注册契约（registerImportPrefs）+ 读取语义（readImportPrefs）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  registerImportPrefs, readImportPrefs, normalizeInjectTools,
  IMPORT_SETTINGS_NAMESPACE, IMPORT_PREFS_DEFAULT, IMPORT_ENTRY_ID_FALLBACK,
  entryIdOf, resolvePrefsBinding, describeImportPrefs, updateImportPrefs, Config,
} from '../lib/import-prefs.mjs'

// Cordis effect 契约回执镜像（与 test/index.test.mjs makeCtx.inject 同一套校验）：
// inject 回调返回值只允许函数 / 可空 / thenable / 可迭代，否则抛 TypeError: Invalid effect。
function validateEffect(effect) {
  if (effect === undefined || effect === null || typeof effect === 'function') return
  const invalid = typeof effect !== 'object' ||
    (!('then' in effect) && !(Symbol.iterator in effect) && !(Symbol.asyncIterator in effect))
  if (invalid) throw new TypeError('Invalid effect')
}

test('registerImportPrefs: settings 就绪时执行 inject 回调注册命名空间，回调返回值须通过 Cordis effect 校验', () => {
  const registered = []
  let returned
  const ctx = {
    inject(serviceList, cb) {
      assert.deepEqual(serviceList, ['settings'])
      const settings = {
        // 真实 SettingsProvider.register 返回 owner scope（普通对象）——作为 effect 非法
        register(ns, schema) {
          registered.push({ ns, schema })
          return { get() { return { importSystemPrompt: false } }, watch() {}, update() {}, replace() {} }
        },
      }
      returned = cb({ settings })
    },
  }
  registerImportPrefs(ctx)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].ns, IMPORT_SETTINGS_NAMESPACE)
  assert.ok(registered[0].schema) // schemastery Schema（函数形态），非空即注册收到
  // 回归锚点：修复前这里返回的是 register 的 owner scope，validateEffect 抛
  // TypeError: Invalid effect —— 正是桌面宿主（settings 就绪早、回调同步执行）启动崩溃点。
  assert.doesNotThrow(() => validateEffect(returned))
})

test('registerImportPrefs: register 抛错被吞掉、不向外抛（重复注册等不致命）', () => {
  let ran = false
  const ctx = {
    inject(_, cb) {
      ran = true
      // 回调容错后返回 undefined（合法 effect），且不外抛
      assert.equal(cb({ settings: { register() { throw new Error('namespace already registered') } } }), undefined)
    },
  }
  registerImportPrefs(ctx)
  assert.equal(ran, true)
})

test('normalizeInjectTools：三档字符串原样、历史 boolean 归一、异常值回退 minimal', () => {
  // 三档字符串原样通过
  assert.equal(normalizeInjectTools('off'), 'off')
  assert.equal(normalizeInjectTools('minimal'), 'minimal')
  assert.equal(normalizeInjectTools('full'), 'full')
  // 历史持久化 boolean：true→full / false→off
  assert.equal(normalizeInjectTools(true), 'full')
  assert.equal(normalizeInjectTools(false), 'off')
  // 缺键 / 异常形态回退默认档
  assert.equal(normalizeInjectTools(undefined), 'minimal')
  assert.equal(normalizeInjectTools(null), 'minimal')
  assert.equal(normalizeInjectTools('bogus'), 'minimal')
  assert.equal(normalizeInjectTools(1), 'minimal')
})

test('readImportPrefs：injectTools 缺服务/缺键/异常回退 minimal，历史 boolean 与三档字符串按归一口径', () => {
  // ctx.get('settings') → settings 服务；服务自身的 get(ns) → 存储值（两层各司其职）
  const ctxWith = (stored) => ({
    get(service) { return service === 'settings' ? { get() { return stored } } : undefined },
  })
  const DEFAULT = { importSystemPrompt: true, injectTools: 'minimal', sidebarButton: true }
  assert.deepEqual(IMPORT_PREFS_DEFAULT, DEFAULT)
  // settings 服务缺席 / get 抛错 → 默认
  assert.deepEqual(readImportPrefs({ get(service) { return service === 'settings' ? undefined : undefined } }), DEFAULT)
  assert.deepEqual(readImportPrefs({ get() { throw new Error('service missing') } }), DEFAULT)
  assert.deepEqual(readImportPrefs({}), DEFAULT)
  // 服务 get 返回非对象 / 裸对象（未应用 schema 默认）→ 默认，降级形态不悄悄改回旧行为
  assert.deepEqual(readImportPrefs(ctxWith(undefined)), DEFAULT)
  assert.deepEqual(readImportPrefs(ctxWith({})), DEFAULT)
  assert.deepEqual(readImportPrefs(ctxWith('garbage')), DEFAULT)
  // 三档字符串按存储值；importSystemPrompt / sidebarButton 独立按「!== false」
  assert.deepEqual(readImportPrefs(ctxWith({ importSystemPrompt: true, injectTools: 'full', sidebarButton: true })), { importSystemPrompt: true, injectTools: 'full', sidebarButton: true })
  assert.deepEqual(readImportPrefs(ctxWith({ importSystemPrompt: false, injectTools: 'off', sidebarButton: false })), { importSystemPrompt: false, injectTools: 'off', sidebarButton: false })
  assert.deepEqual(readImportPrefs(ctxWith({ importSystemPrompt: false, injectTools: 'minimal' })), { importSystemPrompt: false, injectTools: 'minimal', sidebarButton: true })
  // 历史持久化 boolean：true→full / false→off
  assert.deepEqual(readImportPrefs(ctxWith({ importSystemPrompt: true, injectTools: true })), { importSystemPrompt: true, injectTools: 'full', sidebarButton: true })
  assert.deepEqual(readImportPrefs(ctxWith({ importSystemPrompt: false, injectTools: false })), { importSystemPrompt: false, injectTools: 'off', sidebarButton: true })
  // 异常值回退 minimal
  assert.deepEqual(readImportPrefs(ctxWith({ importSystemPrompt: false, injectTools: 'bogus' })), { importSystemPrompt: false, injectTools: 'minimal', sidebarButton: true })
  // 缺 injectTools 键 → 该键回退 minimal，另一键按存储值
  assert.deepEqual(readImportPrefs(ctxWith({ importSystemPrompt: false })), { importSystemPrompt: false, injectTools: 'minimal', sidebarButton: true })
})

test('registerImportPrefs: onInjectToolsChange 在注册后初值对账一次（值为归一档位），并在 injectTools 变化时再次触发', () => {
  const events = []
  let watchCb
  let current = { importSystemPrompt: true, injectTools: true }
  const ctx = {
    inject(serviceList, cb) {
      assert.deepEqual(serviceList, ['settings'])
      const settings = {
        register() {
          return {
            get() { return current },
            watch(cb2) { watchCb = cb2 },
            update() {}, replace() {},
          }
        },
      }
      cb({ settings })
    },
  }
  registerImportPrefs(ctx, (mode) => events.push(mode))
  assert.deepEqual(events, ['full']) // 初值对账：历史 boolean true → 'full'
  // 变更 → 再次触发（三档字符串原样）
  current = { importSystemPrompt: true, injectTools: 'minimal' }
  watchCb()
  assert.deepEqual(events, ['full', 'minimal'])
  // 历史 boolean false → 'off'
  current = { importSystemPrompt: true, injectTools: false }
  watchCb()
  assert.deepEqual(events, ['full', 'minimal', 'off'])
  // 缺 injectTools 键（未应用 schema 默认的降级形态）→ 回退 'minimal'
  current = { importSystemPrompt: true }
  watchCb()
  assert.deepEqual(events, ['full', 'minimal', 'off', 'minimal'])
})

// ── DSH 0.1.7 设置模型（settings.register 已移除）────────────────────────────

test('entryIdOf：剥离 0.1.7 loader 的 <kind>: 前缀，拿不到时回退 patch 条目 id', () => {
  // 0.1.7 的 loader 把 ctx.fiber.entry.id 报成 "<kind>:<id>"，设置服务按裸 id 建索引
  assert.equal(entryIdOf({ fiber: { entry: { id: 'insert:import-claude' } } }), 'import-claude')
  assert.equal(entryIdOf({ fiber: { entry: { id: 'import-claude' } } }), 'import-claude')
  // 取最后一个 ':' 之后：id 自身含冒号也不会被截错
  assert.equal(entryIdOf({ fiber: { entry: { id: 'include:ui-skin:import-claude' } } }), 'import-claude')
  assert.equal(entryIdOf({}), IMPORT_ENTRY_ID_FALLBACK)
  assert.equal(entryIdOf({ fiber: { entry: {} } }), IMPORT_ENTRY_ID_FALLBACK)
  assert.equal(entryIdOf({ fiber: { entry: { id: '' } } }), IMPORT_ENTRY_ID_FALLBACK)
})

test('resolvePrefsBinding：describe 名单含裸条目 id → forms（0.1.7）；只有 register/get → legacy（0.1.5）', () => {
  const formsSettings = {
    describe: () => [{ ns: 'import-claude', value: {}, revision: 3 }],
    update() {}, configure() {},
  }
  const formsCtx = { fiber: { entry: { id: 'insert:import-claude' } }, get: (s) => (s === 'settings' ? formsSettings : undefined) }
  assert.equal(resolvePrefsBinding(formsCtx).mode, 'forms')
  assert.equal(resolvePrefsBinding(formsCtx).ns, 'import-claude')

  // 旧宿主：describe 名单里只有自持命名空间，且有 register/get → legacy
  const legacySettings = {
    register() {},
    get() {},
    describe: () => [{ ns: 'chat-import', value: {}, revision: 1 }],
  }
  const legacy = resolvePrefsBinding({ get: (s) => (s === 'settings' ? legacySettings : undefined) })
  assert.equal(legacy.mode, 'legacy')
  assert.equal(legacy.ns, IMPORT_SETTINGS_NAMESPACE)

  assert.equal(resolvePrefsBinding({ get: () => undefined }).mode, 'none')
  assert.equal(resolvePrefsBinding({}).mode, 'none')
})

test('0.1.7 forms：读走 describe、写走 update(裸条目 id)、probe 报 configured', async () => {
  const calls = []
  const settings = {
    describe: () => [{ ns: 'import-claude', value: { importSystemPrompt: false, injectTools: 'full', sidebarButton: false }, revision: 5 }],
    async update(ns, patch, rev) { calls.push({ ns, patch, rev }) },
    configure() {},
  }
  const ctx = { fiber: { entry: { id: 'insert:import-claude' } }, get: (s) => (s === 'settings' ? settings : undefined) }
  assert.deepEqual(readImportPrefs(ctx), { importSystemPrompt: false, injectTools: 'full', sidebarButton: false })
  const view = describeImportPrefs(ctx)
  assert.equal(view.available, true)
  assert.equal(view.revision, 5)
  assert.deepEqual(view.value, { importSystemPrompt: false, injectTools: 'full', sidebarButton: false })
  // 自检 probe：名单里有裸 id、namespaceState 带 configured 前缀、无 register
  assert.equal(view.probe.hasSettings, true)
  assert.equal(view.probe.hasDescribe, true)
  assert.equal(view.probe.hasRegister, false)
  assert.ok(view.probe.ns.includes('import-claude'), view.probe.ns)
  assert.equal(view.probe.namespaceState, 'configured:import-claude')
  await updateImportPrefs(ctx, { importSystemPrompt: true }, 5)
  assert.deepEqual(calls, [{ ns: 'import-claude', patch: { importSystemPrompt: true }, rev: 5 }])
})

test('0.1.7 forms：registerImportPrefs 声明 auto:false、初值对账一次、document-updated 变化再触发', () => {
  const events = []
  const configured = []
  let current = { importSystemPrompt: true, injectTools: true, sidebarButton: true }
  let updatedListener
  const settings = {
    describe: () => [{ ns: 'import-claude', value: current, revision: 1 }],
    configure(policy, owner) { configured.push({ policy, owner }) },
    update() {},
  }
  const fiber = { entry: { id: 'insert:import-claude' } }
  const ctx = {
    fiber,
    get: (s) => (s === 'settings' ? settings : undefined),
    inject(serviceList, cb) {
      assert.deepEqual(serviceList, ['settings'])
      const returned = cb({
        settings,
        on(event, listener) { if (event === 'settings/document-updated') updatedListener = listener; return () => {} },
      })
      assert.equal(returned, undefined)
    },
  }
  registerImportPrefs(ctx, (mode) => events.push(mode))
  // 初值对账：历史 boolean true → 'full'
  assert.deepEqual(events, ['full'])
  // 页面策略：本插件自带面板，声明不生成宿主自动页
  assert.deepEqual(configured, [{ policy: { auto: false }, owner: fiber }])
  current = { importSystemPrompt: true, injectTools: 'minimal', sidebarButton: true }
  updatedListener('import-claude', 2)
  assert.deepEqual(events, ['full', 'minimal'])
  // 别的命名空间的事件不触发本插件的对账
  updatedListener('other-plugin', 3)
  assert.deepEqual(events, ['full', 'minimal'])
})

test('Config：schemastery 缺 volatile（0.1.5）时不构造、模块照常加载', () => {
  // 回归：无守卫时旧宿主会在模块加载期抛 "volatile is not a function"，整插件报废。
  // 本仓库测试环境的 schemastery 没有 volatile，因此这里 Config 应为 undefined；
  // 若运行环境带新 schemastery 则是带 ~standard 的 schema。两种都合法。
  assert.ok(Config === undefined || (Config && typeof Config['~standard'] === 'object'))
})

test('resolvePrefsBinding：条目未进名单（apply 期 state=1）不缓存 none，state 2 后再解析为 forms', () => {
  // 真实宿主回归：apply 期 fiber 是 state 1，settings.describe() 跳过本条目 → 解析成
  // none。若把 none 也缓存，重启后面板会一直 available:false（probe 却已 configured）。
  let listed = false
  const settings = {
    describe: () => (listed ? [{ ns: 'import-claude', value: { injectTools: 'full' }, revision: 1 }] : []),
    update() {}, configure() {},
  }
  const ctx = { fiber: { entry: { id: 'insert:import-claude' } }, get: (s) => (s === 'settings' ? settings : undefined) }
  assert.equal(resolvePrefsBinding(ctx).mode, 'none')
  listed = true
  const later = resolvePrefsBinding(ctx)
  assert.equal(later.mode, 'forms')
  assert.equal(later.ns, 'import-claude')
})

test('0.1.7 forms：apply 期 describe 未列出条目时，injectTools 初值仍从插件 config 读（真实宿主回归）', () => {
  const events = []
  // 模拟真实宿主 apply 期：fiber state=1，describe() 跳过本条目（空名单）
  const settings = { describe: () => [], update() {}, configure() { return () => {} } }
  const config = { injectTools: { get: () => true } } // 历史 boolean true → 'full'
  const fiber = { entry: { id: 'insert:import-claude' } }
  let updatedListener
  const ctx = {
    fiber,
    get: (s) => (s === 'settings' ? settings : undefined),
    on() { return () => {} },
    inject(serviceList, cb) {
      cb({
        settings,
        on(event, listener) { if (event === 'settings/document-updated') updatedListener = listener; return () => {} },
        effect(fn) { return fn() },
      })
    },
  }
  registerImportPrefs(ctx, (mode) => events.push(mode), config)
  // 初值来自 config 的 volatile 引用，而不是被跳过的 describe
  assert.deepEqual(events, ['full'])
  // config 引用被 loader 原地更新 → 事件触发重读
  config.injectTools = { get: () => 'minimal' }
  updatedListener('import-claude', 2)
  assert.deepEqual(events, ['full', 'minimal'])
})
