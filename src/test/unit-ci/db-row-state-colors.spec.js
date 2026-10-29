// U2a 数据网格行交互态 token 化：悬停/选中底色必须吃 --hover-bg / --active-bg
//
// 为什么要单独钉：antd 的行底色来自它内部 colorPrimary 的派生（实测深色下
// hover = rgb(27,46,63)、选中 = rgb(14,55,75)），换主题时不跟着我们的 token 走。
// 覆盖它有三条只有实机才会踩到的坑，写错任一条都是"规则在、样式没生效"：
//   1) 虚拟表体（DbGridTable 在 scroll.y > 0 时开）里行与格都是 div，
//      用 `td` 的选择器整条落空——Redis 键列表的选中态就这么丢过一次。
//   2) tbody 与行之间还夹着 .ant-table-tbody-virtual-holder(-inner) 两层 div，
//      所以 tbody → row 只能用后代选择器，写 `>` 同样整条落空。
//   3) antd 选中态那条选择器有 5 个类、悬停那条有 4 个类。打平只能靠样式表先后，
//      而 antd 的 CSS-in-JS 是运行时注入的、先后不保证，所以我们的每条选择器都要
//      严格多于它（把 .db-grid-table .ant-table .ant-table-tbody 链路写全，
//      选中态再补 row + row-selected 两个类）。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

const STYL = 'src/client/components/database/db-session.styl'
const TOKENS = 'src/client/css/includes/tokens.styl'

// 去掉注释行：这一组规则上面写了 10 行"为什么"，断言只看真正生效的选择器与声明
const codeOf = src => src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')

// .db-grid-table 下的行交互态那一段（到下一条顶层规则 .db-cell-null 之前）
const stateBlock = () => {
  const src = codeOf(read(STYL))
  const start = src.indexOf('.db-grid-table\n  .ant-table .ant-table-tbody')
  assert.notEqual(start, -1, '.db-grid-table 下的行交互态规则未找到')
  const end = src.indexOf('\n.db-cell-null', start)
  assert.ok(end > start, '行交互态规则的收尾未找到')
  return src.slice(start, end)
}

// stylus 嵌套里的类不会自己带上外层 .db-grid-table，算优先级要手工补回去
const classesOf = sel => (('.db-grid-table ' + sel.replace(/,$/, '')).match(/\.[\w-]+|:hover/g) || []).length

describe('U2a 数据网格行交互态 token 化', () => {
  test('悬停态吃 --hover-bg、选中态吃 --active-bg（不再留 antd 派生色）', () => {
    const block = stateBlock()
    assert.match(block, /\.ant-table-row:hover > \.ant-table-cell\n\s+background var\(--hover-bg\)/)
    assert.match(block, /\.ant-table-row-selected:hover > \.ant-table-cell\n\s+background var\(--active-bg\)/)
    assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b/, '这一段不该再出现色值字面量')
    assert.doesNotMatch(block, /rgba?\(/, '这一段不该再出现 rgb() 字面量')
  })

  test('单元格写 .ant-table-cell 而不是 td（虚拟表体里行与格都是 div）', () => {
    const block = stateBlock()
    assert.equal(block.includes('td'), false, 'td 选择器在虚拟表体下整条落空')
    assert.ok(block.includes('.ant-table-cell'))
  })

  test('tbody → 行用后代选择器：虚拟表体中间夹着 holder/holder-inner 两层 div', () => {
    const block = stateBlock()
    assert.match(block, /\.ant-table-tbody \.ant-table-row/)
    assert.equal((block.match(/\.ant-table-tbody > \.ant-table-row/g) || []).length, 0,
      '.ant-table-tbody > .ant-table-row 在虚拟表体下匹配不到任何元素')
    // 行 → 格仍然是子选择器：格子确实直接挂在行下面
    assert.ok(block.includes('.ant-table-row:hover > .ant-table-cell'))
  })

  test('每条选择器的类数都严格多于 antd 对应规则（不靠样式表先后取胜）', () => {
    // antd 实测：悬停 4 类（wrapper/tbody/row/cell-row-hover）、选中 5 类（再多一个 row-selected）
    const antd = { hover: 4, selected: 5 }
    const block = stateBlock()
    const sels = block.split('\n').flatMap(l => l.trim().replace(/,$/, '').split(',').filter(s => s.startsWith('.ant-table')))
    assert.equal(sels.length, 4, '过渡/悬停/选中/选中+悬停共 4 条选择器，实际 ' + sels.length)
    for (const sel of sels) {
      const mine = classesOf(sel)
      const need = sel.includes('ant-table-row-selected') ? antd.selected : antd.hover
      assert.ok(mine > need, sel.trim() + ' 只有 ' + mine + ' 个类，压不过 antd 的 ' + need)
    }
  })

  test('选中 + 悬停仍是 --active-bg（勾中的行划过不闪色）', () => {
    const block = stateBlock()
    assert.match(block, /\.ant-table-row\.ant-table-row-selected > \.ant-table-cell,/)
    const active = (block.match(/background var\(--active-bg\)/g) || []).length
    assert.equal(active, 1, '选中底色只声明一次，两条选择器共用一条声明')
  })

  test('底色过渡用时长/缓动 token，不写裸毫秒', () => {
    const block = stateBlock()
    assert.match(block, /transition background var\(--dur-1\) var\(--ease\)/)
  })

  test('整段限定在 .db-grid-table 作用域内（不动别的 antd 表格）', () => {
    const block = stateBlock()
    assert.ok(block.startsWith('.db-grid-table\n'))
    const top = block.split('\n').filter(l => /^[.\w]/.test(l))
    assert.deepEqual(top, ['.db-grid-table'], '除了 .db-grid-table 不该有别的顶层选择器')
  })

  test('Redis 键列表"当前键"高亮：td 与 .ant-table-cell 两种渲染都覆盖', () => {
    const src = codeOf(read(STYL))
    const at = src.indexOf('.db-row-selected td,')
    assert.notEqual(at, -1, '.db-row-selected 的多选择器写法未找到')
    const rule = src.slice(at, src.indexOf('\n\n', at))
    assert.ok(rule.includes('.db-row-selected .ant-table-cell'))
    assert.match(rule, /background var\(--active-bg\)/)
  })

  test('两个 token 本身由主题派生（换主题时网格交互态自动跟着走）', () => {
    const src = read(TOKENS)
    assert.match(src, /--hover-bg unquote\('color-mix\(in srgb, var\(--text\) \d+%, transparent\)'\)/)
    assert.match(src, /--active-bg unquote\('color-mix\(in srgb, var\(--primary\) \d+%, transparent\)'\)/)
  })
})
