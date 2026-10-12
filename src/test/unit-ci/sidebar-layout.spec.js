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
    // 顶栏已还原 master 式：.sidebar 从窗口顶开始，不得再引入 title-bar 偏移
    assert.match(m[1], /top\s+0/, 'top 应为 0（无独立顶栏）')
    assert.doesNotMatch(m[1], /--title-bar-height/, '不得引用已退役的 --title-bar-height')
    // 图标栏直通窗口底部（bottom 0，footer 已常驻让位图标栏宽度）；
    // 不得回退为 bottom var(--footer-stack-height)（会让头像悬空被截断）
    assert.match(m[1], /bottom\s+0/, 'bottom 应为 0（图标栏直通底部）')
    assert.doesNotMatch(m[1], /bottom\s+var\(--footer-stack-height/, '不得恢复 bottom 底栏避让（头像会悬空截断）')
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
