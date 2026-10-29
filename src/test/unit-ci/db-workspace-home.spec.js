// U1c 数据页空态：工作台首页
//
// 没选中表时数据页原来是一张空网格（表名为空、控件全隐藏，看起来像坏了）。
// 现在换成 DbWorkspaceHome：连接摘要 + 四个快捷入口 + metadata 里的前 8 张表。
//
// 钉三件事：
//   1) 组件只做快捷入口 —— 不碰 IPC、不新增持久化（数据请求全在 db-session 的既有闭包里）
//   2) 空态只在"非 Redis 且未选中表"时替换数据页，选中表后回到原网格
//   3) "最近表"取当前 metadata 的前 8 张表，只收表（视图/过程不进这个列表）
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

const HOME = 'src/client/components/database/db-workspace-home.jsx'
const SESSION = 'src/client/components/database/db-session.jsx'
const STYL = 'src/client/components/database/db-session.styl'
const LOCALES = 'src/app/common/locales-extra.js'

const codeOf = src => src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

const homeSrc = () => codeOf(read(HOME))

const sessionSrc = () => codeOf(read(SESSION))

// 空态装配块：从 workspaceHome 到它后面第一个顶层 const
const homeMount = () => {
  const src = sessionSrc()
  const start = src.indexOf('const workspaceHome = (')
  assert.notEqual(start, -1, 'workspaceHome 未找到')
  const end = src.indexOf('\n  const ', start + 10)
  assert.ok(end > start, 'workspaceHome 的收尾未找到')
  return src.slice(start, end)
}

const homeTablesMemo = () => {
  const src = sessionSrc()
  const start = src.indexOf('const homeTables = useMemo(')
  assert.notEqual(start, -1, 'homeTables 未找到')
  const deps = '\n  }, [isRedis, metadata])'
  const end = src.indexOf(deps, start)
  assert.ok(end > start, 'homeTables 的依赖数组未找到')
  return src.slice(start, end + deps.length)
}

describe('U1c 空态组件', () => {
  test('四个快捷入口：刷新元数据 / 打开 SQL / 快速打开 / 导入到表', () => {
    const src = homeSrc()
    for (const key of ['dbHomeRefresh', 'dbHomeSql', 'dbHomeQuick', 'dbHomeImport']) {
      assert.match(src, new RegExp("e\\('" + key + "'\\)"), key + ' 没进空态')
    }
  })

  test('组件零 IPC：不直接调 runGlobalAsync / dbClientOp', () => {
    const src = homeSrc()
    assert.doesNotMatch(src, /runGlobalAsync/)
    assert.doesNotMatch(src, /dbClientOp/)
    assert.doesNotMatch(src, /setConfig/, '空态不写配置（最近表不落存储）')
  })

  test('连接摘要带引擎/目标，只读与生产各一枚标记', () => {
    const src = homeSrc()
    assert.match(src, /className='db-home-engine'/)
    assert.match(src, /className='db-home-target'/)
    assert.match(src, /production[\s\S]{0,80}dbRiskProduction/)
    assert.match(src, /readonly[\s\S]{0,80}e\('readOnly'\)/)
  })

  test('导入按表落地：菜单列可导入的表，只读或无表时整组禁用', () => {
    const src = homeSrc()
    assert.match(src, /const canImport = !readonly && tables\.length > 0/)
    assert.match(src, /items: tables\.map\(t => \(\{ key: t\.key, label: t\.title \}\)\)/)
    assert.match(src, /disabled=\{!canImport\}/)
    assert.match(src, /title=\{readonly \? e\('dbImportReadonly'\)/, '只读时给原因，不给一个点了没反应的按钮')
  })

  test('最近表用原生 button（可 Tab、回车即开），文案走 i18n', () => {
    const src = homeSrc()
    assert.match(src, /<button\n\s*key=\{t\.key\}\n\s*type='button'\n\s*className='db-home-table'/)
    assert.match(src, /e\('dbHomeRecent'\)/)
    assert.match(src, /e\('dbHomeNoTables'\)/)
  })
})

describe('U1c 空态装配', () => {
  test('只在"未选中表"时替换数据页；选中后回到原网格', () => {
    const src = sessionSrc()
    assert.match(src, /children: sel \? dataArea : workspaceHome/)
    assert.match(src, /activeKey=\{mainTab\}\n\s*onChange=\{setMainTab\}/)
  })

  test('四个入口全部复用既有闭包，不新增数据请求', () => {
    const mount = homeMount()
    assert.match(mount, /onRefresh=\{\(\) => loadTree\(\)\}/)
    assert.match(mount, /onOpenSql=\{\(\) => setMainTab\('sql'\)\}/)
    assert.match(mount, /onQuickOpen=\{\(\) => setQuickOpen\(true\)\}/)
    assert.match(mount, /onOpenTable=\{t => openTable\(t\)\}/)
    assert.doesNotMatch(mount, /runGlobalAsync/)
  })

  test('导入先打开表再弹向导（向导要读列清单）', () => {
    const mount = homeMount()
    assert.match(mount, /onImportTable=\{t => \{\s*setMainTab\('data'\)\s*openTable\(t\)\.then\(\(\) => setImportOpen\(true\)\)/)
  })

  test('最近表取 metadata 前 8 张、只收表', () => {
    const memo = homeTablesMemo()
    assert.match(sessionSrc(), /const HOME_TABLES_MAX = 8/)
    assert.match(memo, /out\.length >= HOME_TABLES_MAX/)
    assert.match(memo, /node\.type === 'table' \|\| !node\.type/)
    assert.match(memo, /if \(node\.type === 'group'\) \{\s*continue\s*\}/, '库内对象分组里没有表')
    assert.match(memo, /if \(isRedis\) \{\s*return out\s*\}/, 'Redis 无表概念')
    assert.match(memo, /\}, \[isRedis, metadata\]\)/, '只依赖 metadata，不随翻页/编辑重算')
  })

  test('打开表收成一条路径：树点击与空态共用（含竞态令牌）', () => {
    const src = sessionSrc()
    const start = src.indexOf('const openTable = (target) => {')
    assert.notEqual(start, -1, 'openTable 未找到')
    const end = src.indexOf('\n  }\n', start)
    const body = src.slice(start, end)
    assert.match(body, /viewSeqRef\.current \+= 1/)
    assert.match(body, /return loadStructure\(next\)/, '要返回 promise')
    assert.match(body, /setSel\(next\)\s*return loadQuery\(next, 1\)/)
    // 树点击那段单独取（onSelectTree 里 Redis 分支还会涨，别用固定字符窗口）
    const treeAt = src.indexOf('const onSelectTree = ', end)
    assert.notEqual(treeAt, -1, 'onSelectTree 未找到')
    const treeClick = src.slice(treeAt, src.indexOf('\n  const ', treeAt + 10))
    assert.match(treeClick, /openTable\(\{ database, schema, table, nodeType: node\.nodeType \}\)/,
      '树点击走同一条路径')
  })
})

describe('U1c 空态样式与文案', () => {
  test('卡片与表名芯片只用 token，不写裸色值', () => {
    const styl = read(STYL)
    const at = styl.indexOf('.db-home-card')
    assert.ok(at > 0)
    const block = styl.slice(at, styl.indexOf('.db-grid-title'))
    assert.match(block, /border 1px solid var\(--border\)/)
    assert.match(block, /border-radius var\(--radius-lg\)/)
    assert.match(block, /background var\(--surface-1\)/)
    assert.equal(/#[0-9a-f]{3,8}\b/i.test(block), false, '空态样式里不该出现裸色值')
  })

  test('表名芯片有 hover 与 focus-visible 两态（键盘可达要看得见）', () => {
    const styl = read(STYL)
    assert.match(styl, /\.db-home-table[\s\S]*?&:hover\n\s+border-color var\(--primary\)/)
    assert.match(styl, /&:focus-visible\n\s+outline 2px solid var\(--primary\)/)
  })

  test('en 与 zh_cn 同步补齐空态文案', () => {
    const src = read(LOCALES)
    const keys = ['dbHomeTitle', 'dbHomeHint', 'dbHomeRefresh', 'dbHomeSql', 'dbHomeQuick',
      'dbHomeImport', 'dbHomeRecent', 'dbHomeRecentHint', 'dbHomeNoTables']
    for (const k of keys) {
      assert.equal((src.match(new RegExp('  ' + k + ':', 'g')) || []).length, 2, k + ' 要在 en 与 zh_cn 各出现一次')
    }
  })
})
