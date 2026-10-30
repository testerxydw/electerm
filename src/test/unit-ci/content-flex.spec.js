const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const SESSION_STYL = path.join(ROOT, 'src/client/components/session/session.styl')
const FULLSCREEN_STYL = path.join(ROOT, 'src/client/components/main/term-fullscreen.styl')
const SESSION_JSX = path.join(ROOT, 'src/client/components/session/session.jsx')

// T3 内容区 flex 化（doc/TODO-顶栏高度与底栏避让统一-2026-10-30.md §3/§4）：
// .session-wrap 是竖向 flex 容器，页根 flex 1 1 0 + min-height 0，
// 内容高由浏览器分配；JS 扣减逐片删除。每项带反向断言。

const load = p => fs.readFileSync(p, 'utf8')

describe('T3a-1: .session-wrap 是竖向 flex 容器', () => {
  test('flex 列 + 子项 flex 1 1 0 / min-height 0', () => {
    const src = load(SESSION_STYL)
    assert.ok(src.includes('flex-direction column'), 'flex-direction column')
    assert.ok(/\.session-wrap[\s\S]*?>\s*\*[\s\S]*?flex 1 1 0[\s\S]*?min-height 0/.test(src), '页根 flex 1 1 0 + min-height 0')
  })

  test('批处理视图用 display flex（反向：display block 会让整块不参与 flex）', () => {
    const src = load(SESSION_STYL)
    assert.ok(/\.session-batch-active[\s\S]{0,40}display flex/.test(src), 'session-batch-active display flex')
    assert.ok(!/\.session-batch-active[\s\S]{0,40}display block/.test(src), 'display block 回退')
  })

  test('全屏只显示当前会话时同样是 flex（反向：display block !important）', () => {
    const src = load(FULLSCREEN_STYL)
    assert.ok(src.includes('display flex !important'), '全屏 session-wrap display flex')
    assert.ok(!src.includes('display block !important'), 'display block !important 回退')
  })
})

describe('T3a-2/3: DB / web 页不再自己算高', () => {
  test('DB 分支删除 H - tabsHeight 与内联 height', () => {
    const src = load(SESSION_JSX)
    const m = src.match(/if \(type === terminalDatabaseType\) \{[\s\S]*?\n {4}\}/)
    assert.ok(m, 'db 分支存在')
    assert.ok(!m[0].includes('this.props.height - this.props.tabsHeight'), 'DB 高度算术回退')
    assert.ok(!/style=\{\{ width, height \}\}/.test(m[0]), '内联 height 回退')
  })

  test('web 分支不再传 height（WebSession 不读它，尺寸走 CSS）', () => {
    const src = load(SESSION_JSX)
    const m = src.match(/if \(type === terminalWebType\) \{[\s\S]*?\n {4}\}/)
    assert.ok(m, 'web 分支存在')
    assert.ok(!m[0].includes('height: this.props.height'), 'web 仍传 height')
  })
})
