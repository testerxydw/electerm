const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const JSX = path.join(ROOT, 'src/client/components/database/db-session.jsx')
const STYL = path.join(ROOT, 'src/client/components/database/db-session.styl')

// 数据库网格统一滚动（doc/已完成/数据库功能设计归档-2026-10-21.md）：
// 表体定高（scroll.y）→ 横向滚动条常驻可视区底边、表头吸顶。
// 这里守护三块：y 推导逻辑（跑真实源码表达式）、组件接线契约、CSS 布局契约。
// CSS 契约背景：auto 高度的 flex 容器里子项 flex-basis 0 会把内容高缩成 0
// （曾导致 Redis 键列表整块塌陷），故 .db-grid-table 的 basis 必须是 auto。

const loadJsx = () => fs.readFileSync(JSX, 'utf8')
const loadStyl = () => fs.readFileSync(STYL, 'utf8')

// 从 db-session.jsx 里抽出 DbGridTable 的 y 推导表达式，跑的是发布代码而非拷贝
const loadCalcScrollY = () => {
  const src = loadJsx()
  const fnMatch = src.match(/function DbGridTable \([\s\S]*?\n\}/)
  assert.ok(fnMatch, 'DbGridTable definition not found in db-session.jsx')
  const yMatch = fnMatch[0].match(/const y = (wrapH[^\n]+)$/m)
  assert.ok(yMatch, 'y derivation not found inside DbGridTable')
  // vm 而非 new Function：跑真实源码表达式，且过 standard 的 no-new-func
  return vm.runInNewContext('(function (wrapH, headH, pagerH) { return ' + yMatch[1] + ' })', {})
}

// 在 styl 里取某个顶级选择器的块（到下一个顶级选择器为止；文件是 CRLF 行尾）
const stylBlock = (styl, selector) => {
  const re = new RegExp(
    '^' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![-\\w])[^\\n]*\\n(?:[ \\t]+[^\\n]*\\n)+',
    'm'
  )
  const m = styl.match(re)
  return m ? m[0] : ''
}

describe('DbGridTable: y derivation (real source)', () => {
  const calc = loadCalcScrollY()

  test('not measured yet (wrapH=0) -> no scroll.y, keeps outer scrolling', () => {
    assert.equal(calc(0, 0, 0), 0)
    assert.equal(calc(0, 38, 0), 0)
  })

  test('header not rendered yet (headH=0) -> no scroll.y', () => {
    assert.equal(calc(702, 0, 0), 0)
  })

  test('definite wrap height -> y = wrapH - headH (real sizes from live test)', () => {
    assert.equal(calc(702, 38, 0), 664)
    assert.equal(calc(563, 38, 0), 525)
  })

  test('pagination row steals height from the body (SQL result paging)', () => {
    assert.equal(calc(702, 38, 32), 632)
    assert.equal(calc(702, 38, 100), 564)
  })

  test('degenerate tiny container (smaller than header) -> no scroll.y', () => {
    assert.equal(calc(30, 38, 0), 0)
  })
})

describe('DbGridTable: component wiring contract', () => {
  test('all data grids go through DbGridTable (main/SQL/struct/redis detail x4/redis keys)', () => {
    const src = loadJsx()
    const used = src.match(/<DbGridTable/g) || []
    assert.ok(used.length >= 7, 'expected >= 7 <DbGridTable usages, got ' + used.length)
  })

  test('no bare <Table left in db-session.jsx (only the one inside DbGridTable)', () => {
    const src = loadJsx()
    const bare = src.match(/<Table\b/g) || []
    assert.equal(bare.length, 1, 'a new <Table bypasses the unified scroll wrapper')
  })

  test('scroll prop passes x and conditional y (drift guard)', () => {
    const src = loadJsx()
    assert.ok(
      src.includes("scroll={{ x: 'max-content', ...(y > 0 ? { y } : {}) }}"),
      'DbGridTable scroll prop drifted'
    )
  })

  test('measurement effect observes both wrap and thead (transient-height fix)', () => {
    const fnMatch = loadJsx().match(/function DbGridTable \([\s\S]*?\n\}/)
    assert.ok(fnMatch, 'DbGridTable definition not found')
    assert.ok(fnMatch[0].includes('new window.ResizeObserver'), 'must use ResizeObserver')
    assert.ok(fnMatch[0].includes('ob.observe(head)'), 'must observe thead too (transient header height)')
  })
})

describe('批次 C：数据库页渲染收口契约', () => {
  test('列宽采样抽成 useMemo，columns 不再每次 render 扫前 100 行', () => {
    const src = loadJsx()
    assert.ok(src.includes('const columnWidths = useMemo('), 'columnWidths memo missing')
    // 列定义已按 A1 收口成 useMemo（`const columns = useMemo(() => (grid.rows.length ...`），
    // 契约只关心"采样不在 columns 里、宽度消费走 widthOf"，故两种写法都接受
    const colBlock = src.match(/const columns = (?:useMemo\(\(\) => \()?grid\.rows\.length[\s\S]*?\n\s{4}: \[\]/)
    assert.ok(colBlock, 'columns block not found')
    assert.ok(!colBlock[0].includes('slice(0, 100)'), 'width sampling must stay out of columns')
    assert.ok(colBlock[0].includes('widthOf(k)'), 'columns must consume memoized widths')
    // A1：columns 必须是 memo 化的，否则列定义每轮重建、antd 收不到同一份引用
    assert.ok(/const columns = useMemo\(/.test(src), 'columns must be memoized')
    // E2-3b：宽度消费挪进了 widthOf（拖拽中 > 视角记忆 > 自适应），
    // memo 本身仍被消费、仍不被重复采样 —— 契约不变，只是多了一层优先级
    // \s{2} 而不是两个空格字面量：no-regex-spaces 会拦多空格正则
    const widthFn = src.match(/const widthOf = \(k\) => \{[\s\S]*?\n\s{2}\}/)
    assert.ok(widthFn, 'widthOf helper not found')
    assert.ok(widthFn[0].includes('columnWidths[k]'), 'widthOf must consume memoized widths')
  })

  test('treeData 按元数据/筛选/查找关键字记忆化', () => {
    const src = loadJsx()
    assert.ok(src.includes('const treeData = useMemo(() => {'), 'treeData must be memoized')
    const line = src.match(/const treeData = useMemo\([\s\S]*?\}, \[([^\]]+)\]\)/)
    assert.ok(line, 'treeData memo deps not found')
    const deps = line[1]
    ;['visibleMetadata', 'treeFilterKw', 'kw', 'isPg', 'currentDbName'].forEach(k => {
      assert.ok(deps.includes(k), 'treeData deps missing ' + k)
    })
  })

  test('DbGridTable 的 ResizeObserver 只在挂载时创建一次', () => {
    const fn = loadJsx().match(/function DbGridTable \([\s\S]*?\n\}/)
    assert.ok(fn, 'DbGridTable definition not found')
    const code = fn[0]
    assert.ok(code.includes('const measureRef = useRef'), 'measure ref missing')
    assert.match(code, /\n\s{2}\}, \[\]\)/, 'observer effect must have empty deps')
    assert.ok(code.includes('measureRef.current()'), 'data-change remeasure missing')
  })

  test('网格单元格键盘可达（Tab / Enter / F2 / Esc）', () => {
    const src = loadJsx()
    assert.ok(src.includes('tabIndex: 0'), 'cell td must be focusable')
    assert.ok(src.includes("ev.key === 'F2'"), 'F2 edit shortcut missing')
    assert.ok(src.includes("'aria-label': k"), 'cell aria-label missing')
    assert.ok(src.includes("if (ev.key === 'Escape')"), 'Esc exit missing')
    assert.ok(src.includes('ev.target !== ev.currentTarget'), 'editor key events must not bubble into td handler')
  })

  test('.db-cell-editable 有 focus-visible 焦点环', () => {
    const block = stylBlock(loadStyl(), '.db-cell-editable')
    assert.ok(block, '.db-cell-editable block not found')
    assert.match(block, /&:focus-visible/, 'focus-visible ring missing')
    assert.match(block, /outline 2px solid var\(--primary\)/)
  })

  test('全部 hook 必须在 error/!ready 早退之前（React hooks 顺序）', () => {
    // 23eafc70 曾把命令面板的 8 个 hook 放在 `if (error) return` 之后：
    // 连接失败时 hook 数比首帧少 8，React 直接抛
    // "Rendered fewer hooks than expected"，全客户端无 error boundary
    // → 整树卸载，用户看到白屏而不是断线重连页。文件里 sqlTables 的注释
    // （"必须留在 if (!ready) return 之前"）早写过这条铁律，这里钉成测试
    const src = loadJsx()
    const early = src.indexOf('  if (error) {')
    assert.ok(early > 0, 'error early-return marker missing')
    const markers = [
      'const [quickOpen, setQuickOpen] = useState(false)',
      'const quickItems = useMemo(',
      'const sqlTables = useMemo(',
      'const treeData = useMemo(',
      'const columnWidths = useMemo('
    ]
    for (const m of markers) {
      const pos = src.indexOf(m)
      assert.ok(pos > 0, m + ' missing')
      assert.ok(pos < early, m + ' must be declared before the error early-return (hooks order)')
    }
  })
})

describe('DbGridTable: css layout contract', () => {
  test('.db-grid-table basis is auto (redis keys list collapse guard)', () => {
    const block = stylBlock(loadStyl(), '.db-grid-table')
    assert.ok(block, '.db-grid-table block not found')
    assert.match(block, /flex 1 1 auto/, 'basis 0 collapses auto-height wraps (.db-redis-keys)')
  })

  test('.db-grid-table-wrap takes over scrolling with overflow hidden', () => {
    const block = stylBlock(loadStyl(), '.db-grid-table-wrap')
    assert.ok(block, '.db-grid-table-wrap block not found')
    assert.match(block, /flex 1 1 0/)
    assert.match(block, /overflow hidden/)
  })

  test('.db-struct-area fills its tabpane with height 100% (block parent ignores flex-basis)', () => {
    const block = stylBlock(loadStyl(), '.db-struct-area')
    assert.ok(block, '.db-struct-area block not found')
    assert.match(block, /height 100%/, 'flex-basis alone collapses inside block-level tabpane')
  })

  test('.db-sql-result spin wrapper chain passes height through', () => {
    const styl = loadStyl()
    const block = stylBlock(styl, '.db-sql-result')
    assert.ok(block, '.db-sql-result block not found')
    assert.ok(block.includes('> .ant-spin-nested-loading'), 'spin wrapper must flex')
    assert.ok(block.includes('> .ant-spin-container'), 'spin container must flex')
  })

  test('.db-redis-keys has no fixed max-height (drag-split replaced it)', () => {
    const styl = loadStyl()
    const block = stylBlock(styl, '.db-redis-keys')
    assert.ok(
      !block || !/max-height/.test(block),
      'fixed max-height returns the rigid 45/55 split (see doc/已完成/数据库功能设计归档-2026-10-21.md)'
    )
  })

  test('.db-split-resizer exists with row-resize cursor (shared drag split guard)', () => {
    const block = stylBlock(loadStyl(), '.db-split-resizer')
    assert.ok(block, '.db-split-resizer block not found')
    assert.match(block, /cursor row-resize/)
    assert.ok(!loadStyl().includes('.db-redis-resizer'), 'old per-type resizer must be removed (shared DbSplitPane)')
  })
})
