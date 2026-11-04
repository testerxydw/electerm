const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const TOKENS = path.join(ROOT, 'src/client/css/includes/tokens.styl')
const SHELL_STYL = path.join(ROOT, 'src/client/components/common/session-shell.styl')
const SESSION_STYL = path.join(ROOT, 'src/client/components/session/session.styl')
const TERMINAL_STYL = path.join(ROOT, 'src/client/components/terminal/terminal.styl')
const DB_STYL = path.join(ROOT, 'src/client/components/database/db-session.styl')
const WEB_STYL = path.join(ROOT, 'src/client/components/web/web.styl')
const WEB_ADDRESS_BAR = path.join(ROOT, 'src/client/components/web/address-bar.jsx')
const SFTP_STYL = path.join(ROOT, 'src/client/components/sftp/sftp.styl')
const SFTP_ENTRY = path.join(ROOT, 'src/client/components/sftp/sftp-entry.jsx')
const SFTP_ADDRESS_BAR = path.join(ROOT, 'src/client/components/sftp/address-bar.jsx')
const SFTP_LIST_TABLE = path.join(ROOT, 'src/client/components/sftp/list-table-ui.jsx')
const SESSION_CONTROL_STYL = path.join(ROOT, 'src/client/components/session/session-control.styl')
const NO_SESSION_STYL = path.join(ROOT, 'src/client/components/tabs/no-session.styl')
const MOBILE_STYL = path.join(ROOT, 'src/client/css/mobile.styl')

// T1 顶栏高度单源（doc/已完成/TODO-顶栏高度与底栏避让统一-2026-10-30--已完成.md §1）：
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

  // 条高不在 JS 侧立第二条镜像：T4-b 起内容区由 flex 分配，constants.js 的
  // termControlHeight 只剩定义没有消费方。"不得再有消费方"由 s2-tokens.spec.js 扫
  // 全量产品代码来钉，这里不再断言它等于 32（否则将来清掉这个残留会被本测拦住）。
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

  test('sftp 两行条（title / address）各对齐单行节奏', () => {
    const entry = load(SFTP_ENTRY)
    assert.ok(!entry.includes('pd1t pd1b'), 'title 行的 pd1t pd1b 已摘除')
    assert.ok(!load(SFTP_ADDRESS_BAR).includes("'pd1y sftp-title-wrap'"), 'address 行的 pd1y 已摘除')

    const src = load(SFTP_STYL)
    for (const sel of ['.sftp-panel-title', '.sftp-title-wrap']) {
      const block = stylBlock(src, sel)
      assert.ok(block, `${sel} 规则存在`)
      assert.ok(block.includes('min-height var(--session-bar-h)'), `${sel} min-height 用 token`)
      assert.ok(block.includes('line-height var(--session-bar-h)'), `${sel} line-height 用 token`)
      assert.ok(block.includes('padding 0 var(--session-bar-pad-x)'), `${sel} padding 用 token`)
    }
  })

  test('守卫补齐：移动端/空状态/mobile.styl 的裸值换 token（反向：裸值回归）', () => {
    const control = load(SESSION_CONTROL_STYL)
    assert.ok(control.includes('line-height var(--session-bar-h)'), '移动端标签页条行高用 token')
    assert.ok(!/line-height 32px/.test(control), '裸 line-height 32px 回退')

    const noSession = load(NO_SESSION_STYL)
    assert.ok(noSession.includes('top var(--tabs-bar-h)'), '空状态页 top 用 token')
    assert.ok(!/top 36px/.test(noSession), '裸 top 36px 回退')

    const mobile = load(MOBILE_STYL)
    assert.ok(!/line-height 36px/.test(mobile), '裸 line-height 36px 回退')
  })

  test('sftp 列表高度减式已由 T3b 删除（T1 的 42→32 中间态不再适用）', () => {
    const src = load(SFTP_LIST_TABLE)
    assert.ok(!/height - \d+ - \d+ - \d+ - \d+/.test(src), '高度魔法数回潮')
  })
})
