// 值/关联双页签高度链契约测试
//
// 背景（真实缺陷）：F1 把 DbValuePane 包进 antd Tabs 后，MySQL 单元格预览只读态看着正常，
// 一点「编辑」整块塌成 0 高。根因：
//   1) F1 写的 .ant-tabs-content-holder 是 antd5 的类名，当前 antd6 的层级是
//      body-holder > body > content —— 那条规则完全没生效，撑满链断掉；
//   2) 于是 .db-value-pane 退化为「内容高」：只读态 <pre> 自带内容高看不出问题，
//      进编辑态后 textarea（flex 1 1 0 + min-height 0）在 auto 高度父级下塌成 0。
// 同源缺陷参考 db-sql-results-layout.spec.js（多结果集整块不可见）。
// node 单测没有布局引擎，这里锁住会产生该结果的关键规则。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '../../..')
const STYL = path.join(ROOT, 'src/client/components/database/db-session.styl')

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

describe('值/关联双页签：flex 传高链路', () => {
  test('.db-pane-tabs 不得再使用 antd5 的 .ant-tabs-content-holder（写了也不生效）', () => {
    const selectors = read(STYL).split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('//'))
      .filter(l => /(^|[\s>])\.ant-tabs-content-holder$/.test(l))
    assert.deepEqual(
      selectors,
      [],
      'antd6 已无 .ant-tabs-content-holder 类名，必须改成 body-holder > body > content'
    )
  })

  test('Tabs 撑满链路四层齐全（nav / body-holder / body / content）', () => {
    const src = read(STYL)
    for (const sel of ['> .ant-tabs-nav', '> .ant-tabs-body-holder', '> .ant-tabs-body', '> .ant-tabs-content']) {
      assert.ok(src.includes(sel), `撑满链路缺少 ${sel}`)
    }
  })

  test('holder / body / content 均给出确定高度（body 负责滚动）', () => {
    const src = read(STYL)
    const start = src.indexOf('.db-pane-tabs')
    assert.notEqual(start, -1)
    const body = src.slice(start, src.indexOf('.db-refs-pane', start))
    assert.match(body, /body-holder\s*\n\s*flex 1 1 0\n\s*min-height 0\n\s*overflow hidden/)
    assert.match(body, /ant-tabs-body\s*\n\s*height 100%\n\s*overflow auto/)
    assert.match(body, /ant-tabs-content\s*\n\s*height 100%/)
  })

  test('.db-value-pane 自带 height 100%（父级是 antd pane / .db-redis-detail，都不是 flex 容器）', () => {
    const body = ruleBody(read(STYL), '.db-value-pane')
    assert.match(body, /^height 100%$/m, '缺少 height 100%，编辑态 textarea 会塌成 0 高')
    assert.match(body, /^flex 1 1 0$/m)
    assert.match(body, /^min-height 0$/m)
  })

  test('编辑态 textarea 仍靠 flex 撑满', () => {
    const body = ruleBody(read(STYL), '.db-value-pane-text')
    assert.match(body, /^flex 1 1 0$/m)
    assert.match(body, /^min-height 0$/m)
  })

  test('textarea 宽度必须 auto（antd 的 width 100% + 左右 margin 会横向溢出、挤出滚动条）', () => {
    const body = ruleBody(read(STYL), '.db-value-pane-text')
    assert.match(body, /^width auto$/m)
  })
})
