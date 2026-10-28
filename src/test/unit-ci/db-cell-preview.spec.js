// H1a-1 · 截断单元格悬停预览卡（db-cell-preview.jsx 契约）
//
// 根因（设计 §1A.1，CDP 实测修正过）：rc-table 的自动 title 只在单元格渲染出来的
// children 是字符串/数字、或只包一层元素且里层是字符串时生成
// （@rc-component/table/es/Cell/index.js:10-27）。所以纯文本格子其实"有" title，
// 但它顶多重复格子里已经显示的那段；对象列在网格里就被 slice(0, 200) 截过，
// title 也只有那 200 字符 —— 超长文本与 JSON 的全文谁都看不到，而且原生 tooltip
// 的延时/样式由桌面环境决定，深浅主题都不受控。
// 修法是"一个受控单例浮层 + 只在真截断时弹"，并把 rc-table 的自动 title 关掉
// （CELL_ELLIPSIS：ellipsis 仍生效，showTitle: false），避免两层提示叠着挡视线。
//
// 这里跑真实源码里的 show / shown 两个闭包（vm 抽取），不是测试拷贝实现。
// 重点验证三件容易悄悄坏掉的事：
// 1) 只在"真被截断"时弹（scrollWidth > clientWidth），否则鼠标扫过整表就是洪泛；
// 2) 浮层是单例：不随单元格数增长，否则 1 万行直接卡死；
// 3) 预览有字符上限，超出只给前缀（全文另有查看完整/值面板）。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const CMP = path.join(ROOT, 'src/client/components/database/db-cell-preview.jsx')
const SESSION = path.join(ROOT, 'src/client/components/database/db-session.jsx')
const STYL = path.join(ROOT, 'src/client/components/database/db-session.styl')
const read = () => fs.readFileSync(CMP, 'utf8')

// 真实源码里的 show(ev, col, value)：去掉 useCallback 外壳后直接调用
function loadShow (inject = {}) {
  const src = read()
  const m = src.match(/const show = useCallback\(\(ev, col, value\) => \{[\s\S]*?\n {2}\}, \[[^\]]*\]\)/)
  assert.ok(m, 'show useCallback not found in db-cell-preview.jsx')
  const deps = m[0].slice(m[0].lastIndexOf(', ['))
  const expr = m[0].slice(m[0].indexOf('(ev, col, value) =>'), m[0].lastIndexOf(deps))
  const calls = []
  const watches = []
  const sandbox = {
    Math: { round: Math.round },
    cellText: v => (v === null || v === undefined ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : String(v)),
    cancelHide: () => calls.push('cancelHide'),
    watchCell: td => watches.push(td),
    setState: s => calls.push(s),
    console
  }
  Object.assign(sandbox, inject)
  vm.createContext(sandbox)
  return { fn: vm.runInNewContext('(' + expr + ')', sandbox), calls, watches }
}

// 真实源码里的 shown 裁剪闭包（无参数，state 从上下文全局读）
function loadShown (previewMax) {
  const src = read()
  const m = src.match(/const shown = useMemo\(\(\) => \{[\s\S]*?\n {2}\}, \[state\]\)/)
  assert.ok(m, 'shown useMemo not found in db-cell-preview.jsx')
  const expr = m[0].slice(m[0].indexOf('() => {'), m[0].lastIndexOf(', [state]'))
  const ctx = vm.createContext({ PREVIEW_MAX: previewMax, state: null, console })
  const fn = vm.runInContext('(' + expr + ')', ctx)
  return (state) => {
    ctx.state = state
    return fn()
  }
}

const td = (scrollWidth, clientWidth, rect = { left: 120, bottom: 64 }) => ({
  currentTarget: {
    scrollWidth,
    clientWidth,
    getBoundingClientRect: () => rect
  }
})

describe('show：只在真被截断时弹预览', () => {
  test('截断（scrollWidth > clientWidth）→ 写入锚点与全文', () => {
    const { fn, calls } = loadShow()
    fn(td(500, 220), 'parameter', '{"a":1}')
    assert.equal(calls[0], 'cancelHide')
    const state = calls[1]
    assert.equal(state.col, 'parameter')
    assert.equal(state.text, '{"a":1}')
    assert.equal(state.x, 120)
    assert.equal(state.y, 64)
    assert.ok(Number.isInteger(state.x) && Number.isInteger(state.y), '锚点取整，避免半像素抖动')
  })

  test('未截断 → 什么都不做（这是防悬停洪泛的核心）', () => {
    const { fn, calls } = loadShow()
    fn(td(220, 220), 'id', 12)
    fn(td(100, 220), 'name', 'short')
    assert.deepEqual(calls, [], '非截断单元格不得弹卡，也不得改状态')
  })

  test('临界相等按"装得下"处理：宁可少弹一次，不要每格都弹', () => {
    const { fn, calls } = loadShow()
    fn(td(220, 220), 'c', 'x'.repeat(500))
    assert.deepEqual(calls, [])
  })

  test('空文本不弹（NULL 也要显示，所以只有真空串被跳过）', () => {
    const { fn, calls } = loadShow({ cellText: () => '' })
    fn(td(500, 100), 'c', '')
    assert.deepEqual(calls, [])
  })

  test('对象值走 cellText，不是 [object Object]', () => {
    const { fn, calls } = loadShow()
    fn(td(500, 100), 'detail', { k: 'v' })
    assert.equal(calls[1].text, '{"k":"v"}')
  })

  test('拿不到 td（事件源异常）时静默返回，不抛', () => {
    const { fn, calls } = loadShow()
    assert.doesNotThrow(() => fn({}, 'c', 'v'))
    assert.doesNotThrow(() => fn({ currentTarget: null }, 'c', 'v'))
    assert.deepEqual(calls, [])
  })

  test('弹卡才把这一格交给 watchCell；没弹就不挂（悬停扫表不产生观察者）', () => {
    const { fn, watches } = loadShow()
    const ev = td(500, 100)
    fn(ev, 'c', 'v')
    assert.equal(watches.length, 1, '截断格必须挂上兜底观察')
    assert.equal(watches[0], ev.currentTarget)
    fn(td(100, 200), 'c', 'v')
    fn(td(200, 200), 'c', 'v')
    assert.equal(watches.length, 1, '未截断的格子不得挂观察者')
  })

  test('锚点落在单元格左下角（bottomLeft 指向被截断的那格）', () => {
    const { fn, calls } = loadShow()
    fn(td(500, 100, { left: 33.4, bottom: 250.6 }), 'c', 'v')
    assert.equal(calls[1].x, 33)
    assert.equal(calls[1].y, 251)
  })
})

describe('shown：预览渲染上限', () => {
  const MAX = 4000

  test('上限是 4000 字符（长值只给前缀，全文另有出口）', () => {
    assert.ok(/export const PREVIEW_MAX = 4000/.test(read()), 'PREVIEW_MAX drifted')
  })

  test('未超限原样、超限裁到上限并标记 truncated', () => {
    const shown = loadShown(MAX)
    const small = shown({ text: 'abc' })
    assert.equal(small.clipped, 'abc')
    assert.equal(small.truncated, false)
    const big = shown({ text: 'z'.repeat(MAX + 5000) })
    assert.equal(big.clipped.length, MAX)
    assert.equal(big.truncated, true)
  })

  test('边界：正好等于上限不算截断', () => {
    const shown = loadShown(MAX)
    assert.equal(shown({ text: 'q'.repeat(MAX) }).truncated, false)
    assert.equal(shown({ text: 'q'.repeat(MAX + 1) }).truncated, true)
  })

  test('无 state → null（关闭时不渲染内容，也不抛）', () => {
    assert.equal(loadShown(MAX)(null), null)
  })
})

describe('单例与关闭时机契约', () => {
  test('受控 Popover：open 由 state 决定，禁用自带触发器（每格挂浮层的做法不许回来）', () => {
    const src = read()
    assert.ok(src.includes('open={!!state}'), 'open must stay controlled')
    assert.ok(src.includes('trigger={[]}'), 'trigger must stay empty')
    assert.ok(!/trigger=\['hover'\]/.test(src), 'per-cell hover trigger must not return')
    assert.ok(src.includes('className=\'db-cell-preview-anchor\''), 'anchor element missing')
    const anchors = (src.match(/<Popover/g) || []).length
    assert.equal(anchors, 1, 'component must render exactly one Popover')
  })

  test('隐藏有缓冲：指针从单元格移进卡片期间不关（否则无法选中复制）', () => {
    const src = read()
    assert.match(src, /const HIDE_DELAY = (\d+)/)
    const delay = Number(src.match(/const HIDE_DELAY = (\d+)/)[1])
    assert.ok(delay >= 150, '缓冲太短指针来不及移进卡片')
    assert.ok(src.includes('timerRef.current = setTimeout'), 'scheduleHide must be debounced')
    assert.ok(src.includes('const cancelHide = useCallback'), 'cancelHide missing')
  })

  test('Esc 关闭 + 滚动关闭（浮层停在原地指向别的单元格会误导人）', () => {
    const src = read()
    const effect = src.match(/useEffect\(\(\) => \{[\s\S]*?if \(!state\) \{\n {6}return\n {4}\}[\s\S]*?\n {2}\}, \[state, onHide\]\)/)
    assert.ok(effect, 'close effect not found')
    assert.ok(effect[0].includes("'keydown'") && effect[0].includes("ev.key === 'Escape'"), 'Esc close missing')
    assert.ok(effect[0].includes("'scroll'") && effect[0].includes(', true)'), 'capture-phase scroll close missing')
    assert.ok(effect[0].includes('removeEventListener'), 'listeners must be cleaned up')
  })

  test('卸载时清掉待关闭的定时器与观察者（否则组件没了还在 setState）', () => {
    const src = read()
    const m = src.match(/useEffect\(\(\) => \(\) => \{[\s\S]*?\n {2}\}, \[cancelHide\]\)/)
    assert.ok(m, 'unmount cleanup effect not found')
    assert.ok(m[0].includes('cancelHide()'), 'pending hide timer must be cleared')
    assert.ok(m[0].includes('roRef.current.disconnect()'), 'observer must be disconnected')
  })

  test('源单元格消失就关卡：切页签（display:none）与虚拟滚动回收两条路都覆盖', () => {
    const src = read()
    const w = src.match(/const watchCell = useCallback\(\(td\) => \{[\s\S]*?\n {2}\}, \[cancelHide\]\)/)
    assert.ok(w, 'watchCell useCallback not found')
    assert.ok(w[0].includes('new window.ResizeObserver'), '要靠 ResizeObserver 抓到尺寸归零')
    assert.ok(w[0].includes('isConnected'), '行被虚拟滚动换出 DOM 时也要关')
    assert.ok(w[0].includes('contentRect'), 'display:none 的元素报 0 尺寸')
    assert.ok(w[0].includes('roRef.current.disconnect()'), '同一时刻只观察一格')
    assert.ok(w[0].includes('if (cellRef.current === td)'), '同一格反复悬停不重建观察')
    assert.ok(w[0].includes('if (!window.ResizeObserver)'), '不支持 RO 的环境要降级而不是抛错')
    // 观察者只允许有一个实例：RO 在 ref 上懒建，不得每格 new 一个
    assert.equal((src.match(/new window\.ResizeObserver/g) || []).length, 1)
  })

  test('复制的是全文，不是裁剪后的预览', () => {
    const src = read()
    assert.ok(src.includes('copy(state.text)'), 'copy must use full text')
    assert.ok(!src.includes('copy(shown.clipped)'), 'copying the clipped preview would silently lose data')
  })

  test('关闭即卸载浮层：DOM 里没有"藏着的上一次长文本"', () => {
    const src = read()
    assert.ok(src.includes('destroyOnHidden'),
      '默认只 display:none，关掉的卡会把最坏 4000 字符一直留在 DOM 里；实测也依赖"有卡=开着"')
  })

  test('正文按宽度换行、按高度滚动（长内容既不横向溢出也不顶破卡片）', () => {
    const styl = fs.readFileSync(STYL, 'utf8')
    const pre = styl.match(/\.db-cell-preview-pre\n((?: {2}[^\n]*\n)+)/)
    assert.ok(pre, '.db-cell-preview-pre rule not found')
    assert.match(pre[1], /^ {2}white-space pre-wrap$/m, 'long single-line values must wrap, not overflow')
    assert.match(pre[1], /^ {2}word-break break-all$/m, 'a 5000-char run has no break opportunity')
  })

  test('预览卡自身可选中文本（user-select text），锚点不吃事件', () => {
    const styl = fs.readFileSync(STYL, 'utf8')
    const pre = styl.match(/\.db-cell-preview-pre\n((?: {2}[^\n]*\n)+)/)
    assert.ok(pre, '.db-cell-preview-pre rule not found')
    assert.match(pre[1], /^ {2}user-select text$/m, 'preview text must be selectable')
    assert.match(pre[1], /^ {2}max-height 320px$/m, 'preview must have a height cap')
    assert.match(pre[1], /^ {2}overflow auto$/m, 'capped preview must scroll')
    const anchor = styl.match(/\.db-cell-preview-anchor\n((?: {2}[^\n]*\n)+)/)
    assert.ok(anchor, 'anchor rule not found')
    assert.match(anchor[1], /^ {2}pointer-events none$/m, 'anchor must not eat mouse events')
  })

  // 锚点写成 0×0 时，卡片在 DOM 里内容全对、opacity 1，却整张停在屏幕外（rc-trigger
  // 定位前把浮层停在 inset:-1000vh/-1000vw，isVisible(锚点) 判假就再也不定位）。
  // 这条断言是"截图里什么都没有"那次实测换来的，别为了"不占位"改回 0。
  test('锚点必须有非零尺寸：0×0 会被 rc-trigger 判成不可见，浮层停在 -1000vw', () => {
    const styl = fs.readFileSync(STYL, 'utf8')
    const anchor = styl.match(/\.db-cell-preview-anchor\n((?: {2}[^\n]*\n)+)/)
    assert.ok(anchor, 'anchor rule not found')
    const w = anchor[1].match(/^ {2}width (\S+)$/m)
    const h = anchor[1].match(/^ {2}height (\S+)$/m)
    assert.ok(w && h, 'anchor must declare width and height explicitly')
    assert.notEqual(w[1], '0', 'anchor width 0 → popover never aligns')
    assert.notEqual(h[1], '0', 'anchor height 0 → popover never aligns')
    assert.match(anchor[1], /^ {2}position fixed$/m, 'anchor must follow viewport coords of the cell')
  })
})

describe('i18n：预览卡新增文案 en / zh_cn 成对存在', () => {
  const extra = require(path.join(ROOT, 'src/app/common/locales-extra.js'))

  test('用到的 locales-extra 新 key 两种语言都有，且占位符一致', () => {
    const keys = ['dbCellChars', 'dbCellTruncated', 'dbViewFullText']
    for (const k of keys) {
      assert.ok(extra.en[k], k + ' missing in en')
      assert.ok(extra.zh_cn[k], k + ' missing in zh_cn')
    }
    // {n} 占位符漏掉一种语言 → 字符数直接不显示
    assert.match(extra.en.dbCellChars, /\{n\}/)
    assert.match(extra.zh_cn.dbCellChars, /\{n\}/)
  })

  test('组件里用到的 e() key 全部有词条（上游语言包 + locales-extra）', () => {
    const zh = require(path.join(ROOT, 'node_modules/@electerm/electerm-locales/dist/cjs/zh_cn.js')).lang
    const en = require(path.join(ROOT, 'node_modules/@electerm/electerm-locales/dist/cjs/en_us.js')).lang
    const used = [...read().matchAll(/e\('([a-zA-Z0-9_]+)'\)/g)].map(x => x[1])
    assert.ok(used.length, 'no i18n keys found — 说明有写死文案')
    const missing = [...new Set(used)].filter(k => !(
      Object.prototype.hasOwnProperty.call(zh, k) ||
      Object.prototype.hasOwnProperty.call(en, k) ||
      Object.prototype.hasOwnProperty.call(extra.en, k) ||
      Object.prototype.hasOwnProperty.call(extra.zh_cn, k)
    ))
    assert.deepEqual(missing, [])
  })
})

describe('接线：db-session 传给预览的 props 形状', () => {
  test('5 处网格共享同一个预览实例（不各自挂一个）', () => {
    const src = fs.readFileSync(SESSION, 'utf8')
    assert.equal((src.match(/<DbCellPreview/g) || []).length, 1)
    assert.ok(src.includes("import DbCellPreview, { useCellPreview, CELL_ELLIPSIS } from './db-cell-preview'"))
  })

  test('5 处网格都用 CELL_ELLIPSIS：ellipsis 生效但不带原生 title', () => {
    const src = fs.readFileSync(SESSION, 'utf8')
    // ellipsis: true 会让 rc-table 给纯文本格子补 title → 与预览卡叠两层
    assert.equal((src.match(/ellipsis: true/g) || []).length, 0,
      'ellipsis: true 会把原生 title 带回来（CDP 实测过），必须用 CELL_ELLIPSIS')
    assert.equal((src.match(/ellipsis: CELL_ELLIPSIS/g) || []).length, 12,
      '数据页 1 + SQL 结果 1 + 表结构 1 + Redis 键列表 3 + Redis 详情 6')
  })

  test('CELL_ELLIPSIS 是对象且显式关掉 showTitle', () => {
    const src = read()
    assert.match(src, /export const CELL_ELLIPSIS = \{ showTitle: false \}/)
  })

  test('onCell 让位：合并进已有编辑 handler 的列用展开，不覆盖既有回调', () => {
    const src = fs.readFileSync(SESSION, 'utf8')
    // Redis 详情 hash/list/set/zset 的 value/member/score 列原本已有双击编辑
    assert.equal((src.match(/\.\.\.previewProps\(/g) || []).length, 6, 'data grid + redis detail 5 列')
    const hashValue = src.match(/onCell: r => \(\{[\s\S]*?\.\.\.previewProps\('value', r\)/)
    assert.ok(hashValue, 'redis hash value must keep its own onCell and merge preview props')
    assert.ok(/onDoubleClick: \(\) => editRedisCell/.test(src), 'redis inline edit must survive the merge')
  })

  test('合并顺序：previewProps 放最后，列 memo 里不会被前面的字面量吃掉', () => {
    const src = fs.readFileSync(SESSION, 'utf8')
    const cell = src.match(/onCell: row => \(\{[\s\S]*?\.\.\.previewProps\(k, row\)\n {8}\}\)/)
    assert.ok(cell, 'data grid merge order drifted')
  })
})
