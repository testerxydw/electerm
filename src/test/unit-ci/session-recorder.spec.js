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
  window.store = { recState: {}, config: {} }
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

  it('buildCastLine: type 参数支持输入事件 i', () => {
    const line = JSON.parse(mod.buildCastLine('ls\r', 500, 'i'))
    assert.deepEqual(line.slice(1), ['i', 'ls\r'])
  })

  it('stripShellIntegration: 剥离 OSC 633/133, 保留普通文本与颜色序列', () => {
    const bel = String.fromCharCode(7)
    const esc = String.fromCharCode(27)
    const input = `a${esc}]633;A${bel}b${esc}]633;E;ls;x${bel}c${esc}]133;C${bel}d`
    assert.equal(mod.stripShellIntegration(input), 'abcd')
    // 颜色/光标序列不属于 shell 集成, 必须保留
    const color = `${esc}[32mok${esc}[0m`
    assert.equal(mod.stripShellIntegration(color), color)
    // 标题 OSC 0 不在剥离范围
    const title = `${esc}]0;bash${bel}`
    assert.equal(mod.stripShellIntegration(title), title)
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

  it('开录后首块写 header 行, 微批+500ms 窗口后一次落盘', async () => {
    const t = mock.timers
    window.store.recState.tab1 = {
      path: '/tmp/x.cast',
      startTime: 0,
      width: 80,
      height: 24
    }
    const r = new Recorder('tab1')
    r.onData('hello')
    t.tick(mod.REC_BATCH_MS + mod.REC_FLUSH_INTERVAL + 1)
    assert.equal(appends.length, 1)
    const lines = appends[0].content.split('\n').filter(Boolean).map(l => JSON.parse(l))
    assert.equal(lines[0].version, 2, '首块必须先落 header')
    assert.deepEqual(lines[1].slice(1), ['o', 'hello'])
    r.stop()
  })

  it('80ms 微批: 窗口内多块输出合并成一条 o 事件', async () => {
    const t = mock.timers
    window.store.recState.tab1 = { path: '/tmp/x.cast', startTime: 0, width: 80, height: 24 }
    const r = new Recorder('tab1')
    r.onData('hel')
    t.tick(20)
    r.onData('lo')
    t.tick(mod.REC_BATCH_MS - 20)
    r.stop()
    const lines = appends.map(a => a.content).join('').split('\n').filter(Boolean).map(l => JSON.parse(l))
    const outs = lines.filter(l => l[1] === 'o')
    assert.equal(outs.length, 1, '窗口内碎片只成一条事件')
    assert.equal(outs[0][2], 'hello')
  })

  it('256KB 阈值不等定时器立即 flush（微批窗口后）', async () => {
    const t = mock.timers
    const r = new Recorder('tab1')
    window.store.recState.tab1 = { path: '/tmp/x.cast', startTime: 0, width: 80, height: 24 }
    r.onData('a'.repeat(mod.REC_FLUSH_BYTES + 1))
    t.tick(mod.REC_BATCH_MS)
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

  it('recordStripOsc: 默认剥离 OSC 633 噪声, 关闭后原样保留', async () => {
    const t = mock.timers
    const esc = String.fromCharCode(27)
    const bel = String.fromCharCode(7)
    window.store.recState.tab1 = { path: '/tmp/x.cast', startTime: 0, width: 80, height: 24 }
    const r = new Recorder('tab1')
    r.onData(`hi${esc}]633;A${bel}there`)
    t.tick(mod.REC_BATCH_MS)
    r.stop()
    const on = appends.map(a => a.content).join('')
    assert.ok(on.includes('hithere'), '默认剥离 shell 集成序列')
    assert.ok(!on.includes('633;A'), 'OSC 633 不得落盘')

    appends.length = 0
    window.store.config.recordStripOsc = false
    window.store.recState.tab2 = { path: '/tmp/y.cast', startTime: 0, width: 80, height: 24 }
    const r2 = new Recorder('tab2')
    r2.onData(`hi${esc}]633;A${bel}there`)
    t.tick(mod.REC_BATCH_MS)
    r2.stop()
    const off = appends.map(a => a.content).join('')
    assert.ok(off.includes('633;A'), '关闭剥离后必须原样保留')
  })

  it('recordInput: 开关打开才产生 i 事件, 且先落已有输出', async () => {
    const t = mock.timers
    window.store.recState.tab1 = { path: '/tmp/x.cast', startTime: 0, width: 80, height: 24 }
    const r = new Recorder('tab1')
    r.onData('out')
    r.onInput('ls\r')
    r.stop()
    const offLines = appends.map(a => a.content).join('').split('\n').filter(Boolean).map(l => JSON.parse(l))
    assert.ok(!offLines.some(l => l[1] === 'i'), 'recordInput 默认关闭, 不录输入')

    appends.length = 0
    window.store.config.recordInput = true
    window.store.recState.tab2 = { path: '/tmp/y.cast', startTime: 0, width: 80, height: 24 }
    const r2 = new Recorder('tab2')
    r2.onData('out')
    r2.onInput('ls\r')
    t.tick(mod.REC_BATCH_MS)
    r2.stop()
    const lines = appends.map(a => a.content).join('').split('\n').filter(Boolean).map(l => JSON.parse(l))
    const outs = lines.filter(l => l[1] === 'o')
    const ins = lines.filter(l => l[1] === 'i')
    assert.equal(ins.length, 1, '打开后必须记录输入事件')
    assert.equal(ins[0][2], 'ls\r')
    assert.equal(outs[0][2], 'out')
    assert.ok(lines.indexOf(outs[0]) < lines.indexOf(ins[0]), '输入事件必须在已有输出之后')
  })

  it('密码避录: pause 期间输出/输入均不入 cast, resume 后恢复', async () => {
    window.store.recState.tab1 = { path: '/tmp/x.cast', startTime: 0, width: 80, height: 24 }
    window.store.config.recordInput = true
    const r = new Recorder('tab1')
    r.onData('before')
    r.pause()
    r.onData('secret-out')
    r.onInput('secret-input')
    r.resume()
    r.onData('after')
    r.stop()
    const all = appends.map(a => a.content).join('')
    assert.ok(all.includes('before'))
    assert.ok(all.includes('after'))
    assert.ok(!all.includes('secret'), '避录期间不得落盘')
  })

  it('用户暂停(recState.paused) 时输出不入 cast, 取消暂停后恢复', async () => {
    window.store.recState.tab1 = { path: '/tmp/x.cast', startTime: 0, width: 80, height: 24, paused: true }
    const r = new Recorder('tab1')
    r.onData('paused-out')
    window.store.recState.tab1.paused = false
    r.onData('live-out')
    r.stop()
    const all = appends.map(a => a.content).join('')
    assert.ok(!all.includes('paused-out'))
    assert.ok(all.includes('live-out'))
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
    // T5-4f: 输入录制在 sendToServer 单点挂接; 密码提示 pause/resume
    assert.match(addonJs, /sendToServer = \(data\) => \{[\s\S]*?this\.recorder\?\.onInput\(data\)/)
    assert.match(addonJs, /this\.recorder\?\.pause\(\)/, '密码提示必须触发避录')
    assert.match(addonJs, /this\.recorder\?\.resume\(\)/, '提示结束必须恢复录制')
  })

  it('init-state.js: recState 初始化', () => {
    assert.match(initStateJs, /recState: \{\}/)
  })

  it('T5-4f 终端日志页: 目录行 + 打开目录 + cast 区控制 + 三个录制选项', () => {
    const baseJsx = read('client/components/terminal-info/base.jsx')
    // 顶部统一目录行, 图标与文字按钮同一动作
    assert.match(baseJsx, /renderLogDir \(\)[\s\S]*?createDefaultLogPath\(\)/, '目录行必须展示统一日志目录')
    assert.match(baseJsx, /runGlobalAsync\('openSessionLogDir'\)/, '必须经主进程打开目录')
    assert.match(baseJsx, /FolderOutlined/, '目录行必须有文档图标入口')
    // cast 区读 store 状态 + 时长 + 文件定位 + 控制
    assert.match(baseJsx, /window\.store\.recState\[pid\]/, '录制状态必须来自 store')
    assert.match(baseJsx, /formatDuration\(rec \? now - rec\.startTime : 0\)/, '必须展示录制时长')
    assert.match(baseJsx, /ShowItem to=\{rec\.path\}/, '录制文件必须可定位')
    assert.match(baseJsx, /window\.store\.toggleSessionRecord\(this\.props\.pid\)/)
    assert.match(baseJsx, /window\.store\.toggleSessionRecordPause\(this\.props\.pid\)/)
    for (const k of ['recordInput', 'recordStripOsc', 'recordAvoidPassword']) {
      assert.match(baseJsx, new RegExp(`renderRecSetting\\('${k}'`), `${k} 必须在本页可切换`)
    }
  })

  it('T5-4f: toggleSessionRecordPause 只切 recState.paused, 不新建文件', () => {
    const seg = sessionStoreJs.slice(
      sessionStoreJs.indexOf('Store.prototype.toggleSessionRecordPause'),
      sessionStoreJs.lastIndexOf('}')
    )
    assert.match(seg, /rec\.paused = !rec\.paused/)
    assert.doesNotMatch(seg, /createRecordFile|delete store\.recState/, '暂停不得改变文件与录制状态')
    // 反向: 输入录制提醒只在 recordInput 打开时出现
    assert.match(sessionStoreJs, /if \(store\.config\.recordInput\) \{[\s\S]*?message\.warning\(/)
  })

  it('T5-4f: 密码避录受 recordAvoidPassword 配置控制', () => {
    assert.match(addonJs, /recordAvoidPassword !== false[\s\S]*?this\.recorder\?\.pause\(\)/)
  })

  it('store/session.js: toggle 走 createRecordFile IPC + delete 状态 + 复用语言包 record/stopRecord', () => {
    assert.match(sessionStoreJs, /runGlobalAsync\('createRecordFile'\)/)
    assert.match(sessionStoreJs, /delete store\.recState\[tabId\]/)
    assert.match(sessionStoreJs, /e\('record'\)/)
    assert.match(sessionStoreJs, /e\('stopRecord'\)/)
    // 反向: 语言包不存在 recStart/recStop 等新 key, 引用会回退 key 名
    assert.doesNotMatch(sessionStoreJs, /recStart|recStop|startRecord|stopRecord2/)
  })

  it('T5-4e: 停录通知可点击定位文件 (ShowItem 链接模式, 同 term-log 通知)', () => {
    assert.match(sessionStoreJs, /notification\.open\(\{/,
      '停录后应有可点击通知')
    const stopSeg = sessionStoreJs.slice(
      sessionStoreJs.indexOf('delete store.recState[tabId]'),
      sessionStoreJs.indexOf("runGlobalAsync('createRecordFile')")
    )
    assert.match(stopSeg, /React\.createElement\(ShowItem, \{ to: rec\.path \}/,
      '通知 description 必须用 ShowItem 链接 (点击直调 showItemInFolder 通道)')
    // 反向: antd 6 静态 notification 卡片级 onClick 真机无响应, 弃用该形态
    assert.doesNotMatch(stopSeg, /onClick: \(\) => \{/, '禁止回退卡片级 onClick')
    // 反向: 不得调 shell.openPath (cast 文件无默认关联程序, 打开会失败);
    // 匹配调用形式而非裸词, 避免注释提及 openPath 时误报
    assert.doesNotMatch(sessionStoreJs, /pre\.[a-zA-Z]*[Oo]penPath|shell\.openPath/)
  })

  it('ipc.js: createRecordFile 防重名递增 + appendRecFile 白名单校验（反向: 任意路径拒绝）', () => {
    assert.match(ipcJs, /recRecordFiles\.add\(path\)/)
    assert.match(ipcJs, /while \(fs\.existsSync\(path\)\)/, '同名 cast 递增后缀')
    assert.match(ipcJs, /if \(!recRecordFiles\.has\(path\)\) \{\s*\n\s*throw new Error\('appendRecFile: path not created by createRecordFile'\)/)
    assert.match(ipcJs, /createRecordFile,\n\s*appendRecFile,/, 'asyncGlobals 必须导出两个函数')
    // 反向: 文件名固定前缀, 不得接受渲染层传任意文件名
    assert.match(ipcJs, /electerm-rec-\$\{d\.getFullYear\(\)\}/)
  })

  it('T5-4f: cast 落统一会话日志目录 (与文本日志同处), 不再写 Downloads', () => {
    assert.match(ipcJs, /const getSessionLogDir = \(\) => \{[\s\S]*?config\.sessionLogPath \|\| join\(app\.getPath\('appData'\), 'electerm', 'session_logs'\)/)
    assert.match(ipcJs, /const createRecordFile = async \(\) => \{\s*\n\s*const dir = getSessionLogDir\(\)/)
    assert.match(ipcJs, /fs\.mkdirSync\(dir, \{ recursive: true \}\)/, '目录不存在时必须自建')
    // 反向: 不得回退到 Downloads
    assert.doesNotMatch(ipcJs, /app\.getPath\('downloads'\)/)
  })

  it('T5-4f: openSessionLogDir 建目录后用 shell.openPath 打开, 并导出为 asyncGlobal', () => {
    assert.match(ipcJs, /createRecordFile,\n\s*appendRecFile,\n\s*openSessionLogDir,/, 'asyncGlobals 必须导出 openSessionLogDir')
    assert.match(ipcJs, /const openSessionLogDir = async \(\) => \{[\s\S]*?fs\.mkdirSync\(dir, \{ recursive: true \}\)[\s\S]*?shell\.openPath\(dir\)/)
    // 失败不抛错弹窗, 只记日志
    assert.match(ipcJs, /if \(err\) \{\s*\n\s*log\.error\('\[session-log\]/)
  })

  it('T5-4f: 三个录制配置在主进程/渲染层 default-setting 双处定义', () => {
    const appDefaults = read('app/common/default-setting.js')
    const clientDefaults = read('client/common/default-setting.js')
    const settingTerminal = read('client/components/setting-panel/setting-terminal.jsx')
    const expect = /recordInput: false,\s*\n\s*recordStripOsc: true,\s*\n\s*recordAvoidPassword: true,/
    assert.match(appDefaults, expect, '主进程默认值缺失会导致配置 key 被跳过')
    assert.match(clientDefaults, expect, '渲染层默认值缺失同样静默失效')
    for (const k of ['recordInput', 'recordStripOsc', 'recordAvoidPassword']) {
      assert.match(settingTerminal, new RegExp(`renderToggle\\('${k}'`), `${k} 必须在设置页终端区可编辑`)
    }
    // 反向: 不得引入上一版被否决的 recordFormat 三选
    assert.doesNotMatch(appDefaults, /recordFormat|recordAnsiFilter/)
    assert.doesNotMatch(clientDefaults, /recordFormat|recordAnsiFilter/)
  })
})
