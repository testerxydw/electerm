const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const LAYOUT = path.join(ROOT, 'src/client/components/layout/layout.jsx')
const MAIN = path.join(ROOT, 'src/client/components/main/main.jsx')

// T2 底栏避让接线（doc/TODO-顶栏高度与底栏避让统一-2026-10-30.md §2）：
// JS 只消费 resolveBottomStack().session，CSS 只消费注入的三个派生变量。
// 反向断言锁住"手写和式回潮"。

const load = p => fs.readFileSync(p, 'utf8')

describe('T2: layout.jsx / main.jsx 接线', () => {
  test('layout.jsx 用 resolveBottomStack 的 session，保留 resizeTrigger', () => {
    const src = load(LAYOUT)
    assert.ok(src.includes('resolveBottomStack({'), '调用纯函数')
    assert.ok(src.includes('height - stack.session'), '会话高减 session')
    assert.ok(src.includes('+ resizeTrigger'), 'D6：T2 保留 1px 重排')
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
