// U1b 数据页控制条折行：翻页 + 页大小收成行尾一整组
//
// 这一行有十几个控件（表名/总数/过滤/汇总/列显隐/自适应/本地化/刷新/导出/导入/
// 事务/复制/新增/反选/删除/批量/替换 + 翻页/页大小）。900px 宽时横向溢出：
// 实测 scrollWidth 1143 > clientWidth 569，右侧按钮被裁、表名被压成 0 宽。
//
// 两条约束：
//   1) .db-grid-head 允许折行 —— 溢出变成多行，而不是把控件挤没
//   2) 翻页 + 页大小收进 .db-grid-head-pager 一整组 —— 折行时整组一起走，
//      不会出现"上一页 在第 1 行 / 下一页 掉到第 2 行"这种拆开的翻页条
//
// 宽度表现由 self-test 三档截图覆盖；这里钉结构与 CSS 契约。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

const SESSION = 'src/client/components/database/db-session.jsx'
const STYL = 'src/client/components/database/db-session.styl'

const codeOf = src => src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

// 数据页控制条：<div className='db-grid-head'> 到同级 </div>
const headBody = () => {
  const src = codeOf(read(SESSION))
  const start = src.indexOf("<div className='db-grid-head'>")
  assert.notEqual(start, -1, '.db-grid-head 未找到')
  const end = src.indexOf('\n      </div>', start)
  assert.ok(end > start, '.db-grid-head 的收尾 </div> 未找到')
  return src.slice(start, end)
}

describe('U1b 数据页控制条折行', () => {
  test('控制条允许折行：flex-wrap + row-gap（溢出变多行，不是裁掉）', () => {
    const styl = read(STYL)
    assert.match(styl, /\.db-grid-head\n\s+display flex\n\s+align-items center\n\s+flex-wrap wrap\n\s+gap 8px\n\s+row-gap 6px/)
  })

  test('翻页 + 页大小是行尾一个整组，宽屏贴右端', () => {
    const styl = read(STYL)
    assert.match(styl, /\.db-grid-head-pager\n\s+display inline-flex\n\s+align-items center\n\s+gap 6px\n\s+margin-left auto/)
  })

  test('翻页条与页大小选择器都在 .db-grid-head-pager 里（折行不拆组）', () => {
    const body = headBody()
    const start = body.indexOf("<span className='db-grid-head-pager'>")
    assert.notEqual(start, -1, '.db-grid-head-pager 未找到')
    const group = body.slice(start)
    assert.match(group, /<DbGridPager\b/)
    assert.match(group, /\{renderPageSizeSelect\(\)\}/)
    // 组内不再嵌套第二层：从开头到 </span> 之间只有这两块
    const end = group.indexOf('</span>')
    assert.ok(end > 0, '组收尾 </span> 未找到')
    const inner = group.slice(0, end)
    assert.equal((inner.match(/<DbGridPager\b/g) || []).length, 1)
    assert.equal((inner.match(/\{renderPageSizeSelect\(\)\}/g) || []).length, 1)
  })

  test('翻页组只在控制条里出现一次，且位于动作按钮之后（行尾）', () => {
    const body = headBody()
    assert.equal((body.match(/<DbGridPager\b/g) || []).length, 1, '控制条里翻页条只能有一处')
    assert.equal((body.match(/renderPageSizeSelect\(\)/g) || []).length, 1, '页大小选择器只能有一处')
    const pager = body.indexOf("<span className='db-grid-head-pager'>")
    const start = body.indexOf("<div className='db-grid-head'>")
    assert.ok(pager > start)
    // 批量按钮（删除/批量改值/查找替换）都应在翻页组之前
    for (const key of ['dbDeleteRows', 'dbBulkEdit', 'dbReplace']) {
      const at = body.indexOf("e('" + key + "')")
      assert.notEqual(at, -1, key + ' 未找到')
      assert.ok(at < pager, key + ' 应该在翻页组之前')
    }
  })

  test('翻页组挂在"选中表"分支上（无表时不渲染空壳）', () => {
    const body = headBody()
    const pager = body.indexOf("<span className='db-grid-head-pager'>")
    const before = body.slice(Math.max(0, pager - 80), pager)
    assert.match(before, /\bsel\s*\?\s*\(\s*$/)
  })

  test('翻页组保留原有能力：上一页/下一页禁用态与跳页', () => {
    const body = headBody()
    const group = body.slice(body.indexOf("<span className='db-grid-head-pager'>"))
    assert.match(group, /prevDisabled=\{grid\.page <= 1 \|\| grid\.loading\}/)
    assert.match(group, /nextDisabled=\{!grid\.hasMore \|\| grid\.loading\}/)
    assert.match(group, /onPressEnter: goPage/)
    assert.match(group, /onGo=\{goPage\}/)
  })
})
