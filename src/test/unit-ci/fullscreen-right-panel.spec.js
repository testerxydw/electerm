/**
 * 全屏布局守卫：右侧面板不得遮挡全屏会话。
 *
 * 回归背景：会话区全屏时被钉成 width 100% !important，而 .right-side-panel
 * 是 absolute 定宽覆盖层，面板展开时会压住远程桌面（VNC/RDP/SPICE）与
 * 终端内容。修复口径与左侧图标栏一致：全屏时隐藏右面板，并隐藏底栏里
 * 对应的打开入口，避免"点了没反应"。
 */
const assert = require('node:assert/strict')
const { it } = require('node:test')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const ROOT = join(__dirname, '../../')
const read = p => readFileSync(join(ROOT, p), 'utf8')

const fullscreenStyl = read('client/components/main/term-fullscreen.styl')

it('全屏隐藏右侧面板（与左侧图标栏同口径）', () => {
  // .fullscreen 的 hide 列表里必须包含 .right-side-panel
  assert.match(
    fullscreenStyl,
    /\.fullscreen\s*\n(?:[\s\S]*?\n)?\s*\.right-side-panel\s*\n\s*display none/,
    '全屏必须隐藏 .right-side-panel，否则定宽覆盖层会遮挡 100% 宽的会话区'
  )
  // 旧的"面板保留在全屏"定位规则若回归，会与 display none 相互矛盾
  assert.doesNotMatch(fullscreenStyl, /\.fullscreen:not\(\.fs-with-footer\)\s*\n\s*\.right-side-panel/)
})

it('终端全屏保留底栏时隐藏右面板入口', () => {
  for (const cls of [
    'terminal-footer-ai',
    'terminal-footer-transfer',
    'terminal-footer-monitor'
  ]) {
    assert.match(
      fullscreenStyl,
      new RegExp(`\\.${cls}\\s*\\n[\\s\\S]*?display none`),
      `${cls} 在全屏下必须隐藏：右面板不可见，入口点了也没有反馈`
    )
  }
  assert.match(
    fullscreenStyl,
    /\.terminal-footer-info:has\(\.terminal-info-icon\)\s*\n[\s\S]*?display none/,
    '终端日志入口（图表图标）同样隐藏，编码选择等其它单元不受影响'
  )
})
