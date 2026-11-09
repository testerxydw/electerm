/**
 * Modal.confirm 的 Esc 键盘路由契约。
 *
 * 背景：焦点常落在 xterm 的隐藏 TEXTAREA 上，它的既有 keydown 处理在 target
 * 阶段 stopPropagation，document 上注册在冒泡阶段的监听收不到 Escape，
 * confirm 按 Esc 不关（CDP 实机复现：capture 有日志、bubble 无日志）。
 * 修法是注册到 capture 阶段，注销时必须带同样的第三参数，否则监听器泄漏。
 *
 * 契约只锁源码事实；真实按键链路的回归由 self-test/modal-scroll-cdp-probe.js
 * 的「一级真按键即关闭」判据覆盖。
 */

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const SRC = fs.readFileSync(
  path.resolve(__dirname, '../../client/components/common/modal.jsx'),
  'utf8'
)

describe('Modal 的 keydown 必须注册在 capture 阶段', () => {
  it('add/remove 都带第三参数 true', () => {
    assert.match(SRC, /document\.addEventListener\('keydown', handleKeyDown, true\)/)
    assert.match(SRC, /document\.removeEventListener\('keydown', handleKeyDown, true\)/)
  })

  it('不允许退回冒泡阶段的两参数写法', () => {
    assert.doesNotMatch(SRC, /document\.addEventListener\('keydown', handleKeyDown\)/)
    assert.doesNotMatch(SRC, /document\.removeEventListener\('keydown', handleKeyDown\)/)
  })

  it('Escape 仍走 onCancel 并阻止默认行为', () => {
    assert.match(SRC, /if \(e\.key === 'Escape'\) \{[\s\S]{0,240}onCancel\(\)[\s\S]{0,120}e\.preventDefault\(\)/)
  })

  it('监听器仍在 useEffect 内按 open/onCancel 变化注册与注销', () => {
    assert.match(SRC, /useEffect\(\(\) => \{[\s\S]{0,2000}\}, \[open, onCancel\]\)/)
  })
})
