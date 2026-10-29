// U1d 数据页状态行 + 批量动作分组
//
// 数据页控制条原来只说"总行数（约）"，说不清这一屏到底拿到多少行；勾选后的
// 四个动作也各自带着同一串门控散在控制条里，"选了没"只能靠猜。本 spec 钉住
// 改完后的结构：本页行数与总数并排（总数为空时不画分隔点）、门控提到组首、
// 组首补"已选 n 行"。宽度表现与三档截图由 self-test 覆盖。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

const SESSION = 'src/client/components/database/db-session.jsx'
const STYL = 'src/client/components/database/db-session.styl'
const LOCALES = 'src/app/common/locales-extra.js'

// 状态行：从 .db-grid-total 到自己的收尾标签
const totalSpan = () => {
  const src = read(SESSION)
  const start = src.indexOf("<span className='db-grid-total'>")
  assert.ok(start !== -1, '没找到 .db-grid-total')
  const end = src.indexOf('\n              </span>', start)
  assert.ok(end > start, '没找到 .db-grid-total 的收尾')
  return src.slice(start, end)
}

// 批量动作组：从 U1d 注释到组的 `: null`（组内子块的 `: null` 缩进更深，不会被误截）
const batchGroup = () => {
  const src = read(SESSION)
  const start = src.indexOf('// U1d：勾选后的一族动作')
  assert.ok(start !== -1, '没找到批量动作组')
  const end = src.indexOf(': null\n        }', start)
  assert.ok(end > start, '没找到批量动作组的收尾')
  return src.slice(start, end)
}

const blockOf = (startMarker, endMarker) => {
  const src = read(SESSION)
  const start = src.indexOf(startMarker)
  assert.ok(start !== -1, startMarker + ' 未找到')
  const end = src.indexOf(endMarker, start)
  assert.ok(end > start, endMarker + ' 未找到')
  return src.slice(start, end)
}

describe('U1d 数据页状态行', () => {
  test('本页行数排在最前，且用 dbGridPageRows 词条 + {n} 占位', () => {
    const body = totalSpan()
    const at = body.indexOf("<span className='db-grid-page-rows'>{gridRowsText}</span>")
    assert.ok(at !== -1, '本页行数应在状态行里')
    assert.ok(at < body.indexOf('gridTotalText'), '本页行数应排在总数之前')
    assert.match(blockOf('const gridRowsText =', '\n  const gridTotalText'), /e\('dbGridPageRows'\)\.replace\('\{n\}', String\(grid\.rows\.length\)\)/)
  })

  test('总数三态：精确 > 估算 > 没有；只有"有总数"时才画分隔点', () => {
    const text = blockOf('const gridTotalText =', '\n  const dataArea')
    assert.match(text, /exactRows\.value !== null/)
    assert.match(text, /e\('dbExactRows'\)/)
    assert.match(text, /typeof grid\.totalRows === 'number'/)
    assert.match(text, /e\('approxRows'\)/)
    assert.match(text, /: ''/, '两个口径都没有时应返回空串')
    const body = totalSpan()
    assert.match(body, /gridTotalText\s*\?\s*<span className='db-grid-dot'>·<\/span>\s*:\s*null/, '空总数不该带一个孤立的点')
    assert.match(body, /gridTotalText \? <span>\{gridTotalText\}<\/span> : null/)
  })

  test('精确态保留 exact 标记，估算态保留"精确"入口', () => {
    const body = totalSpan()
    assert.match(body, /<Tag className='db-exact-tag'>\{e\('dbExactTag'\)\}<\/Tag>/)
    assert.match(body, /exactRows\.value === null[\s\S]*?<Button[\s\S]*?className='db-exact-btn'[\s\S]*?\{e\('dbExact'\)\}/)
  })

  test('状态行常量在 dataArea 之前定义，口径判定不重复', () => {
    const src = read(SESSION)
    const at = src.indexOf('const gridRowsText =')
    assert.ok(at !== -1 && at < src.indexOf('const dataArea = ('), 'gridRowsText 应在 dataArea 之前')
    const body = totalSpan()
    assert.equal((body.match(/typeof grid\.totalRows/g) || []).length, 0, '估算口径应留在常量里，只判一次')
    assert.equal((body.match(/exactRows\.value === null/g) || []).length, 2, '精确/估算分支与"精确"入口各判一次')
  })
})

describe('U1d 批量动作分组', () => {
  test('勾选后四个动作 + 选中计数收进一个 .db-tool-group', () => {
    const body = batchGroup()
    assert.equal((body.match(/<span className='db-tool-group'>/g) || []).length, 1)
    for (const k of ['dbInvertSelection', 'dbDeleteRows', 'dbBulkEdit', 'dbReplace']) {
      assert.ok(body.includes("e('" + k + "'"), k + ' 应在组内')
    }
  })

  test('门控只写一次（提到组首），组内不再各带一份', () => {
    const body = batchGroup()
    assert.match(body, /\n {10}sel && !isReadonly && pkColumn && grid\.rows\.length/, '门控应在组首')
    assert.equal((body.match(/sel && !isReadonly && pkColumn/g) || []).length, 1, '四段不再各写一遍门控')
  })

  test('选中计数只在有勾选时出现，文案走 dbGridSelectedRows 的 {n}', () => {
    const body = batchGroup()
    assert.match(body, /selectedRowKeys\.length\s*\n\s*\?\s*\n?\s*\(?\s*<span className='db-grid-selected'>/)
    assert.match(body, /e\('dbGridSelectedRows'\)\.replace\('\{n\}', String\(selectedRowKeys\.length\)\)/)
    // 按钮后缀保留：破坏性动作在按下处还能看到自己的范围
    assert.match(body, /\{e\('dbDeleteRows'\)\}\{selectedRowKeys\.length \? `\(\$\{selectedRowKeys\.length\}\)` : ''\}/)
  })

  test('组仍挂在数据页控制条里，位置在翻页组之前', () => {
    const src = read(SESSION)
    const group = src.indexOf("<span className='db-tool-group'>")
    const pager = src.indexOf("<span className='db-grid-head-pager'>")
    assert.ok(group !== -1 && pager > group, '批量组应在翻页组之前')
    const headStart = src.indexOf("<div className='db-grid-head'>")
    assert.ok(group > headStart, '批量组应在控制条内')
  })
})

describe('U1d 样式与文案契约', () => {
  test('本页行数用主文本色、选中计数用主色、数字等宽', () => {
    const styl = read(STYL)
    assert.match(styl, /\.db-grid-total\n[\s\S]*?font-variant-numeric tabular-nums/)
    assert.match(styl, /\.db-grid-page-rows\n {2}color var\(--text\)/)
    assert.match(styl, /\.db-grid-selected\n {2}color var\(--primary\)/)
    assert.match(styl, /\.db-grid-dot\n {2}opacity/)
  })

  test('新词条 en/zh_cn 两区同步且都带 {n}', () => {
    const loc = read(LOCALES)
    for (const k of ['dbGridPageRows', 'dbGridSelectedRows']) {
      const all = loc.match(new RegExp('\\b' + k + ": '([^']*)'", 'g')) || []
      assert.equal(all.length, 2, k + ' 必须同时存在于 en 与 zh_cn')
      for (const one of all) {
        assert.ok(one.includes('{n}'), k + ' 需要 {n} 占位：' + one)
      }
    }
  })
})
