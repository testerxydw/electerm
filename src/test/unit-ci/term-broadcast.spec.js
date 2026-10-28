// G1 广播输入纯逻辑（设计 §14.2）
// 用 vm 直接执行 src 下的同一份实现，避免测试拷贝与实现漂移。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const SRC = path.join(ROOT, 'src/client/common/term-broadcast.js')

const EXPORTS = '({ isOscResponse, isMirrorableData, isBroadcastSource, canMirror, ' +
  'resolveBroadcastTargets, productionTargets, registerBroadcastAddon, ' +
  'unregisterBroadcastAddon, getBroadcastAddon, resetBroadcastAddons, mirrorInput })'

function load () {
  const src = fs.readFileSync(SRC, 'utf8').replace(/^export /gm, '')
  const sandbox = { String, Array, Set, Map, Object, Boolean, Error }
  vm.createContext(sandbox)
  return vm.runInContext(src + '\n' + EXPORTS, sandbox)
}

const m = load()
const ESC = String.fromCharCode(27)

// vm 里创建的对象/数组来自另一个 realm，deepStrictEqual 会因原型不同而失败，
// 断言前统一转成本 realm 的纯数据。
const plain = x => JSON.parse(JSON.stringify(x))

// 注入用的终端类型白名单替身（生产由 constants.js 的 isShellSessionTab 提供）
const shell = t => ['ssh', 'local', 'telnet', 'serial'].includes(t.type || 'ssh')

function tab (id, extra = {}) {
  return { id, type: 'ssh', host: id + '.example.com', title: id, ...extra }
}

function state (over = {}) {
  return {
    on: true,
    sourceTabId: 'src',
    blocked: null,
    targets: [{ tabId: 't1', title: 't1', isProduction: false }],
    ...over
  }
}

describe('isOscResponse: 终端应答不参与镜像', () => {
  test('OSC / DCS 前缀判定', () => {
    assert.equal(m.isOscResponse(`${ESC}]11;rgb:0000/0000/0000\x07`), true)
    assert.equal(m.isOscResponse(`${ESC}]52;c;Y29weQ==\x07`), true)
    assert.equal(m.isOscResponse(`${ESC}P1$r0m${ESC}\\`), true)
    assert.equal(m.isOscResponse(`${ESC}[A`), false)
    assert.equal(m.isOscResponse('ls -l\r'), false)
    assert.equal(m.isOscResponse(new Uint8Array([1, 2])), false)
    assert.equal(m.isOscResponse(null), false)
  })

  test('isMirrorableData 只接受非空文本', () => {
    assert.equal(m.isMirrorableData('a'), true)
    assert.equal(m.isMirrorableData(''), false)
    assert.equal(m.isMirrorableData(undefined), false)
    assert.equal(m.isMirrorableData(new Uint8Array([97])), false)
    assert.equal(m.isMirrorableData(`${ESC}]0;t\x07`), false)
  })
})

describe('canMirror: 开关 + 三闸 + 防环', () => {
  test('主控身份匹配才镜像', () => {
    assert.equal(m.isBroadcastSource(state(), 'src'), true)
    assert.equal(m.isBroadcastSource(state(), 'other'), false)
    assert.equal(m.isBroadcastSource(state({ on: false }), 'src'), false)
    assert.equal(m.isBroadcastSource(null, 'src'), false)
    assert.equal(m.canMirror({ state: state(), sourceTabId: 'src', data: 'a' }), true)
    assert.equal(m.canMirror({ state: state(), sourceTabId: 'x', data: 'a' }), false)
  })

  test('密码期 / blocked / 空目标都不镜像', () => {
    const base = { state: state(), sourceTabId: 'src', data: 'a' }
    assert.equal(m.canMirror({ ...base, passwordPrompt: true }), false)
    assert.equal(m.canMirror({ ...base, state: state({ blocked: 'password' }) }), false)
    assert.equal(m.canMirror({ ...base, state: state({ targets: [] }) }), false)
  })

  test('镜像转发不二次扇出（防环）', () => {
    const base = { state: state(), sourceTabId: 'src', data: 'a' }
    assert.equal(m.canMirror({ ...base, depth: 1 }), false)
  })

  test('OSC 应答与二进制不镜像', () => {
    const base = { state: state(), sourceTabId: 'src' }
    assert.equal(m.canMirror({ ...base, data: `${ESC}]52;c;eA==\x07` }), false)
    assert.equal(m.canMirror({ ...base, data: new Uint8Array([3]) }), false)
    assert.equal(m.canMirror({ ...base, data: '' }), false)
  })
})

describe('resolveBroadcastTargets: 只保留 shell 会话且排除主控', () => {
  const tabs = [
    tab('src'),
    tab('t1', { production: true, host: 'prod.example.com', title: 'prod' }),
    tab('db', { type: 'database' }),
    tab('t2', { type: 'local' })
  ]

  test('过滤 + 排序保持 tabs 顺序 + 生产标记', () => {
    assert.deepEqual(
      plain(m.resolveBroadcastTargets(tabs, ['t1', 'db', 't2', 'src', 'ghost'], 'src', shell)),
      [
        { tabId: 't1', title: 'prod', host: 'prod.example.com', isProduction: true },
        { tabId: 't2', title: 't2', host: 't2.example.com', isProduction: false }
      ]
    )
  })

  test('空入参安全', () => {
    assert.deepEqual(plain(m.resolveBroadcastTargets(null, ['a'], 'src', shell)), [])
    assert.deepEqual(plain(m.resolveBroadcastTargets(tabs, null, 'src', shell)), [])
    assert.deepEqual(plain(m.resolveBroadcastTargets(tabs, 't1', 'src', shell)), [])
  })

  test('productionTargets 只列生产目标', () => {
    const targets = m.resolveBroadcastTargets(tabs, ['t1', 't2'], 'src', shell)
    assert.deepEqual(plain(m.productionTargets(targets).map(d => d.tabId)), ['t1'])
    assert.deepEqual(plain(m.productionTargets(null)), [])
  })
})

describe('mirrorInput: 扇出行为', () => {
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

  test('对每个在线目标各发一次，返回命中的 tab', () => {
    const a1 = fakeAddon('t1')
    const a2 = fakeAddon('t2')
    const registry = new Map([['t1', a1], ['t2', a2]])
    const sent = m.mirrorInput({
      state: state({ targets: [{ tabId: 't1' }, { tabId: 't2' }] }),
      sourceTabId: 'src',
      data: 'ls\r',
      getAddon: id => registry.get(id) || null
    })
    assert.deepEqual(plain(sent), ['t1', 't2'])
    assert.deepEqual(a1._sent, ['ls\r'])
    assert.deepEqual(a2._sent, ['ls\r'])
    assert.equal(a1._broadcastDepth, 0)
    assert.equal(a2._broadcastDepth, 0)
  })

  test('断连/未注册/目标密码提示的目标被跳过', () => {
    const alive = fakeAddon('t1')
    const gone = fakeAddon('t2', { disposed: true })
    const prompt = fakeAddon('t3', { _passwordPromptDetected: true })
    const registry = new Map([['t1', alive], ['t2', gone], ['t3', prompt]])
    const sent = m.mirrorInput({
      state: state({ targets: [{ tabId: 't1' }, { tabId: 't2' }, { tabId: 't3' }, { tabId: 't4' }] }),
      sourceTabId: 'src',
      data: 'x',
      getAddon: id => registry.get(id) || null
    })
    assert.deepEqual(plain(sent), ['t1'])
    assert.deepEqual(gone._sent, [])
    assert.deepEqual(prompt._sent, [])
  })

  test('闸门关闭时零扇出（密码/OSC/blocked）', () => {
    const a1 = fakeAddon('t1')
    const getAddon = () => a1
    const cases = [
      { state: state(), passwordPrompt: true },
      { state: state({ blocked: 'password' }) },
      { state: state(), data: `${ESC}]11;rgb:0/0/0\x07` },
      { state: state({ on: false }) }
    ]
    for (const c of cases) {
      const before = a1._sent.length
      const sent = m.mirrorInput({
        state: c.state,
        sourceTabId: 'src',
        data: c.data || 'a',
        passwordPrompt: c.passwordPrompt,
        getAddon
      })
      assert.deepEqual(plain(sent), [])
      assert.equal(a1._sent.length, before)
    }
  })

  test('扇出后 depth 归零：目标侧可继续正常使用', () => {
    const a1 = fakeAddon('t1')
    a1.sendToServer = function () {
      assert.equal(this._broadcastDepth, 1)
    }
    m.mirrorInput({
      state: state(),
      sourceTabId: 'src',
      data: 'a',
      getAddon: () => a1
    })
    assert.equal(a1._broadcastDepth, 0)
  })
})

describe('addon 注册表', () => {
  test('注册/取用/注销只对同一实例生效', () => {
    m.resetBroadcastAddons()
    const a = { sendToServer () {} }
    const b = { sendToServer () {} }
    m.registerBroadcastAddon('t1', a)
    assert.equal(m.getBroadcastAddon('t1'), a)
    // 旧实例 dispose 不得误删新实例的注册
    m.unregisterBroadcastAddon('t1', b)
    assert.equal(m.getBroadcastAddon('t1'), a)
    m.unregisterBroadcastAddon('t1', a)
    assert.equal(m.getBroadcastAddon('t1'), null)
    // 非法入参
    m.registerBroadcastAddon('', a)
    assert.equal(m.getBroadcastAddon(''), null)
    m.resetBroadcastAddons()
    assert.equal(m.getBroadcastAddon('t1'), null)
  })
})
