// CSS 契约测试 1：所有 var(--x) 引用必须有定义（美化设计规范 §6.10）
// 拦截 --border 这类"被引用但从未定义"的静默失效问题
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const clientRoot = path.resolve(__dirname, '../../client')

function walkStyl (dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    if (st.isDirectory()) {
      walkStyl(p, out)
    } else if (name.endsWith('.styl')) {
      out.push(p)
    }
  }
  return out
}

const files = walkStyl(clientRoot)

// 定义点：css/includes/theme.styl（静态兜底）+ css/includes/tokens.styl（设计 token）
const definitionFiles = files.filter(f => /[\\/]css[\\/]includes[\\/](theme|tokens)\.styl$/.test(f))
const defined = new Set()
for (const f of definitionFiles) {
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*--([a-z0-9-]+)\s/)
    if (m) defined.add(m[1])
  }
}

// 上游 5.5.26 运行时注入 / jsx 内联注入的变量白名单
const whitelist = new Set([
  'left-side-bar-width', // main.jsx:187
  'footer-stack-height', // main.jsx:189（底栏三合一后仅一条 footer）
  'qm-bar-h', // main.jsx:199（快捷命令盒钉在底栏时 180px，右面板底部避让用）
  'below-footer-h', // main.jsx（T2）：resolveBottomStack.belowFooter
  'below-monitor-h', // main.jsx（T2）：resolveBottomStack.belowMonitor
  'bottom-reserved-h', // main.jsx（T2）：resolveBottomStack.reserved
  'shortcut-bar-h', // shortcut-bar.jsx:160
  'shortcut-bar-kb-offset', // shortcut-bar.jsx:148
  'ai-watermark', // ai-chat-empty.jsx:23
  'wco-controls-width', // 上游 title-bar-overlay: tabs.styl L29 局部定义,依赖 env(titlebar-area-*)
  'db-code-font' // db-session.jsx（S6）：DbSession 根部注入 tab.fontFamily || store._config.fontFamily，CSS 侧回落 --font-mono
])

// 收集全部 var(--x) 引用（含 var(--x, fallback) 形式，取逗号前的变量名）
const refs = new Map() // name -> [file:line]
for (const f of files) {
  const rel = path.relative(clientRoot, f)
  const content = fs.readFileSync(f, 'utf8')
  for (let i = 0; i < content.split('\n').length; i++) {
    const line = content.split('\n')[i]
    const re = /var\(\s*(--[a-z0-9-]+)/g
    let m
    while ((m = re.exec(line))) {
      const name = m[1].slice(2)
      if (!refs.has(name)) refs.set(name, [])
      refs.get(name).push(`${rel}:${i + 1}`)
    }
  }
}

describe('css-tokens: var() 引用必须有定义', () => {
  it('定义集合非空（theme.styl + tokens.styl 解析正常）', () => {
    assert.ok(defined.size >= 15, `定义数 ${defined.size} 应 ≥ 15（theme 15 + tokens 新增）`)
  })

  it('所有 var(--x) 引用的变量均已定义或在上游白名单中', () => {
    const missing = []
    for (const [name, locs] of refs) {
      if (!defined.has(name) && !whitelist.has(name)) {
        missing.push(`${name} ← ${locs.slice(0, 3).join(', ')}`)
      }
    }
    assert.deepEqual(missing, [], `以下变量被引用但从未定义:\n${missing.join('\n')}`)
  })

  it('tokens.styl 顶层（:root）无重复定义（.theme-light 覆盖块除外）', () => {
    const tokensFile = files.find(f => /[\\/]tokens\.styl$/.test(f))
    const names = fs.readFileSync(tokensFile, 'utf8')
      .split('\n')
      // 仅统计 0 缩进行（:root 顶层定义）；.theme-light 内的缩进覆盖是合法的分档
      .filter(l => /^--[a-z0-9-]+\s/.test(l))
      .map(l => (l.match(/^--([a-z0-9-]+)\s/) || [])[1])
      .filter(Boolean)
    const dup = names.filter((n, i) => names.indexOf(n) !== i)
    assert.deepEqual(dup, [], `重复定义: ${dup.join(', ')}`)
  })
})

describe('css-tokens: S6 数据面字体与终端统一（db-code-font）', () => {
  const dbStylPath = files.find(f => /database[\\/]db-session\.styl$/.test(f))
  const dbStyl = fs.readFileSync(dbStylPath, 'utf8')
  // N11b-#24：treeData（.db-tree-name 的全部包装点）已迁到 use-db-tree-data.jsx
  const dbJsx = fs.readFileSync(
    path.resolve(__dirname, '../../client/components/database/db-session.jsx'), 'utf8') +
    fs.readFileSync(
      path.resolve(__dirname, '../../client/components/database/use-db-tree-data.jsx'), 'utf8')
  // 数据面选择器（网格/键列表/SQL/错误信息/值预览/列聚合摘要/元数据树的对象名）
  // 必须走 --db-code-font，回落 --font-mono（tab/全局配置缺省时仍等宽）
  const dataFaceSelectors = [
    '.db-grid-table',
    '.db-redis-keys',
    '.db-sql-editor',
    '.db-conn-fail-raw',
    '.db-value-pre',
    '.db-cell-summary',
    '.db-tree-name'
  ]

  it('七个数据面选择器字体均为 var(--db-code-font, var(--font-mono))', () => {
    const missing = dataFaceSelectors.filter(sel => {
      const i = dbStyl.indexOf(sel + '\n')
      if (i < 0) return true
      const block = dbStyl.slice(i, i + 400)
      return !block.includes('font-family var(--db-code-font, var(--font-mono))')
    })
    assert.deepEqual(missing, [], `以下数据面未接入 db-code-font: ${missing.join(', ')}`)
  })

  it('根部注入点存在（jsx style 注入 + styl 禁连字）', () => {
    assert.match(dbJsx, /'--db-code-font': tab\.fontFamily \|\| window\.store\._config\?\.fontFamily/,
      'DbSession 必须注入 tab 字体 → 全局字体，缺省回落 CSS 侧')
    assert.match(dbStyl, /font-variant-ligatures none/, '数据面禁连字')
    // 反向：数据面不允许残留裸 var(--font-mono)（会绕过 tab 字体）。
    // 这条以前写成 includes('font-family var(--font-mono)')，于是带兜底的写法
    // `var(--font-mono, monospace)` 从缝里漏了出去 —— B3-1 的列聚合摘要
    // （.db-cell-summary）就是这么绕过 tab 字体的：数字与网格单元格不同源，
    // 设了终端/页签字体时 Σ/⌀ 那一行的字形跟着字体走、宽度对不上。
    const bare = dbStyl.split('\n').map((l, i) => ({ l, n: i + 1 }))
      .filter(x => /font-family\s+var\(\s*--font-mono\b/.test(x.l))
    assert.deepEqual(bare.map(x => `db-session.styl:${x.n}`), [],
      '数据面 font-family 不得直接用 --font-mono（含带兜底的 var(--font-mono, …)，须走 db-code-font 回落链）')
  })

  // P-1/P-2 的边界：只有"标识符"包进 .db-tree-name。这个包装点是数据面/界面字体的
  // 唯一分界，写漏一处那个对象就退回界面字体、多写一处（比如把本地化分组标签也包进去）
  // 就把界面词染成等宽 —— 实机 demo 量得到结果，量不到"是谁包的"，所以源码侧钉死。
  it('树的名字包装点：5 处标识符包 .db-tree-name，分组标签不包', () => {
    const wrapped = (dbJsx.match(/className='db-tree-name'/g) || []).length
    const redisName = (dbJsx.match(/className='db-tree-db-name db-tree-name'/g) || []).length
    // 叶子（有图标/无图标两条）+ schema + 库名 = 4 处独立 span，redis 库名在既有 span 上加类
    assert.equal(wrapped, 4, '树里包 .db-tree-name 的 span 数量变了，核对是不是漏了某一类标识符')
    assert.equal(redisName, 1, 'redis 库名（.db-tree-db-name）必须同时吃数据面字体')
    assert.ok(!/db-tree-name'>\{treeTitle\(e\(DB_GROUP_LABEL/.test(dbJsx),
      '分组标签是本地化界面词，不该包进 .db-tree-name')
  })

  // 行盒：树行高度由"这一行里最高的内联盒的字体度量"决定，不是由 line-height 继承决定。
  // 名字换成等宽后 normal 行高比界面字体高一档 → 名字行 23px→25px，与相邻的 chrome 行
  // （分组标签/计数/S 标记）不齐，U4 的"树行行高一致"就这么破了（self-test/db-tree-font-demo.js
  // 量到）。修复是把名字的 line-height 钉在行最小盒以下；这条把"必须显式钉住"钉成契约，
  // 否则以后有人删这行只会让运行时 demo 变红，源码侧毫无信号。
  it('.db-tree-name 必须显式钉住 line-height（等宽度量不再驱动树行高）', () => {
    const i = dbStyl.indexOf('.db-tree-name\n')
    assert.ok(i >= 0, '未找到 .db-tree-name 块')
    const rest = dbStyl.slice(i + '.db-tree-name\n'.length)
    const end = rest.search(/^\S/m)
    const block = (end < 0 ? rest : rest.slice(0, end))
    const lh = /^\s*line-height\s+(\d+)px\s*$/m.exec(block)
    assert.ok(lh, `.db-tree-name 缺显式 line-height（px）：${block.trim()}`)
    assert.ok(Number(lh[1]) <= 20,
      `line-height ${lh[1]}px 会重新驱动树行高（chrome 行 23px），必须钉在 20px 及以下`)
    assert.ok(!/display\s+inline-block/.test(block),
      '名字保持 inline：转 inline-block 会脱离与对象图标的基线对齐')
  })

  // 只钉 wrapper 那条不够：antd 在 Table 的 loading 容器 .ant-spin 与表根 .ant-table 上
  // 都重新声明了自己的 font-family（界面字体），这两层挂在 wrapper 下面 → 令牌停在
  // wrapper，单元格实际吃界面字体（真机实测 self-test/db-font-realdb.js F2：整棵网格
  // 子树只有这两个"字体重置点"，补一条会露出下一条）。这条把"令牌必须续到这两层"
  // 钉成契约，否则回归只在运行时才暴露。
  it('.db-grid-table 必须把字体续到 .ant-spin 与 .ant-table（否则单元格吃界面字体）', () => {
    const i = dbStyl.indexOf('.db-grid-table\n')
    assert.ok(i >= 0, '未找到 .db-grid-table 块')
    // 块到下一个顶格选择器为止；注释行不参与解析（注释里提到 .ant-spin 不算数）
    const rest = dbStyl.slice(i + '.db-grid-table\n'.length)
    const end = rest.search(/^\S/m)
    const lines = (end < 0 ? rest : rest.slice(0, end)).split('\n')
      .filter(l => !l.trim().startsWith('//'))
    // 两级缩进 = 子规则选择器（逗号续行拼成一条），四级缩进 = 该子规则的声明
    let sel = ''
    const declsBySel = []
    lines.forEach(l => {
      if (/^ {2}\S/.test(l)) {
        sel = (sel ? sel + ' ' : '') + l.trim().replace(/,$/, '')
        return
      }
      if (/^ {4}\S/.test(l) && sel) declsBySel.push({ sel, decl: l.trim() })
    })
    const mono = 'font-family var(--db-code-font, var(--font-mono))'
    const covered = declsBySel.filter(r => r.decl === mono).map(r => r.sel).join(' | ')
    assert.ok(/\.ant-spin(?![\w-])/.test(covered),
      `.db-grid-table 子规则未覆盖 .ant-spin（antd 在该层重置字体）：${covered || '块内无子规则'}`)
    assert.ok(/\.ant-table(?![\w-])/.test(covered),
      `.db-grid-table 子规则未覆盖 .ant-table（表根同样重置字体）：${covered || '块内无子规则'}`)
    assert.ok(!covered.includes('!important'), '网格字体修复不应依赖 !important')
  })
})

// U2 文字对比度：数据库工作台的"次级文字"必须吃随主题派生的 token。
// --text-dark / --text-disabled 是主题给的固定灰（未覆盖时 #888 / #777）：浅色主题够用，
// 但在比 default 亮一档的深底（iterm#Cobalt2、iterm#IC_Orange_PPL）上实测只有 4.31 / 4.27:1，
// 掉破正文 AA。--text-muted 由 --text 往 --main 收一档，深底自动提亮、浅底自动加深。
// 这条钉的是"被判据覆盖的那几个角色不许退回固定灰"，不是全仓扫（其他地方还有历史用法）。
describe('css-tokens: U2 数据库工作台次级文字走派生 token', () => {
  const dbStyl = fs.readFileSync(
    files.find(f => /database[\\/]db-session\.styl$/.test(f)), 'utf8')
  const lines = dbStyl.split('\n')

  // 选择器自己的样式块：从选择器行往下，吃进所有缩进行（含 &.xxx 嵌套），
  // 遇到下一个顶格行（新选择器/注释）收尾。返回**行数组**不返回字符串——
  // 返回字符串的话下面的 for...of 会逐字符遍历，判据看着在跑其实一条都没看到（假绿）
  const blockOf = selector => {
    const at = lines.findIndex(l => l === selector)
    if (at < 0) return null
    const out = []
    for (let i = at + 1; i < lines.length; i++) {
      const l = lines[i]
      if (l.trim() && !/^[ \t]/.test(l)) break
      out.push(l)
    }
    return out
  }

  // 允许的前景 token：正文 / 派生弱化 / 强调文字（--primary-text 是 --primary 收深后的 AA 版）。
  // 存的是 var(--x) 里捕获到的名字本身（不带前导 --），写错一个字符就全线误报（踩过）
  const SAFE = ['text', 'text-muted', 'primary-text']
  const unsafeColors = block => {
    assert.ok(Array.isArray(block) && block.length > 0, '样式块为空，判据没读到东西')
    const bad = []
    for (const l of block) {
      const m = /^\s*color\s+(.+)$/.exec(l)
      if (!m) continue
      const v = m[1].trim()
      const tok = /^var\(--([a-z0-9-]+)\)$/.exec(v)
      if (tok) {
        if (SAFE.indexOf(tok[1]) < 0) bad.push(v)
      } else if (v !== 'inherit') {
        bad.push(v)
      }
    }
    return bad
  }

  const probed = [
    ['.db-grid-total', '状态行次级'],
    ['.db-grid-selected', '已选计数'],
    ['.db-row-detail-type', '详情字段名'],
    ['.db-explain-type', '执行计划类型'],
    ['.db-row-detail-value', '详情值（含 &.is-null）']
  ]

  it('五个被判据覆盖的角色选择器在 styl 里都找得到（改了名字要同步判据）', () => {
    const gone = probed.filter(([sel]) => blockOf(sel) === null).map(([sel]) => sel)
    assert.deepEqual(gone, [], '以下选择器块不存在：' + gone.join(', '))
  })

  for (const [sel, label] of probed) {
    it(label + ' 的 color 只用 AA 派生 token（' + sel + '）', () => {
      const bad = unsafeColors(blockOf(sel))
      assert.deepEqual(bad, [], sel + ' 用了不达标的固定色：' + bad.join(', ') +
        '（正文用 --text，弱化用 --text-muted，强调文字用 --primary-text）')
    })
  }
})
