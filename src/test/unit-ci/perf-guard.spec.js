const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const DB_DIR = path.join(ROOT, 'src/client/components/database')
const FOOTER = path.join(ROOT, 'src/client/components/footer/footer-entry.jsx')
const HIGHLIGHT = path.join(DB_DIR, 'db-highlight.jsx')
const DB_SESSION = path.join(DB_DIR, 'db-session.jsx')

// 性能/资源消耗守护单测（配套 doc/已完成/分析-性能热点与优化总案-2026-10-21.md）：
// 1) 算法预算：值预览高亮在大文本 × 多规则下的耗时上限（防病态回退）
// 2) 源码契约：已落地的性能修复锁死——每渲染重算/重建与 deepCopy getter 不得回归
const loadHighlightValue = () => {
  const src = fs.readFileSync(HIGHLIGHT, 'utf8')
  const m = src.match(/export function highlightValue \([\s\S]*?\n\}/)
  assert.ok(m, 'highlightValue definition not found')
  let body = m[0].replace(/^export /, '')
  // 源码含 JSX：定向替换（失配 → '<' 留在源里 → vm 语法错误 → 响亮失败，防漂移）
  const jsx = body.match(/<span[\s\S]*?<\/span>/)
  assert.ok(jsx, 'span JSX block not found (implementation drifted?)')
  body = body.replace(
    jsx[0],
    "React.createElement('span', " +
    "{ key: h.start, className: 'db-kw', style: (themeConfig && themeConfig[h.color] ? { color: themeConfig[h.color] } : undefined) }, " +
    'text.slice(h.start, h.end))'
  )
  const sandbox = {
    maxHighlightLength: 4096,
    maxHits: 200,
    React: {
      createElement: (type, props, ...children) => ({ type, props, children })
    }
  }
  vm.runInNewContext(body, sandbox)
  return sandbox.highlightValue
}

const loadSrc = p => fs.readFileSync(p, 'utf8')

describe('perf guard: highlightValue budget (real source)', () => {
  const highlightValue = loadHighlightValue()
  // 30 条混合规则 × 100KB 文本：逼近值预览上限的真实规模
  const rules = [
    { re: /192[.]168[.][0-9]+[.][0-9]+/gi, color: 'red' },
    { re: /https?:\/\/[^\s"']+/gi, color: 'blue' },
    { re: /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, color: 'green' },
    { re: /[A-Z]{3,}/g, color: 'yellow' }
  ]
  for (let i = 0; i < 26; i++) {
    rules.push({ re: new RegExp('kw' + i + '[a-z]*', 'gi'), color: 'red' })
  }
  const bigText = Array.from({ length: 500 }, (_, i) =>
    'line ' + i + ' ip=192.168.115.' + (i % 250) + ' url=https://example.com/path/' + i +
    ' id=3f2b8c1a-9d4e-4f5a-8b7c-1a2b3c4d5e6f KEYWORD kw' + (i % 26) + 'x\n'
  ).join('')

  test('100KB x 30 rules finishes within budget and respects maxHits cap', () => {
    // 预热（JIT），排除首次编译噪声
    highlightValue(bigText, rules, { red: '#f00' }, { maxLength: 100000, maxHits: 2000 })
    const t0 = process.hrtime.bigint()
    const out = highlightValue(bigText, rules, { red: '#f00' }, { maxLength: 100000, maxHits: 2000 })
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    assert.ok(ms < 500, 'highlight took ' + ms.toFixed(1) + 'ms, budget 500ms')
    const spans = Array.isArray(out) ? out.filter(p => p && p.type === 'span').length : 0
    assert.ok(spans > 0, 'must produce highlights')
    assert.ok(spans <= 2000, 'must respect maxHits cap')
  })

  test('default limits still protect table cells (4096 skip)', () => {
    const out = highlightValue(bigText, rules, { red: '#f00' })
    assert.equal(out, bigText, 'over-length text must skip highlight by default')
  })
})

describe('批次 B：config 快照缓存', () => {
  test('config getter 按版本复用快照，不再每次 deepCopy', () => {
    const src = loadSrc(path.join(ROOT, 'src/client/store/store.js'))
    const block = src.match(/get config \(\) \{[\s\S]*?\n\s{2}\}/)
    assert.ok(block, 'config getter not found')
    assert.ok(block[0].includes('_configVersion'), 'must read version to keep mobx subscription')
    assert.ok(block[0].includes('configSnapshots.get(store)'), 'cache lookup missing')
    assert.ok(block[0].includes('cached.version === version'), 'cache invalidation missing')
    assert.ok(!/return deepCopy\(window\.store\._config\)/.test(block[0]), 'unconditional deepCopy returned')
  })

  test('两条配置写入路径都递增版本', () => {
    const setting = loadSrc(path.join(ROOT, 'src/client/store/setting.js'))
    assert.ok(/setConfig[\s\S]*?_configVersion \+= 1/.test(setting), 'setConfig must bump version')
    const load = loadSrc(path.join(ROOT, 'src/client/store/load-data.js'))
    assert.ok(/store\._config = globs\.config[\s\S]{0,80}_configVersion \+= 1/.test(load), 'initApp must bump version')
    const init = loadSrc(path.join(ROOT, 'src/client/store/init-state.js'))
    assert.ok(init.includes('_configVersion: 0'), 'initial version missing')
  })

  test('getUiThemeConfig 不再为找主题深拷贝配置/主题列表', () => {
    const src = loadSrc(path.join(ROOT, 'src/client/store/ui-theme.js'))
    assert.ok(!src.includes('getSidebarList('), 'must not deep-copy the whole theme list')
    assert.ok(!src.includes('store.config'), 'must read _config directly')
    assert.ok(src.includes('store._config.theme'), 'theme id read missing')
    assert.ok(src.includes('copy(theme.uiThemeConfig)'), 'only the selected theme config should be copied')
  })

  test('settingSidebarList 不重复深拷贝 initItem', () => {
    const src = loadSrc(path.join(ROOT, 'src/client/store/store.js'))
    assert.ok(!/deepCopy\(initItem\)/.test(src), 'initItem already comes from the copied list')
  })
})

describe('main.jsx 深拷贝治理', () => {
  const src = () => loadSrc(path.join(ROOT, 'src/client/components/main/main.jsx'))

  test('不再导入/调用 json-deep-copy', () => {
    const code = src()
    assert.ok(!code.includes("from 'json-deep-copy'"), 'deepCopy import must be removed')
    assert.ok(!code.includes('deepCopy('), 'no deepCopy calls expected')
  })

  test('传输列表/历史改浅拷贝，变更键只看控制字段', () => {
    const code = src()
    assert.ok(code.includes('fileTransfers.map(t => ({ ...t }))'), 'transfer snapshot missing')
    assert.ok(code.includes('transferHistory.map(t => ({ ...t }))'), 'history snapshot missing')
    assert.ok(!code.includes('JSON.stringify(copiedTransfer)'), 'full JSON signature must be removed')
    assert.ok(code.includes('t.inited ? 1 : 0'), 'control key missing inited/pausing fields')
    assert.ok(code.includes('t.typeFrom}:'), 'control key missing type fields')
    assert.ok(code.includes(".join('|')"), 'control key join missing')
  })

  test('upgradeInfo / resolutions / terminalInfoProps 不再深拷贝', () => {
    const code = src()
    assert.ok(code.includes('{ ...store.upgradeInfo }'), 'upgradeInfo shallow copy missing')
    assert.ok(code.includes('store.resolutions.slice()'), 'resolutions shallow copy missing')
    assert.ok(code.includes('{...store.terminalInfoProps}'), 'terminalInfoProps spread missing')
  })
})

describe('批次 E：tabs 测量只在有效变化时触发', () => {
  const src = () => loadSrc(path.join(ROOT, 'src/client/components/tabs/index.jsx'))

  test('componentDidUpdate 用布局输入快照 gate', () => {
    const code = src()
    assert.ok(code.includes('measuredLayoutKey'), 'layout key missing')
    assert.ok(code.includes('store.leftSideBarWidth'), 'left bar width missing from key')
    assert.ok(code.includes('store.rightPanelWidth'), 'right panel width missing from key')
    assert.ok(code.includes('window.innerWidth'), 'window width missing from key')
    assert.ok(code.includes('if (this.measureWrapWidth())'), 'failed measure must retry next update')
  })

  test('测量未就绪返回 false，标题变化仍由 ResizeObserver 重测', () => {
    const code = src()
    const fn = code.match(/measureWrapWidth = \(\) => \{[\s\S]*?\n\s{2}\}/)
    assert.ok(fn, 'measureWrapWidth not found')
    assert.ok(fn[0].includes('return false'), 'not-ready path must return false')
    assert.ok(fn[0].includes('return true'), 'successful path must return true')
    assert.ok(code.includes('this.resizeObserver = new ResizeObserver(this.handleTabsResize)'), 'resize observer removed')
    assert.ok(code.includes('this.measureWrapWidth()'), 'resize handler must remeasure')
  })
})

describe('批次 F：db-session 算法簇抽取', () => {
  test('查找算法独立成 db-search.jsx，db-session 只导入引用', () => {
    const search = loadSrc(path.join(ROOT, 'src/client/components/database/db-search.jsx'))
    ;['hlText', 'hlNode', 'scanTextHits', 'cycleIndex'].forEach(name => {
      assert.ok(search.includes('export function ' + name + ' ('), name + ' not exported')
    })
    const session = loadSrc(path.join(ROOT, 'src/client/components/database/db-session.jsx'))
    assert.ok(session.includes("from './db-search'"), 'db-session must import the helper module')
    ;['hlText', 'hlNode', 'scanTextHits', 'cycleIndex'].forEach(name => {
      assert.ok(!session.includes('function ' + name + ' ('), name + ' must not be redefined')
    })
  })
})

describe('perf guard: source contracts (committed perf fixes stay fixed)', () => {
  test('value pane highlight is memoized (no per-render recompute)', () => {
    const src = loadSrc(path.join(DB_DIR, 'db-value-pane.jsx'))
    assert.ok(
      /const highlighted = useMemo\(/.test(src),
      'pane highlight must stay behind useMemo (per-render recompute caused heap churn)'
    )
  })

  test('value pane opts keep the lifted limits', () => {
    const src = loadSrc(path.join(DB_DIR, 'db-value-pane.jsx'))
    assert.ok(src.includes('maxLength = 100000'), 'preview maxLength drifted')
    assert.ok(src.includes('maxHits = 2000'), 'preview maxHits drifted')
  })

  test('redis string editing goes through setKey op (readonly enforced in main process)', () => {
    const rs = fs.readFileSync(path.join(ROOT, 'src/app/lib/db-client/redis.js'), 'utf8')
    const idx = fs.readFileSync(path.join(ROOT, 'src/app/lib/db-client/index.js'), 'utf8')
    assert.ok(/async function setKey \(conn[\s\S]*?checkWritable/.test(rs), 'setKey must checkWritable')
    assert.ok(/setKey: 'setKey'/.test(idx), 'OP_MAP.redis must register setKey')
  })

  test('useKeywordPatterns reads _config, not the deepCopy config getter', () => {
    const src = loadSrc(HIGHLIGHT)
    assert.ok(src.includes('store._config.keywords'), 'must read _config directly')
    assert.ok(!/store\.config\b/.test(src), 'store.config getter deep-copies per access - hot path must not use it')
  })

  test('themeConfig is memoized by theme id (no per-render rebuild)', () => {
    const src = loadSrc(DB_SESSION)
    assert.ok(
      /const themeConfig = useMemo\(/.test(src) && /store\._config\.theme/.test(src),
      'themeConfig must be cached by theme id (getThemeConfig deep-copies per call)'
    )
  })

  test('footer status area stays removed (kept AI and later units)', () => {
    const src = loadSrc(FOOTER)
    assert.ok(!src.includes('terminal-footer-status'), 'status area must not return')
    assert.ok(!src.includes('renderStatusInfo'), 'dead renderer must not return')
    assert.ok(src.includes('renderAIIcon()'), 'AI button must stay')
  })

  test('DbGridTable enables row virtualization (DOM rows decoupled from pageSize)', () => {
    const src = loadSrc(DB_SESSION)
    assert.ok(src.includes('virtual={y > 0}'), 'row virtualization must stay on')
  })

  test('dbPageSize config respected with default 20', () => {
    const src = loadSrc(DB_SESSION)
    assert.ok(src.includes('dbPageSize'), 'page size config key missing')
    assert.ok(src.includes('DB_PAGE_SIZE_DEFAULT = 20'), 'default page size drifted')
  })

  test('dbPageSize capped at 200 so one page cannot explode render cost', () => {
    const src = loadSrc(DB_SESSION)
    assert.ok(src.includes('DB_PAGE_SIZE_MAX = 200'), 'page size ceiling drifted')
    assert.ok(
      /return v >= 10 \? Math\.min\(v, DB_PAGE_SIZE_MAX\)/.test(src),
      'config page size must clamp to the ceiling'
    )
    assert.ok(
      /return Number\.isInteger\(n\) && n >= 10 \? Math\.min\(n, DB_PAGE_SIZE_MAX\)/.test(src),
      'persisted view pageSize must clamp to the ceiling too'
    )
    assert.ok(!/300, 500, 1000/.test(src), 'selector must not offer pages above the ceiling')
  })

  test('page size selector UI exists (mysql grid + redis bar)', () => {
    const src = loadSrc(DB_SESSION)
    assert.ok(src.includes('renderPageSizeSelect()'), 'page size selector must be rendered')
    assert.ok(src.includes('changePageSize'), 'selector change handler missing')
  })

  test('dbPageSize joins config sync whitelist', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/client/store/sync.js'), 'utf8')
    const m = src.match(/const configSyncKeys = \[[\s\S]*?\]/)
    assert.ok(m && m[0].includes('dbPageSize'), 'dbPageSize must sync with settings')
  })
})
