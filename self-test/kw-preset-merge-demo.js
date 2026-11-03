#!/usr/bin/env node
/**
 * 预置关键字高亮合并 + 编译结果共享 —— CDP 实机验收
 *
 * 钉的是合并/优化后的落地效果（对应三个提交点）：
 *   A) 设置面板：12 个预设分组、规则总数 136（合并前 164）；「全部应用」后
 *      配置里 136 条、跨预设共用的同一条正则不会出现两种颜色（合并纪律）；
 *      组级勾选/取消的统计与配置一致。
 *   B) 终端真实渲染（真 PTY 往返 → xterm 缓冲区单元格前景色）：
 *      Exited (137) 整段红、Exited (0) 整段绿、[core:error] 整块红、
 *      request_time=0.012 与 upstream_response_time=0.008 各自成段（不互相吃掉）、
 *      Traceback (most recent call last) 整句红、[00:12:34.567] 含方括号青，
 *      普通 prose 不着色。
 *   C) 资源：多个页签共用同一份编译结果（compiledPatterns 是同一个数组引用，
 *      RegExp 对象不按页签翻倍）；「全部应用」后生效规则去重成 102 条而非 136 条。
 *   D) 洪泛上限：一行 600 个 error 只有前 maxMatchesPerSegment(512) 个着色。
 *   E) 全部不应用后新建页签 0 条规则、完全不着色（静音路径 + 空规则不缓存）。
 *
 * 数据库网格走同一条链路（activeKeywords → compileKeywords），由单测覆盖：
 * src/test/unit-ci/keyword-compile.spec.js、keyword-groups.spec.js、
 * db-highlight-length.spec.js。
 *
 * 用法：
 *   1) npm run vite-build
 *   2) D=$(mktemp -d /tmp/electerm-kw-XXXX) && mkdir -p $D/home $D/config $D/data
 *      HOME=$D/home XDG_CONFIG_HOME=$D/config DATA_PATH=$D/data \
 *      xvfb-run -a -s "-screen 0 1600x1000x24" ./node_modules/electron/dist/electron \
 *        work/app/app.js --no-sandbox --disable-gpu --remote-debugging-port=9225 \
 *        --window-size=1600,1000 >/dev/null 2>&1 &
 *   3) node self-test/kw-preset-merge-demo.js 9225 [shotDir]
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const WebSocket = require('ws')

const PORT = process.argv[2] || '9225'
const SHOT_DIR = process.argv[3] || path.join(__dirname, 'kw-preset-merge-shots')

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

/* ------------------------------------------------------------------ *
 * 面板
 * ------------------------------------------------------------------ */

const OPEN_TERMINAL_SETTING = `(() => {
  const store = window.store
  store.storeAssign({ settingTab: 'setting' })
  store.setSettingItem({ id: 'setting-terminal', name: 'setting-terminal' })
  store.openSettingModal()
  return 'opened'
})()`

const EXPAND_PRESET = `(() => {
  const sec = document.querySelector('.kw-section')
  if (!sec) return 'no-section'
  if (!sec.querySelector('.kw-sec-body')) {
    sec.querySelector('.kw-sec-head').click()
  }
  return sec.querySelector('.kw-sec-body') ? 'expanded' : 'collapsed'
})()`

const GROUP_ROWS = `(() => {
  const body = document.querySelector('.kw-section .kw-sec-body')
  if (!body) return '[]'
  return JSON.stringify([...body.querySelectorAll('.kw-group')].map(g => ({
    name: g.querySelector('.kw-group-name').textContent,
    total: Number(g.querySelector('.kw-pill').textContent),
    count: g.querySelector('.kw-group-count').textContent.trim()
  })))
})()`

const STAT_TEXTS = `JSON.stringify({
  stat: (document.querySelector('.kw-stat') || {}).textContent || '',
  badge: ((document.querySelector('.kw-section .kw-badge') || {}).textContent || '').trim()
})`

const clickToolbar = key => `(() => {
  const want = window.translate('${key}')
  const b = [...document.querySelectorAll('.kw-toolbar button')]
    .find(x => x.textContent.trim() === want)
  if (!b) return 'not-found:' + want
  b.click()
  return 'clicked:' + want
})()`

// 组级三态勾选：点预设分组头里的 checkbox（TriCheck 自己 stopPropagation，不会误展开）
const toggleGroupCheck = name => `(() => {
  const body = document.querySelector('.kw-section .kw-sec-body')
  const g = body && [...body.querySelectorAll('.kw-group')]
    .find(x => (x.querySelector('.kw-group-name') || {}).textContent === '${name}')
  if (!g) return 'no-group'
  const box = g.querySelector('.kw-group-head .kw-check')
  if (!box) return 'no-check'
  box.click()
  return 'clicked'
})()`

// 配置侧的真实数据：条数、生效数、静音数、去重后的不同正则数、跨预设撞色
const CONFIG_STATS = `(() => {
  const raw = (window.store._config && window.store._config.keywords) || []
  const colorOf = new Map()
  const conflict = []
  for (const r of raw) {
    if (!r || !r.keyword) continue
    const c = r.color || 'red'
    if (colorOf.has(r.keyword) && colorOf.get(r.keyword) !== c) {
      conflict.push([r.keyword, colorOf.get(r.keyword), c])
    }
    if (!colorOf.has(r.keyword)) colorOf.set(r.keyword, c)
  }
  const on = raw.filter(r => r && r.keyword && !r.off)
  return JSON.stringify({
    total: raw.length,
    on: on.length,
    off: raw.filter(r => r && r.off).length,
    distinctPattern: colorOf.size,
    conflict,
    // 生效侧「正则 + 颜色」去重后的条数 = 终端/网格真正编译的规则数
    activeDedup: new Set(on.map(r => r.keyword + '|' + (r.color || 'red'))).size
  })
})()`

/* ------------------------------------------------------------------ *
 * 终端
 * ------------------------------------------------------------------ */

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

const findHighlightAddon = `(() => {
  const inst = window.refs.get('term-' + window.__kwTab)
  const term = inst && inst.term
  const list = ((term && term._addonManager && term._addonManager._addons) || []).map(a => a.instance)
  return list.find(i => Array.isArray(i.compiledPatterns)) ? 'ok' : 'no-addon'
})()`

// 所有页签的高亮插件编译结果：是否同一引用、RegExp 对象总数、去重后规则数
const shareCheck = ids => `(() => {
  const arrs = []
  for (const id of ${JSON.stringify(ids)}) {
    const inst = window.refs.get('term-' + id)
    const term = inst && inst.term
    const list = ((term && term._addonManager && term._addonManager._addons) || []).map(a => a.instance)
    const addon = list.find(i => Array.isArray(i.compiledPatterns))
    if (!addon) return 'missing-addon:' + id
    arrs.push(addon.compiledPatterns)
  }
  const objs = new Set()
  for (const a of arrs) for (const p of a) objs.add(p)
  const pairs = new Set()
  for (const p of arrs[0]) pairs.add(p.re.source + '|' + p.color)
  return JSON.stringify({
    tabs: arrs.length,
    perTab: arrs.map(a => a.length),
    sameReference: arrs.every(a => a === arrs[0]),
    regExpObjects: objs.size,
    distinctRules: pairs.size
  })
})()`

const addonLimits = id => `(() => {
  const inst = window.refs.get('term-' + '${id}')
  const term = inst && inst.term
  const list = ((term && term._addonManager && term._addonManager._addons) || []).map(a => a.instance)
  const addon = list.find(i => Array.isArray(i.compiledPatterns))
  if (!addon) return '{}'
  return JSON.stringify({
    maxHighlightLength: addon.maxHighlightLength,
    maxHighlightChunkLength: addon.maxHighlightChunkLength,
    maxMatchesPerSegment: addon.maxMatchesPerSegment
  })
})()`

const termWrite = (id, text) => `(() => {
  const inst = window.refs.get('term-' + '${id}')
  inst.term.write(${JSON.stringify(text)})
  return 'written'
})()`

const sendToPty = (id, cmd) => `(() => {
  const inst = window.refs.get('term-' + '${id}')
  inst.attachAddon.sendToServer(${JSON.stringify(cmd)})
  return 'sent'
})()`

// 校准：用真实 ANSI 码写出 R G Y B M C W，读回各颜色在本机 xterm 里的前景色号
const CALIBRATION_TEXT = '\r\nKWCAL \u001b[31mR\u001b[0m \u001b[32mG\u001b[0m \u001b[33mY\u001b[0m ' +
  '\u001b[34mB\u001b[0m \u001b[35mM\u001b[0m \u001b[36mC\u001b[0m \u001b[37mW\u001b[0m\r\n'

const CALIBRATION_READ = id => `(() => {
  const inst = window.refs.get('term-' + '${id}')
  const b = inst.term.buffer.active
  for (let y = 0; y < b.length; y++) {
    const line = b.getLine(y)
    if (!line || line.translateToString(true).indexOf('KWCAL') < 0) continue
    const s = line.translateToString(false)
    const out = {}
    for (let x = 0; x < s.length; x++) {
      const ch = s[x]
      if ('RGBYMCW'.indexOf(ch) < 0) continue
      const c = line.getCell(x)
      if (c && s[x - 1] === ' ') {
        out[ch] = c.isFgDefault() ? 0 : c.getFgColor()
      }
    }
    return JSON.stringify(out)
  }
  return '{}'
})()`

// 片段着色探针：needle 每次出现，逐格取前景色号，并取片段右侧一列（越界检查）
const spanProbe = (id, needle) => `(() => {
  const inst = window.refs.get('term-' + '${id}')
  const b = inst.term.buffer.active
  const needle = ${JSON.stringify(needle)}
  const hits = []
  for (let y = 0; y < b.length; y++) {
    const line = b.getLine(y)
    if (!line) continue
    const s = line.translateToString(false)
    let i = s.indexOf(needle)
    while (i >= 0) {
      const cells = []
      for (let x = i; x < i + needle.length; x++) {
        const c = line.getCell(x)
        cells.push(c ? (c.isFgDefault() ? 0 : c.getFgColor()) : -1)
      }
      const right = line.getCell(i + needle.length)
      hits.push({
        y,
        cells,
        right: right ? (right.isFgDefault() ? 0 : right.getFgColor()) : -1,
        afterText: right ? right.char : '',
        wrapped: !!line.isWrapped
      })
      i = s.indexOf(needle, i + 1)
    }
  }
  return JSON.stringify({ hits })
})()`

/**
 * 断言：needle 至少出现一次；每格前景色都等于期望色号（负例 = 全部默认前景）；
 * 片段右邻一格必须是默认前景（证明没有多吃一个字符）。
 */
const assertSpan = (name, probe, fg) => {
  const parsed = JSON.parse(probe)
  const hits = parsed.hits
  const okCount = hits.length > 0
  const badSpan = okCount ? hits.find(h => h.cells.some(c => (fg === 0 ? c !== 0 : c !== fg))) : null
  const leak = (!badSpan && fg !== 0) ? hits.find(h => h.right !== 0) : null
  check(name, okCount && !badSpan && !leak, {
    occurrences: hits.length,
    expectFg: fg,
    firstCells: hits.length ? hits[0].cells : null,
    bad: badSpan ? { y: badSpan.y, cells: badSpan.cells } : null,
    leak: leak ? { y: leak.y, right: leak.right, afterText: leak.afterText } : null
  })
}

// 洪泛：统计 KWFLOOD 与 KWFLOOD-END 两条标记行之间的着色格子数
const floodColoredCells = id => `(() => {
  const inst = window.refs.get('term-' + '${id}')
  const b = inst.term.buffer.active
  let start = -1
  let end = -1
  const lines = []
  for (let y = 0; y < b.length; y++) {
    const l = b.getLine(y)
    lines.push(l ? l.translateToString(true) : '')
  }
  for (let y = 0; y < lines.length; y++) {
    if (lines[y].indexOf('KWFLOOD') >= 0 && lines[y].indexOf('END') < 0) start = y
    if (lines[y].indexOf('KWFLOOD-END') >= 0) end = y
  }
  if (start < 0 || end < 0 || end <= start) return JSON.stringify({ start, end, cells: -1 })
  let cells = 0
  let runs = 0
  let prev = false
  for (let y = start + 1; y < end; y++) {
    const line = b.getLine(y)
    if (!line) continue
    for (let x = 0; x < line.length; x++) {
      const c = line.getCell(x)
      const on = !!c && !c.isFgDefault()
      if (on) cells++
      if (on && !prev) runs++
      prev = on
    }
  }
  return JSON.stringify({ start, end, cells, runs })
})()`

const main = async () => {
  const targets = await getJson(`http://127.0.0.1:${PORT}/json`)
  const page = targets.find(t => t.type === 'page' && String(t.url || '').includes('index.html'))
  if (!page) {
    throw new Error('no electerm page target on ' + PORT)
  }
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready
  const ev = e => cdp.eval(e)

  await waitFor(cdp, '(() => !!(window.store && window.refs))()', 'app ready', 40000)
  console.log('app ready')

  // ---- A) 设置面板 ----
  console.log(await ev(OPEN_TERMINAL_SETTING))
  check('设置 → 终端 → 关键字高亮面板渲染', !!(await waitFor(cdp, "(() => !!document.querySelector('.kw-wrap'))()", 'kw form')))
  console.log(await ev(EXPAND_PRESET))
  await sleep(600)
  const groups = JSON.parse(await ev(GROUP_ROWS))
  const pillSum = groups.reduce((n, g) => n + g.total, 0)
  check('预置分组 12 个', groups.length === 12, { groups: groups.length })
  check('合并后规则总数 136（合并前 164）', pillSum === 136, {
    pillSum, byGroup: groups.map(g => g.name + '=' + g.total)
  })
  const t0 = JSON.parse(await ev(STAT_TEXTS))
  const flat = s => String(s).replace(/\s+/g, '')
  check('未应用时面板统计 0/136',
    flat(t0.stat).includes('0/136') && flat(t0.badge).includes('0/136'), t0)
  await cdp.shot(path.join(SHOT_DIR, '01-panel-empty.png'))

  console.log(await ev(clickToolbar('kwApplyAll')))
  // 面板未填过的默认空规则也会留在配置里，所以按「带 keyword 的条数」判定
  const cfgApplied = JSON.parse(await waitFor(
    cdp,
    `(() => { const r = (window.store._config.keywords || []); return r.filter(x => x.keyword && !x.off).length === 136 ? ${CONFIG_STATS} : null })()`,
    'apply all -> 136 active rules in config'
  ))
  check('「全部应用」写入配置 136 条预设规则', cfgApplied.on === 136, cfgApplied)
  check('跨预设没有一条正则被配成两种颜色（合并纪律）', cfgApplied.conflict.length === 0, cfgApplied.conflict)
  check('「全部应用」后生效规则去重为 102 条', cfgApplied.activeDedup === 102, cfgApplied)
  const t1 = JSON.parse(await ev(STAT_TEXTS))
  check('面板统计跟随：已应用 136/136', String(t1.stat).replace(/\s+/g, ' ').includes('136/136'), t1)
  await cdp.shot(path.join(SHOT_DIR, '02-panel-applied.png'))

  // 组级取消勾选：只静音，不丢规则
  console.log(await ev(toggleGroupCheck('Networking')))
  const cfgOff = JSON.parse(await waitFor(
    cdp,
    `(() => { const r = (window.store._config.keywords || []); return r.filter(x => x.off).length === 10 ? ${CONFIG_STATS} : null })()`,
    'mute Networking group'
  ))
  check('取消 Networking 分组：10 条静音、生效 126 条（规则保留不丢）',
    cfgOff.off === 10 && cfgOff.on === 126 && cfgOff.total === cfgApplied.total, cfgOff)
  console.log(await ev(toggleGroupCheck('Networking')))
  const cfgOn = JSON.parse(await waitFor(
    cdp,
    `(() => { const r = (window.store._config.keywords || []); return r.filter(x => x.off).length === 0 ? ${CONFIG_STATS} : null })()`,
    'un-mute Networking group'
  ))
  check('重新勾选：静音清零、生效仍是 102 条', cfgOn.off === 0 && cfgOn.activeDedup === 102, cfgOn)

  console.log(await ev('window.store.hideSettingModal()'))
  await sleep(500)

  // ---- C) 三个页签共享同一份编译结果 ----
  const ids = []
  for (const t of ['KW-A', 'KW-B', 'KW-C']) {
    ids.push(await ev(addTab(t)))
  }
  for (const id of ids) {
    await waitFor(cdp, tabReady(id), 'terminal ' + id + ' socket')
  }
  await ev(`window.__kwTab = '${ids[0]}'`)
  check('高亮插件已挂到终端 addon 链', await waitFor(cdp, findHighlightAddon, 'highlight addon'))
  const share = JSON.parse(await waitFor(
    cdp,
    `(() => { const r = ${shareCheck(ids)}; return r.indexOf('missing') === 0 ? null : r })()`,
    'three terminals compiled'
  ))
  check('三个页签 compiledPatterns 是同一引用（进程级共享）', share.sameReference === true, share)
  check('RegExp 对象数 = 规则数 102，不按页签翻倍（旧实现 3×136）',
    share.regExpObjects === 102 && share.perTab.every(n => n === 102), share)
  const limits = JSON.parse(await ev(addonLimits(ids[0])))
  check('运行期限流参数：4096 / 256K / 512',
    limits.maxHighlightLength === 4096 && limits.maxHighlightChunkLength === 262144 &&
    limits.maxMatchesPerSegment === 512, limits)

  // ---- B) 真 PTY 往返 + 缓冲区单元格颜色 ----
  const tab = ids[0]
  // 截图要拍到被写入的那个页签，所以先切过去（断言读的是缓冲区，与可见性无关）
  await ev(`window.store.changeActiveTabId('${tab}')`)
  await ev(`window.__kwTab = '${tab}'`)
  await ev(termWrite(tab, CALIBRATION_TEXT))
  await sleep(700)
  const cal = JSON.parse(await ev(CALIBRATION_READ(tab)))
  const fgOf = c => cal[c] === undefined ? -1 : cal[c]
  check('颜色校准成功（红绿黄蓝紫青白七色均可读回）',
    'RGBYMCW'.split('').every(c => typeof cal[c] === 'number' && cal[c] > 0), cal)

  const ptyLines = [
    ['container 42 Exited (137) 2 minutes ago', 'Exited (137)', 'R', 'Exited (137) 整段红（含括号与退出码）'],
    ['container 7 Exited (0) 5 minutes ago', 'Exited (0)', 'G', 'Exited (0) 整段绿'],
    ['request_time=0.012 upstream_response_time=0.008', 'request_time=0.012', 'C', 'request_time 成段青，单位尾巴没吃掉后面的键名'],
    ['request_time=0.012 upstream_response_time=0.008', 'upstream_response_time=0.008', 'C', 'upstream_response_time 同样成段青'],
    ['[core:error] pid 1234 tid 5678', '[core:error]', 'R', '[core:error] 含方括号整块红'],
    ['Traceback (most recent call last):', 'Traceback (most recent call last)', 'R', 'Traceback 整句红，不被共享 severity 规则截成单词'],
    ['[00:12:34.567] worker started', '[00:12:34.567]', 'C', '方括号时钟含括号整段青'],
    ['FATAL boom', 'FATAL', 'R', 'FATAL 红（后面收尾用于验证静音路径）'],
    ['the weather is fine today', 'weather is fine', '0', '负例：普通 prose 不着色']
  ]
  for (const [payload, needle, color, label] of ptyLines) {
    await ev(sendToPty(tab, `printf '%s\\n' '${payload}'\r`))
    await sleep(1200)
    assertSpan(label, await ev(spanProbe(tab, needle)), color === '0' ? 0 : fgOf(color))
  }
  await cdp.shot(path.join(SHOT_DIR, '03-terminal-lines.png'))

  // ---- D) 洪泛上限 ----
  const flood = 'error '.repeat(600)
  await ev(termWrite(tab, '\r\nKWFLOOD\r\n' + flood + '\r\nKWFLOOD-END\r\n'))
  const flooded = JSON.parse(await waitFor(
    cdp,
    `(() => { const r = ${floodColoredCells(tab)}; return JSON.parse(r).end > 0 ? r : null })()`,
    'flood rendered',
    30000
  ))
  // 512 段 x 5 格 = 2560 个着色格子；跨行折行的片段会被拆成两段，所以 runs 只作下界
  check('600 个 error 只着色前 512 个（其余留白）',
    flooded.cells === 512 * 5 && flooded.runs >= 512, flooded)
  await cdp.shot(path.join(SHOT_DIR, '04-flood-cap.png'))

  // ---- E) 全部不应用 ----
  console.log(await ev(OPEN_TERMINAL_SETTING))
  await waitFor(cdp, "(() => !!document.querySelector('.kw-wrap'))()", 'kw form again')
  console.log(await ev(EXPAND_PRESET))
  await sleep(400)
  console.log(await ev(clickToolbar('kwUnapplyAll')))
  const cfgCleared = JSON.parse(await waitFor(
    cdp,
    `(() => { const r = (window.store._config.keywords || []); return r.filter(x => !x.off && x.keyword).length === 0 ? ${CONFIG_STATS} : null })()`,
    'unapply all'
  ))
  check('「全部不应用」后生效规则 0 条（规则保留只静音）',
    cfgCleared.on === 0 && cfgCleared.total === cfgApplied.total, cfgCleared)
  console.log(await ev('window.store.hideSettingModal()'))
  await sleep(500)

  const offId = await ev(addTab('KW-OFF'))
  await waitFor(cdp, tabReady(offId), 'off-state terminal socket')
  const offShare = JSON.parse(await waitFor(
    cdp,
    `(() => { const r = ${shareCheck([offId])}; return r.indexOf('missing') === 0 ? null : r })()`,
    'off terminal compiled'
  ))
  check('静音后新建页签编译到 0 条规则', offShare.perTab[0] === 0, offShare)
  await ev(sendToPty(offId, "printf '%s\\n' 'FATAL boom'\r"))
  await sleep(1200)
  assertSpan('静音后 FATAL 不再着色', await ev(spanProbe(offId, 'FATAL')), 0)
  await cdp.shot(path.join(SHOT_DIR, '05-unapplied.png'))

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
