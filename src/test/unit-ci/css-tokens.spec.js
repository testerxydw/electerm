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
  const dbJsx = fs.readFileSync(
    path.resolve(__dirname, '../../client/components/database/db-session.jsx'), 'utf8')
  // 数据面选择器（网格/键列表/SQL/错误信息/值预览）必须走 --db-code-font
  // 回落 --font-mono（tab/全局配置缺省时仍等宽）
  const dataFaceSelectors = [
    '.db-grid-table',
    '.db-redis-keys',
    '.db-sql-editor',
    '.db-conn-fail-raw',
    '.db-value-pre'
  ]

  it('五个数据面选择器字体均为 var(--db-code-font, var(--font-mono))', () => {
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
    // 反向：数据面不允许残留裸 var(--font-mono)（会绕过 tab 字体）
    const bare = dbStyl.split('\n').map((l, i) => ({ l, n: i + 1 }))
      .filter(x => x.l.includes('font-family var(--font-mono)'))
    assert.deepEqual(bare.map(x => `db-session.styl:${x.n}`), [],
      '数据面 font-family 不得直接用 --font-mono（须带 db-code-font 回落链）')
  })
})
