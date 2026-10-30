const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const TERMINAL = path.join(ROOT, 'src/client/components/terminal/terminal.jsx')
const TERM_RESIZE = path.join(ROOT, 'src/client/components/terminal/mixins/term-resize.js')
const TERM_INIT = path.join(ROOT, 'src/client/components/terminal/mixins/term-init.js')
const SESSION = path.join(ROOT, 'src/client/components/session/session.jsx')
const SESSIONS = path.join(ROOT, 'src/client/components/session/sessions.jsx')
const SESSION_STYL = path.join(ROOT, 'src/client/components/session/session.styl')

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
    assert.match(m[0], /if \(!this\.isElementVisible\(\)\) \{\s*return/, '不可见直接返回，不得 fit 0 列')
  })
})

describe('T4-b: 终端内容区改由 flex 铺满', () => {
  test('terminal.jsx：.term-wrap 用 inset 0，不再接收布局宽高', () => {
    const src = load(TERMINAL)
    const m = src.match(/const prps1 = \{[\s\S]*?\n {4}\}/)
    assert.ok(m, 'prps1 存在')
    for (const side of ['left: 0', 'top: 0', 'right: 0', 'bottom: 0']) {
      assert.ok(m[0].includes(side), '.term-wrap 缺 ' + side)
    }
    assert.ok(!/\bheight,\s*\n?\s*width,\s*\n?\s*left,\s*\n?\s*top,\s*\n?\s*zIndex/.test(m[0]), '仍按 props 铺尺寸')
    assert.ok(!src.includes('const { height, width, left, top, fullscreen }'), '仍读布局宽高 props')
    assert.ok(!src.includes("'height',\n      'width'"), 'componentDidUpdate 仍按 props 尺寸 fit')
  })

  test('sessions.jsx / session.jsx：computeHeight 与内联 px 链删除', () => {
    for (const p of [SESSIONS, SESSION]) {
      const src = load(p)
      assert.ok(!src.includes('computeHeight'), path.basename(p) + ' 仍有 computeHeight')
      assert.ok(!src.includes('calcTermWidthHeight'), path.basename(p) + ' 仍有 calcTermWidthHeight')
    }
    const src = load(SESSION)
    assert.ok(!src.includes('this.props.width + \'px\''), 'Splitter 内联宽残留')
    assert.ok(!/style=\{\{\s*width,\s*height\s*\}\}/.test(src), '.terms-box 内联宽高残留')
    assert.ok(!src.includes('computePosition'), '死代码 computePosition 残留')
  })

  test('分栏比例用实测分母（反向：布局 props / computeHeight 回潮）', () => {
    const src = load(SESSION)
    const m = src.match(/onSplitResize = \(sizes\) => \{[\s\S]*?\n {2}\}/)
    assert.ok(m, 'onSplitResize 存在')
    assert.ok(m[0].includes('clientWidth') && m[0].includes('clientHeight'), '按 splitter 实测宽高')
    assert.ok(!m[0].includes('computeHeight'), '仍用 computeHeight 当分母')
  })

  test('.terms-box 有实际尺寸：非分栏吃满、分栏由面板给高（反向：回到 JS px）', () => {
    const block = load(SESSION_STYL)
    assert.match(block, /\.term-sftp-box > \.terms-box\n\s*flex 1 1 0\n\s*min-height 0/, '非分栏 flex 1 1 0')
    assert.match(block, /\.term-sftp-box \.ant-splitter-panel > \.terms-box\n\s*height 100%/, '分栏面板给高')
  })

  test('字号缩放直接 fit（反向：靠 triggerResize 的 1px 间接触发）', () => {
    const src = load(TERM_RESIZE)
    const zoom = src.match(/zoom \(v\) \{[\s\S]*?\n {2}\}/)
    const reset = src.match(/handleResetFontSize \(\) \{[\s\S]*?\n {2}\}/)
    assert.ok(zoom && reset, 'zoom / handleResetFontSize 存在')
    assert.ok(zoom[0].includes('this.fitToContainer()'), 'zoom 未直接 fit')
    assert.ok(reset[0].includes('this.fitToContainer()'), 'reset 未直接 fit')
    assert.ok(!zoom[0].includes('triggerResize'), 'zoom 仍靠 triggerResize')
    assert.ok(!reset[0].includes('triggerResize'), 'reset 仍靠 triggerResize')
  })
})
