// #4539 终端主题 background 落地：画的那层和"可见底色"必须是同一个答案
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const TERMINAL = path.join(ROOT, 'src/client/components/terminal/terminal.jsx')
const MIXIN = path.join(ROOT, 'src/client/components/terminal/mixins/term-theme.js')

const load = p => fs.readFileSync(p, 'utf8')

describe('#4539 主题 background 成为可见底色', () => {
  test('.term-wrap 用背景色长写画主题色，不覆盖 terminal.styl 的氛围光层', () => {
    const src = load(TERMINAL)
    const m = src.match(/const prps1 = \{[\s\S]*?\n {4}\}/)
    assert.ok(m, 'prps1 存在')
    assert.ok(
      m[0].includes('backgroundColor: this.getTerminalBackgroundOverride() || undefined'),
      '容器底色取主题 background'
    )
    assert.ok(!m[0].includes('background:'), '只能写 backgroundColor 长写：shorthand 会抹掉 radial-gradient 氛围光')
    assert.ok(!m[0].includes('var(--main)'), '内联不再钉 --main')
  })

  test('画的那层与 getVisibleTerminalBackground 共用同一个 override', () => {
    const mixin = load(MIXIN)
    const override = mixin.match(/getTerminalBackgroundOverride \(\) \{[\s\S]*?\n {2}\}/)
    assert.ok(override, 'override 取值口存在')
    assert.ok(override[0].includes('resolveThemeBackgroundOverride('), '语义收敛到纯函数')
    assert.ok(override[0].includes('this.hasTerminalBackgroundImage()'), '背景图让位')

    const visible = mixin.match(/getVisibleTerminalBackground \(\) \{[\s\S]*?\n {2}\}/)
    assert.ok(visible, '可见底色取值口存在')
    const body = visible[0]
    const atOverride = body.indexOf('getTerminalBackgroundOverride()')
    const atStore = body.indexOf('getUiThemeConfig')
    assert.ok(atOverride >= 0, '先问 override')
    assert.ok(atStore > atOverride, '--main 只在没有 override 时兜底')
  })

  test('背景图判定认 tab 级优先、且 none 算显式关闭', () => {
    const mixin = load(MIXIN)
    const has = mixin.match(/hasTerminalBackgroundImage \(\) \{[\s\S]*?\n {2}\}/)
    assert.ok(has, '背景图判定存在')
    assert.ok(has[0].includes('this.props.tab'), '先看 tab 级背景')
    assert.ok(has[0].includes('this.props.config'), '再看全局设置')
    assert.ok(has[0].includes("!== 'none'"), "'none' 是显式关闭，不该压住主题色")
  })

  test('OSC 11 在问的当下取可见底色，不是注册时快照', () => {
    const mixin = load(MIXIN)
    const osc = mixin.match(/registerTerminalColorQueryHandlers \(term, themeConfig = \{\}\) \{[\s\S]*?\n {2}\}/)
    assert.ok(osc, 'OSC 处理器注册存在')
    assert.match(
      osc[0],
      /registerOscHandler\(11,[\s\S]*?this\.getVisibleTerminalBackground\(\)/,
      'OSC 11 回可见底色（且是查询时求值）'
    )
    assert.ok(
      !/const background = this\.getVisibleTerminalBackground\(\)/.test(osc[0]),
      '不得在注册时快照：背景图设置变化不会重新注册处理器'
    )

    const renderer = mixin.match(/getRendererThemeConfig \([\s\S]*?\n {2}\}/)
    assert.ok(renderer, '渲染层主题构造存在')
    assert.ok(renderer[0].includes('this.getVisibleTerminalBackground()'), 'webGL 清屏色同源（#4407 DOM/WebGL 对齐）')
    assert.ok(renderer[0].includes('rendererType'), '渲染层主题带 rendererType 实判（DOM/WebGL 两套底色）')

    const selection = mixin.match(/fixSelectionColors \(term\) \{[\s\S]*?\n {2}\}/)
    assert.ok(selection, '选中色修正存在')
    assert.ok(selection[0].includes('this.getVisibleTerminalBackground()'), '选中色混合在同一条色上')
  })
})
