// G1 广播「发送一次」增量回归（设计 §14.2 / 批量输入并入广播）
//
// 测试手段说明（源码含 window / message / ESM import，node 下无法直接 require）：
//  1) term-broadcast.js 是纯逻辑 ESM —— 用 vm 执行去掉 `export ` 的同一份源码，
//     通过 addon 注册表（registerBroadcastAddon）注入终端替身，验证
//     sendOnceToTargets 的扇出边界；
//  2) store/broadcast.js 依赖 window.translate / message / refs / constants /
//     term-broadcast —— 用 vm 执行剥离 import 后的源码，注入可控 stub
//     （message 记录文案 key、真实 resolveBroadcastTargets + sendOnceToTargets
//      联动 addon 注册表），验证 sendBroadcastOnce 的控制流与副作用；
//  3) 文案键：app/common/locales-extra.js 是 CommonJS，直接 require 比对
//     en / zh_cn 键集合与取值；
//  4) DOM 契约：jsx 依赖 antd 无法在 node 渲染，用源码文本静态断言守护
//     e2e 选择器对应的 class，避免选择器漂移。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')
const SRC_TB = 'src/client/common/term-broadcast.js'
const SRC_STORE = 'src/client/store/broadcast.js'
const SRC_MODAL = 'src/client/components/session/broadcast-modal.jsx'
const SRC_TRIGGER = 'src/client/components/footer/batch-input.jsx'
const SRC_E2E = 'src/test/e2e/024.broadcast-once.spec.js'
const SRC_LOCALES = 'src/app/common/locales-extra.js'
const ESC = String.fromCharCode(27)

// 本次新增文案键（git diff 实际为 12 个，任务书写 11 个，按实际登记核对）
const NEW_KEYS = [
  'broadcastModeContinuous',
  'broadcastModeOnce',
  'broadcastOnceDesc',
  'broadcastOnceCmd',
  'broadcastIncludeSource',
  'broadcastSendOnce',
  'broadcastSendAnyway',
  'broadcastOnceSent',
  'broadcastOnceEmpty',
  'broadcastOnceNoTarget',
  'broadcastOnceBlocked',
  'broadcastOnceProductionWarn'
]

// vm 内创建的对象/数组来自另一个 realm，deepStrictEqual 会因原型不同失败
const plain = x => JSON.parse(JSON.stringify(x))

function fakeAddon (id, extra = {}) {
  return {
    id,
    disposed: false,
    _passwordPromptDetected: false,
    _sent: [],
    sendToServer (data) {
      this._sent.push(data)
    },
    ...extra
  }
}

function loadTermBroadcast () {
  const src = read(SRC_TB).replace(/^export /gm, '')
  const sandbox = { String, Array, Set, Map, Object, Boolean, Error }
  vm.createContext(sandbox)
  const exports = '({ isOscResponse, isMirrorableData, canMirror, ' +
    'resolveBroadcastTargets, productionTargets, registerBroadcastAddon, ' +
    'unregisterBroadcastAddon, getBroadcastAddon, resetBroadcastAddons, ' +
    'mirrorInput, sendOnceToTargets })'
  return vm.runInContext(src + '\n' + exports, sandbox)
}

// store/broadcast.js 的 import 全在文件头（含一个 4 行的多行 import），
// 用非贪婪跨行匹配一次性剥掉，再把 default export 转成可取值的表达式
function loadStoreFactory (deps) {
  let src = read(SRC_STORE)
    .replace(/^import[\s\S]*?from '[^']+'\r?$/gm, '')
    .replace('export default Store => {', 'const factory = Store => {')
  src += '\n;factory'
  const sandbox = {
    String,
    Array,
    Set,
    Map,
    Object,
    Boolean,
    Error,
    console,
    ...deps
  }
  vm.createContext(sandbox)
  return vm.runInContext(src, sandbox)
}

// store 侧环境：message 记录文案 key；sendOnceToTargets 用真实实现但记录入参
function makeEnv (opts = {}) {
  const tb = loadTermBroadcast()
  tb.resetBroadcastAddons()
  const calls = { warning: [], success: [], info: [], batch: [], onceArgs: [] }
  const windowStub = {
    translate: k => (k === 'broadcastOnceSent' ? 'broadcastOnceSent {n}' : k),
    store: null
  }
  const message = {
    warning: k => { calls.warning.push(k) },
    success: k => { calls.success.push(k) },
    info: k => { calls.info.push(k) }
  }
  const factory = loadStoreFactory({
    window: windowStub,
    message,
    refs: { get: () => undefined },
    isShellSessionTab: t => ['ssh', 'local', 'telnet', 'serial'].includes(t.type || 'ssh'),
    resolveBroadcastTargets: tb.resolveBroadcastTargets,
    productionTargets: tb.productionTargets,
    sendOnceToTargets: args => {
      calls.onceArgs.push(args)
      return tb.sendOnceToTargets(args)
    }
  })
  class Store {}
  factory(Store)
  const store = new Store()
  Object.assign(store, {
    broadcast: { on: false, sourceTabId: '', targets: [], blocked: null },
    tabs: opts.tabs || [
      { id: 'src', type: 'ssh', title: 'src', host: 'src.example.com' },
      { id: 't1', type: 'ssh', title: 't1', host: 't1.example.com' },
      { id: 't2', type: 'ssh', title: 't2', host: 't2.example.com' }
    ],
    activeTabId: 'src',
    currentTab: { id: 'src', type: 'ssh', title: 'src' },
    broadcastPickerOpen: true,
    broadcastPickerMode: 'once',
    batchInputs: [],
    addBatchInput (text) {
      calls.batch.push(text)
      this.batchInputs.push(text)
    }
  })
  windowStub.store = store
  const addons = {}
  const register = (id, extra) => {
    const a = fakeAddon(id, extra)
    tb.registerBroadcastAddon(id, a)
    addons[id] = a
    return a
  }
  return { store, tb, calls, addons, register }
}

// 纯函数侧环境：走默认 getAddon（= 注册表），与 store 的真实调用一致
function onceEnv () {
  const tb = loadTermBroadcast()
  tb.resetBroadcastAddons()
  const addons = {}
  const register = (id, extra) => {
    const a = fakeAddon(id, extra)
    tb.registerBroadcastAddon(id, a)
    addons[id] = a
    return a
  }
  return { tb, addons, register }
}

describe('sendBroadcastOnce：入参校验与拦截', () => {
  test('持续广播中拒绝一次性发送，且不改任何状态', () => {
    const { store, calls } = makeEnv()
    store.broadcast.on = true
    const r = store.sendBroadcastOnce('ls', ['t1'])
    assert.equal(r, undefined)
    assert.deepEqual(calls.warning, ['broadcastOnceBlocked'])
    assert.equal(calls.onceArgs.length, 0, '不得进入扇出')
    assert.deepEqual(calls.batch, [], '不得写历史')
    assert.equal(calls.success.length, 0)
    assert.equal(store.broadcastPickerOpen, true, '拒绝时不得关弹层')
    assert.equal(store.broadcast.on, true, '不得动持续广播态')
  })

  test('空命令 / 纯空白 / 非字符串一律拦截', () => {
    const bad = ['', '   ', '\n\t  ', null, undefined, 0, 123, {}, ['ls'], true]
    for (const cmd of bad) {
      const { store, calls } = makeEnv()
      const r = store.sendBroadcastOnce(cmd, ['t1'])
      assert.equal(r, undefined, `cmd=${String(cmd)} 应被拦截`)
      assert.deepEqual(calls.warning, ['broadcastOnceEmpty'], `cmd=${String(cmd)} 文案须一致`)
      assert.equal(calls.onceArgs.length, 0)
      assert.deepEqual(calls.batch, [])
      assert.equal(store.broadcastPickerOpen, true)
    }
  })

  test('无目标 + includeSource=false 被拦截', () => {
    const { store, calls } = makeEnv()
    const r = store.sendBroadcastOnce('ls', [], false)
    assert.equal(r, undefined)
    assert.deepEqual(calls.warning, ['broadcastNoTarget'])
    assert.equal(calls.onceArgs.length, 0)
    assert.equal(store.broadcastPickerOpen, true)
  })

  test('无目标 + includeSource=true：只发主控一次并正常收尾', () => {
    const { store, calls, addons, register } = makeEnv()
    register('src')
    const r = store.sendBroadcastOnce('uptime', [], true)
    assert.deepEqual(plain(r), ['src'])
    assert.deepEqual(addons.src._sent, ['uptime\r'])
    assert.equal(calls.onceArgs[0].includeSource, true)
    assert.deepEqual(plain(calls.onceArgs[0].targets), [])
    assert.deepEqual(calls.batch, ['uptime'])
    assert.deepEqual(calls.success, ['broadcastOnceSent 1'])
    assert.equal(store.broadcastPickerOpen, false)
    assert.equal(store.broadcastPickerMode, 'continuous')
  })

  test('目标 id 不存在 / targetIds 为非数组时也按无目标处理', () => {
    for (const ids of [['ghost'], null, undefined, 't1', {}]) {
      const { store, calls } = makeEnv()
      const r = store.sendBroadcastOnce('ls', ids, false)
      assert.equal(r, undefined)
      assert.deepEqual(calls.warning, ['broadcastNoTarget'])
      assert.equal(calls.onceArgs.length, 0)
    }
  })
})

describe('sendBroadcastOnce：成功路径与副作用', () => {
  test('trim 后补 \r 扇出、写历史、关弹层、toast 带命中数', () => {
    const { store, calls, addons, register } = makeEnv()
    register('t1')
    const r = store.sendBroadcastOnce('  uptime  ', ['t1'], false)
    assert.deepEqual(plain(r), ['t1'])
    assert.deepEqual(addons.t1._sent, ['uptime\r'])
    assert.equal(calls.onceArgs[0].data, 'uptime\r')
    assert.equal(calls.onceArgs[0].includeSource, false)
    assert.equal(calls.onceArgs[0].sourceTabId, 'src')
    assert.deepEqual(calls.batch, ['uptime'], '历史存 trim 后的命令')
    assert.deepEqual(calls.success, ['broadcastOnceSent 1'])
    assert.equal(store.broadcastPickerOpen, false)
    assert.equal(store.broadcastPickerMode, 'continuous', '关闭弹层须重置模式')
  })

  test('多行命令保留内部换行，整段以 \r 结尾', () => {
    const { store, calls, addons, register } = makeEnv()
    register('t1')
    const cmd = 'echo a\necho b'
    store.sendBroadcastOnce(cmd, ['t1'])
    assert.equal(calls.onceArgs[0].data, cmd + '\r')
    assert.deepEqual(addons.t1._sent, [cmd + '\r'])
    assert.deepEqual(calls.batch, [cmd])
  })

  test('一次性发送不置 store.broadcast.on、不改写 broadcast 快照', () => {
    const { store, calls, register } = makeEnv()
    register('t1')
    register('src')
    const before = plain(store.broadcast)
    store.sendBroadcastOnce('ls', ['t1'], true)
    assert.deepEqual(plain(store.broadcast), before)
    assert.equal(store.broadcast.on, false)
    assert.deepEqual(plain(store.broadcast.targets), [])
    assert.equal(calls.info.length, 0, '不得触发 stopBroadcast 的提示')
  })

  test('扇出零命中（目标未注册 addon）：提示且不留历史、不关弹层', () => {
    const { store, calls } = makeEnv()
    const r = store.sendBroadcastOnce('ls', ['t1'])
    assert.equal(r, undefined)
    assert.deepEqual(calls.warning, ['broadcastOnceNoTarget'])
    assert.deepEqual(calls.batch, [])
    assert.equal(store.broadcastPickerOpen, true)
    assert.equal(calls.success.length, 0)
  })

  test('目标与主控都处于密码提示：全部跳过并提示无可用目标', () => {
    const { store, calls, addons, register } = makeEnv()
    register('t1', { _passwordPromptDetected: true })
    register('src', { _passwordPromptDetected: true })
    const r = store.sendBroadcastOnce('ls', ['t1'], true)
    assert.equal(r, undefined)
    assert.deepEqual(calls.warning, ['broadcastOnceNoTarget'])
    assert.deepEqual(addons.t1._sent, [])
    assert.deepEqual(addons.src._sent, [])
    assert.equal(store.broadcastPickerOpen, true)
  })

  test('部分目标密码提示：只发给可用目标，命中数按实际计', () => {
    const { store, calls, addons, register } = makeEnv()
    register('t1', { _passwordPromptDetected: true })
    register('t2')
    const r = store.sendBroadcastOnce('ls', ['t1', 't2'], false)
    assert.deepEqual(plain(r), ['t2'])
    assert.deepEqual(addons.t1._sent, [])
    assert.deepEqual(addons.t2._sent, ['ls\r'])
    assert.deepEqual(calls.success, ['broadcastOnceSent 1'])
  })
})

describe('openBroadcastPicker / closeBroadcastPicker 模式', () => {
  test('底栏传 once、其余入口默认 continuous，非法值回落 continuous', () => {
    const { store } = makeEnv()
    store.openBroadcastPicker('once')
    assert.equal(store.broadcastPickerMode, 'once')
    assert.equal(store.broadcastPickerOpen, true)
    store.closeBroadcastPicker()
    assert.equal(store.broadcastPickerOpen, false)
    assert.equal(store.broadcastPickerMode, 'continuous')
    store.openBroadcastPicker()
    assert.equal(store.broadcastPickerMode, 'continuous')
    store.openBroadcastPicker('bogus')
    assert.equal(store.broadcastPickerMode, 'continuous')
  })

  test('非 shell 当前标签 / 无当前标签：告警且不打开弹层', () => {
    const { store, calls } = makeEnv()
    store.currentTab = { id: 'db', type: 'database' }
    store.broadcastPickerOpen = false
    store.openBroadcastPicker('once')
    assert.equal(store.broadcastPickerOpen, false)
    store.currentTab = null
    store.openBroadcastPicker('once')
    assert.equal(store.broadcastPickerOpen, false)
    assert.deepEqual(calls.warning, ['broadcastNoSession', 'broadcastNoSession'])
  })
})

describe('sendOnceToTargets：扇出边界（真实纯函数 + 注册表）', () => {
  test('空目标 + includeSource=false：零扇出', () => {
    const { tb, addons, register } = onceEnv()
    register('src')
    const sent = tb.sendOnceToTargets({
      targets: [],
      sourceTabId: 'src',
      data: 'ls\r',
      includeSource: false
    })
    assert.deepEqual(plain(sent), [])
    assert.deepEqual(addons.src._sent, [])
  })

  test('空目标 + includeSource=true：只发主控一次', () => {
    const { tb, addons, register } = onceEnv()
    register('src')
    const sent = tb.sendOnceToTargets({
      targets: [],
      sourceTabId: 'src',
      data: 'ls\r',
      includeSource: true
    })
    assert.deepEqual(plain(sent), ['src'])
    assert.deepEqual(addons.src._sent, ['ls\r'], '主控只发一次')
    assert.equal(addons.src._broadcastDepth, 0)
  })

  test('目标与主控都注册时主控仍只发一次，不重复', () => {
    const { tb, addons, register } = onceEnv()
    register('src')
    register('t1')
    const sent = tb.sendOnceToTargets({
      targets: [{ tabId: 't1' }],
      sourceTabId: 'src',
      data: 'uptime\r',
      includeSource: true
    })
    assert.deepEqual(plain(sent), ['t1', 'src'])
    assert.deepEqual(addons.src._sent, ['uptime\r'])
    assert.deepEqual(addons.t1._sent, ['uptime\r'])
  })

  test('目标处于密码提示：跳过该目标', () => {
    const { tb, addons, register } = onceEnv()
    register('t1', { _passwordPromptDetected: true })
    register('t2')
    const sent = tb.sendOnceToTargets({
      targets: [{ tabId: 't1' }, { tabId: 't2' }],
      sourceTabId: 'src',
      data: 'ls\r'
    })
    assert.deepEqual(plain(sent), ['t2'])
    assert.deepEqual(addons.t1._sent, [])
    assert.deepEqual(addons.t2._sent, ['ls\r'])
  })

  test('主控处于密码提示：跳过主控，目标照常扇出', () => {
    const { tb, addons, register } = onceEnv()
    register('src', { _passwordPromptDetected: true })
    register('t1')
    const sent = tb.sendOnceToTargets({
      targets: [{ tabId: 't1' }],
      sourceTabId: 'src',
      data: 'ls\r',
      includeSource: true
    })
    assert.deepEqual(plain(sent), ['t1'])
    assert.deepEqual(addons.src._sent, [])
    assert.deepEqual(addons.t1._sent, ['ls\r'])
  })

  test('OSC / DCS 数据不扇出到目标', () => {
    const { tb, addons, register } = onceEnv()
    register('t1')
    const cases = [
      `${ESC}]52;c;eA==\x07`,
      `${ESC}]11;rgb:0/0/0\x07`,
      `${ESC}P1$r0m${ESC}\\`
    ]
    for (const data of cases) {
      const sent = tb.sendOnceToTargets({
        targets: [{ tabId: 't1' }],
        sourceTabId: 'src',
        data
      })
      assert.deepEqual(plain(sent), [], `OSC/DCS 不得扇出：${JSON.stringify(data)}`)
    }
    assert.deepEqual(addons.t1._sent, [])
  })

  test('OSC + includeSource：目标不扇出，主控仍本地执行（闸门不对称，见报告遗留风险）', () => {
    const { tb, addons, register } = onceEnv()
    register('t1')
    register('src')
    const data = `${ESC}]52;c;eA==\x07`
    const sent = tb.sendOnceToTargets({
      targets: [{ tabId: 't1' }],
      sourceTabId: 'src',
      data,
      includeSource: true
    })
    assert.deepEqual(plain(sent), ['src'])
    assert.deepEqual(addons.t1._sent, [], '目标不得收到 OSC 应答')
    // 当前实现：includeSource 分支只挡 disposed / 密码期，不套 OSC 闸门。
    // 主控即本地终端，OSC 应答本地有意义，暂不判为缺陷；此断言锁定当前行为，
    // 若后续对主控也加 OSC 闸门，须同步更新本用例与报告。
    assert.deepEqual(addons.src._sent, [data])
  })

  test('非字符串 / 空 data 不扇出', () => {
    const { tb, addons, register } = onceEnv()
    register('t1')
    for (const data of [null, undefined, '', 123, new Uint8Array([97])]) {
      const sent = tb.sendOnceToTargets({
        targets: [{ tabId: 't1' }],
        sourceTabId: 'src',
        data
      })
      assert.deepEqual(plain(sent), [])
    }
    assert.deepEqual(addons.t1._sent, [])
  })

  test('disposed / 未注册目标跳过', () => {
    const { tb, addons, register } = onceEnv()
    register('t1')
    register('t2', { disposed: true })
    const sent = tb.sendOnceToTargets({
      targets: [{ tabId: 't1' }, { tabId: 't2' }, { tabId: 'ghost' }],
      sourceTabId: 'src',
      data: 'ls\r'
    })
    assert.deepEqual(plain(sent), ['t1'])
    assert.deepEqual(addons.t1._sent, ['ls\r'])
    assert.deepEqual(addons.t2._sent, [])
  })

  test('扇出期间 _broadcastDepth 为 1，结束归 0（防环）', () => {
    const { tb, register } = onceEnv()
    const t1 = register('t1')
    t1.sendToServer = function (data) {
      assert.equal(this._broadcastDepth, 1)
      this._sent.push(data)
    }
    const sent = tb.sendOnceToTargets({
      targets: [{ tabId: 't1' }],
      sourceTabId: 'src',
      data: 'ls\r'
    })
    assert.deepEqual(plain(sent), ['t1'])
    assert.equal(t1._broadcastDepth, 0)
    assert.equal(tb.canMirror({
      state: { on: true, sourceTabId: 't1', targets: [{ tabId: 't1' }], blocked: null },
      sourceTabId: 't1',
      data: 'ls\r',
      depth: 1
    }), false, '镜像转发不得二次扇出')
  })

  test('sendOnceToTargets 不写 store.broadcast：只用临时 state 借闸门', () => {
    const src = read(SRC_TB)
    // sendOnceToTargets 是文件最后一个导出，整段截取；若用非贪婪匹配到行首 }，
    // 会误把参数解构的收尾当成函数结尾
    const fn = src.slice(src.indexOf('export function sendOnceToTargets'))
    assert.doesNotMatch(fn, /store\.broadcast/, '纯函数不得引用 store.broadcast')
    assert.doesNotMatch(fn, /setBroadcast/, '纯函数不得调用 setBroadcast')
    assert.match(fn, /state: \{ on: true, sourceTabId, targets, blocked: null \}/,
      '须用临时 state 调用 mirrorInput')
    assert.match(fn, /mirrorInput\(/, '须复用唯一扇出点')
  })
})

describe('新增文案键：en / zh_cn 一一对应', () => {
  const locales = require(path.join(ROOT, SRC_LOCALES))

  test('12 个新增键两侧都存在、非空、且确为翻译', () => {
    for (const k of NEW_KEYS) {
      assert.equal(typeof locales.en[k], 'string', `en 缺少 ${k}`)
      assert.equal(typeof locales.zh_cn[k], 'string', `zh_cn 缺少 ${k}`)
      assert.ok(locales.en[k].length > 0, `en ${k} 不得为空`)
      assert.ok(locales.zh_cn[k].length > 0, `zh_cn ${k} 不得为空`)
      assert.notEqual(locales.zh_cn[k], k, `zh_cn ${k} 不得回落成 key 原文`)
    }
  })

  test('en / zh_cn 全量键集合完全一致（无单侧漏键）', () => {
    assert.deepEqual(Object.keys(locales.en).sort(), Object.keys(locales.zh_cn).sort())
  })

  test('广播相关 {n} 占位符两侧一致', () => {
    for (const k of ['broadcastOnceSent', 'broadcastStarted']) {
      assert.ok(locales.en[k].includes('{n}'), `en ${k} 须含 {n}`)
      assert.ok(locales.zh_cn[k].includes('{n}'), `zh_cn ${k} 须含 {n}`)
    }
  })

  test('新增 12 个键都已被 store / 弹层实际引用', () => {
    const src = read(SRC_STORE) + read(SRC_MODAL)
    const used = new Set([...src.matchAll(/\be\('([^']+)'\)/g)].map(m => m[1]))
    for (const k of NEW_KEYS) {
      assert.ok(used.has(k), `${k} 应被代码引用，避免死词条`)
      assert.ok(locales.en[k] && locales.zh_cn[k])
    }
  })
})

describe('e2e 选择器与实际 DOM 契约（静态核对，未实跑 Electron）', () => {
  test('底栏触发器保留 .batch-input-holder 且只打开 once 档', () => {
    const trigger = read(SRC_TRIGGER)
    assert.match(trigger, /className='batch-input-holder'/)
    assert.match(trigger, /openBroadcastPicker\('once'\)/)
  })

  test('弹层提供 .broadcast-pick / .broadcast-once / TextArea / primary 按钮', () => {
    const modal = read(SRC_MODAL)
    assert.match(modal, /className='broadcast-modal'/)
    assert.match(modal, /className='broadcast-pick'/)
    assert.match(modal, /className='broadcast-once'/)
    assert.match(modal, /Input\.TextArea/, 'once 档须渲染 TextArea（.ant-input）')
    assert.match(modal, /type='primary'/, 'footer 须有 primary 按钮')
  })

  test('e2e 使用的 4 个选择器与 3 个状态断言字段齐备', () => {
    const e2e = read(SRC_E2E)
    for (const sel of [
      '.batch-input-holder',
      '.broadcast-pick',
      '.broadcast-once .ant-input',
      '.ant-modal-footer .ant-btn-primary'
    ]) {
      assert.ok(e2e.includes(sel), `e2e 缺少选择器 ${sel}`)
    }
    for (const field of ['broadcast.on', 'broadcastPickerOpen', 'batchInputs']) {
      assert.ok(e2e.includes(field), `e2e 缺少字段断言 ${field}`)
    }
  })
})
