#!/usr/bin/env node
/**
 * 批次 F 实机验收（V7 §6 批次 F）：面板 family 归属 + 色板体检 + 13 类语料终端截图。
 *
 * 与 kw-preset-merge-demo.js 同一套 CDP 设施，但目标不同：
 *   A) 设置面板：预设规则行带 family 徽标（归属唯一对用户可见）；
 *      「色板体检」四条闸实测值与 common/keyword-palette-health.js 逐字同源。
 *   B) 终端真实渲染：结构档全开（62 条全上），13 类冻结语料逐类截图进 f-shots/，
 *      后 3 类是批次 D 零命中删除的盲区场景（批次 G 已回表增补并复验着色）。
 *   C) INFO/DEBUG 拆色证据：批次 G 把 word-info 独立到 info 组（cyan），两词前景色号必须不同。
 *
 * 密度数字门槛不在本脚本（见 keyword-density-demo.js E 段）；这里只拍屏幕 + 轻断言。
 *
 * 用法：
 *   1) npm run vite-build
 *   2) D=$(mktemp -d /tmp/electerm-f-XXXX) && mkdir -p $D/home $D/config $D/data
 *      HOME=$D/home XDG_CONFIG_HOME=$D/config DATA_PATH=$D/data \
 *      xvfb-run -a -s "-screen 0 1600x1000x24" ./node_modules/electron/dist/electron \
 *        work/app/app.js --no-sandbox --disable-gpu --remote-debugging-port=9226 \
 *        --window-size=1600,1000 >/dev/null 2>&1 &
 *   3) node --experimental-detect-module self-test/keyword-f-demo.js 9226 [shotDir]
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const WebSocket = require('ws')
const corpus = require('./keyword-f-corpus.js')

const PORT = process.argv[2] || '9226'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'f-shots')

const getJson = url => new Promise((resolve, reject) => {
  http.get(url, res => {
    let body = ''
    res.on('data', d => { body += d })
    res.on('end', () => {
      try {
        resolve(JSON.parse(body))
      } catch (e) {
        reject(e)
      }
    })
  }).on('error', reject)
})

class Cdp {
  constructor (wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.id = 0
    this.pending = new Map()
    this.ready = new Promise((resolve, reject) => {
      this.ws.on('open', resolve)
      this.ws.on('error', reject)
    })
    this.ws.on('message', d => {
      const m = JSON.parse(d.toString())
      if (m.id === undefined) {
        return
      }
      const cb = this.pending.get(m.id)
      if (cb) {
        this.pending.delete(m.id)
        cb(m)
      }
    })
  }

  call (method, params) {
    return new Promise(resolve => {
      const id = ++this.id
      this.pending.set(id, resolve)
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval (expression) {
    const r = await this.call('Runtime.evaluate', { expression, returnByValue: true })
    const details = r.result && r.result.exceptionDetails
    if (details) {
      throw new Error('eval failed: ' + (details.exception && details.exception.description))
    }
    return r.result && r.result.result ? r.result.result.value : undefined
  }

  async shot (file) {
    const r = await this.call('Page.captureScreenshot', { format: 'png' })
    const data = r.result && r.result.data
    if (!data) {
      throw new Error('screenshot failed')
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, Buffer.from(data, 'base64'))
    return path.basename(file)
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const waitFor = async (cdp, expr, label, timeout = 20000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    const v = await cdp.eval(expr)
    if (v) {
      return v
    }
    await sleep(200)
  }
  console.log('TIMEOUT waiting for ' + label)
  return null
}

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)))
}

const OPEN_TERMINAL_SETTING = `(() => {
  const store = window.store
  store.storeAssign({ settingTab: 'setting' })
  store.setSettingItem({ id: 'setting-terminal', name: 'setting-terminal' })
  store.openSettingModal()
  return 'opened'
})()`

const EXPAND_SECTION = i => `(() => {
  const sec = document.querySelectorAll('.kw-section')[${i}]
  if (!sec) return 'no-section'
  if (!sec.querySelector('.kw-sec-body')) {
    sec.querySelector('.kw-sec-head').click()
  }
  return sec.querySelector('.kw-sec-body') ? 'expanded' : 'collapsed'
})()`

const EXPAND_FIRST_GROUPS = `(() => {
  const body = document.querySelector('.kw-section .kw-sec-body')
  if (!body) return 'no-body'
  const groups = [...body.querySelectorAll('.kw-group')].slice(0, 2)
  for (const g of groups) {
    if (!g.querySelector('.kw-rules')) g.querySelector('.kw-group-head').click()
  }
  return groups.length
})()`

const FAMILY_BADGES = `JSON.stringify([...document.querySelectorAll('.kw-family')].slice(0, 8).map(x => ({
  text: x.textContent, title: x.title
})))`

const HEALTH_ROWS = `JSON.stringify([...document.querySelectorAll('.kw-health-row')].map(r => ({
  name: r.querySelector('.kw-health-name').textContent,
  val: r.querySelector('.kw-health-val').textContent,
  gate: r.querySelector('.kw-health-gate').textContent,
  detail: r.querySelector('.kw-health-detail').textContent,
  state: r.querySelector('.kw-health-state').textContent,
  bad: r.classList.contains('bad')
})))`

const clickToolbar = key => `(() => {
  const want = window.translate('${key}')
  const b = [...document.querySelectorAll('.kw-toolbar button')]
    .find(x => x.textContent.trim() === want)
  if (!b) return 'not-found:' + want
  b.click()
  return 'clicked:' + want
})()`

const TURN_STRUCTURE_ON = `(() => {
  const want = window.translate('kwStructureTier')
  const label = [...document.querySelectorAll('.kw-toolbar label.kw-only-on')]
    .find(x => x.textContent.includes(want))
  if (!label) return 'no-label'
  const box = label.querySelector('input')
  if (!box.checked) box.click()
  return 'structure-on'
})()`

const addTab = title => `(() => {
  const store = window.store
  store.addTab({ type: 'local', title: '${title}', batch: 0 })
  const t = store.tabs[store.tabs.length - 1]
  store.changeActiveTabId(t.id)
  return t.id
})()`

const tabReady = id => `(() => {
  const inst = window.refs.get('term-' + '${id}')
  const addon = inst && inst.attachAddon
  return !!(addon && !addon.disposed && addon.term && addon._socket && addon._socket.readyState === 1)
})()`

const findHighlightAddon = id => `(() => {
  const inst = window.refs.get('term-' + '${id}')
  const term = inst && inst.term
  const list = ((term && term._addonManager && term._addonManager._addons) || []).map(a => a.instance)
  const addon = list.find(i => Array.isArray(i.compiledPatterns))
  return addon ? addon.compiledPatterns.length : -1
})()`

const termWrite = (id, text) => `(() => {
  const inst = window.refs.get('term-' + '${id}')
  inst.term.clear()
  inst.term.write(${JSON.stringify(text)})
  return 'written'
})()`

// 读某个词在缓冲区最后一次出现处的首格前景色号（INFO/DEBUG 同色证据）
const wordFg = (id, needle) => `(() => {
  const inst = window.refs.get('term-' + '${id}')
  const b = inst.term.buffer.active
  for (let y = b.length - 1; y >= 0; y--) {
    const line = b.getLine(y)
    if (!line) continue
    const s = line.translateToString(false)
    const i = s.indexOf(${JSON.stringify(needle)})
    if (i < 0) continue
    const c = line.getCell(i)
    return c ? (c.isFgDefault() ? 0 : c.getFgColor()) : -1
  }
  return -1
})()`

const main = async () => {
  const { keywordPresets } = await import('../src/client/common/keyword-presets.js')
  const { paletteHealth } = await import('../src/client/common/keyword-palette-health.js')
  const ruleTotal = keywordPresets.reduce((n, p) => n + p.keywords.length, 0)
  const health = paletteHealth()

  const targets = await getJson(`http://127.0.0.1:${PORT}/json`)
  const page = targets.find(t => t.type === 'page' && String(t.url || '').includes('index.html'))
  if (!page) {
    throw new Error('no electerm page target on ' + PORT)
  }
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready
  const ev = e => cdp.eval(e)
  await waitFor(cdp, '(() => !!(window.store && window.refs))()', 'app ready', 40000)
  console.log('app ready, ruleTotal =', ruleTotal)

  // ---- A) 面板：family 徽标 + 色板体检 ----
  console.log(await ev(OPEN_TERMINAL_SETTING))
  await waitFor(cdp, "(() => !!document.querySelector('.kw-wrap'))()", 'kw form')
  console.log(await ev(EXPAND_SECTION(0)))
  await sleep(400)
  console.log('expanded groups:', await ev(EXPAND_FIRST_GROUPS))
  await sleep(400)
  const badges = JSON.parse(await ev(FAMILY_BADGES))
  check('预设规则行带 family 徽标（title 含家族与色组说明）',
    badges.length > 0 && badges.every(b => b.text && (b.title.includes('色组') || b.title.includes('color groups'))),
    badges.slice(0, 3))
  await cdp.shot(path.join(SHOT_DIR, '01-panel-family.png'))

  console.log(await ev(EXPAND_SECTION(2)))
  await sleep(400)
  // 体检区在长面板底部，不滚动进视口截图拍不到它
  await ev("(() => { const el = document.querySelector('.kw-health'); if (el) el.scrollIntoView({ block: 'center' }); return !!el })()")
  await sleep(200)
  const rows = JSON.parse(await ev(HEALTH_ROWS))
  check('色板体检渲染四条闸', rows.length === 4, rows.map(r => r.name))
  check('四条闸全部 OK（与 CI 同判定）', rows.length === 4 && rows.every(r => r.state === 'OK' && !r.bad), rows)
  const expectVals = [health.g1.min.toFixed(1), health.g2.min.toFixed(1), health.g3.min.toFixed(1), String(health.g4.violations.length)]
  check('面板实测值与 keyword-palette-health.js 逐字同源',
    rows.length === 4 && rows.every((r, i) => r.val === expectVals[i]),
    { panel: rows.map(r => r.val), module: expectVals })
  await cdp.shot(path.join(SHOT_DIR, '02-palette-health.png'))

  // 结构档全开：语义档 + structure 开关 → 56 条全上
  console.log(await ev(clickToolbar('kwApplySemantic')))
  await sleep(300)
  console.log(await ev(TURN_STRUCTURE_ON))
  const cfgFull = await waitFor(
    cdp,
    `(() => { const r = (window.store._config.keywords || []); return r.filter(x => x.keyword && !x.off).length === ${ruleTotal} ? r.filter(x => x.keyword && !x.off).length : null })()`,
    `all ${ruleTotal} rules on`
  )
  check(`语义档 + 结构档 = ${ruleTotal} 条全上`, cfgFull === ruleTotal, { active: cfgFull })
  console.log(await ev('window.store.hideSettingModal()'))
  await sleep(500)

  // ---- B) 终端：13 类语料逐类截图 ----
  const tab = await ev(addTab('KW-F'))
  await waitFor(cdp, tabReady(tab), 'terminal socket')
  await ev(`window.store.changeActiveTabId('${tab}')`)
  const compiled = await waitFor(cdp, `(() => { const n = ${findHighlightAddon(tab)}; return n > 0 ? n : null })()`, 'highlight addon')
  check(`终端编译到 ${ruleTotal} 条规则`, compiled === ruleTotal, { compiled })

  const slugs = [
    'kubectl', 'journalctl', 'nginx', 'ss', 'docker', 'git-status', 'mysql',
    'dmesg', 'pytest', 'switch', 'blind-git-diff', 'blind-ssh', 'blind-git-log'
  ]
  for (let i = 0; i < corpus.length; i++) {
    const [label, lines] = corpus[i]
    const text = '\r\n=== ' + label + ' ===\r\n' + lines.join('\r\n') + '\r\n'
    await ev(termWrite(tab, text))
    await sleep(900)
    const file = String(i + 3).padStart(2, '0') + '-' + slugs[i] + '.png'
    await cdp.shot(path.join(SHOT_DIR, file))
    console.log('shot', file)
  }

  // ---- C) INFO/DEBUG 拆色复核（批次 G：word-info 独立 info 组，cyan）----
  await ev(termWrite(tab, '\r\nINFO level message\r\nDEBUG level message\r\n'))
  await sleep(900)
  const infoFg = await ev(wordFg(tab, 'INFO'))
  const debugFg = await ev(wordFg(tab, 'DEBUG'))
  check('INFO 与 DEBUG 不同色（批次 G：word-info 独立 info 组 = cyan，DEBUG 仍在 debug 组）',
    infoFg > 0 && debugFg > 0 && infoFg !== debugFg, { infoFg, debugFg })
  await cdp.shot(path.join(SHOT_DIR, '16-info-debug.png'))

  const failed = results.filter(r => !r.ok)
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' PASS')
  if (failed.length) {
    console.log('FAILED: ' + failed.map(f => f.name).join(' | '))
  }
  cdp.ws.close()
  process.exit(failed.length ? 1 : 0)
}

main().catch(e => {
  console.error('demo error:', e)
  process.exit(2)
})
