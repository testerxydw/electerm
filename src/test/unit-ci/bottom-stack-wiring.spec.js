const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const LAYOUT = path.join(ROOT, 'src/client/components/layout/layout.jsx')
const MAIN = path.join(ROOT, 'src/client/components/main/main.jsx')
const SIDEBAR = path.join(ROOT, 'src/client/components/sidebar/sidebar.styl')
const QM = path.join(ROOT, 'src/client/components/quick-commands/qm.styl')
const RIGHT_PANEL = path.join(ROOT, 'src/client/components/side-panel-r/right-side-panel.styl')
const SHORTCUT = path.join(ROOT, 'src/client/components/terminal/shortcut-bar.styl')
const MONITOR = path.join(ROOT, 'src/client/components/remote-monitor/remote-monitor-bar.styl')
const FULLSCREEN = path.join(ROOT, 'src/client/components/main/term-fullscreen.styl')
const FOOTER = path.join(ROOT, 'src/client/components/footer/footer.styl')
const MOBILE = path.join(ROOT, 'src/client/css/mobile.styl')
const CONSTANTS = path.join(ROOT, 'src/client/common/constants.js')

// T2 底栏避让接线（doc/已完成/TODO-顶栏高度与底栏避让统一-2026-10-30--已完成.md §2）：
// JS 只消费 resolveBottomStack().session，CSS 只消费注入的三个派生变量。
// 反向断言锁住"手写和式回潮"。

const load = p => fs.readFileSync(p, 'utf8')

describe('T2: layout.jsx / main.jsx 接线', () => {
  test('layout.jsx 用 resolveBottomStack 的 session，不再靠 1px 重排', () => {
    const src = load(LAYOUT)
    assert.ok(src.includes('resolveBottomStack({'), '调用纯函数')
    assert.ok(src.includes('height - stack.session'), '会话高减 session')
    assert.ok(!src.includes('resizeTrigger'), 'T4-c：1px 强制重排已删（RO 驱动 fit）')
    assert.ok(!/height - footerHeight - monitorHeight/.test(src), '手写和式不得回归')
  })

  test('main.jsx 注入三个新变量（值取自同一函数）', () => {
    const src = load(MAIN)
    assert.ok(src.includes('resolveBottomStack({'), '调用纯函数')
    assert.ok(src.includes("'--below-footer-h'"), '注入 --below-footer-h')
    assert.ok(src.includes("'--below-monitor-h'"), '注入 --below-monitor-h')
    assert.ok(src.includes("'--bottom-reserved-h'"), '注入 --bottom-reserved-h')
    assert.ok(src.includes('bottomStack.belowFooter'), 'belowFooter 取自函数')
    assert.ok(src.includes('bottomStack.belowMonitor'), 'belowMonitor 取自函数')
    assert.ok(src.includes('bottomStack.reserved'), 'reserved 取自函数')
  })
})

describe('T2: 六个消费方各取一个变量（反向：裸值/补位回潮）', () => {
  test('侧栏 / 快捷命令带 / 右面板 / 移动端 popup 避让整个底部栈', () => {
    for (const [name, file] of [
      ['sidebar.styl', SIDEBAR],
      ['qm.styl', QM],
      ['right-side-panel.styl', RIGHT_PANEL],
      ['mobile.styl', MOBILE]
    ]) {
      assert.ok(load(file).includes('var(--bottom-reserved-h'), `${name} 使用 --bottom-reserved-h`)
    }
    // 侧栏此前的漏项：只避让 footer，被快捷键条压住
    assert.ok(load(SIDEBAR).includes('bottom var(--bottom-reserved-h'), '侧栏 bottom 用整栈')
  })

  test('footer / 监控条各自只避让它上面的层', () => {
    assert.ok(load(FOOTER).includes('bottom var(--below-footer-h, 0px)'), 'footer bottom = --below-footer-h')
    assert.ok(load(MONITOR).includes('bottom var(--below-monitor-h'), '监控条 bottom = --below-monitor-h')
  })

  test('.shortcut-bar-on 条件补位整段删除（变量为 0 时自然退化）', () => {
    const src = load(SHORTCUT)
    assert.ok(!src.includes('.shortcut-bar-on'), '补位规则不得残留')
    assert.ok(!src.includes('+ 30px'), '裸 30px 不得残留')
  })

  test('全屏内容避让用变量，不再裸 180px / 手拼和式', () => {
    const src = load(FULLSCREEN)
    assert.ok(!src.includes('180px'), '裸 180px 回退')
    assert.ok(!/var\(--footer-stack-height, 30px\) - var\(--shortcut-bar-h/.test(src), '手拼和式回退')
    assert.ok(src.includes('var(--bottom-reserved-h'), '术语用 --bottom-reserved-h')
    assert.ok(src.includes('var(--qm-bar-h, 0px)'), '快捷命令带用 --qm-bar-h')
  })

  test('死常量 sftpControlHeight 已删', () => {
    assert.ok(!load(CONSTANTS).includes('sftpControlHeight'), 'sftpControlHeight 零引用，应删除')
  })
})
