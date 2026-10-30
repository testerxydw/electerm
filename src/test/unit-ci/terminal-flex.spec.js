const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const TERMINAL = path.join(ROOT, 'src/client/components/terminal/terminal.jsx')
const TERM_RESIZE = path.join(ROOT, 'src/client/components/terminal/mixins/term-resize.js')
const TERM_INIT = path.join(ROOT, 'src/client/components/terminal/mixins/term-init.js')

// T4 终端内容区 flex 化（doc/TODO-顶栏高度与底栏避让统一-2026-10-30.md §5）：
// fit 的触发源从"布局 props 变化"换成"容器实测尺寸变化"，隐藏标签的
// isElementVisible 守卫必须原样保留。

const load = p => fs.readFileSync(p, 'utf8')

describe('T4-a: xterm fit 由容器实测尺寸驱动', () => {
  test('terminal.jsx 把 ResizeObserver 挂在 xterm 挂载点（反向：只靠 props 变化触发）', () => {
    const src = load(TERMINAL)
    assert.ok(src.includes('new ResizeObserver(this.onTermBoxResize)'), 'RO 指向 onTermBoxResize')
    assert.ok(src.includes('this.termBoxObserver.observe(el)'), '观察 .term-wrap-2')
    const m = src.match(/observeTermBox = \(\) => \{[\s\S]*?\n {2}\}/)
    assert.ok(m, 'observeTermBox 存在')
    assert.ok(m[0].includes('this.domRef.current'), '观察 xterm 挂载点 domRef')
  })

  test('RO 只在尺寸变化时 fit 一次，且走 fitAndRefresh（反向：直接 fitAddon.fit）', () => {
    const src = load(TERMINAL)
    const m = src.match(/onTermBoxResize = \(\) => \{[\s\S]*?\n {2}\}/)
    assert.ok(m, 'onTermBoxResize 存在')
    assert.ok(m[0].includes('clientWidth') && m[0].includes('clientHeight'), '取实测宽高')
    assert.match(m[0], /prev\.width === width && prev\.height === height/, '尺寸判等')
    assert.ok(m[0].includes('this.fitToContainer()'), '走 fitToContainer')
    const f = src.match(/fitToContainer = \(\) => \{[\s\S]*?\n {2}\}/)
    assert.ok(f, 'fitToContainer 存在')
    assert.ok(f[0].includes('proposeDimensions()'), '按拟议行列判等')
    assert.ok(f[0].includes('this.fitAndRefresh()'), '走 fitAndRefresh')
    assert.ok(!src.includes('this.fitAddon.fit()'), 'terminal.jsx 不得绕过守卫直接 fit')
  })

  test('单元格尺寸变化（字体/连字加载）补 fit（反向：只靠容器 RO）', () => {
    const src = load(TERM_INIT)
    assert.ok(src.includes('onDimensionsChange(this.fitToContainer)'), '订阅 onDimensionsChange')
  })

  test('隐藏标签不 fit：isElementVisible 守卫原样保留（反向：守卫被删）', () => {
    const src = load(TERM_RESIZE)
    const m = src.match(/fitAndRefresh \(\) \{[\s\S]*?\n {2}\}/)
    assert.ok(m, 'fitAndRefresh 存在')
    assert.ok(m[0].includes('isElementVisible()'), '可见性守卫')
    assert.match(m[0], /if \(!this\.isElementVisible\(\)\) \{\n\s*return/, '不可见直接返回，不得 fit 0 列')
  })
})
