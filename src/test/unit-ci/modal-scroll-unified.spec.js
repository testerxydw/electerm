/**
 * 弹层 / 滚动容器统一滚动通道契约（SSOT 护栏）
 *
 * 背景（真实缺陷，用户点名「所有弹框或滚动容器的滚动条都要在容器内」）：
 *   1) 关于页 info.styl 写的是 antd5 的 .ant-tabs-content-holder，antd 6.5.1
 *      真实层级是 nav + body-holder > body > content，规则完全没生效 →
 *      deps 一两百行 / 超长命令行帮助把最外层 wrap 顶出全屏滚动条，Tab 栏被滚走；
 *   2) 自定义 Modal 的 .custom-modal-wrap 与 antd Modal 的 .ant-modal-wrap
 *      都以 overflow:auto 由最外层 fixed 包裹层承担滚动 → 滚动条贴在视口边缘
 *      （弹框外），header / footer 一起滚走，31 + 27 处调用点全受影响；
 *   3) 已有的 db-pane-tabs-layout.spec.js 只扫 db-session.styl 一个文件，
 *      关于页正是从这个盲区漏过去的 —— 本 spec 把失效类名扫描扩到全部 styl；
 *   4) 本轮 QA 实机（真 Electron + Xvfb + CDP）发现第二轮回归：info.styl 曾
 *      照抄 .db-pane-tabs 的「flex 1 1 0 + height 100% 定高链」，但祖先
 *      .custom-modal-content 只有 max-height 没有确定 height → 全链坍缩成 0 高，
 *      deps/cmd 完全不可见。已改为「滚动归 SSOT 的 .custom-modal-body +
 *      nav sticky 钉住」，本 spec 相应把关于页护栏从「锁四层链」换成
 *      「禁定高链 + 锁 nav sticky + 锁单通道」。
 *
 * 判据纪律（AGENTS.md §5.2.7，禁止自证常量）：
 *   - 「完整类名是否出现在依赖源码」不是判据：antd 类名几乎都由 CSS-in-JS
 *     模板 `${prefixCls}-body` 生成，完整字符串 ant-modal-body /
 *     ant-tabs-body-holder 在依赖源码里零命中，但类本身有效。唯一证实失效的
 *     是 `content-holder` 这个**片段**零命中，而 `-body-holder` 片段命中。
 *   - 因此正向断言从真实依赖源码抽片段，绑定 antd 的 DOM 模板与 top:100，
 *     依赖升级改了结构/偏移时测试会红，提示重新推导，而不是自证一个常量。
 *
 * 能力边界（必须如实声明）：
 *   1) 以下全是静态字符串/结构断言，只能钉死「源码里写了什么」，发现不了
 *      「CSS 已产出但运行时被更晚注入的 CSS-in-JS 规则覆盖」。上一轮
 *      .db-sticky-thead 的教训：position:sticky 写了却被
 *      .ant-table-wrapper .ant-table-thead>tr>th{position:relative} 压过，
 *      最后靠 !important + QA 实机 getComputedStyle + 真实滚轮才确认。
 *   2) 更关键：静态断言也发现不了「CSS 全部产出、全部生效，但运行时布局链
 *      坍缩」——本轮 NoGo 里所有 CSS 规则都在产物中且都生效，info.styl 的
 *      flex 1 1 0 + height 100% 链仍把 .ant-tabs-body 压成 clientHeight=0，
 *      deps/cmd 完全不可见。这类回归只有实机 clientHeight>0 + 真实滚轮
 *      scrollTop>0 才能发现，QA 已把它固化成可复跑探针。
 *   运行时优先级、真实滚轮下 header/nav 的 rect.top 是否恒定、是否出现双
 *   滚动条、布局链是否坍缩，均由 QA 独立实机验证，不在本 spec 能力范围内。
 */
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '../../..')
const CLIENT = path.join(ROOT, 'src/client')
const INCLUDES = path.join(CLIENT, 'css/includes')
const SSOT = path.join(INCLUDES, 'modal-scroll.styl')
const INDEX = path.join(INCLUDES, 'index.styl')
const BASIC = path.join(CLIENT, 'css/basic.styl')
const MOBILE = path.join(CLIENT, 'css/mobile.styl')
const BOX = path.join(INCLUDES, 'box.styl')
const MODAL_STYL = path.join(CLIENT, 'components/common/modal.styl')
const ERROR_MODAL = path.join(CLIENT, 'components/common/error-modal.styl')
const INFO_STYL = path.join(CLIENT, 'components/sidebar/info.styl')
const DB_STYL = path.join(CLIENT, 'components/database/db-session.styl')
const TREE_STYL = path.join(CLIENT, 'components/tree-list/tree-list.styl')
const SHORTCUT_STYL = path.join(CLIENT, 'components/terminal/shortcut-bar.styl')
const ANTD_TABS_DIR = path.join(ROOT, 'node_modules/antd/es/tabs')
const ANTD_MODAL_STYLE = path.join(ROOT, 'node_modules/antd/es/modal/style/index.js')
const PANEL = path.join(ROOT, 'node_modules/@rc-component/dialog/es/Dialog/Content/Panel.js')

const read = (p) => fs.readFileSync(p, 'utf8')

// antd5 遗留结构名（片段级判据，见文件头「判据纪律」）
const DEAD_TABS_CLASSES = ['ant-tabs-content-holder']

// ---- 通用静态源码工具 ------------------------------------------------------

// 剥离 stylus 注释，但保留行数（行号仍对应原文件）。
// `\s//` 只剥行尾注释，不会误伤 https:// 这类字符串里的 //。
function stripStylComments (src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(l => l.replace(/\s\/\/.*$/, '').replace(/^\s*\/\/.*$/, ''))
    .join('\n')
}

function walkFiles (dir, ext, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walkFiles(p, ext, out)
    else if (e.name.endsWith(ext)) out.push(p)
  }
  return out
}

function walkStyl () {
  return walkFiles(CLIENT, '.styl')
}

// 取某个选择器的规则体（stylus 缩进块），注释行已被剥离为空行。
function ruleBody (src, selector) {
  const lines = stripStylComments(src).split('\n')
  const start = lines.findIndex(l => l.trim() === selector)
  assert.notEqual(start, -1, `样式里找不到选择器 ${selector}`)
  const base = lines[start].match(/^\s*/)[0].length
  const out = []
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]
    // 空行 / 被剥离成空行的块内注释不终止规则块；只有缩进回退到同级或更浅
    // 的非空行才表示本块结束（否则块内注释会截断声明收集，见错误弹层用例）。
    if (!l.trim()) continue
    if (l.match(/^\s*/)[0].length <= base) break
    out.push(l.trim())
  }
  return out.join('\n')
}

// 纯函数：单个源码里失效类名的命中数（供反例自检直接注入变异字符串）。
function deadTabsHits (src) {
  const hits = []
  stripStylComments(src).split('\n').forEach((l, i) => {
    for (const cls of DEAD_TABS_CLASSES) {
      if (l.includes(cls)) hits.push(`${i + 1}:${l.trim()}`)
    }
  })
  return hits
}

// Tabs 撑满链四层：只适用于 db-session.styl 的 .db-pane-tabs（其父级已定高）。
// 关于页曾照抄这条链，但祖先 .custom-modal-content 只有 max-height、
// 没有确定 height，flex-basis 0 + min-height 0 取消 min-content 保护 →
// 全链坍缩成 0 高（QA 实机 NoGo）。关于页已改为 SSOT 内滚 + nav sticky。
const TABS_CHAIN = [
  '> .ant-tabs-nav',
  '> .ant-tabs-body-holder',
  '> .ant-tabs-body',
  '> .ant-tabs-content'
]

function assertTabsChain (src, label) {
  // 逐行精确相等，不用 includes：否则 `> .ant-tabs-content-X` 仍会被
  // `> .ant-tabs-content` 的子串匹配骗过（反例 C 就是为了钉死这一点）。
  const lines = stripStylComments(src).split('\n').map(l => l.trim())
  for (const sel of TABS_CHAIN) {
    assert.ok(lines.includes(sel), `${label} 撑满链路缺少 ${sel}`)
  }
}

// 纯函数：每条对 antd 的覆盖都必须带 !important（运行时 CSS-in-JS 晚注入）。
const ANTD_SELECTORS = [
  '.ant-modal-wrap',
  '.ant-modal-container',
  '.ant-modal-header, .ant-modal-footer',
  '.ant-modal-body'
]

function assertAntdImportant (src) {
  for (const sel of ANTD_SELECTORS) {
    const decls = ruleBody(src, sel).split('\n')
      .map(s => s.trim())
      .filter(s => s && /^[a-z][a-z-]*\s/.test(s))
    assert.ok(decls.length > 0, `${sel} 没有声明`)
    for (const d of decls) {
      assert.match(d, /!important\s*$/, `${sel} 的 "${d}" 缺 !important：会被运行时 CSS-in-JS 压过`)
    }
  }
}

// ---- 关于页专项护栏（QA 实机 NoGo 后的收敛口径）---------------------------

// a) 禁止任何定高链回潮：祖先只有 max-height 时 flex-basis 0 / height 100%
//    会把整条 Tabs 链压成 0 高；info.styl 也不得另起滚动通道。
function assertInfoNoHeightChain (src) {
  const code = stripStylComments(src)
  for (const forbidden of [
    /^\s*flex 1 1 0\s*$/m,
    /^\s*height 100%\s*$/m,
    /^\s*min-height 0\s*$/m
  ]) {
    assert.doesNotMatch(
      code,
      forbidden,
      'info.styl 不得出现定高链：祖先只有 max-height 时会坍缩成 0 高（QA 实机 NoGo）'
    )
  }
  assert.doesNotMatch(
    code,
    /\.custom-modal-body/,
    '滚动必须归 SSOT 的 .custom-modal-body，info.styl 不得另起通道'
  )
  assert.doesNotMatch(
    code,
    /^\s*overflow(-[xy])?\s*:?\s*(auto|scroll|hidden)\b/m,
    'info.styl 不得声明任何 overflow（滚动归 SSOT 单一真源）'
  )
}

// b) nav 必须 sticky 且带 !important：antd tabs style :719 默认
//    position:relative，CSS-in-JS 晚注入，裸 sticky 会被压回 relative。
function assertInfoNavSticky (src) {
  const body = ruleBody(src, '.ant-tabs-nav')
  assert.match(
    body,
    /^position sticky !important$/m,
    'nav 默认 position:relative，必须 !important 才能在滚动容器内钉住'
  )
  assert.match(body, /^top 0$/m, 'sticky 必须给出 top 0')
  assert.match(body, /^z-index\s+\d+$/m, 'sticky nav 必须给 z-index，避免被正文盖住')
  assert.match(
    body,
    /^background var\(--[\w-]+\)$/m,
    'sticky nav 必须不透明，否则滚动时正文行会穿透'
  )
}

// ---- 滚动容器：规则块树 ----------------------------------------------------

// stylus 声明行 = 「属性名 + 值」；选择器行以 . # & @ [ : > * 开头，
// 或第二 token 是选择器组合符（如 tr.dnd-before > td）。
function isDeclaration (t) {
  if (/^[.#&@>:[*]/.test(t)) return false
  if (/^[a-z][a-z-]*\s*:/.test(t)) return true
  const m = t.match(/^([a-z][a-z-]*)\s+(\S.*)$/)
  if (!m) return false
  if (/^[.#&@>:[*$]/.test(m[2])) return false
  return true
}

function parseBlocks (src) {
  const lines = src.split('\n')
  const blocks = []
  const stack = []
  lines.forEach((raw, i) => {
    const t = raw.trim()
    if (!t || t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) return
    const indent = raw.match(/^\s*/)[0].length
    if (isDeclaration(t)) {
      if (stack.length) stack[stack.length - 1].decls.push({ line: i + 1, text: t })
      return
    }
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop()
    const b = {
      selector: t,
      indent,
      decls: [],
      parent: stack.length ? stack[stack.length - 1] : null
    }
    blocks.push(b)
    stack.push(b)
  })
  return blocks
}

// 纵向滚动声明（overflow-x 是横向滚动条，由宽度约束，不在本护栏范围）。
const OVERFLOW_Y = /^(overflow|overflow-y)\s*:?\s*(auto|scroll)\b/

// 高度约束判据：明确 height/max-height，或 flex + min-height 0 弹性链，
// 或 absolute/fixed + top + bottom 的上下定位定高。
function hasHeightConstraint (decls) {
  const has = re => decls.some(d => re.test(d.text))
  return has(/^(height|max-height|min-height)\b/) ||
    (has(/^flex\b/) && has(/^min-height\s*0\b/)) ||
    (has(/^position\s*:?\s*(absolute|fixed)\b/) && has(/^top\b/) && has(/^bottom\b/))
}

// 纯函数：单文件内「自身块 + 祖先块」都没有高度约束的纵向 overflow 声明。
function overflowViolationsInSrc (src, rel) {
  const out = []
  for (const b of parseBlocks(src)) {
    for (const d of b.decls) {
      if (!OVERFLOW_Y.test(d.text)) continue
      const all = b.decls.slice()
      let p = b.parent
      while (p) {
        all.push(...p.decls)
        p = p.parent
      }
      if (!hasHeightConstraint(all)) out.push(`${rel}|${b.selector}|${d.text}`)
    }
  }
  return out
}

function overflowViolations (files) {
  const out = []
  for (const f of files) {
    out.push(...overflowViolationsInSrc(read(f), path.relative(ROOT, f)))
  }
  return out
}

// 已核实合规白名单（「保留 + 理由」逐条登记，AGENTS.md §5.2.2 SSOT）：
// 这些声明自身/祖先链里没有显式高度约束，但高度由「使用处 / 兄弟规则 /
// 已定高的父容器」给出，滚动条仍落在该容器内，不做改动以免行为变更。
const OVERFLOW_ALLOWLIST = [
  // 父级 .ai-chat-container{height 100%} + .ai-chat-history{flex-grow 1;min-height 0}
  'src/client/components/ai/ai.styl|.ai-history-wrap|overflow-y auto',
  // 父容器 height 100% + flex column + overflow hidden，本块 flex 1 收高
  'src/client/components/bookmark-form/bookmark-form.styl|.tree-select-content|overflow auto',
  // 祖先 .db-pane-tabs > .ant-tabs-body{height 100%;overflow auto} 已定高并内滚，
  // 本块无自身定高、不产生第二条独立滚动条
  'src/client/components/database/db-session.styl|.db-refs-table-wrap|overflow auto',
  // 下拉浮层：父 .transports-wrap{height 36px;position absolute}，
  // 子 .transports-content{max-height 200px} 限制内容
  'src/client/components/file-transfer/transfer.styl|.transports-dd|overflow-y scroll',
  // 高度由 JSX 的 listStyle 动态给定 + 父 .setting-row 绝对定位定高
  'src/client/components/setting-panel/list.styl|.item-list-wrap|overflow-y scroll',
  // 兄弟规则 .setting-row-left/.setting-row-right 提供 bottom 0 完成上下定位定高
  'src/client/components/setting-panel/setting-wrap.styl|.setting-row|overflow-y scroll',
  // 父 .audit-center{height 62vh;display flex} + .audit-col{min-height 0;flex column}
  'src/client/components/terminal/audit-center.styl|.audit-col-filters|overflow-y auto',
  'src/client/components/terminal/audit-center.styl|.audit-col-detail|overflow-y auto',
  // includes/box.styl 工具类：高度一律由使用处给定（.overscroll / .overscroll-y）
  'src/client/css/includes/box.styl|.overscroll|overflow auto',
  'src/client/css/includes/box.styl|.overscroll-y|overflow-y auto'
]

// ---- 1. 全局失效类名护栏 ---------------------------------------------------

describe('全局失效类名护栏（全部 styl，代码行口径）', () => {
  test('遍历 src/client 下全部 styl（95 个），代码行里不得出现 antd5 遗留类名', () => {
    const files = walkStyl()
    assert.ok(files.length >= 90, 'styl 扫描不完整，只找到 ' + files.length + ' 个')
    const hits = []
    for (const f of files) {
      for (const h of deadTabsHits(read(f))) {
        hits.push(`${path.relative(ROOT, f)}:${h}`)
      }
    }
    assert.deepEqual(
      hits,
      [],
      'antd6 已无 .ant-tabs-content-holder 类名，必须改成 body-holder > body > content'
    )
  })

  test('必须区分注释/代码行：db-session.styl 注释里的失效类名不算命中', () => {
    const raw = read(DB_STYL)
    assert.ok(raw.includes('ant-tabs-content-holder'), '该注释应仍在，用于验证剥离逻辑')
    assert.deepEqual(deadTabsHits(raw), [], '剥离注释后代码行必须干净，不能误判既有成果')
    // info.styl 的文件头注释同样记录了失效类名，也不能被误判
    assert.ok(read(INFO_STYL).includes('ant-tabs-content-holder'))
    assert.deepEqual(deadTabsHits(read(INFO_STYL)), [])
  })

  test('正向依赖：antd tabs 依赖源码里 -body-holder 模板命中、content-holder 片段零命中', () => {
    const depFiles = walkFiles(ANTD_TABS_DIR, '.js')
    assert.ok(depFiles.length > 0, 'antd tabs 依赖源码目录不存在：' + ANTD_TABS_DIR)
    const dep = depFiles.map(read).join('\n')
    assert.match(
      dep,
      /\$\{componentCls\}-body-holder/,
      'antd 升级改了 Tabs DOM 模板，项目 Tabs 链必须重新评估'
    )
    assert.equal(
      (dep.match(/content-holder/g) || []).length,
      0,
      'content-holder 片段若被 antd 加回，失效类名判据须重评'
    )
  })

  test('db-session.styl 的 .db-pane-tabs 四层齐全；关于页不再自建定高链', () => {
    // .db-pane-tabs 的父级已定高（上一轮实机验证），四层链是正确范式；
    // 关于页祖先只有 max-height，照抄会坍缩，故只断言「不自建定高链」。
    assertTabsChain(read(DB_STYL), 'db-session.styl .db-pane-tabs')
    assertInfoNoHeightChain(read(INFO_STYL))
  })
})

// ---- 2. 弹层通道护栏（SSOT）----------------------------------------------

describe('弹层统一通道：modal-scroll.styl 是唯一真源', () => {
  test('SSOT 被 includes/index.styl require，basic.styl 已 require includes', () => {
    assert.match(read(INDEX), /@require\s+'.\/modal-scroll'/)
    assert.match(read(BASIC), /@require\s+'.\/includes'/)
    assert.match(read(BASIC), /^body[\s\S]{0,80}overflow hidden/m, '页面本身不滚')
  })

  test('契约四要素：wrap 不滚 / content 限高 / body 内滚 / header+footer flex none', () => {
    const ssot = read(SSOT)
    assert.match(ruleBody(ssot, '.custom-modal-wrap'), /^overflow hidden$/m)
    const content = ruleBody(ssot, '.custom-modal-content')
    assert.match(content, /^display flex$/m)
    assert.match(content, /^flex-direction column$/m)
    assert.match(content, /^max-height calc\(100vh - 98px\)$/m)
    const body = ruleBody(ssot, '.custom-modal-body')
    assert.match(body, /^flex 1 1 auto$/m)
    assert.match(body, /^min-height 0$/m)
    assert.match(body, /^overflow-y auto$/m)
    assert.match(ruleBody(ssot, '.custom-modal-header, .custom-modal-footer'), /^flex none$/m)
  })

  test('.custom-modal-wrap 不得再出现 overflow auto/scroll（组件级 + SSOT 都不行）', () => {
    for (const f of [MODAL_STYL, SSOT]) {
      const block = ruleBody(stripStylComments(read(f)), '.custom-modal-wrap')
      assert.doesNotMatch(
        block,
        /^overflow(-[xy])?\s*:?\s*(auto|scroll)\b/m,
        path.relative(ROOT, f) + ' 的 wrap 又承担了滚动（滚动条会跑到视口边缘）'
      )
    }
  })

  test('每条对 antd 的覆盖都带 !important（CSS-in-JS 晚注入，裸声明会被压过）', () => {
    assertAntdImportant(read(SSOT))
  })

  test('限高推导绑定真实依赖：wrap overflow auto / top:100 / Panel DOM 类名', () => {
    const modal = read(ANTD_MODAL_STYLE)
    assert.match(modal, /overflow:\s*'auto'/, 'antd wrap 默认仍由最外层滚，全局覆盖必要')
    assert.match(modal, /top:\s*100/, 'antd .ant-modal top:100 仍在，限高必须扣掉 100px')
    assert.match(read(SSOT), /max-height calc\(100vh - 148px\) !important/)
    const panel = read(PANEL)
    // 拼接出模板字面量片段，避免把 `${...}` 直接写进字符串触发
    // standard 的 no-template-curly-in-string（这里比对的正是 antd 的源码模板）。
    const prefix = '$' + '{prefixCls}-'
    for (const name of ['container', 'header', 'body', 'footer']) {
      assert.ok(panel.includes(prefix + name), `Panel.js 不再生成 ${name}，SSOT 覆盖会落空`)
    }
  })

  test('移动端全屏弹层有显式 100vh 高度链（覆盖 mobile.styl 的 min-height 100vh）', () => {
    const ssot = read(SSOT)
    const mobileBlock = ssot.slice(ssot.indexOf('.is-mobile'))
    assert.match(mobileBlock, /\.custom-modal-content[\s\S]{0,160}height 100vh/)
    assert.match(mobileBlock, /min-height 100vh/)
    assert.match(mobileBlock, /max-height 100vh/)
    assert.match(read(MOBILE), /\.custom-modal-content[\s\S]{0,200}min-height 100vh/,
      'mobile.styl 的全屏规则仍在，SSOT 子规则必须存在以消除隐式覆盖')
  })

  test('局部 .ant-modal-body 补丁已收敛，既有成果不被回退', () => {
    const tree = stripStylComments(read(TREE_STYL))
    const db = stripStylComments(read(DB_STYL))
    assert.doesNotMatch(tree, /max-height 60vh/, '.dup-bookmarks-modal 不得再局部限高')
    assert.doesNotMatch(db, /max-height calc\(100vh - 300px\)/, '.db-table-design-modal 不得再局部限高')
    assert.match(read(TREE_STYL), /\.dup-bookmarks-modal[\s\S]{0,200}padding-top var\(--sp-2\)/,
      '保留 padding（布局无关）')
    // .db-er-modal 的 height 85vh + 画布 flex 链是自定义画布高度，必须保留
    assert.match(db, /\.db-er-modal[\s\S]{0,200}height 85vh/)
    assert.match(db, /\.db-er-modal[\s\S]{0,400}flex 1 1 auto[\s\S]{0,80}min-height 0/)
    // 上一轮成果：.db-sticky-thead 的 position sticky !important 绝不能被本轮回退
    assert.match(db, /\.db-sticky-thead[\s\S]{0,400}position\s*:?\s*sticky\s+!important/)
    // shortcut-bar.styl 只改宽度，不受全局 max-height 影响
    assert.match(read(SHORTCUT_STYL), /\.shortcut-edit-wrap[\s\S]{0,120}max-width 92vw/)
  })

  test('错误弹层正文是唯一弹性区（弹层内滚、head/footer 常驻）', () => {
    const body = ruleBody(stripStylComments(read(ERROR_MODAL)), '.error-modal-body')
    assert.match(body, /^flex 1 1 auto$/m)
    assert.match(body, /^min-height 0$/m)
    assert.match(body, /^overflow auto$/m)
    assert.match(read(ERROR_MODAL), /\.error-modal-box[\s\S]{0,200}max-height 80vh[\s\S]{0,120}overflow hidden/)
  })
})

// ---- 3. 滚动容器护栏 -------------------------------------------------------

describe('滚动容器护栏：无高度约束的 overflow auto/scroll 必须登记白名单', () => {
  test('全仓纵向 overflow 声明的「无定高」集合与已核实白名单逐项相等', () => {
    const files = walkStyl()
    assert.ok(files.length >= 90, 'styl 扫描不完整')
    const actual = overflowViolations(files).sort()
    const expected = OVERFLOW_ALLOWLIST.slice().sort()
    assert.deepEqual(
      actual,
      expected,
      '出现未登记的无定高 overflow auto/scroll，或白名单已失效；新增滚动容器必须先给自身/祖先定高'
    )
  })

  test('白名单登记项引用的文件都真实存在，且每项恰好命中一次', () => {
    const files = new Set(walkStyl().map(f => path.relative(ROOT, f)))
    for (const item of OVERFLOW_ALLOWLIST) {
      assert.ok(files.has(item.split('|')[0]), '白名单指向不存在的文件：' + item)
    }
    assert.equal(new Set(OVERFLOW_ALLOWLIST).size, OVERFLOW_ALLOWLIST.length, '白名单不得有重复项')
    const actual = overflowViolations(walkStyl())
    for (const item of OVERFLOW_ALLOWLIST) {
      assert.equal(actual.filter(a => a === item).length, 1, '白名单项未恰好命中一次：' + item)
    }
  })
})

// ---- 4. 关于页专项（NoGo 后收敛口径）--------------------------------------

describe('关于页：滚动归 SSOT + nav sticky 钉住 + 禁止定高链坍缩', () => {
  test('无失效类名、无定高链、不覆盖 .custom-modal-body（防本轮 NoGo 回潮）', () => {
    const src = read(INFO_STYL)
    assert.deepEqual(deadTabsHits(src), [], '不得回退到 ant-tabs-content-holder')
    assertInfoNoHeightChain(src)
  })

  test('.ant-tabs-nav 必须 sticky !important + top 0 + z-index + 不透明背景', () => {
    assertInfoNavSticky(read(INFO_STYL))
  })

  test('滚动归属：SSOT 的 .custom-modal-body 仍内滚，本页不另起通道', () => {
    const body = ruleBody(read(SSOT), '.custom-modal-body')
    assert.match(body, /^flex 1 1 auto$/m)
    assert.match(body, /^min-height 0$/m)
    assert.match(body, /^overflow-y auto$/m)
    assert.doesNotMatch(stripStylComments(read(INFO_STYL)), /\.custom-modal-body/)
  })

  // 能力边界（与文件头第 2 条呼应）：以上断言只能证明「源码里没有坍缩链」，
  // 证明不了「运行时 .ant-tabs-body clientHeight > 0」。CSS 全部产出且生效、
  // 但布局链坍缩这类回归，必须靠 QA 实机 clientHeight>0 + 真实滚轮
  // scrollTop>0 的可复跑探针；本 spec 不覆盖。
})

// ---- 5. 反例自检（纯函数变异，证明护栏灵敏度）-----------------------------

describe('反例自检：把源码改坏，护栏必须立即红', () => {
  test('反例 A：去掉任意一条 antd 覆盖的 !important → assertAntdImportant 抛错', () => {
    const mutated = read(SSOT).replace('overflow hidden !important', 'overflow hidden')
    assert.notEqual(mutated, read(SSOT), '变异未生效')
    assert.throws(() => assertAntdImportant(mutated), /!important/)
  })

  test('反例 B：db-session.styl 的 body-holder 改回 content-holder → 失效类名护栏命中', () => {
    assert.deepEqual(deadTabsHits(read(DB_STYL)), [])
    const mutated = read(DB_STYL).replace('> .ant-tabs-body-holder', '> .ant-tabs-content-holder')
    assert.ok(deadTabsHits(mutated).length > 0, '失效类名必须被扫到')
  })

  test('反例 C：db-pane-tabs 四层链删掉一层 → assertTabsChain 抛错', () => {
    // db-session.styl 里有两处 > .ant-tabs-content（.db-tabs 与 .db-pane-tabs），
    // 必须全部删掉才算「缺一层」；只 replace 第一个会让 .db-pane-tabs 仍完整。
    const mutated = read(DB_STYL).split('\n')
      .filter(l => l.trim() !== '> .ant-tabs-content')
      .join('\n')
    assert.throws(() => assertTabsChain(mutated, 'mutated'), /缺少/)
  })

  test('反例 D：新增一条无定高的 overflow auto → 滚动容器护栏多一条违规', () => {
    const clean = overflowViolationsInSrc(read(BOX), 'src/client/css/includes/box.styl')
    const mutated = read(BOX) + '\n.regression-new-scroll\n  overflow auto\n'
    const dirty = overflowViolationsInSrc(mutated, 'src/client/css/includes/box.styl')
    assert.equal(dirty.length, clean.length + 1)
    assert.ok(dirty.some(h => h.includes('.regression-new-scroll')), '新增违规必须被识别')
  })

  test('反例 E：nav 去掉 !important → 关于页 sticky 护栏抛错', () => {
    const mutated = read(INFO_STYL).replace('position sticky !important', 'position sticky')
    assert.notEqual(mutated, read(INFO_STYL), '变异未生效')
    assert.throws(() => assertInfoNavSticky(mutated), /!important/)
  })

  test('反例 F：把 flex 1 1 0 加回 info.styl → 定高链护栏抛错', () => {
    const mutated = read(INFO_STYL) + '\n.regression-chain\n  flex 1 1 0\n'
    assert.throws(() => assertInfoNoHeightChain(mutated), /坍缩/)
  })

  test('反例 G：info.styl 覆盖 .custom-modal-body → 单通道护栏抛错', () => {
    const mutated = read(INFO_STYL) + '\n  .custom-modal-body\n    overflow hidden\n'
    assert.throws(() => assertInfoNoHeightChain(mutated), /SSOT/)
  })
})
