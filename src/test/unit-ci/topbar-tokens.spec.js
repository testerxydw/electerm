const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const TOKENS = path.join(ROOT, 'src/client/css/includes/tokens.styl')
const CONSTANTS = path.join(ROOT, 'src/client/common/constants.js')
const SHELL_STYL = path.join(ROOT, 'src/client/components/common/session-shell.styl')
const SESSION_STYL = path.join(ROOT, 'src/client/components/session/session.styl')
const TERMINAL_STYL = path.join(ROOT, 'src/client/components/terminal/terminal.styl')
const DB_STYL = path.join(ROOT, 'src/client/components/database/db-session.styl')
const WEB_STYL = path.join(ROOT, 'src/client/components/web/web.styl')
const WEB_ADDRESS_BAR = path.join(ROOT, 'src/client/components/web/address-bar.jsx')

// T1 顶栏高度单源（doc/TODO-顶栏高度与底栏避让统一-2026-10-30.md §1）：
// --session-bar-h 是单行条唯一高度来源，--session-bar-pad-x 是左右内边距唯一来源。
// 消费方式固定为 flex none + min-height + line-height + padding 0 <token>，
// 不写死 height（窄窗换行是自然结果）。每项带反向断言，防裸值回潮。

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

describe('T1: session bar tokens', () => {
  test('tokens.styl 定义条高与左右内边距', () => {
    const src = load(TOKENS)
    assert.match(src, /--session-bar-h 32px/, '--session-bar-h=32')
    assert.match(src, /--session-bar-pad-x 10px/, '--session-bar-pad-x=10')
  })

  test('JS 镜像 termControlHeight 与条高同值', () => {
    assert.match(load(CONSTANTS), /export const termControlHeight = 32/, 'termControlHeight=32')
  })
})

describe('T1: 五类顶栏消费 token（反向：裸值回归）', () => {
  test('remote 条：min-height/line-height/padding 全用 token，行盒不再改高', () => {
    const block = stylBlock(load(SHELL_STYL), '.remote-session-control')
    assert.ok(block, '.remote-session-control 块存在')
    assert.ok(block.includes('min-height var(--session-bar-h)'), 'min-height 用 token')
    assert.ok(block.includes('line-height var(--session-bar-h)'), 'line-height 用 token')
    assert.ok(block.includes('padding 0 var(--session-bar-pad-x)'), 'padding 用 token')
    assert.ok(!block.includes('4px 8px'), '裸 padding 4px 8px 回退')
    assert.ok(!block.includes('row-gap 4px'), 'row-gap 4px 会让换行高不是 32 的倍数')
    assert.ok(!/\b(?:38|40)px\b/.test(block), '裸 38px/40px 回退')
  })

  test('remote 条内侧分组的 row-gap 同样归零（反向：二次换行改高）', () => {
    const src = load(SHELL_STYL)
    const pair = src.match(/\.remote-session-control-left\n\.remote-session-control-right\n[\s\S]*?\n\n/)
    assert.ok(pair, 'left/right 分组块存在')
    assert.ok(!pair[0].includes('row-gap 4px'), '内部分组 row-gap 4px 回退')
  })

  test('.session-v-info 的 30px 行高已删（38/40 抖动的直接来源）', () => {
    const src = load(SESSION_STYL)
    assert.ok(!/\.session-v-info[\s\S]{0,40}line-height 30px/.test(src), 'line-height 30px 不得留在 .session-v-info')
  })

  test('终端 / DB 条左右内边距与 remote 同源（反向：裸 10px 回退）', () => {
    const term = stylBlock(load(TERMINAL_STYL), '.terminal-control')
    assert.ok(term.includes('padding 0 var(--session-bar-pad-x)'), '终端条 padding 用 token')
    assert.ok(!term.includes('padding 0 10px'), '终端条裸 10px 回退')

    const db = stylBlock(load(DB_STYL), '.db-head')
    assert.ok(db.includes('padding 0 var(--session-bar-pad-x)'), 'DB 条 padding 用 token')
    assert.ok(!db.includes('padding 0 10px'), 'DB 条裸 10px 回退')
  })

  test('web 地址栏有自己的条规则，不再靠 pd1 + antd Input 默认高', () => {
    const src = load(WEB_ADDRESS_BAR)
    assert.ok(!src.includes("'web-address-bar pd1'"), 'pd1 已摘除')
    assert.ok(src.includes("import './web.styl'"), '引入 web.styl')

    const block = stylBlock(load(WEB_STYL), '.web-address-bar')
    assert.ok(block, '.web-address-bar 规则存在')
    assert.ok(block.includes('flex none'), '地址栏不参与内容区伸缩')
    assert.ok(block.includes('min-height var(--session-bar-h)'), 'min-height 用 token')
    assert.ok(block.includes('line-height var(--session-bar-h)'), 'line-height 用 token')
    assert.ok(block.includes('padding 0 var(--session-bar-pad-x)'), 'padding 用 token')
  })
})
