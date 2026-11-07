#!/usr/bin/env node
/**
 * 关键字高亮「档位组合」实机验收 —— 工具条三勾选（语义档 / 结构档 / 应用全部）
 *
 * 钉的是组合链路，不是扫描算法（算法有 unit-ci 逐字断言）：
 *   UI 点击 → keyword-groups 纯函数 → store._config.keywords
 *          → compileKeywords → 终端 addon.compiledPatterns → xterm 单元格前景色
 *
 * 十二个组合（每步都按面板真实点击语义回放，含 indeterminate 的「先补齐再全关」）：
 *   C0 全关 → C1 只勾语义档 → C2 再勾结构档（应用全部自动勾上）→ C3 取消语义档
 *   （只剩结构档，证明两档互相独立）→ C4 再取消结构档 → C5 重勾语义档 → C6 应用全部
 *   → C7 单条静音 FATAL → C8 新增用户规则 → C9 静音用户规则
 *   → C10 半开的「应用全部」再点 = 补齐 → C11 全部取消
 *
 * 每个组合断言四件事：
 *   1) 三个勾选的 DOM 态（checked / indeterminate / n-m 计数）= 纯函数派生态；
 *   2) 配置生效条数 = Node 侧独立回放点击序列算出的 activeKeywords 条数（回放与
 *      真实 UI 分叉时这里直接 FAIL）；
 *   3) 终端 addon.compiledPatterns 条数 = 实际配置编译出来的规则数（热更新路径）；
 *   4) 语料逐格着色：与 Node 真实管线（含 35% 行级覆盖率闸）逐字符一致，
 *      同色同号 / 异色异号，且每个 needle 的着色与否 = 该档在当前组合的开关意图。
 *
 * 用法：
 *   1) npm run vite-build
 *   2) 干净临时实例 + xvfb + --remote-debugging-port=9225（见 self-test/README 同款）
 *   3) node --experimental-detect-module self-test/kw-tier-combo-demo.js 9225 [shotDir]
 *      node --experimental-detect-module self-test/kw-tier-combo-demo.js --dry
 *      ↑ --dry 只跑 Node 侧语料自检，不开 CDP、不截图
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const argv = process.argv.slice(2)
const DRY = argv.includes('--dry')
const nums = argv.filter(a => /^\d+$/.test(a))
const PORT = nums[0] || '9225'
// 从第 N 个组合开始断言（前面的组合照常执行但不做逐格断言）：单步调试时用，
// 全量验收从 1 开始。
const START_AT = Number(nums[1] || 1)
const SHOT_DIR = argv.find(a => a !== '--dry' && !/^\d+$/.test(a)) ||
  path.join(__dirname, 'kw-tier-combo-shots')

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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/* ------------------------------------------------------------------ *
 * Node 侧引擎：真实纯函数 + 真实扫描管线
 * ------------------------------------------------------------------ */

const loadEngine = async () => {
  const root = path.join(__dirname, '..')
  const groups = await import(path.join(root, 'src/client/common/keyword-groups.js'))
  const { keywordPresets } = await import(path.join(root, 'src/client/common/keyword-presets.js'))
  const { compileKeywords } = await import(path.join(root, 'src/client/common/keyword-compile.js'))
  const scan = await import(path.join(root, 'src/client/common/keyword-scan.js'))

  /** 与终端 write 完全同一条管线：编译 → 单遍扫描 → 覆盖率闸 → 逐字符着色 */
  const predict = (config, text) => {
    const active = groups.activeKeywords(config)
    const patterns = compileKeywords(active)
    const hits = scan.applyCoverageGate(text,
      scan.collectMatches(text, patterns, scan.buildScan(patterns), 512))
    const colorAt = new Array(text.length).fill(null)
    for (const h of hits) {
      for (let i = h.start; i < h.end; i++) {
        colorAt[i] = h.color
      }
    }
    return { active, patterns, hits, colorAt }
  }

  /** needle 命中的那条规则（正则原文 + 档位），供「语料归类」断言与单条静音定位 */
  const ruleAt = (config, line, needle) => {
    const p = predict(config, line)
    const i = line.indexOf(needle)
    if (i < 0) {
      return null
    }
    const hit = p.hits.find(h => h.start === i && h.text === needle)
    if (!hit) {
      return { hit: null, ratio: ratioOf(p, line) }
    }
    return { keyword: p.active[hit.index].keyword, tier: hit.tier, hit, ratio: ratioOf(p, line) }
  }

  const ratioOf = (p, line) => Number(
    (p.hits.reduce((n, h) => n + h.end - h.start, 0) / line.length).toFixed(3))

  const presetOf = keyword => keywordPresets.find(p =>
    (p.keywords || []).some(k => k.keyword === keyword))

  return { groups, keywordPresets, predict, ruleAt, presetOf }
}

/* ------------------------------------------------------------------ *
 * 语料：needle 声明所属档位；表本身由真实管线反查（换档/被闸掉都会 FAIL）
 * ------------------------------------------------------------------ */

const USER_KEYWORD = 'KWUSERMARKER'

const corpus = [
  {
    line: 'container 42 Exited (137) 2 minutes ago, please wait for the operator to nod',
    needles: [{ text: 'Exited (137)', tier: 'signal' }, { text: '2 minutes', tier: 'structure' }]
  },
  {
    line: 'FATAL boom during the nightly archive rotation on the backup machine',
    needles: [{ text: 'FATAL', tier: 'signal' }]
  },
  {
    line: 'ERROR 1146 (42S02): Table users does not exist here, check the spelling',
    needles: [
      { text: 'ERROR', tier: 'signal' },
      { text: 'does not exist', tier: 'signal' },
      { text: 'Table', tier: 'structure' }
    ]
  },
  {
    line: '[00:12:34.567] the queue watermark was crossed while draining workers',
    needles: [{ text: '[00:12:34.567]', tier: 'structure' }]
  },
  {
    line: 'disk usage on the shared volume climbed to 233G which is far more today',
    needles: [{ text: '233G', tier: 'structure' }]
  },
  {
    line: 'run the collector with --max-time=30 and keep the budget sane for all',
    needles: [{ text: '--max-time=30', tier: 'structure' }]
  },
  {
    line: 'upstream 10.0.0.1 handled eleven hundred requests during this window',
    needles: [{ text: '10.0.0.1', tier: 'structure' }]
  },
  {
    line: 'exported the summary document to /tmp/kw-combo-report.pdf just before the weekly review',
    needles: [{ text: '/tmp/kw-combo-report.pdf', tier: 'structure' }]
  },
  {
    line: 'the weather is fine today and the meeting was shifted by an hour',
    needles: [{ text: 'weather is fine', tier: 'none' }]
  },
  {
    line: 'KWUSERMARKER appeared inside an ordinary sentence about nothing at all',
    needles: [{ text: USER_KEYWORD, tier: 'user' }]
  }
]

/* ------------------------------------------------------------------ *
 * 组合序列：op 同时驱动「浏览器动作」和「Node 回放」
 *   semantic / structure / userOn / muted 是 needle 着色意图的唯一来源
 * ------------------------------------------------------------------ */

const steps = [
  { id: 'C0', name: '全部不应用', ops: [{ t: 'all', on: false }] },
  { id: 'C1', name: '只勾语义档', ops: [{ t: 'semantic', on: true }] },
  { id: 'C2', name: '再勾结构档（两档全中 → 应用全部自动勾上）', ops: [{ t: 'structure', on: true }] },
  { id: 'C3', name: '取消语义档（只剩结构档，两档互相独立）', ops: [{ t: 'semantic', on: false }] },
  { id: 'C4', name: '再取消结构档（两档皆关 → 应用全部回到未勾）', ops: [{ t: 'structure', on: false }] },
  { id: 'C5', name: '重新勾上语义档', ops: [{ t: 'semantic', on: true }] },
  { id: 'C6', name: '应用全部（半开状态一次点满）', ops: [{ t: 'all', on: true }] },
  { id: 'C7', name: '单条静音 severity 规则（FATAL/ERROR/does not exist 同属一条正则）', ops: [{ t: 'muteRule', needle: 'FATAL' }] },
  { id: 'C8', name: '新增用户规则 KWUSERMARKER（新行默认就是勾上的）', ops: [{ t: 'clearSearch' }, { t: 'userAdd' }] },
  { id: 'C9', name: '单独静音这条用户规则', ops: [{ t: 'userMute' }] },
  { id: 'C10', name: '半开的「应用全部」再点 = 补齐（不是关掉）', ops: [{ t: 'clearSearch' }, { t: 'all', on: true }] },
  { id: 'C11', name: '全部取消（规则保留只静音）', ops: [{ t: 'all', on: false }] }
]

const initState = () => ({ semantic: false, structure: false, userAdded: false, userOn: false, muted: new Set() })

/**
 * 单条静音记「规则的 keyword」而不是 needle 文本。一条预设正则可以是
 * FATAL|ERROR|does not exist 这种分支组合，静音它 = 这三个词一起掉色。
 * 按 needle 记期望会把产品本来的正确行为误判成 bug（首轮 CDP 就栽在这）。
 */
const buildNeedleKeyword = (ruleAt, allList) => {
  const map = new Map()
  for (const { line, needles } of corpus) {
    for (const n of needles) {
      if (n.tier === 'none' || map.has(n.text)) {
        continue
      }
      // 用户规则的 needle 在预设配置里命中不了，它自己的文本就是 keyword
      const r = ruleAt(allList, line, n.text)
      map.set(n.text, (r && r.keyword) || n.text)
    }
  }
  return text => map.get(text) || text
}

const foldStep = (st, step, keywordOf) => {
  const next = { ...st, muted: new Set(st.muted) }
  for (const op of step.ops) {
    if (op.t === 'semantic') {
      next.semantic = op.on
    }
    if (op.t === 'structure') {
      next.structure = op.on
    }
    if (op.t === 'all') {
      next.semantic = op.on
      next.structure = op.on
      next.muted.clear()
      if (op.on) {
        next.userOn = next.userAdded
      } else {
        next.userOn = false
      }
    }
    if (op.t === 'muteRule') {
      next.muted.add(keywordOf(op.needle))
    }
    if (op.t === 'userAdd') {
      next.userAdded = true
      // addUserRule 新建的条目不带 off —— 填上关键字即生效，直到被单独静音
      next.userOn = true
    }
    if (op.t === 'userMute') {
      next.userOn = false
    }
  }
  return next
}

const computeStates = (keywordOf) => {
  const out = []
  let st = initState()
  for (const step of steps) {
    st = foldStep(st, step, keywordOf)
    out.push({ id: step.id, ...st })
  }
  return out
}

/** needle 期望：所属档开着 且 承载它的规则没被单条静音 */
const expectNeedle = (st, needle, keywordOf) => {
  if (needle.tier === 'none') {
    return false
  }
  if (st.muted.has(keywordOf(needle.text))) {
    return false
  }
  if (needle.tier === 'signal') {
    return st.semantic
  }
  if (needle.tier === 'structure') {
    return st.structure
  }
  return st.userAdded && st.userOn
}

/* ------------------------------------------------------------------ *
 * Node 侧回放（与面板同一套点击语义）
 * ------------------------------------------------------------------ */

const replayOp = (groups, list, op) => {
  if (op.t === 'semantic' || op.t === 'structure') {
    const tier = op.t === 'semantic' ? 'signal' : 'structure'
    for (let i = 0; i < 4; i++) {
      const v = groups.tierView(list, tier)
      if (v.checked === op.on && !v.indeterminate) {
        return list
      }
      // DOM 上 indeterminate 的 checkbox checked=false，点一下得到 checked=true
      list = groups.setTierOn(list, tier, !v.checked)
    }
    return list
  }
  if (op.t === 'all') {
    for (let i = 0; i < 4; i++) {
      const v = groups.applyAllView(list)
      if (v.checked === op.on && !v.indeterminate) {
        return list
      }
      list = v.checked ? groups.setAllOff(list) : groups.applyAllRules(list)
    }
    return list
  }
  if (op.t === 'userAdd') {
    let idx = list.findIndex(r => r.source === 'user' && !r.keyword)
    if (idx < 0) {
      // 面板没有可填的空行时会点「+ 关键字」新建一条，回放跟它同一条路径
      list = groups.addUserRule(list, {})
      idx = list.length - 1
    }
    return groups.updateEntry(list, idx, { keyword: USER_KEYWORD })
  }
  if (op.t === 'userMute') {
    const idx = list.findIndex(r => r.source === 'user' && r.keyword === USER_KEYWORD)
    if (idx < 0) {
      throw new Error('回放：配置里找不到用户规则 ' + USER_KEYWORD)
    }
    return groups.setEntryOn(list, idx, false)
  }
  return list
}

/* ------------------------------------------------------------------ *
 * CDP
 * ------------------------------------------------------------------ */

class Cdp {
  constructor (wsUrl) {
    const WebSocket = require('ws')
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
  }
}

const OPEN_SETTING = `(() => {
  const store = window.store
  store.storeAssign({ settingTab: 'setting' })
  store.setSettingItem({ id: 'setting-terminal', name: 'setting-terminal' })
  store.openSettingModal()
  return 'opened'
})()`

const secHead = title => `((document.querySelector('.kw-wrap') && [...document.querySelectorAll('.kw-section')]
  .find(s => ((s.querySelector('.kw-sec-title') || {}).textContent) === window.translate('${title}'))) || null)`

const EXPAND_SEC = title => `(() => {
  const sec = ${secHead(title)}
  if (!sec) return 'no-section:${title}'
  if (!sec.querySelector('.kw-sec-body')) sec.querySelector('.kw-sec-head').click()
  return sec.querySelector('.kw-sec-body') ? 'expanded' : 'collapsed'
})()`

const tickFind = key => `(() => {
  const want = window.translate('${key}')
  const label = [...document.querySelectorAll('.kw-toolbar label.kw-only-on')]
    .find(x => x.textContent.includes(want))
  const box = label && label.querySelector('input.kw-check')
  if (!box) return null
  const count = ((label.querySelector('.kw-tier-count') || {}).textContent || '').replace(/\\s+/g, '')
  return JSON.stringify({ checked: box.checked, indeterminate: box.indeterminate, count })
})()`

const tickOnce = key => `(() => {
  const want = window.translate('${key}')
  const label = [...document.querySelectorAll('.kw-toolbar label.kw-only-on')]
    .find(x => x.textContent.includes(want))
  const box = label && label.querySelector('input.kw-check')
  if (!box) return 'no-tick:' + want
  box.click()
  return 'clicked:' + want + '=' + box.checked
})()`

const CONFIG_SNAPSHOT = `JSON.stringify({
  total: (window.store._config.keywords || []).length,
  on: (window.store._config.keywords || []).filter(r => r && r.keyword && !r.off).length,
  off: (window.store._config.keywords || []).filter(r => r && r.off).length,
  raw: window.store._config.keywords || []
})`

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

const compiledExpr = id => `(() => {
  const inst = window.refs.get('term-' + '${id}')
  const term = inst && inst.term
  const list = ((term && term._addonManager && term._addonManager._addons) || []).map(a => a.instance)
  const addon = list.find(i => Array.isArray(i.compiledPatterns))
  return addon ? addon.compiledPatterns.length : -1
})()`

const writeLines = (id, text) => `(() => {
  const inst = window.refs.get('term-' + '${id}')
  inst.term.write(${JSON.stringify(text)})
  return 'written'
})()`

/** 从缓冲区底部往上找该行，逐格取前景色号（0 = 默认前景） */
const lineCells = (id, text) => `(() => {
  const inst = window.refs.get('term-' + '${id}')
  const b = inst.term.buffer.active
  for (let y = b.length - 1; y >= 0; y--) {
    const l = b.getLine(y)
    if (!l) continue
    const s = l.translateToString(false)
    if (s.indexOf(${JSON.stringify(text)}) !== 0) continue
    const cells = []
    for (let x = 0; x < ${String(text.length)}; x++) {
      const c = l.getCell(x)
      cells.push(c ? (c.isFgDefault() ? 0 : c.getFgColor()) : -1)
    }
    return JSON.stringify({ y, cells, text: s.slice(0, ${String(text.length)}) })
  }
  return JSON.stringify({ missing: true })
})()`

// 搜索框过滤时全部分组自动展开，用它定位单条预设规则再点行首勾选
const searchFor = q => `(() => {
  const box = document.querySelector('.kw-search input') || document.querySelector('input.kw-search')
  if (!box) return 'no-search'
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(box, ${JSON.stringify(q)})
  box.dispatchEvent(new Event('input', { bubbles: true }))
  return 'searched'
})()`

const toggleRuleByRegex = keyword => `(() => {
  const row = [...document.querySelectorAll('.kw-rule')].find(r => {
    const c = r.querySelector('.kw-regex')
    return c && c.getAttribute('title') === ${JSON.stringify(keyword)}
  })
  if (!row) return 'no-rule-row'
  const box = row.querySelector('input.kw-check')
  if (!box) return 'no-rule-check'
  box.click()
  return 'clicked-rule:' + (box.checked ? 'on' : 'off')
})()`

const userStep = keyword => `(() => {
  const sec = ${secHead('kwUserGroup')}
  if (!sec) return 'no-user-section'
  if (!sec.querySelector('.kw-sec-body')) {
    sec.querySelector('.kw-sec-head').click()
    return 'expanded-user-sec'
  }
  const body = sec.querySelector('.kw-sec-body')
  const groups = [...body.querySelectorAll('.kw-group')]
  const g = groups[0]
  if (!g) return 'no-user-group'
  if (!g.querySelector('.kw-rules')) {
    g.querySelector('.kw-group-head').click()
    return 'expanded-user-group'
  }
  const row = [...g.querySelectorAll('.kw-rule')].find(r => {
    const i = r.querySelector('.kw-regex-input')
    return i && (i.value === '' || i.value === ${JSON.stringify(keyword)})
  })
  if (!row) {
    const add = g.querySelector('.kw-add-rule')
    if (!add) return 'no-add-rule'
    add.click()
    return 'clicked-add-rule'
  }
  const input = row.querySelector('.kw-regex-input')
  // React 的 onBlur 实际监听 focusout：没聚焦过的 input.blur() 与手工 dispatch
  // 的 new Event('blur') 都不会触发提交，配置里就一直是一条空规则。
  // 即便本地 value 已是目标串（上一轮 onChange 写进去的），也要再补一次
  // onPressEnter / 真 blur —— 只有 React 的回调才会把值推进配置。
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  if (input.value !== ${JSON.stringify(keyword)}) {
    input.focus()
    setter.call(input, ${JSON.stringify(keyword)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }))
  input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }))
  input.blur()
  return 'typed:' + input.value
})()`

// 每调用一次只做一件事（展开分区 / 展开分组 / 点勾选），由 Node 侧循环推进
const muteUserRule = keyword => `(() => {
  const sec = ${secHead('kwUserGroup')}
  if (!sec) return 'no-user-section'
  if (!sec.querySelector('.kw-sec-body')) {
    sec.querySelector('.kw-sec-head').click()
    return 'expanded-user-sec'
  }
  const g = sec.querySelector('.kw-sec-body .kw-group')
  if (!g) return 'no-user-group'
  if (!g.querySelector('.kw-rules')) {
    g.querySelector('.kw-group-head').click()
    return 'expanded-user-group'
  }
  const row = [...g.querySelectorAll('.kw-rule')].find(r => {
    const i = r.querySelector('.kw-regex-input')
    return i && i.value === ${JSON.stringify(keyword)}
  })
  if (!row) return 'no-user-rule-row'
  const box = row.querySelector('input.kw-check')
  if (!box) return 'no-user-rule-check'
  // 已经是关的就别再点 —— Node 侧轮询重试时这一行保证动作幂等
  if (!box.checked) return 'already-off'
  box.click()
  return 'clicked-user-rule:' + (box.checked ? 'on' : 'off')
})()`

/* ------------------------------------------------------------------ *
 * 断言
 * ------------------------------------------------------------------ */

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)))
}

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

const tickUntil = async (cdp, key, target) => {
  const clicks = []
  for (let i = 0; i < 4; i++) {
    const raw = await cdp.eval(tickFind(key))
    if (!raw) {
      return { error: 'no-tick:' + key, clicks }
    }
    const st = JSON.parse(raw)
    if (st.checked === target && st.indeterminate === false) {
      return { ...st, clicks }
    }
    clicks.push(await cdp.eval(tickOnce(key)))
    await sleep(300)
  }
  return { ...(JSON.parse(await cdp.eval(tickFind(key)) || 'null') || {}), clicks, unstable: true }
}

const KEY_OF = { semantic: 'kwSemanticTier', structure: 'kwStructureTier', all: 'kwApplyAll' }

/* ------------------------------------------------------------------ *
 * Node 侧：语料自检（档位归类 + 覆盖率闸）
 * ------------------------------------------------------------------ */

const verifyCorpus = async () => {
  const { groups, ruleAt, presetOf, predict } = await loadEngine()
  const allList = groups.applyAllRules([])
  const semList = groups.setTierOn(groups.setTierOn([], 'signal', true), 'structure', false)
  check('语料基线：应用全部 = ' + groups.activeKeywords(allList).length + ' 条 / 语义档 = ' +
    groups.activeKeywords(semList).length + ' 条',
  groups.tierView(allList, 'signal').checked && groups.tierView(allList, 'structure').checked,
  { signal: groups.tierView(allList, 'signal'), structure: groups.tierView(allList, 'structure') })

  for (const { line, needles } of corpus) {
    for (const n of needles) {
      if (n.tier === 'user') {
        continue
      }
      if (n.tier === 'none') {
        const p = predict(allList, line)
        const covered = p.hits.some(h => h.start <= line.indexOf(n.text) &&
          h.end >= line.indexOf(n.text) + n.text.length)
        check(`语料「${n.text}」在两档全开时也不该被任何规则命中`, !covered,
          { hits: p.hits.map(h => h.text) })
        continue
      }
      const r = ruleAt(allList, line, n.text)
      if (!r || !r.hit) {
        check(`语料「${n.text}」确实被 ${n.tier} 档规则命中`, false, { ratio: r && r.ratio })
        continue
      }
      check(`语料「${n.text}」命中的是 ${n.tier} 档（覆盖率 ${r.ratio} < 0.35）`,
        r.tier === n.tier && r.ratio <= 0.35, { tier: r.tier, ratio: r.ratio, hit: [r.hit.start, r.hit.end] })
      const preset = presetOf(r.keyword)
      check(`语料「${n.text}」的正则在预设表里可定位（组 ${preset && preset.name}）`, !!preset, { keyword: r.keyword })
      if (n.tier === 'signal') {
        const off = ruleAt(groups.setTierOn([], 'structure', true), line, n.text)
        check(`语料「${n.text}」不属于结构档：纯结构档下不再命中`, !off || !off.hit, {
          still: off && off.hit && off.hit.text
        })
      }
      if (n.tier === 'structure') {
        const only = ruleAt(groups.setTierOn([], 'structure', true), line, n.text)
        check(`语料「${n.text}」只属 structure：纯结构档下仍命中`, !!only && !!only.hit, { ratio: only && only.ratio })
      }
    }
  }
  return { groups, ruleAt, presetOf, predict }
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

const main = async () => {
  const engine = await verifyCorpus()
  const { groups, predict, ruleAt, presetOf } = engine
  if (DRY) {
    report()
    return
  }

  const targets = await getJson(`http://127.0.0.1:${PORT}/json`)
  const page = targets.find(t => t.type === 'page' && String(t.url || '').includes('index.html'))
  if (!page) {
    throw new Error('no electerm page target on ' + PORT)
  }
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready
  const ev = e => cdp.eval(e)

  /** 轮询浏览器真配置直到满足条件；返回快照，超时返回 null */
  const pollConfig = async (predicate, timeout = 8000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeout) {
      const cfg = JSON.parse(await ev(CONFIG_SNAPSHOT))
      if (predicate(cfg.raw)) {
        return cfg
      }
      await sleep(250)
    }
    return null
  }
  const hasUserRule = want => raw => raw.some(r =>
    r.source === 'user' && r.keyword === USER_KEYWORD &&
    (want === 'present' || (want === 'on' ? !r.off : !!r.off)))

  await waitFor(cdp, '(() => !!(window.store && window.refs))()', 'app ready', 60000)
  console.log('app ready')

  // 浏览器是配置的唯一真源；Node 回放同一条点击序列，两者条数必须一致
  let replay = (JSON.parse(await ev(CONFIG_SNAPSHOT))).raw
  const first = JSON.parse(await ev(CONFIG_SNAPSHOT))
  console.log('初始配置:', JSON.stringify({ total: first.total, on: first.on, off: first.off }))

  // 静音期望按「规则 keyword」记账，需要先有引擎才能反查 needle 属于哪条正则
  const keywordOf = buildNeedleKeyword(ruleAt, groups.applyAllRules([]))
  const states = computeStates(keywordOf)

  const tab = await ev(addTab('KW-COMBO'))
  await waitFor(cdp, tabReady(tab), 'terminal ' + tab + ' socket', 40000)
  await sleep(1000)
  console.log(await ev(OPEN_SETTING))
  await waitFor(cdp, "(() => !!document.querySelector('.kw-toolbar'))()", 'kw toolbar')

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const st = states[i]
    console.log('\n=== ' + st.id + ' ' + step.name + ' ===')

    for (const op of step.ops) {
      if (op.t === 'clearSearch') {
        console.log(await ev(searchFor('')))
        await sleep(300)
        continue
      }
      if (op.t === 'muteRule') {
        console.log(await ev(EXPAND_SEC('kwPresetGroup')))
        await sleep(300)
        const sample = corpus.find(c => c.needles.some(x => x.text === op.needle))
        const r = ruleAt(replay, sample.line, op.needle)
        if (!r || !r.hit) {
          check(`${st.id} 定位 ${op.needle} 的预设规则`, false, r)
          continue
        }
        console.log(await ev(searchFor(op.needle)))
        await sleep(400)
        console.log(await ev(toggleRuleByRegex(r.keyword)))
        await sleep(400)
        const preset = presetOf(r.keyword)
        replay = groups.setPresetRuleOn(replay, preset, r.keyword, false)
        continue
      }
      if (op.t === 'userAdd') {
        let committed = null
        for (let k = 0; k < 6 && !committed; k++) {
          const r = await ev(userStep(USER_KEYWORD))
          console.log('user ->', r)
          // 面板本地 state 有值 ≠ 提交成功，一律回读真配置再决定要不要补一刀
          committed = await pollConfig(hasUserRule('present'), 2000)
        }
        check(`${st.id} 用户规则 ${USER_KEYWORD} 已落进配置`, !!committed,
          committed && { total: committed.total, on: committed.on })
        replay = replayOp(groups, replay, op)
        continue
      }
      if (op.t === 'userMute') {
        let mutedRow = null
        for (let k = 0; k < 6 && !mutedRow; k++) {
          const r = await ev(muteUserRule(USER_KEYWORD))
          console.log('user mute ->', r)
          await sleep(300)
          mutedRow = await pollConfig(hasUserRule('off'), 2000)
        }
        check(`${st.id} 用户规则 ${USER_KEYWORD} 已静音`, !!mutedRow)
        replay = replayOp(groups, replay, op)
        continue
      }
      const key = KEY_OF[op.t]
      const r = await tickUntil(cdp, key, op.on)
      console.log(key + ' ->', JSON.stringify(r))
      replay = replayOp(groups, replay, op)
    }

    // 快进：动作照常执行（浏览器与回放都要跟着走），只是不做逐格断言
    if (i < START_AT - 1) {
      console.log(await ev(OPEN_SETTING))
      await waitFor(cdp, "(() => !!document.querySelector('.kw-toolbar'))()", 'toolbar again')
      continue
    }

    // 1) 三勾选 DOM 态 = 纯函数派生态（用浏览器真配置算，避免回放分叉掩盖问题）
    const cfg = JSON.parse(await ev(CONFIG_SNAPSHOT))
    const live = cfg.raw
    for (const [t, key] of [['signal', 'kwSemanticTier'], ['structure', 'kwStructureTier']]) {
      const v = groups.tierView(live, t)
      const got = JSON.parse(await ev(tickFind(key)) || 'null')
      check(`${st.id} ${key} = ${v.checked ? '全勾' : v.indeterminate ? '半开' : '未勾'}（${v.on}/${v.total}）`,
        !!got && got.checked === v.checked && got.indeterminate === v.indeterminate &&
        got.count === `${v.on}/${v.total}`, { got, want: v })
    }
    const av = groups.applyAllView(live)
    const gotAll = JSON.parse(await ev(tickFind('kwApplyAll')) || 'null')
    check(`${st.id} kwApplyAll = ${av.checked ? '全勾' : av.indeterminate ? '半开' : '未勾'}（${av.on}/${av.total}）`,
      !!gotAll && gotAll.checked === av.checked && gotAll.indeterminate === av.indeterminate &&
      gotAll.count === `${av.on}/${av.total}`, { got: gotAll, want: av })

    // 2) 回放与真实 UI 的生效条数必须一致
    const wantOn = groups.activeKeywords(replay).length
    check(`${st.id} Node 回放生效条数 = 浏览器配置生效条数 ${wantOn}`,
      cfg.on === wantOn, { browser: { total: cfg.total, on: cfg.on, off: cfg.off }, replay: wantOn })

    // 3) 终端热更新后的编译条数
    await ev('window.store.hideSettingModal()')
    await sleep(500)
    const wantCompiled = predict(live, 'x').patterns.length
    const compiled = await waitFor(cdp, `(() => ${compiledExpr(tab)} === ${wantCompiled})()`,
      'terminal compiled ' + wantCompiled, 15000)
      ? await ev(compiledExpr(tab))
      : -1
    check(`${st.id} 终端 compiledPatterns = ${wantCompiled} 条（热更新生效）`,
      compiled === wantCompiled, { compiled, wantCompiled })

    // 4) 逐格着色 + 逐 needle 意图
    await ev(writeLines(tab, corpus.map(c => c.line).join('\r\n') + '\r\n'))
    await sleep(1200)
    for (const { line, needles } of corpus) {
      const p = predict(live, line)
      const got = JSON.parse(await ev(lineCells(tab, line)))
      const tag = st.id + '「' + line.slice(0, 22) + '…」'
      if (got.missing) {
        check(tag + ' 行在缓冲区可见', false, got)
        continue
      }
      const diff = []
      for (let x = 0; x < line.length; x++) {
        const wantOnCell = p.colorAt[x] !== null
        if (wantOnCell !== (got.cells[x] !== 0)) {
          diff.push({ x, ch: line[x], wantOnCell, fg: got.cells[x] })
        }
      }
      check(tag + ' 逐格着色 = 真实管线（含覆盖率闸）', diff.length === 0,
        diff.length ? { first: diff[0], count: diff.length } : undefined)
      const part = partitionCheck(p.colorAt, got.cells)
      check(tag + ' 颜色分区一一对应（同色同号、异色异号）', part.ok, part.detail)
      for (const n of needles) {
        const x = line.indexOf(n.text)
        const want = expectNeedle(st, n, keywordOf)
        const cells = got.cells.slice(x, x + n.text.length)
        const colored = cells.length > 0 && cells.every(v => v !== 0)
        check(`${st.id} needle「${n.text}」(${n.tier}) ${want ? '着色' : '不着色'}`,
          x >= 0 && colored === want, { x, cells: cells.slice(0, 6), want })
      }
    }
    await cdp.shot(path.join(SHOT_DIR, (st.id + '-' + step.name.replace(/[^\w\u4e00-\u9fa5]+/g, '')).slice(0, 40) + '.png'))

    console.log(await ev(OPEN_SETTING))
    await waitFor(cdp, "(() => !!document.querySelector('.kw-toolbar'))()", 'toolbar again')
  }

  report()
  cdp.ws.close()
}

/** 期望色 ↔ 实际前景号必须构成一对一映射（只比已着色的格子） */
const partitionCheck = (colorAt, cells) => {
  const colorToId = new Map()
  const idToColor = new Map()
  for (let i = 0; i < colorAt.length; i++) {
    const want = colorAt[i]
    const got = cells[i]
    if (want === null || got === 0) {
      continue
    }
    if (colorToId.has(want) && colorToId.get(want) !== got) {
      return { ok: false, detail: { sameColorTwoIds: want, at: i, ids: [colorToId.get(want), got] } }
    }
    if (idToColor.has(got) && idToColor.get(got) !== want) {
      return { ok: false, detail: { sameIdTwoColors: got, at: i, colors: [idToColor.get(got), want] } }
    }
    colorToId.set(want, got)
    idToColor.set(got, want)
  }
  return { ok: true, detail: { distinctColors: colorToId.size } }
}

const report = () => {
  const failed = results.filter(r => !r.ok)
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' PASS')
  if (failed.length) {
    console.log('FAILED: ' + failed.map(f => f.name).join(' | '))
  }
  process.exit(failed.length ? 1 : 0)
}

main().catch(e => {
  console.error('demo error:', e)
  process.exit(2)
})
