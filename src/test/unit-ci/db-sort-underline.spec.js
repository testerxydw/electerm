// U2d 排序列主色下划线契约：线由 :has() 从箭头反推，不新增状态类
//
// 实测（self-test/db-sort-underline-demo.js，深/浅各一轮）：
//   · computed boxShadow = "rgb(0, 136, 204) 0px -2px 0px 0px inset"，与 --primary 解析值同色
//   · 线 vs 表头实际底色：深色 4.46:1、浅色 3.24:1 —— 非文本指示物门槛 3:1（正文才是 4.5:1）
//   · 未排序列 boxShadow = none；取消排序后线立即消失
// 这里钉住三件事：线挂在 :has(.db-col-sort-active) 上（排序态唯一的 DOM 标记）、
// 用 inset（别把邻列/滚动区糊出一道线）、颜色吃 token（换主题要跟着走）。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

const STYL = 'src/client/components/database/db-session.styl'
const HEAD = 'src/client/components/database/db-col-resize.jsx'

const codeOf = src => src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')

describe('U2d 排序列下划线契约', () => {
  const styl = codeOf(read(STYL))
  const rule = /\.db-grid-table\n {2}th\.ant-table-cell:has\(\.db-col-sort-active\)\n([\s\S]*?)\n\.\S/
  const hit = rule.exec(styl)

  test('下划线规则存在，且作用域限定在 .db-grid-table 的表头格', () => {
    assert.ok(hit, '未找到 .db-grid-table th.ant-table-cell:has(.db-col-sort-active) 规则')
  })

  test('用 :has() 反推整格，不额外引入"已排序"状态类', () => {
    assert.ok(styl.includes('th.ant-table-cell:has(.db-col-sort-active)'),
      '线的判据应当只有箭头那一个类名')
    // 箭头类是排序态唯一的 DOM 标记；再造一份 sorted 类就会有两套状态互相打脸
    assert.equal(styl.includes('db-col-head-sorted'), false, '不该再引入第二个排序状态类')
  })

  test('线是 inset 的主色 2px（贴在格底，不外溢到邻列）', () => {
    const body = hit[1]
    assert.match(body, /box-shadow inset 0 -2px 0 0 var\(--primary\)/)
    assert.equal(/inset 0 2px/.test(body), false, '偏移应为 -2px：贴在格底，不是画到下一行')
  })

  test('写法在 css-radius-shadow 的"功能指示条"白名单里（不绕开阴影 token 契约）', () => {
    const contract = read('src/test/unit-ci/css-radius-shadow.spec.js')
    assert.ok(contract.includes('/^inset 0 -?2px 0 0 var\\(--primary\\)$/'),
      '契约里的"功能指示条"原子形变了，这边要同步')
  })

  test('颜色吃 --primary，不写死色值（换主题要跟着走）', () => {
    assert.equal(/#[0-9a-f]{3,8}/i.test(hit[1]), false, '下划线不该写死十六进制色值')
    assert.equal(/rgba?\(/.test(hit[1]), false, '下划线不该写死 rgb()')
  })

  test('线与箭头同色：箭头 .db-col-sort-active 也用 --primary', () => {
    const at = styl.indexOf('\n.db-col-sort-active\n')
    assert.notEqual(at, -1, '.db-col-sort-active 规则未找到')
    assert.match(styl.slice(at, at + 90), /color var\(--primary\)/)
  })

  test('只作用于表头：规则里不带 tbody，别把线画到数据行上', () => {
    assert.equal(/tbody/.test(hit[1]), false)
    assert.equal(hit[0].includes('.ant-table-row'), false)
  })

  test('JSX 契约：箭头类只在真的有排序时挂上（取消排序 → 线跟着消失）', () => {
    const jsx = read(HEAD)
    assert.match(jsx, /className=\{'db-col-sort' \+ \(sort \? ' db-col-sort-active' : ''\)\}/)
  })
})
