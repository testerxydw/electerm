// H2 底部"行"页签契约测试
//
// 行详情在 SQL 结果里是 Modal（DbRowDetailModal），数据页放在底部页签里。
// 两边必须共用同一份渲染体（db-row-detail.jsx 的 DbRowDetail），否则折叠阈值、
// 二进制/JSON 呈现、逐字段复制会各写一套、慢慢走偏。
// 页签的字段集也必须与"复制整行"同源（rowColumnNames）：__rowKey 是网格辅助键，
// 漏进任何一边都会让用户看到/导出与表结构无关的一列。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '../../..')
const SESSION = path.join(ROOT, 'src/client/components/database/db-session.jsx')
const ROW_DETAIL = path.join(ROOT, 'src/client/components/database/db-row-detail.jsx')
const extra = require(path.join(ROOT, 'src/app/common/locales-extra.js'))

const read = p => fs.readFileSync(p, 'utf8')
// N11b-#22：rowColumnNames / colTypeByName 已迁到 use-db-grid-columns.jsx（已接线）
const readSession = () => read(path.join(ROOT, 'src/client/components/database/db-session.jsx')) + '\n' + read(path.join(ROOT, 'src/client/components/database/use-db-grid-columns.jsx'))

describe('H2 底部"行"页签', () => {
  test('复用 db-row-detail 的 DbRowDetail 本体（不另写一份字段列表）', () => {
    const src = readSession()
    assert.match(
      src,
      /import\s*\{\s*DbRowDetail,\s*DbRowDetailModal\s*\}\s*from\s*'\.\/db-row-detail'/,
      '数据页行页签必须 import DbRowDetail（与 SQL 结果 Modal 同一渲染体）'
    )
    assert.match(read(ROW_DETAIL), /export function DbRowDetail\b/)
  })

  test('页签三选：值 / 行 / 关联，关联按 showRefTab 条件挂载', () => {
    const src = readSession()
    const start = src.indexOf('const detailTabItems = [')
    assert.notEqual(start, -1, 'detailTabItems 未找到')
    const body = src.slice(start, src.indexOf('const emptyPaneEl', start))
    assert.match(body, /key: 'value'[\s\S]*?label: e\('dbTabValue'\)/)
    assert.match(body, /key: 'row'[\s\S]*?label: e\('dbTabRow'\)[\s\S]*?children: rowPaneEl/)
    assert.match(body, /if \(showRefTab\) \{[\s\S]*?key: 'refs'[\s\S]*?label: e\('dbTabRefs'\)/)
  })

  test('行页签字段序与类型表与网格同源（rowColumnNames / colTypeByName）', () => {
    const src = readSession()
    const start = src.indexOf('const rowPaneEl = selectedRow')
    assert.notEqual(start, -1, 'rowPaneEl 未找到')
    const body = src.slice(start, src.indexOf('const detailTabItems', start))
    assert.match(body, /columns=\{rowColumnNames\(selectedRow\)\}/)
    assert.match(body, /row=\{selectedRow\}/)
    assert.match(body, /types=\{colTypeByName\}/)
  })

  test('rowColumnNames 剔掉 __rowKey（不是数据列，只是网格定位键）', () => {
    const src = readSession()
    assert.match(
      src,
      /const rowColumnNames = \(row\) => visibleColumnNames\(\s*Object\.keys\(row \|\| \{\}\)\.filter\(k => k !== '__rowKey'\)/,
      'rowColumnNames 必须过滤 __rowKey，否则行详情/复制整行会多出一列内部下标'
    )
  })

  test('"行"页签有中英词条', () => {
    assert.equal(extra.en.dbTabRow, 'Row')
    assert.equal(extra.zh_cn.dbTabRow, '行')
  })
})
