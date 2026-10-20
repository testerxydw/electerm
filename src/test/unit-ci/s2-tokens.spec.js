const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const TOKENS = path.join(ROOT, 'src/client/css/includes/tokens.styl')
const TERMINAL_STYL = path.join(ROOT, 'src/client/components/terminal/terminal.styl')
const DB_STYL = path.join(ROOT, 'src/client/components/database/db-session.styl')
const SESSION_STYL = path.join(ROOT, 'src/client/components/session/session.styl')
const CONSTANTS = path.join(ROOT, 'src/client/common/constants.js')
const INIT_STATE = path.join(ROOT, 'src/client/store/init-state.js')
const SESSION = path.join(ROOT, 'src/client/components/session/session.jsx')
const SESSIONS = path.join(ROOT, 'src/client/components/session/sessions.jsx')

// S2 骨架高度 token 单点化（doc/TODO-顶栏与显示页统一执行计划.md §S2）：
// --session-bar-h(32) / --tabs-bar-h(36) 与 JS 侧常量互为镜像（JS 布局扣减
// 拿不到 CSS 变量），两源必须同值；DB 去掉"扣 32 再加回 32"补偿。
// 每项含反向断言（裸 32px/36px 回归、补偿复活都会被拦）。

const load = p => fs.readFileSync(p, 'utf8')
// 取 styl 顶级选择器块（至下一个顶级选择器）
function stylBlock (src, sel) {
  const i = src.indexOf(sel + '\n')
  if (i < 0) return ''
  const j = src.indexOf('\n.', i + 1)
  const k = src.indexOf('\n#', i + 1)
  const end = [j, k].filter(n => n > 0).sort((a, b) => a - b)[0]
  return src.slice(i, end > 0 ? end : undefined)
}

describe('S2: session-bar-h / tabs-bar-h tokens exist', () => {
  test('tokens.styl defines both skeleton heights', () => {
    const src = load(TOKENS)
    assert.match(src, /--session-bar-h 32px/, '--session-bar-h 32px')
    assert.match(src, /--tabs-bar-h 36px/, '--tabs-bar-h 36px')
  })

  test('JS mirrors locked to same values (reverse: drift is caught)', () => {
    assert.match(load(CONSTANTS), /export const termControlHeight = 32/, 'termControlHeight=32')
    assert.match(load(INIT_STATE), /tabsHeight: 36/, 'tabsHeight=36')
  })

  test('CSS consumers use the tokens (reverse: bare px regression)', () => {
    const termBlock = stylBlock(load(TERMINAL_STYL), '.terminal-control')
    assert.ok(termBlock.includes('line-height var(--session-bar-h)'), '.terminal-control line-height uses token')
    assert.ok(!/line-height 32px/.test(termBlock), 'bare 32px crept back')

    const dbBlock = stylBlock(load(DB_STYL), '.db-head')
    assert.ok(dbBlock.includes('height var(--session-bar-h)'), '.db-head height uses token')
    assert.ok(!/height 32px/.test(dbBlock), 'bare 32px crept back')

    const wrapBlock = stylBlock(load(SESSION_STYL), '.session-wrap')
    assert.ok(wrapBlock.includes('padding-top var(--tabs-bar-h)'), '.session-wrap padding uses token')
    assert.ok(!/padding-top 36px/.test(wrapBlock), 'bare 36px crept back')
  })
})

describe('S2: DB session.jsx compensation removed', () => {
  test('DB branch computes height as height - tabsHeight (no +termControlHeight)', () => {
    const src = load(SESSION)
    const m = src.match(/if \(type === terminalDatabaseType\) \{[\s\S]*?\n {4}\}/)
    assert.ok(m, 'db branch found')
    const body = m[0]
    assert.match(body, /height - this\.props\.tabsHeight/, 'db height = layout height - tabs bar')
    assert.ok(!body.includes('termControlHeight'), 'compensation must not come back')
    assert.ok(!/this\.props\.computeHeight/.test(body), 'db branch must not call computeHeight')
  })

  test('terminal computeHeight keeps both deductions (reverse: guard the 36+32 contract)', () => {
    const src = load(SESSIONS)
    const m = src.match(/computeHeight = \(height\) => \{[\s\S]*?\n {2}\}/)
    assert.ok(m, 'computeHeight found')
    assert.match(m[0], /height\s*-\s*\n?\s*tabsHeight\s*-\s*\n?\s*termControlHeight/, 'must deduct tabsHeight + termControlHeight')
  })

  test('session.jsx no longer imports termControlHeight (unused after S2)', () => {
    const src = load(SESSION)
    assert.ok(!src.includes('termControlHeight'), 'import and usages both gone')
  })
})
