const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const JSX = path.join(ROOT, 'src/client/components/database/db-session.jsx')
const STYL = path.join(ROOT, 'src/client/components/database/db-session.styl')

// 数据库网格统一滚动（doc/数据库表格横向滚动条优化方案.md）：
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
  return vm.runInNewContext('(function (wrapH, headH) { return ' + yMatch[1] + ' })', {})
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
    assert.equal(calc(0, 0), 0)
    assert.equal(calc(0, 38), 0)
  })

  test('header not rendered yet (headH=0) -> no scroll.y', () => {
    assert.equal(calc(702, 0), 0)
  })

  test('definite wrap height -> y = wrapH - headH (real sizes from live test)', () => {
    assert.equal(calc(702, 38), 664)
    assert.equal(calc(563, 38), 525)
  })

  test('degenerate tiny container (smaller than header) -> no scroll.y', () => {
    assert.equal(calc(30, 38), 0)
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
      'fixed max-height returns the rigid 45/55 split (see doc/设计-redis键空间右侧高度分配.md)'
    )
  })

  test('.db-redis-resizer exists with row-resize cursor (drag split guard)', () => {
    const block = stylBlock(loadStyl(), '.db-redis-resizer')
    assert.ok(block, '.db-redis-resizer block not found')
    assert.match(block, /cursor row-resize/)
  })
})
