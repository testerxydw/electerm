const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const SESSION_STYL = path.join(ROOT, 'src/client/components/session/session.styl')
const FULLSCREEN_STYL = path.join(ROOT, 'src/client/components/main/term-fullscreen.styl')
const SESSION_JSX = path.join(ROOT, 'src/client/components/session/session.jsx')
const SFTP_STYL = path.join(ROOT, 'src/client/components/sftp/sftp.styl')
const SFTP_ENTRY = path.join(ROOT, 'src/client/components/sftp/sftp-entry.jsx')
const SFTP_LIST_TABLE = path.join(ROOT, 'src/client/components/sftp/list-table-ui.jsx')
const RDP_JSX = path.join(ROOT, 'src/client/components/rdp/rdp-session.jsx')
const VNC_JSX = path.join(ROOT, 'src/client/components/vnc/vnc-session.jsx')
const SPICE_JSX = path.join(ROOT, 'src/client/components/spice/spice-session.jsx')

// T3 内容区 flex 化（doc/已完成/TODO-顶栏高度与底栏避让统一-2026-10-30--已完成.md §3/§4）：
// .session-wrap 是竖向 flex 容器，页根 flex 1 1 0 + min-height 0，
// 内容高由浏览器分配；JS 扣减逐片删除。每项带反向断言。

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

  test('DB 容器自己吃 flex（反向：inline height 删了但 flex 没补 → 内容高为 0）', () => {
    const block = stylBlock(load(SESSION_STYL), '.db-session-box')
    assert.ok(block, '.db-session-box 块存在')
    assert.ok(block.includes('flex 1 1 0'), '.db-session-box 未参与 flex 分配')
    assert.ok(block.includes('min-height 0'), '.db-session-box 缺 min-height 0')
  })
})

describe('T3b-a: sftp 面板高度改为 flex 分配', () => {
  test('sftp-entry 不再下发内联高度（反向：内联定位/高度回潮）', () => {
    const src = load(SFTP_ENTRY)
    assert.ok(!/className: 'sftp-wrap[\s\S]{0,120}style: \{ height \}/.test(src), '.sftp-wrap 内联 height')
    const sec = src.match(/renderSection \(type, width\) \{[\s\S]*?\n {2}\}/)
    assert.ok(sec, 'renderSection(type, width) 签名')
    assert.ok(!sec[0].includes('style={style}'), 'section 内联定位/高度')
    const list = src.match(/renderSections \(\) \{[\s\S]*?\n {2}\}/)
    assert.ok(list, 'renderSections 存在')
    assert.ok(!/height/.test(list[0]), 'renderSections 仍算高度')
  })

  test('session.jsx：分栏不给 px 高，SFTP 外壳带 flex 类名', () => {
    const src = load(SESSION_JSX)
    assert.ok(!src.includes("height: this.props.computeHeight(this.props.height) + 'px'"), 'Splitter 内联 height')
    assert.ok(!src.includes('calcSftpWidthHeight'), '旧的高度+宽度合并计算残留')
    assert.ok(src.includes('calcSftpWidth = () =>'), 'calcSftpWidth 存在')
    assert.ok(src.includes("'sftp-pane-wrap'"), 'sftp-pane-wrap 类名')
  })

  test('.term-sftp-box 列 flex + Splitter 吃满（反向：静态 height 100%）', () => {
    const block = stylBlock(load(SESSION_STYL), '.term-sftp-box')
    assert.ok(block, '.term-sftp-box 块存在')
    assert.ok(block.includes('flex-direction column'), 'term-sftp-box 竖向 flex')
    assert.ok(/> \.ant-splitter\n {4}flex 1 1 0/.test(block), 'Splitter flex 1 1 0')
    assert.ok(!block.includes('height 100%'), 'term-sftp-box 不再靠 height 100%')
  })

  test('sftp.styl：整条链 flex，表头 flex none，滚动区吃满（反向：魔法数回潮）', () => {
    const src = load(SFTP_STYL)
    assert.ok(stylBlock(src, '.sftp-wrap').includes('flex 1 1 0'), '.sftp-wrap flex 1 1 0')
    const section = stylBlock(src, '.sftp-section')
    assert.ok(section.includes('flex-direction column'), '.sftp-section 列 flex')
    assert.ok(section.includes('.ant-spin-container'), 'Spin 两级包裹参与 flex')
    assert.ok(stylBlock(src, '.file-list').includes('flex 1 1 0'), '.file-list flex 1 1 0')
    assert.ok(stylBlock(src, '.sftp-table').includes('flex-direction column'), '.sftp-table 列 flex')
    assert.ok(stylBlock(src, '.sftp-file-table-header').includes('flex none'), '表头 flex none')
    assert.ok(stylBlock(src, '.sftp-table-content').includes('flex 1 1 0'), '.sftp-table-content flex 1 1 0')
  })

  test('pager 死代码已删（反向：42px / pager 规则回潮）', () => {
    const src = load(SFTP_STYL)
    assert.ok(!src.includes('.sftp-has-pager'), '.sftp-has-pager 残留')
    assert.ok(!src.includes('.pager-wrap'), '.pager-wrap 残留')
    assert.ok(!src.includes('padding-bottom 42px'), 'padding-bottom 42px 残留')
  })

  test('list-table-ui：删高度算术，滚动高由 ResizeObserver 实测', () => {
    const src = load(SFTP_LIST_TABLE)
    assert.ok(!src.includes('height - 32 - 30 - 32 - 90'), '容器高算术残留')
    assert.ok(!src.includes('height: containerHeight'), '内联高度残留')
    assert.ok(src.includes('new ResizeObserver'), 'ResizeObserver 实测')
    assert.ok(src.includes('containerHeight={this.state.containerHeight}'), '实测高传给 PagedList')
  })

  test('全屏会话把标签栏让位归零（反向：SFTP 顶部 36px 空带）', () => {
    const src = load(FULLSCREEN_STYL)
    const m = src.match(/\.session-wrap\.session-current\n[\s\S]*?\n {4}\.term-wrap/)
    assert.ok(m, '全屏 session-wrap 块存在')
    assert.match(m[0], /padding-top 0 !important/, '全屏时 padding-top 未归零')
  })
})

describe('T3b-b: remote 不再接收布局宽高', () => {
  test('session.jsx 的 rdpProps 不再 pick width/height', () => {
    const src = load(SESSION_JSX)
    const m = src.match(/if \(type === terminalRdpType[\s\S]*?\.\.\.pick\(this\.props, \[[\s\S]*?\]\)/)
    assert.ok(m, 'rdpProps 存在')
    assert.ok(!/'width'/.test(m[0]), 'width 仍在 pick 列表')
    assert.ok(!/'height'/.test(m[0]), 'height 仍在 pick 列表')
  })

  test('RDP / VNC / SPICE 源码零 props.width / props.height 读取', () => {
    for (const p of [RDP_JSX, VNC_JSX, SPICE_JSX]) {
      const src = load(p)
      assert.ok(!/props\.(?:width|height)\b/.test(src), path.basename(p) + ' 仍在读 props.width/height')
    }
  })

  test('VNC / SPICE 首连尺寸量挂载点（反向：-10/-80 猜测回潮）', () => {
    for (const p of [VNC_JSX, SPICE_JSX]) {
      const src = load(p)
      const m = src.match(/calcCanvasSize = \(\) => \{[\s\S]*?\n {2}\}/)
      assert.ok(m, path.basename(p) + ' calcCanvasSize 存在')
      assert.ok(m[0].includes('clientWidth') && m[0].includes('clientHeight'), '按挂载点实测')
      assert.ok(!/- 10\b|- 80\b/.test(m[0]), '旧的 -10 / -80 猜测')
    }
  })
})
