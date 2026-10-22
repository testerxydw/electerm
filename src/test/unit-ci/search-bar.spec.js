const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const SEARCH_BAR = path.join(ROOT, 'src/client/components/common/search-bar.jsx')
const SEARCH_BAR_STYL = path.join(ROOT, 'src/client/components/common/search-bar.styl')
const TERM_SEARCH = path.join(ROOT, 'src/client/components/terminal/term-search.jsx')
const TERM_SEARCH_STYL = path.join(ROOT, 'src/client/components/terminal/term-search.styl')
const SESSION_CONTROL = path.join(ROOT, 'src/client/components/session/session-control.jsx')
const SESSION_CONTROL_STYL = path.join(ROOT, 'src/client/components/session/session-control.styl')
const SESSION = path.join(ROOT, 'src/client/components/session/session.jsx')
const ACTIONS = path.join(ROOT, 'src/client/components/common/session-bar-actions.jsx')
const LAYOUT = path.join(ROOT, 'src/client/components/layout/layout.jsx')
const DB_SESSION = path.join(ROOT, 'src/client/components/database/db-session.jsx')
const DB_SEARCH = path.join(ROOT, 'src/client/components/database/db-search.jsx')
const DB_SESSION_STYL = path.join(ROOT, 'src/client/components/database/db-session.styl')

// 统一查找条（doc/已完成/草图-统一搜索条-2026-10-19.html + doc/数据库功能总览-2026-10-21.md）：
// 终端页与数据库页共用 SearchBar UI（引擎注入）；终端从右上浮层迁入顶栏内联；
// DB 命中清单 = .db-kw-hit 标记 + textarea 文本命中（选区定位）。
// 这里守护：SearchBar UI 契约、终端接线契约、DB 命中逻辑（跑真实源码）、CSS 契约。

const load = p => fs.readFileSync(p, 'utf8')
const searchBarSrc = () => load(SEARCH_BAR)
const termSearchSrc = () => load(TERM_SEARCH)
const sessionControlSrc = () => load(SESSION_CONTROL)
const dbSessionSrc = () => load(DB_SESSION)

// 在 styl 里取某个顶级选择器的块（到下一个顶级选择器为止；文件可能是 CRLF 行尾）
const stylBlock = (styl, selector) => {
  const re = new RegExp(
    '^' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![-\\w])[^\\n]*\\n(?:[ \\t]+[^\\n]*\\n)+',
    'm'
  )
  const m = styl.match(re)
  return m ? m[0] : ''
}

// 从 db-search.jsx 抽出纯函数定义，vm 跑发布代码而非拷贝
const loadHelpers = () => {
  const src = load(DB_SEARCH)
  const pick = name => {
    const m = src.match(new RegExp('export function ' + name + ' \\([\\s\\S]*?\\n\\}'))
    assert.ok(m, name + ' definition not found in db-search.jsx')
    return m[0].replace(/^export /, '')
  }
  const code = pick('scanTextHits') + '\n' + pick('cycleIndex') + ';({ scanTextHits, cycleIndex })'
  return vm.runInNewContext(code, {})
}

describe('SearchBar: UI contract (real source)', () => {
  test('input: autofocused, allowClear, Esc closes, Enter = next', () => {
    const src = searchBarSrc()
    assert.ok(src.includes('<InputAutoFocus'), 'must render InputAutoFocus')
    assert.ok(src.includes('allowClear'), 'must allowClear')
    assert.ok(src.includes('selectall'), 'must selectall (autofocus + select)')
    assert.match(src, /if \(ev\.key === 'Escape'\) \{\s*\n\s*onClose\(\)/, 'Esc must call onClose')
    assert.ok(src.includes('onPressEnter={onNext}'), 'Enter must trigger onNext')
  })

  test('count renders (i/n) only when matchCount > 0', () => {
    const src = searchBarSrc()
    assert.ok(src.includes('({matchIndex + 1}/{matchCount})'), 'count format drifted')
    assert.match(src, /matchCount\s*\?\s*<span className='search-bar-count'/, 'count must be conditional on matchCount')
  })

  test('prev/next/close actions wired to icons', () => {
    const src = searchBarSrc()
    assert.match(src, /<ArrowLeftOutlined className='search-bar-act' onClick=\{onPrev\} \/>/)
    assert.match(src, /<ArrowRightOutlined className='search-bar-act' onClick=\{onNext\} \/>/)
    assert.match(src, /<CloseCircleOutlined className='search-bar-act search-bar-close' onClick=\{onClose\} \/>/)
  })

  test('className composition and defaults', () => {
    const src = searchBarSrc()
    assert.ok(src.includes("'search-bar' + (className ? ' ' + className : '')"), 'className composition drifted')
    assert.match(src, /matchIndex = 0/, 'matchIndex default')
    assert.match(src, /matchCount = 0/, 'matchCount default')
    assert.ok(src.includes('suffix'), 'suffix slot must be forwarded (terminal option toggles)')
  })
})

describe('TermSearch: inline migration contract', () => {
  test('store-driven auto component (no layout props anymore)', () => {
    const src = termSearchSrc()
    assert.ok(src.includes('export default auto(TermSearch)'), 'must be auto-wrapped store-driven component')
    assert.ok(src.includes('const {\n    termSearchOpen'), 'must read termSearchOpen from window.store')
  })

  test('controller registered on refsStatic["term-search"] with cleanup', () => {
    const src = termSearchSrc()
    assert.ok(src.includes("refsStatic.add('term-search', controller)"), 'shortcut/menu callers depend on this key')
    assert.ok(src.includes("refsStatic.remove('term-search')"), 'must unregister on unmount')
    assert.match(src, /toggleSearch \(\)/, 'controller.toggleSearch')
    assert.match(src, /prev \(searchTerm\)/, 'controller.prev')
    assert.match(src, /next \(\)/, 'controller.next')
    // 关闭时清理 xterm 装饰（toggleSearch 的 isClosing 分支）
    assert.match(src, /const isClosing = window\.store\.termSearchOpen\s*\n\s*if \(isClosing\) \{\s*\n\s*clearSearch\(\)/, 'toggle close must clear decorations')
  })

  test('hidden when closed or file manager pane', () => {
    const src = termSearchSrc()
    assert.ok(src.includes('!termSearchOpen'), 'hidden when closed')
    assert.ok(src.includes('tab.pane === paneMap.fileManager'), 'hidden on file manager pane')
  })

  test('option toggles (case/word/regex) as SearchBar suffix slot', () => {
    const src = termSearchSrc()
    assert.ok(src.includes('suffix={searchControls.map(renderSearchControl)}'), 'suffix slot wiring drifted')
    assert.ok(src.includes("id: 'matchCase'") && src.includes("prop: 'caseSensitive'"), 'matchCase option')
    assert.ok(src.includes("id: 'matchWholeWord'") && src.includes("prop: 'wholeWord'"), 'wholeWord option')
    assert.ok(src.includes("id: 'useRegExp'") && src.includes("prop: 'regex'"), 'regex option')
  })

  test('empty input clears decorations instead of searching', () => {
    const src = termSearchSrc()
    assert.match(src, /if \(v\) \{\s*\n\s*controller\.prev\(v\)\s*\n\s*\} else \{\s*\n\s*clearSearch\(\)/, 'handleChange empty branch')
  })
})

describe('terminal inline wiring (session-control / session / layout)', () => {
  test('search bar rendered inline before the search icon in term-controls', () => {
    const src = sessionControlSrc()
    const i1 = src.indexOf('<TermSearch tab={tab} />')
    // S1 起查找/全屏图标来自共享动作组件 renderBarActions()
    const i2 = src.indexOf('{renderBarActions()}')
    assert.ok(i1 >= 0, 'TermSearch must be mounted in session-control')
    assert.ok(i2 > i1, 'search bar must expand to the left of the search icon')
  })

  test('search icon active state driven by searchOpen prop', () => {
    const src = sessionControlSrc()
    // S1：激活态类移入 common/session-bar-actions.jsx（searchOpen 透传）
    const actionsSrc = load(ACTIONS)
    assert.ok(actionsSrc.includes("searchOpen ? ' search-open' : ''"), 'active class drifted')
    assert.ok(src.includes('searchOpen={searchOpen}'), 'session-control must pass searchOpen to SessionBarActions')
    const styl = load(SESSION_CONTROL_STYL)
    const block = stylBlock(styl, '.search-open')
    assert.ok(block.includes('color var(--primary)'), '.search-open must use primary color (same as .db-search-on)')
  })

  test('session.jsx passes store-driven searchOpen to SessionControl', () => {
    const src = load(SESSION)
    assert.ok(src.includes('searchOpen={!!window.store.termSearchOpen}'), 'SessionControl is not manate-wrapped; prop must come from the class render')
  })

  test('layout.jsx no longer renders the floating TermSearch', () => {
    const src = load(LAYOUT)
    assert.ok(!src.includes('<TermSearch'), 'global floating search must stay removed')
    assert.ok(!src.includes("'termSearchOpen'"), 'term search store keys are not layout concerns anymore')
  })

  test('term-search.styl: no floating positioning left', () => {
    const block = stylBlock(load(TERM_SEARCH_STYL), '.term-search-wrap')
    assert.ok(block, '.term-search-wrap block not found')
    assert.ok(!/position absolute/.test(block), 'floating overlay must stay removed (inline in .terminal-control)')
  })
})

describe('DB search: hit-list logic (real source)', () => {
  const { scanTextHits, cycleIndex } = loadHelpers()

  test('scanTextHits: case-insensitive, non-overlapping, offsets', () => {
    // vm 跨 realm 数组不能 deepEqual（原型不同），JSON 序列化比对
    const hits = JSON.stringify(scanTextHits('Alice and alice again', 'ali').map(h => [h.start, h.end]))
    assert.equal(hits, JSON.stringify([[0, 3], [10, 13]]))
  })

  test('scanTextHits: empty kw / no match / null value', () => {
    assert.equal(scanTextHits('abc', '').length, 0)
    assert.equal(scanTextHits('abc', 'zz').length, 0)
    assert.equal(scanTextHits(null, 'a').length, 0)
    assert.equal(scanTextHits(undefined, 'a').length, 0)
  })

  test('scanTextHits: non-overlapping scan (aaa / aa -> one hit)', () => {
    const hits = JSON.stringify(scanTextHits('aaa', 'aa').map(h => [h.start, h.end]))
    assert.equal(hits, JSON.stringify([[0, 2]]))
  })

  test('cycleIndex: wraps both directions, guards n=0', () => {
    assert.equal(cycleIndex(0, -1, 5), 4)
    assert.equal(cycleIndex(4, 1, 5), 0)
    assert.equal(cycleIndex(2, 7, 5), 4)
    assert.equal(cycleIndex(3, -9, 5), 4)
    assert.equal(cycleIndex(3, 1, 0), 3, 'n=0 must not produce NaN')
  })

  test('recount: textarea hits via scanTextHits + input delegation', () => {
    const src = dbSessionSrc()
    assert.ok(src.includes('scanTextHits(ta.value, kw)'), 'textarea scan must go through the pure helper')
    assert.ok(src.includes("root.addEventListener('input', recount, true)"), 'textarea value changes emit no DOM mutation; input delegation is required')
    assert.ok(src.includes("root.removeEventListener('input', recount, true)"), 'listener must be removed on cleanup')
  })

  test('goHit: cycle navigation via cycleIndex + locateHit', () => {
    const src = dbSessionSrc()
    assert.ok(src.includes('const next = cycleIndex(searchIndexRef.current, delta, n)'), 'goHit drifted')
    assert.match(src, /const locateHit = \(index\) => \{[\s\S]*?hit\.el\.focus\(\)[\s\S]*?hit\.el\.setSelectionRange\(hit\.start, hit\.end\)/, 'textarea hit must locate via focus + selection')
  })

  test('drift guard: focus/selection only in locateHit, never in the render-sync effect', () => {
    const src = dbSessionSrc()
    const end = src.indexOf('}, [searchIndex, searchHits, kw])')
    assert.ok(end > 0, 'render-sync effect deps drifted')
    const start = src.lastIndexOf('useEffect(', end)
    const block = src.slice(start, end)
    assert.ok(block.includes('const { marks } = hitsRef.current'), 'render-sync effect block not found')
    assert.ok(!block.includes('setSelectionRange'), 'switching keywords must not steal focus into textareas (focus belongs to goHit only)')
  })

  test('index ref mirror kept in sync (setIdx on reset and close)', () => {
    const src = dbSessionSrc()
    assert.match(src, /const setIdx = \(v\) => \{\s*\n\s*searchIndexRef\.current = v\s*\n\s*setSearchIndex\(v\)/, 'ref mirror helper')
    assert.match(src, /useEffect\(\(\) => \{\s*\n\s*setIdx\(0\)\s*\n\s*\}, \[kw\]\)/, 'keyword change must reset to first hit')
    const closeMatch = src.match(/const closeSearch = \(\) => \{[\s\S]*?\n {2}\}/)
    assert.ok(closeMatch && closeMatch[0].includes('setIdx(0)'), 'close must reset via setIdx')
  })

  test('two-color current hit css stays (weak + primary + outline)', () => {
    const styl = load(DB_SESSION_STYL)
    const block = stylBlock(styl, '.db-kw-hit')
    assert.ok(block.includes('&.db-kw-cur'), 'current-hit class missing')
    assert.ok(block.includes('outline 1px solid'), 'current hit must have outline (box-shadow is contract-restricted)')
    assert.ok(!stylBlock(styl, '.db-search'), 'old inline .db-search block must stay removed (SearchBar has its own styles)')
  })
})

describe('SearchBar styl contract', () => {
  test('input flex-shrinkable with min width (narrow window guard)', () => {
    const block = stylBlock(load(SEARCH_BAR_STYL), '.search-bar-input')
    assert.ok(block.includes('min-width 100px'), 'input needs a floor width when the bar flexes')
  })

  test('count uses tabular-nums', () => {
    const block = stylBlock(load(SEARCH_BAR_STYL), '.search-bar-count')
    assert.ok(block.includes('font-variant-numeric tabular-nums'), '(i/n) must not jitter while navigating')
  })

  test('no raw colors (tokens only)', () => {
    const styl = load(SEARCH_BAR_STYL)
    assert.ok(!/#[0-9a-f]{3,8}\b/i.test(styl), 'CSS contract: no raw hex in search-bar.styl')
    // (?![-\w]) 防误报：white-space 这类连字符词不是颜色
    assert.ok(!/(?<![-\w])(?:white|black|red|green|blue)(?![-\w])/.test(styl), 'CSS contract: no named colors in search-bar.styl')
  })
})
