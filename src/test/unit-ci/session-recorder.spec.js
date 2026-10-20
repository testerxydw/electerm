// 会话录制引擎 (T5-4b) 契约守护
// 纯函数 + SessionRecorder 真值测试（mock timers / window stub）；
// ipc.js 与 store/session.js 无法在 node import（electron/antd），走源码契约断言
const { describe, it, beforeEach, afterEach, mock } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const srcRoot = path.resolve(__dirname, '../..')
const read = p => fs.readFileSync(path.join(srcRoot, p), 'utf8')

const addonJs = read('client/components/terminal/attach-addon-custom.js')
const ipcJs = read('app/lib/ipc.js')
const sessionStoreJs = read('client/store/session.js')
const initStateJs = read('client/store/init-state.js')

// window stub: recorder 消费 store.recState + pre.runGlobalAsync 落盘
const appends = []
function setupWindow () {
  if (typeof globalThis.window === 'undefined') {
    globalThis.window = globalThis
  }
  appends.length = 0
  window.store = { recState: {} }
  window.pre = {
    runGlobalAsync: async (name, p, content) => {
      appends.push({ name, p, content })
    }
  }
}

describe('session-recorder: asciinema v2 纯函数', () => {
  // 动态加载 ESM（源文件零 JSX 零外部依赖, 可直接 import）
  let mod
  beforeEach(async () => {
    mod = mod || await import('../../client/common/session-recorder.js')
    setupWindow()
  })

  it('buildCastHeader: version 2 + width/height + unix 秒 timestamp', () => {
    const h = JSON.parse(mod.buildCastHeader({
      width: 120,
      height: 40,
      timestamp: 1698765432456
    }))
    assert.equal(h.version, 2)
    assert.equal(h.width, 120)
    assert.equal(h.height, 40)
    assert.equal(h.timestamp, 1698765432)
  })

  it('buildCastLine: [浮点秒, "o", data] 三元素, 相对开始秒', () => {
    const line = JSON.parse(mod.buildCastLine('hello\n', 1234))
    assert.deepEqual(line.slice(1), ['o', 'hello\n'])
    assert.equal(line[0], 1.234)
  })

  it('buildCastLine: 负 elapsed 钳 0（时钟回拨不产生负时间戳）', () => {
    const line = JSON.parse(mod.buildCastLine('x', -50))
    assert.equal(line[0], 0)
  })

  it('时间戳单调性: elapsed 递增则行首秒不回退', () => {
    let prev = -1
    for (const ms of [0, 10, 500, 1500, 61000]) {
      const ts = JSON.parse(mod.buildCastLine('x', ms))[0]
      assert.ok(ts >= prev, '时间戳必须单调')
      prev = ts
    }
  })
})

describe('session-recorder: SessionRecorder 缓冲与落盘', () => {
  let mod
  let Recorder
  beforeEach(async () => {
    mod = mod || await import('../../client/common/session-recorder.js')
    Recorder = mod.default
    setupWindow()
    mock.timers.enable({ apis: ['Date', 'setTimeout'] })
  })
  afterEach(() => {
    mock.timers.reset()
  })

  it('无 recState 时 onData 不产生任何落盘', async () => {
    const t = mock.timers
    const r = new Recorder('tab1')
    r.onData('out')
    t.tick(100000)
    assert.equal(appends.length, 0)
  })

  it('开录后首块写 header 行, 500ms 窗口 flush 一次落盘', async () => {
    const t = mock.timers
    window.store.recState.tab1 = {
      path: '/tmp/x.cast',
      startTime: 0,
      width: 80,
      height: 24
    }
    const r = new Recorder('tab1')
    r.onData('hello')
    t.tick(501)
    assert.equal(appends.length, 1)
    const lines = appends[0].content.split('\n').filter(Boolean).map(l => JSON.parse(l))
    assert.equal(lines[0].version, 2, '首块必须先落 header')
    assert.deepEqual(lines[1].slice(1), ['o', 'hello'])
    r.stop()
  })

  it('256KB 阈值不等定时器立即 flush', async () => {
    const r = new Recorder('tab1')
    window.store.recState.tab1 = { path: '/tmp/x.cast', startTime: 0, width: 80, height: 24 }
    r.onData('a'.repeat(mod.REC_FLUSH_BYTES + 1))
    assert.equal(appends.length, 1, '超阈值应立即落盘')
    r.stop()
  })

  it('停录(recState 删除)后 onData 收尾落盘尾部, 且后续不再录', async () => {
    const t = mock.timers
    window.store.recState.tab1 = { path: '/tmp/x.cast', startTime: 0, width: 80, height: 24 }
    const r = new Recorder('tab1')
    r.onData('before-stop')
    delete window.store.recState.tab1
    r.onData('trigger-flush') // 触发 active→inactive 收尾
    assert.ok(appends.length >= 1, '收尾必须落盘')
    const all = appends.map(a => a.content).join('')
    assert.ok(all.includes('before-stop'), '尾部缓冲必须落盘')
    const count = appends.length
    r.onData('after-stop')
    t.tick(100000)
    assert.equal(appends.length, count, '停录后不得继续录')
  })

  it('stop() 强制落盘尾部（tab 关闭 dispose 场景）', async () => {
    window.store.recState.tab1 = { path: '/tmp/x.cast', startTime: 0, width: 80, height: 24 }
    const r = new Recorder('tab1')
    r.onData('tail-data')
    r.stop()
    const all = appends.map(a => a.content).join('')
    assert.ok(all.includes('tail-data'))
    // stop 后复用同一实例再次开录, 重新写 header
    window.store.recState.tab1 = { path: '/tmp/y.cast', startTime: 1000, width: 80, height: 24 }
    r.onData('again')
    r.stop()
    assert.ok(appends.some(a => a.p === '/tmp/y.cast'), '复用实例可重新开录')
  })
})

describe('session-recorder: 接线契约', () => {
  it('attach addon: writeToTerminal 挂 recorder.onData, dispose 停录', () => {
    assert.match(addonJs, /import SessionRecorder from '\.\.\/\.\.\/common\/session-recorder\.js'/)
    assert.match(addonJs, /this\.recorder = infoTabId \? new SessionRecorder\(infoTabId\) : null/)
    assert.match(addonJs, /this\.recorder\?\.onData\(str\)/)
    assert.match(addonJs, /this\.recorder\?\.stop\(\)/, 'dispose 必须收尾落盘')
  })

  it('init-state.js: recState 初始化', () => {
    assert.match(initStateJs, /recState: \{\}/)
  })

  it('store/session.js: toggle 走 createRecordFile IPC + delete 状态 + 复用语言包 record/stopRecord', () => {
    assert.match(sessionStoreJs, /runGlobalAsync\('createRecordFile'\)/)
    assert.match(sessionStoreJs, /delete store\.recState\[tabId\]/)
    assert.match(sessionStoreJs, /e\('record'\)/)
    assert.match(sessionStoreJs, /e\('stopRecord'\)/)
    // 反向: 语言包不存在 recStart/recStop 等新 key, 引用会回退 key 名
    assert.doesNotMatch(sessionStoreJs, /recStart|recStop|startRecord|stopRecord2/)
  })

  it('ipc.js: createRecordFile 防重名递增 + appendRecFile 白名单校验（反向: 任意路径拒绝）', () => {
    assert.match(ipcJs, /recRecordFiles\.add\(path\)/)
    assert.match(ipcJs, /while \(fs\.existsSync\(path\)\)/, '同名 cast 递增后缀')
    assert.match(ipcJs, /if \(!recRecordFiles\.has\(path\)\) \{\s*\n\s*throw new Error\('appendRecFile: path not created by createRecordFile'\)/)
    assert.match(ipcJs, /createRecordFile,\n\s*appendRecFile,/, 'asyncGlobals 必须导出两个函数')
    // 反向: 文件名固定前缀, 不得接受渲染层传任意文件名
    assert.match(ipcJs, /electerm-rec-\$\{d\.getFullYear\(\)\}/)
  })
})
