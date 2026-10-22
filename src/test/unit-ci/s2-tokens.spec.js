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
const TABS_STYL = path.join(ROOT, 'src/client/components/tabs/tabs.styl')
const FOOTER_STYL = path.join(ROOT, 'src/client/components/footer/footer.styl')

// S2 骨架高度 token 单点化（doc/TODO-顶栏与显示页统一执行计划-2026-10-21.md §S2）：
// --session-bar-h(32) / --tabs-bar-h(36) 与 JS 侧常量互为镜像（JS 布局扣减
// 拿不到 CSS 变量），两源必须同值；DB 去掉"扣 32 再加回 32"补偿。
// 每项含反向断言（裸 32px/36px 回归、补偿复活都会被拦）。

const load = p => fs.readFileSync(p, 'utf8')
// 取 styl 顶级选择器块（至下一个顶级选择器）；先按行首匹配，避免命中后代选择器
function stylBlock (src, sel) {
  let i = src.indexOf('\n' + sel + '\n')
  if (i < 0) {
    if (!src.startsWith(sel + '\n')) return ''
    i = 0
  } else {
    i += 1
  }
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

describe('F: tabs / footer 渲染高度 token', () => {
  test('tokens.styl 定义 tabs-render-h / tab-item-h / footer-h', () => {
    const src = load(TOKENS)
    assert.match(src, /--tabs-render-h 38px/)
    assert.match(src, /--tab-item-h 32px/)
    assert.match(src, /--footer-h 30px/)
  })

  test('JS 镜像 footerHeight=30 与 token 同值（反向：漂移被拦）', () => {
    assert.match(load(CONSTANTS), /export const footerHeight = 30/)
  })

  test('tabs.styl 使用 token 且无裸 38px/32px/36px（反向：回退被拦）', () => {
    const src = load(TABS_STYL)
    const tabsBlock = stylBlock(src, '.tabs')
    assert.ok(tabsBlock.includes('height var(--tabs-render-h)'), '.tabs 用 --tabs-render-h')
    const innerBlock = stylBlock(src, '.tabs-inner')
    assert.ok(innerBlock.includes('height var(--tabs-render-h)'), '.tabs-inner 用 --tabs-render-h')
    const tabBlock = stylBlock(src, '.tab')
    assert.ok(tabBlock.includes('height var(--tab-item-h)'), '.tab 用 --tab-item-h')
    assert.ok(tabBlock.includes('line-height var(--tab-item-h)'), '.tab 行高用 --tab-item-h')
    const ca = src.match(/\.tabs-corner\n[\s\S]*?\n {2}\.tabs-dd-icon/)
    assert.ok(ca, '.tabs-corner 块存在')
    assert.ok(ca[0].includes('height var(--tabs-render-h)'), '.tabs-corner 用 --tabs-render-h')
    assert.ok(!/(?:height|line-height) 38px/.test(src), '裸 38px 回退')
    assert.ok(!/(?:height|line-height) 32px/.test(src), '裸 32px 回退')
    assert.ok(!/(?:height|line-height) 36px/.test(src), '裸 36px 回退')
  })

  test('footer.styl 使用 --footer-h 且无裸 30px（反向：回退被拦）', () => {
    const src = load(FOOTER_STYL)
    const footerBlock = stylBlock(src, '.main-footer')
    assert.ok(footerBlock.includes('height var(--footer-h)'), '.main-footer 用 --footer-h')
    assert.ok(!/(?:height|line-height) 30px/.test(src), '裸 30px 回退')
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
