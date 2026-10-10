// sidebar 布局守卫：.sidebar 高度只能由 CSS（top+bottom）决定，
// 禁止 JS 内联 height —— 绝对定位下 top+height 会顶掉 bottom，
// 导致底边多出标题栏高度（左下角露缝，2026-10-10 修复的静默失效）
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '../../client/components/sidebar')
const jsx = fs.readFileSync(path.join(root, 'index.jsx'), 'utf8')
const styl = fs.readFileSync(path.join(root, 'sidebar.styl'), 'utf8')

// sidebarProps 的 style 对象片段：width 后直接收尾，无 height 键
const INLINE_HEIGHT = /sidebarProps\s*=\s*\{[\s\S]{0,300}?height\s*:/

describe('sidebar-layout: 高度只由 CSS top+bottom 决定', () => {
  it('sidebar/index.jsx 不得给 .sidebar 设置内联 height', () => {
    assert.doesNotMatch(jsx, INLINE_HEIGHT,
      'sidebarProps 出现内联 height（会顶掉 CSS bottom，底边多出标题栏高度）')
  })

  it('sidebar.styl 的 .sidebar 必须同时有 top 与 bottom 定位', () => {
    const m = styl.match(/\.sidebar\n([\s\S]*?)\n\.sidebar-pin-top/)
    assert.ok(m, 'sidebar.styl 中未找到 .sidebar 规则块')
    assert.match(m[1], /top\s+var\(--title-bar-height/, '缺 top 定位')
    assert.match(m[1], /bottom\s+var\(--footer-stack-height/, '缺 bottom 避让')
  })

  it('反向验证：守卫正则能捕获内联 height 回归', () => {
    const fake = `const sidebarProps = {
  className: 'sidebar',
  style: {
    width: leftSideBarWidth,
    height: height - bottomStack
  }
}`
    assert.match(fake, INLINE_HEIGHT, '守卫正则失效，无法拦截回归')
  })
})
