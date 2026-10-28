// 多结果集高度链路契约测试
//
// 背景（真实缺陷）：多语句执行后结果区只剩 Tab 头和右上角下载按钮，表格整块不可见。
// 根因是 flex 传递断在 Tabs 的 pane 上——pane 是 display block，
// `.db-sql-result-one` 的 flex:1 1 0 在非 flex 父级里完全不生效，高度退化为内容高，
// 而内层 `.db-grid-table-wrap`（flex 1 1 0 + overflow hidden）在 auto 高度父级下主尺寸塌成 0。
// 用 Electron + 真实 antd 实测：pane 354px 时 wrap 为 0；补 height 100% 后 wrap 326px。
//
// node 单测没有布局引擎，无法断言"高度不为 0"，所以这里锁住会产生该结果的三条规则，
// 以及那条被否决的错误方案（给 pane 加 display flex 会覆盖 antd 的隐藏规则）。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '../../..')
const STYL = path.join(ROOT, 'src/client/components/database/db-session.styl')
const SESSION = path.join(ROOT, 'src/client/components/database/db-session.jsx')

const read = p => fs.readFileSync(p, 'utf8')

// 取出某个选择器的规则体（stylus 缩进块）：从选择器行到下一个同级选择器/空行为止
function ruleBody (src, selector) {
  const lines = src.split('\n')
  const start = lines.findIndex(l => l.trim() === selector)
  assert.notEqual(start, -1, `样式里找不到选择器 ${selector}`)
  const out = []
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]
    if (!l.trim()) {
      break
    }
    if (!/^\s{2}/.test(l)) {
      break
    }
    out.push(l.trim())
  }
  return out.join('\n')
}

describe('多结果集：flex 传高链路', () => {
  test('pane 是 block 容器，.db-sql-result-one 必须自带 height 100%', () => {
    const body = ruleBody(read(STYL), '.db-sql-result-one')
    assert.match(body, /^height 100%$/m, '缺少 height 100%，多结果集表格会塌成 0 高')
  })

  test('单结果集路径仍靠 flex 撑满（父级是 .db-sql-result）', () => {
    const body = ruleBody(read(STYL), '.db-sql-result-one')
    assert.match(body, /^flex 1 1 0$/m)
    assert.match(body, /^min-height 0$/m)
  })

  test('内层网格容器保持 overflow hidden + flex 撑满（塌陷后不可见的直接原因）', () => {
    const body = ruleBody(read(STYL), '.db-grid-table-wrap')
    assert.match(body, /^flex 1 1 0$/m)
    assert.match(body, /^overflow hidden$/m)
  })

  test('不允许给 .ant-tabs-content 自身加 display（会覆盖 antd 的隐藏规则）', () => {
    const lines = read(STYL).split('\n')
    const hits = []
    lines.forEach((l, i) => {
      // 选择器行以 .ant-tabs-content 结尾（不含父级链上的 body/holder）
      if (/\.ant-tabs-content$/.test(l.trim())) {
        for (let j = i + 1; j < lines.length && /^\s{2}/.test(lines[j]); j++) {
          if (/^\s*display\b/.test(lines[j])) {
            hits.push(l.trim())
          }
        }
      }
    })
    assert.equal(hits.length, 0, '给 pane 写 display 会让非激活 tab 也显示出来: ' + hits.join(', '))
  })

  test('Tabs 撑满链路四层仍在（nav / body-holder / body / content）', () => {
    const src = read(STYL)
    for (const sel of ['> .ant-tabs-nav', '> .ant-tabs-body-holder', '> .ant-tabs-body', '> .ant-tabs-content']) {
      assert.ok(src.includes(sel), `撑满链路缺少 ${sel}`)
    }
  })
})

describe('多结果集：渲染分支', () => {
  test('单结果集不套 Tabs，多结果集才用 Tabs 分栏', () => {
    const src = read(SESSION)
    assert.match(src, /if \(results\.length === 1\) \{\s*\n\s*return renderOne\(results\[0\], 0\)/)
    assert.match(src, /db-sql-results-tabs/)
  })

  test('下载按钮只在有行时渲染（现象判据：能看到按钮就说明数据回来了）', () => {
    const src = read(SESSION)
    // 分页后判断依据从 (r.rows || []).length 改为局部 rows，语义不变
    assert.match(src, /const rows = r\.rows \|\| \[\]/)
    assert.match(src, /^\s*rows\.length$/m)
  })
})
