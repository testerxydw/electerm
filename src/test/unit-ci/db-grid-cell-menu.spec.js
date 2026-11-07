// H2 单元格右键菜单：浮层契约 + 数据页菜单项装配
//
// 两层：
//   1) 浮层 db-cell-menu.jsx —— 单例渲染、三条关闭通道（外部按下 / Esc / 滚动）、
//      点项后收起、关闭即卸载（DOM 里不留旧菜单）
//   2) 装配 openDataCellMenu —— 菜单项顺序与出现条件：复制值（二进制取 base64）/
//      字段名 / 整行 TSV / 整行 JSON / 查看完整值 / 编辑（可编辑时）/ 按值过滤
//      （格子文本非空白时）/ 外键跳转（可定位时）
//
// 全站只挂一份浮层、两页共用同一份 state —— 每格挂一个 Dropdown 在 1 万行结果
// 上会把渲染拖垮，这条也在这里钉住。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')
// N11b-#22：openDataCellMenu / rowColumnNames 已迁到 use-db-grid-columns.jsx（已接线）
const readSession = () => read(SESSION) + '\n' + read('src/client/components/database/use-db-grid-columns.jsx')

const MENU = 'src/client/components/database/db-cell-menu.jsx'
const SESSION = 'src/client/components/database/db-session.jsx'

const codeOf = src => src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

const dataMenuBody = () => {
  const src = codeOf(readSession())
  const start = src.indexOf('const openDataCellMenu =')
  assert.notEqual(start, -1, 'openDataCellMenu 未找到')
  // 函数体到同级缩进的收尾大括号为止（按下一个顶层 const 截会把 body 里的
  // const v / const headers 当成边界，只剩一行）
  const end = src.indexOf('\n  }\n', start)
  assert.ok(end > start, 'openDataCellMenu 的收尾大括号未找到')
  return src.slice(start, end)
}

describe('H2 单元格右键菜单：浮层契约', () => {
  test('不受控的 antd Dropdown，而是 trigger=[] 的受控 Popover', () => {
    const src = codeOf(read(MENU))
    assert.match(src, /<Popover/)
    assert.match(src, /open=\{!!target\}/)
    assert.match(src, /trigger=\{\[\]\}/)
    assert.match(src, /destroyOnHidden/, '关闭即卸载，才能在实测里按"菜单在不在 DOM"判读')
  })

  test('三条关闭通道：外部 pointerdown（捕获）/ Escape / 滚动', () => {
    const src = codeOf(read(MENU))
    assert.match(src, /addEventListener\('pointerdown', onDown, true\)/)
    assert.match(src, /addEventListener\('keydown', onKey\)/)
    assert.match(src, /ev\.key === 'Escape'[\s\S]{0,40}onHide\(\)/)
    assert.match(src, /addEventListener\('scroll', onHide, true\)/)
    assert.match(src, /removeEventListener\('pointerdown', onDown, true\)/)
    assert.match(src, /removeEventListener\('keydown', onKey\)/)
    assert.match(src, /removeEventListener\('scroll', onHide, true\)/)
  })

  test('点项先执行动作再收起（动作里读不到浮层状态也能跑）', () => {
    const src = codeOf(read(MENU))
    assert.match(src, /onClick=\{\(\) => \{\s*item\.onClick\(\)\s*onHide\(\)\s*\}\}/)
  })

  test('锚点 0×0 也会被判"不可见"：宽高由 CSS 给，坐标只写 left/top', () => {
    const src = codeOf(read(MENU))
    assert.match(src, /className='db-cell-menu-anchor'/)
    assert.match(src, /left: target \? target\.x : -1/)
    assert.match(src, /top: target \? target\.y : -1/)
    assert.match(src, /db-cell-menu-anchor/)
  })
})

describe('H2 单元格右键菜单：数据页装配', () => {
  test('全站单例：DbCellMenu 只挂一处，两页共用同一份 cellMenu state', () => {
    const src = codeOf(readSession())
    const mounts = src.match(/<DbCellMenu\b/g) || []
    assert.equal(mounts.length, 1, '右键菜单必须是全站单例')
    assert.equal((src.match(/setCellMenu\(/g) || []).length > 2, true, '两页都要能写这份 state')
  })

  test('菜单项顺序：复制族 → 完整值 → 编辑 → 过滤 → 外键', () => {
    const body = dataMenuBody()
    const order = ['dbCellCopyValue', 'dbCellCopyColName', 'dbCellCopyRowTsv',
      'dbCellCopyRowJson', 'dbCellValuePane', 'dbCellEdit', 'dbCellFilterByValue', 'dbCellOpenRef']
    let last = -1
    for (const key of order) {
      const at = body.indexOf("e('" + key + "')")
      assert.notEqual(at, -1, key + ' 没进菜单')
      assert.ok(at > last, key + ' 的顺序变了')
      last = at
    }
  })

  test('复制值：二进制信封复制 base64，其余复制格子文本', () => {
    const body = dataMenuBody()
    assert.match(body, /copy\(isBinEnvelope\(v\) \? v\.__bin\.b64 : cellText\(v\)\)/)
  })

  test('复制整行的列集与屏幕同源，且不带 __rowKey', () => {
    const body = dataMenuBody()
    assert.match(body, /const headers = rowColumnNames\(row\)/)
    assert.match(body, /toTsv\(headers, \[row\]\)/)
    assert.match(body, /buildCopyStatements\('json', \{ headers, rows: \[row\] \}\)/)
  })

  test('按值过滤只在格子文本非空白时出现，且写进本页过滤', () => {
    const body = dataMenuBody()
    assert.match(body, /const filterText = cellText\(v\)/)
    assert.match(body, /if \(filterText\.trim\(\)\) \{[\s\S]*?onClick: \(\) => setPageFilter\(filterText\)/)
  })

  test('编辑项只在可编辑时出现（只读/无主键时不给点了没用的项）', () => {
    const body = dataMenuBody()
    assert.match(body, /if \(canEditCell\) \{[\s\S]*?onClick: \(\) => startEdit\(row, k\)/)
  })

  test('外键项跳过不可定位的（NULL/二进制），只出本表外键这一向', () => {
    const body = dataMenuBody()
    assert.match(body, /if \(item\.unusable\) \{\s*continue\s*\}/)
    assert.match(body, /references: \[\]/)
    assert.match(body, /onClick: \(\) => openRefTable\(item\)/)
  })

  test('右键先 preventDefault（不弹系统菜单），无表/无行时直接返回', () => {
    const body = dataMenuBody()
    assert.match(body, /ev\.preventDefault\(\)/)
    assert.match(body, /if \(!sel \|\| !row\) \{\s*return\s*\}/)
  })
})
