#!/usr/bin/env node
// N5f Redis Pub/Sub —— 真 Redis 实机全链路 CDP 探针。
//
// 链路每一环都是真的（无桩）：
//   真实 Redis（env 凭据，不写文件）→ 真实 UI 打开 Pub/Sub 弹层
//   → SUBSCRIBE + PSUBSCRIBE（主进程独立订阅 client）
//   → PUBLISH 走**界面上的发布测试行**（渲染层 → runRedisCommand 控制台策略通道）
//   → 服务端投递 → 'message'/'pmessage' 事件 → 主进程环形缓冲 → 渲染侧 200ms 拉流 → 表格
//
// 为什么必须实机（单测替代不了）：
// - ioredis 的 subscribe 事件流、独立连接与共享连接的隔离，只有真服务端投递才验得出；
// - "同一条消息命中频道+模式出两行"是服务端语义，纯函数测不出；
// - 暂停是主进程侧 skip append（订阅连接继续收），丢消息语义只有实机能验。
//
// 用法（先 npm run compile 并同步主进程产物）：
//   RDB_REDIS_HOST=… RDB_REDIS_PORT=… RDB_REDIS_PASS=… \
//   node self-test/redis-pubsub-cdp-probe.js [display] [pagePort] [mainPort]
// 凭据只从环境变量读，绝不写进被 git 跟踪的文件。频道全部用 probe:ps: 前缀，
// pub/sub 消息不落 keyspace，对实例零数据污染。
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')
const { getJson, Cdp, sleep, waitFor, findPageTarget, makeChecker } = require('./db-ui-helpers')

const ROOT = path.join(__dirname, '..')
const DISPLAY = process.argv[2] || ':153'
const PORT = process.argv[3] || '9358'
const IPORT = process.argv[4] || '9359'
const SHOT_DIR = path.join(ROOT, 'self-test/2026-11-10-redis-pubsub-shots')

const ENV = {
  host: process.env.RDB_REDIS_HOST,
  port: process.env.RDB_REDIS_PORT,
  pass: process.env.RDB_REDIS_PASS
}
const DB = process.env.RDB_REDIS_DB || '0'
// 探针频道：前缀收敛，pub/sub 不产生任何键，跑完无痕
const CH = 'probe:ps:ch1'
const PAT = 'probe:ps:*'

const J = JSON.stringify
const { results, check } = makeChecker()

const RUN = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-n5f-'))
const TITLE = 'n5f-pubsub'
let app = null
let page = null
let mainCdp = null

// 页内探针：Pub/Sub 弹层的 DOM 形状（可见性一律带命中测试）
const PROBE = `(() => {
  window.__hidden = el => {
    let n = el
    while (n && n !== document.body) {
      const s = getComputedStyle(n)
      if (s.display === 'none' || s.visibility === 'hidden') return true
      n = n.parentElement
    }
    return false
  }
  window.__vis = el => {
    if (!el) return false
    const r = el.getBoundingClientRect()
    return !!r.width && !!r.height && !window.__hidden(el)
  }
  window.__one = sel => [...document.querySelectorAll(sel)].filter(window.__vis)[0] || null
  window.__xy = el => {
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  }
  window.__txt = el => (el ? String(el.innerText || '').trim() : null)
  window.__setInput = (el, v) => {
    if (!el) return 'no-input'
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  }
  // 弹层根：antd Modal 挂 body，className 在 .ant-modal 上
  window.__psModal = () => [...document.querySelectorAll('.db-redis-pubsub-modal')].filter(window.__vis)[0] || null
  // 弹层内按文案找按钮。antd 对「无图标的二字按钮」会自动插空格（清屏 → 清 屏），
  // 匹配必须去掉全部空白再比
  window.__psBtn = label => {
    const m = window.__psModal()
    if (!m) return null
    const b = [...m.querySelectorAll('button')].filter(window.__vis)
      .find(x => String(x.innerText || '').replace(/\\s+/g, '') === label)
    return b ? { xy: window.__xy(b), disabled: !!b.disabled } : null
  }
  window.__psState = () => {
    const m = window.__psModal()
    if (!m) return null
    const inputs = [...m.querySelectorAll('.db-redis-pubsub-form input')]
    const rows = [...m.querySelectorAll('.ant-table-row')].filter(window.__vis)
      .map(tr => [...tr.children].map(td => String(td.innerText || '').trim()))
    const tags = [...m.querySelectorAll('.db-redis-pubsub-subs .ant-tag')].filter(window.__vis)
      .map(t => String(t.innerText || '').trim())
    return {
      open: !!m,
      chanInput: inputs[0] ? inputs[0].value : null,
      patInput: inputs[1] ? inputs[1].value : null,
      subsTags: tags,
      subErr: window.__txt(m.querySelector('.db-redis-pubsub-subs-error')),
      error: window.__txt(m.querySelector('.db-redis-pubsub-error')),
      rows,
      pubResult: window.__txt(m.querySelector('.db-redis-pubsub-pub-result')),
      hasStop: !!window.__psBtn('退订'),
      hasStart: !!window.__psBtn('订阅')
    }
  }
  window.__pubChanInput = () => {
    const m = window.__psModal()
    if (!m) return null
    const el = m.querySelector('.db-redis-pubsub-pub-channel')
    if (!el) return null
    return el.tagName === 'INPUT' ? el : el.querySelector('input')
  }
  window.__pubMsgInput = () => {
    const m = window.__psModal()
    if (!m) return null
    const el = m.querySelector('.db-redis-pubsub-pub-message')
    if (!el) return null
    return el.tagName === 'INPUT' ? el : el.querySelector('input')
  }
  window.__psBtnXY = label => {
    const b = window.__psBtn(label)
    return b && !b.disabled ? b.xy : null
  }
  return 1
})()`

function launch () {
  fs.mkdirSync(path.join(RUN, 'home'), { recursive: true })
  fs.mkdirSync(path.join(RUN, 'tmp'), { recursive: true })
  const env = { ...process.env }
  // 宿主（WorkBuddy 沙箱）带 ELECTRON_RUN_AS_NODE=1，不清掉 electron 会以普通 node 跑
  delete env.ELECTRON_RUN_AS_NODE
  env.DISPLAY = DISPLAY
  env.HOME = path.join(RUN, 'home')
  env.XDG_CONFIG_HOME = path.join(RUN, 'config')
  env.TMPDIR = path.join(RUN, 'tmp')
  env.DATA_PATH = path.join(RUN, 'data')
  // Xvfb 无 GPU：命令行 --disable-gpu 不够，必须 app 级禁用硬件加速（crash-reporter.js 认 DISABLE_GPU）
  env.DISABLE_GPU = '1'
  app = spawn(path.join(ROOT, 'node_modules/electron/dist/electron'), [
    'work/app/app.js',
    '--inspect=127.0.0.1:' + IPORT,
    '--remote-debugging-port=' + PORT,
    '--no-sandbox',
    '--disable-gpu',
    '--window-size=1600,1000'
  ], { cwd: ROOT, env, detached: true, stdio: 'ignore' })
}

async function cleanup () {
  if (page) page.ws.close()
  if (mainCdp) mainCdp.ws.close()
  if (app && app.exitCode === null && app.signalCode === null) {
    const exited = new Promise(resolve => app.once('exit', resolve))
    try { process.kill(-app.pid, 'SIGTERM') } catch (err) {
      if (err.code !== 'ESRCH') throw err
    }
    await exited
  }
  fs.rmSync(RUN, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
}

async function assertPortsIdle () {
  for (const [label, port] of [['页面', PORT], ['主进程', IPORT]]) {
    const v = await getJson('http://127.0.0.1:' + port + '/json/list').catch(() => null)
    if (v) {
      throw new Error(label + '端口 ' + port + ' 上已有实例（targets=' + v.length + '）——先清掉再跑')
    }
  }
}

async function waitPageCdp (tries = 90) {
  for (let i = 0; i < tries; i++) {
    const list = await getJson('http://127.0.0.1:' + PORT + '/json/list').catch(() => null)
    const p = list && findPageTarget(list)
    if (p) {
      const cdp = new Cdp(p.webSocketDebuggerUrl)
      await cdp.ready
      await cdp.call('Page.enable', {})
      await cdp.call('Runtime.enable', {})
      await cdp.call('Log.enable', {})
      cdp.events.length = 0
      return cdp
    }
    await sleep(1000)
  }
  throw new Error('端口 ' + PORT + ' 上没有 CDP 页面目标')
}

async function waitMainCdp (tries = 60) {
  for (let i = 0; i < tries; i++) {
    const list = await getJson('http://127.0.0.1:' + IPORT + '/json/list').catch(() => null)
    const t = Array.isArray(list) && list.find(x => x.webSocketDebuggerUrl)
    if (t) {
      const cdp = new Cdp(t.webSocketDebuggerUrl)
      await cdp.ready
      await cdp.call('Runtime.enable', {})
      return cdp
    }
    await sleep(1000)
  }
  throw new Error('inspect 端口 ' + IPORT + ' 上没有主进程目标')
}

// 表格里等一条含 needle 的行（拉流 200ms 一轮，留足窗口）
async function waitRow (needle, label, timeout = 10000) {
  const ok = await waitFor(page,
    `window.__psState() && window.__psState().rows.some(r => r.join('|').indexOf(${J(needle)}) >= 0)`,
    label, timeout)
  return ok
}

async function shot (f) {
  const r = await page.call('Page.captureScreenshot', { format: 'png' })
  const data = r.result && r.result.data
  if (!data) throw new Error('screenshot failed')
  fs.writeFileSync(path.join(SHOT_DIR, f), Buffer.from(data, 'base64'))
}

// 主进程侧：redis.js 模块的 Pub/Sub 导出健在（inspect 直读运行时模块；
// require 用 cwd 绝对路径——process.mainModule 指向 browser_init，相对路径解析不到）
const PS_INSPECT = `(() => {
  const req = process.mainModule && process.mainModule.require
    ? process.mainModule.require
    : require
  const p = req('path').join(process.cwd(), 'work/app/lib/db-client/redis.js')
  const m = req(p)
  return JSON.stringify({
    hasPubsubExports: typeof m.startRedisPubSub === 'function' &&
      typeof m.stopRedisPubSub === 'function'
  })
})()`

async function main () {
  await assertPortsIdle()
  for (const k of ['host', 'port', 'pass']) {
    if (ENV[k] === undefined) {
      throw new Error('缺环境变量 RDB_REDIS_' + k.toUpperCase() + '（凭据只走 env，不写文件）')
    }
  }
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  launch()
  mainCdp = await waitMainCdp()
  page = await waitPageCdp()
  const readyExpr = '!!(window.store && window.store.tabs && window.translate)'
  if (!await waitFor(page, readyExpr, '应用未就绪', 60000)) {
    throw new Error('实例起来了但渲染层没就绪')
  }
  await sleep(2500)
  await page.eval(PROBE)

  // ===== 1. 连真 Redis：readOnly 必须显式 false（发布测试行要过策略层的非只读分支）=====
  await page.eval(`(() => {
    window.store.addTab({
      type: 'database',
      from: 'quick-connect',
      title: ${J(TITLE)},
      dbType: 'redis',
      dbHost: ${J(ENV.host)},
      dbPort: Number(${J(ENV.port)}),
      dbPassword: ${J(ENV.pass)},
      dbName: ${J(DB)},
      dbSsl: false,
      readOnly: false,
      production: false,
      batch: window.store.currentLayoutBatch
    })
    const t = window.store.tabs[window.store.tabs.length - 1]
    window.store.changeActiveTabId(t.id)
    return t.id
  })()`)
  // 真连接要么出库树（db 节点可点），要么出错误页；别干等
  const loaded = await waitFor(page,
    "document.querySelectorAll('.db-tree-db-name').length > 0 || !!window.__one('.db-session-error')",
    'redis connects', 30000)
  const errEl = await page.eval("window.__txt(window.__one('.db-session-error'))")
  check('真 Redis 连上（' + ENV.host + ':' + ENV.port + ' db' + DB + '）', !!loaded && !errEl, errEl || '')
  if (errEl) throw new Error('真库连不上：' + errEl)
  // redis tab 先落在库树：点 db 节点才进键空间（bar 出现 = redisDb 就绪）
  const dbClick = await page.eval(`(() => {
    const el = [...document.querySelectorAll('.db-tree-db-name')]
      .filter(window.__vis)
      .find(x => x.innerText.trim() === ${J('db' + DB)} || x.innerText.trim() === ${J(DB)})
    if (!el) return null
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return 'ok'
  })()`)
  if (!dbClick) throw new Error('库树里找不到 db' + DB + ' 节点')
  check('点库节点进键空间（bar 出现）',
    await waitFor(page, "!!window.__one('.db-redis-bar')", 'redis bar', 20000))

  // ===== 2. 打开 Pub/Sub 弹层 =====
  const openBtn = await page.eval("(() => { const b = window.__one('.db-redis-pubsub-open'); return b ? window.__xy(b) : null })()")
  if (!openBtn) throw new Error('Pub/Sub 入口按钮不可点（redisDb 未就绪？）')
  await page.click(openBtn.x, openBtn.y)
  check('Pub/Sub 弹层打开，初始为表单态（订阅按钮可见、无退订）',
    await waitFor(page, '(() => { const s = window.__psState(); return !!(s && s.open && s.hasStart && !s.hasStop) })()',
      'modal form', 8000))
  await shot('1-modal-form.png')

  // ===== 3. 填频道 + 模式，订阅 =====
  await page.eval(`(() => {
    const s = window.__psState()
    const m = window.__psModal()
    const inputs = [...m.querySelectorAll('.db-redis-pubsub-form input')]
    window.__setInput(inputs[0], ${J(CH)})
    window.__setInput(inputs[1], ${J(PAT)})
    return 'ok'
  })()`)
  const startBtn = await page.eval('window.__psBtnXY("订阅")')
  if (!startBtn) throw new Error('订阅按钮不可点')
  await page.click(startBtn.x, startBtn.y)
  check('订阅确认：频道与模式 Tag 出现（服务端回执）',
    await waitFor(page,
      `(() => { const s = window.__psState(); return !!(s && s.subsTags.indexOf(${J(CH)}) >= 0 && s.subsTags.indexOf(${J(PAT)}) >= 0) })()`,
      'subs tags', 10000))
  check('订阅无失败项（errors 空）',
    await page.eval('(() => { const s = window.__psState(); return s && !s.subErr && !s.error })()'))
  await shot('2-subscribed.png')

  // ===== 4. 命中「频道+模式」双订阅：一条消息两行（服务端语义） =====
  // 发布按钮在 channel 有内容前是 disabled——先填再取坐标
  await page.eval(`(() => {
    window.__setInput(window.__pubChanInput(), ${J(CH)})
    window.__setInput(window.__pubMsgInput(), 'n5f-hello-both')
    return 'ok'
  })()`)
  const pubBtn1 = await page.eval('window.__psBtnXY("发布")')
  await page.click(pubBtn1.x, pubBtn1.y)
  check('发布回执：已发布（接收者数 > 0）',
    await waitFor(page,
      '(() => { const s = window.__psState(); return !!(s && s.pubResult && s.pubResult.indexOf(\'已发布\') >= 0) })()',
      'pub result', 8000))
  check('消息落表（频道+模式双命中各一行：1 行消息 + 1 行模式）',
    await waitFor(page, `(() => {
      const s = window.__psState()
      if (!s) return false
      const hit = s.rows.filter(r => r.join('|').indexOf('n5f-hello-both') >= 0)
      return hit.length === 2 && hit.some(r => r[1] === '消息') && hit.some(r => r[1] === '模式') &&
        hit.every(r => r[2] === ${J(CH)})
    })()`, 'dual row', 10000))

  // ===== 5. 只命中模式的频道：1 行模式 =====
  await page.eval(`(() => {
    window.__setInput(window.__pubChanInput(), 'probe:ps:only-pattern')
    window.__setInput(window.__pubMsgInput(), 'n5f-via-pattern')
    return 'ok'
  })()`)
  const pubBtn2 = await page.eval('window.__psBtnXY("发布")')
  await page.click(pubBtn2.x, pubBtn2.y)
  check('只命中模式的消息：恰 1 行且类型=模式',
    await waitFor(page, `(() => {
      const s = window.__psState()
      if (!s) return false
      const hit = s.rows.filter(r => r.join('|').indexOf('n5f-via-pattern') >= 0)
      return hit.length === 1 && hit[0][1] === '模式' && hit[0][2] === 'probe:ps:only-pattern'
    })()`, 'pattern only row', 10000))
  await shot('3-messages.png')

  // ===== 6. 暂停 = 主进程 skip append：暂停期间发布的消息不追补 =====
  const pauseBtn = await page.eval('window.__psBtnXY("暂停")')
  if (!pauseBtn) throw new Error('暂停按钮不可点')
  await page.click(pauseBtn.x, pauseBtn.y)
  check('暂停态生效（按钮变继续）', await waitFor(page, '!!window.__psBtnXY("继续")', 'paused', 6000))
  await page.eval(`(() => {
    window.__setInput(window.__pubChanInput(), ${J(CH)})
    window.__setInput(window.__pubMsgInput(), 'n5f-while-paused')
    return 'ok'
  })()`)
  const pubBtn3 = await page.eval('window.__psBtnXY("发布")')
  await page.click(pubBtn3.x, pubBtn3.y)
  await sleep(2500)
  check('暂停期间发布的消息不出现（主进程 skip，不追补）',
    !(await page.eval("(() => { const s = window.__psState(); return s && s.rows.some(r => r.join('|').indexOf('n5f-while-paused') >= 0) })()")))
  const resumeBtn = await page.eval('window.__psBtnXY("继续")')
  await page.click(resumeBtn.x, resumeBtn.y)
  await page.eval(`(() => {
    window.__setInput(window.__pubMsgInput(), 'n5f-after-resume')
    return 'ok'
  })()`)
  const pubBtn4 = await page.eval('window.__psBtnXY("发布")')
  await page.click(pubBtn4.x, pubBtn4.y)
  check('恢复后消息继续落表',
    await waitRow('n5f-after-resume', 'after resume row', 10000))

  // ===== 7. 清屏 + 退订 =====
  const clearBtn = await page.eval('window.__psBtnXY("清屏")')
  await page.click(clearBtn.x, clearBtn.y)
  check('清屏后表格为空', await waitFor(page,
    '(() => { const s = window.__psState(); return s && s.rows.length === 0 })()', 'cleared', 6000))
  const stopBtn = await page.eval('window.__psBtnXY("退订")')
  await page.click(stopBtn.x, stopBtn.y)
  check('退订后回到表单态（订阅按钮回归、退订消失）',
    await waitFor(page,
      '(() => { const s = window.__psState(); return !!(s && s.hasStart && !s.hasStop) })()',
      'back to form', 8000))
  await shot('4-stopped.png')

  // ===== 8. 主进程侧 pubsub 导出健在（inspect）=====
  const ins = JSON.parse(await mainCdp.eval(PS_INSPECT))
  check('主进程 Pub/Sub 导出健在（handle 全部清退后模块仍在）', ins.hasPubsubExports === true, ins)

  // 汇总
  const fails = results.filter(x => !x.ok)
  console.log('\\n==== N5f pubsub probe: ' + (results.length - fails.length) + '/' + results.length + ' PASS ====')
  if (fails.length) {
    fails.forEach(f => console.log('FAIL: ' + f.name + ' :: ' + JSON.stringify(f.detail)))
    process.exit(1)
  }
}

main().then(() => {
  return cleanup()
}).then(() => process.exit(0)).catch(async err => {
  console.error('PROBE-ERROR:', (err && err.message) || err)
  try {
    const s = page && await page.eval('window.__psState ? JSON.stringify(window.__psState()) : "no-probe"')
    if (s) console.error('pubsub-state:', String(s).slice(0, 600))
    const btns = page && await page.eval(`(() => {
      const m = window.__psModal()
      return m ? [...m.querySelectorAll('button')].map(b => String(b.innerText || '').trim()).join('|') : 'no-modal'
    })()`)
    if (btns) console.error('modal-buttons:', btns)
  } catch (_) {}
  await cleanup()
  process.exit(1)
})
