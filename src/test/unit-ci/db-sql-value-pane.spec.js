// H1a-4 · SQL 结果完整查看（设计 §1A.6 / §1A.11）
//
// 这一批只做"看得全"：单击结果网格的一格 → 底部挂完整值面板（只读）。
// 2026-10-29 按用户反馈改成交互：去掉悬停预览卡与"单击展开"的折叠工具条，
// 点一格就展开面板，与数据页点格打开下方预览框对齐。不改执行语义、不做行内编辑。
//
// 这里钉的是**接线契约**（真实源码抽取，不放拷贝实现）：
// 1) 展开/收起走 DbSplitPane 的 collapsed，且**网格在 DOM 里的位置不变** ——
//    折叠时不渲染 DbSplitPane 会让表格整块重挂，虚拟滚动的滚动位置全丢；
// 2) 选中三元组 (rs, rowKey, col) 用的是结果内的绝对下标，翻页不指错行；
//    行取不到就当没选中，不留一个指向空气的面板；
// 3) 面板 editable=false 且不传 onSave —— SQL 结果是只读视图；
// 4) 5 处数据库网格都不再挂悬停预览卡（没有 DbCellPreview 这个组件了）。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const SESSION = path.join(ROOT, 'src/client/components/database/db-session.jsx')
// N11a：纯常量/纯函数搬到了 common/db-session-const.js，声明级断言跟过去
const SESSION_CONST = path.join(ROOT, 'src/client/common/db-session-const.js')
const SPLIT = path.join(ROOT, 'src/client/components/database/db-split-pane.jsx')
const PREVIEW = path.join(ROOT, 'src/client/components/database/db-cell-preview.jsx')
const STYL = path.join(ROOT, 'src/client/components/database/db-session.styl')
const LOCALES = path.join(ROOT, 'src/app/common/locales-extra.js')

// N11b-#23：sqlCellInfo / sqlValuePane / sqlPaneShown 已迁到 use-db-sql-result-columns.jsx
const SQL_RESULT_COLUMNS = path.join(ROOT, 'src/client/components/database/use-db-sql-result-columns.jsx')
const sqlPaneSrc = () => fs.readFileSync(SQL_RESULT_COLUMNS, 'utf8')
const jsx = () => fs.readFileSync(SESSION, 'utf8') + '\n' + sqlPaneSrc()
const consts = () => fs.readFileSync(SESSION_CONST, 'utf8')
const metaMin = () => Number((/const VALUE_META_MIN = (\d+)/.exec(consts()) || [])[1])
const splitSrc = () => fs.readFileSync(SPLIT, 'utf8')
const styl = () => fs.readFileSync(STYL, 'utf8')
// H1a-4：SQL 结果列定义并入公共列工厂，单元格级契约跟着挪过去
const COLS = path.join(ROOT, 'src/client/components/database/db-grid-columns.jsx')
const colFactory = () => fs.readFileSync(COLS, 'utf8')

// 去掉行注释：契约钉的是"代码里有没有这一句"，不是"注释里提没提"
function codeOf (src) {
  return src.split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n')
}

// 抽出 sqlCellInfo 这个 useMemo 的函数体，在 vm 里真跑（不复制实现）
function loadSqlCellInfo () {
  const m = /const sqlCellInfo = useMemo\(\(\) => \{([\s\S]*?)\n {2}\}, \[sqlCell, sqlResult\.results, sqlColTypeMaps\]\)/
    .exec(jsx())
  assert.ok(m, 'sqlCellInfo useMemo not found (改名或依赖表变了，先看设计 §1A.11)')
  const ctx = vm.createContext({
    Number,
    String,
    Array,
    VALUE_META_MIN: metaMin(),
    isBinaryType: t => /blob|bytea|binary|^varbinary$/.test(String(t || '').toLowerCase()),
    isBinEnvelope: v => !!(v && typeof v === 'object' && v.__bin),
    e: k => ({ dbResultN: 'result {n}', dbRowN: 'row {n}' })[k] || k
  })
  const fn = vm.runInContext('(function () {' + m[1] + ' })', ctx)
  return (sqlCell, results, typeMaps) => {
    ctx.sqlCell = sqlCell
    ctx.sqlResult = { results }
    ctx.sqlColTypeMaps = typeMaps
    return fn()
  }
}

describe('DbSplitPane：collapsed 是"同一条 DOM 链路"的折叠', () => {
  test('props 里有 collapsed，且默认展开（不影响既有 3 处调用）', () => {
    assert.match(splitSrc(), /const \{ storageKey, defaultPct = 50, top, bottom, collapsed = false \} = props/)
  })

  test('折叠分支不渲染 resizer（没有可拖的东西，也不给 row-resize 光标）', () => {
    const src = splitSrc()
    const m = /if \(collapsed\) \{([\s\S]*?)\n {2}\}\n/.exec(src)
    assert.ok(m, 'collapsed 分支没找到')
    assert.match(m[1], /db-split-pane-collapsed/)
    assert.ok(!/db-split-resizer/.test(m[1]), '折叠态不该有拖拽条')
    // top / bottom 各自仍是同一个容器类名：换类名可以，换 DOM 层级会让表格重挂
    assert.match(m[1], /className='db-split-pane-top'/)
    assert.match(m[1], /className='db-split-pane-bottom'/)
  })

  test('collapsed 判断在 useState 之后（hook 数量不随分支变化）', () => {
    const src = splitSrc()
    assert.ok(src.indexOf('useState(') < src.indexOf('if (collapsed)'),
      'collapsed 提前 return 不能抢在 hook 之前')
  })

  test('CSS：折叠态 top 吃满、bottom 按内容高', () => {
    const block = /\.db-split-pane-collapsed\n((?: {2}.*\n)+)/.exec(styl())
    assert.ok(block, '.db-split-pane-collapsed 未定义')
    assert.match(block[1], /> \.db-split-pane-top\n {4}flex 1 1 auto/)
    assert.match(block[1], /> \.db-split-pane-bottom\n {4}flex 0 0 auto/)
  })
})

describe('SQL 结果区：选中一格就展开下方面板', () => {
  test('有结果时永远套 DbSplitPane，且用本批自己的持久化键', () => {
    const src = codeOf(jsx())
    assert.match(codeOf(consts()), /const SQL_VALUE_SPLIT_KEY = 'electerm-db-sql-value-split'/)
    assert.match(src, /storageKey=\{SQL_VALUE_SPLIT_KEY\}/)
    assert.match(src, /\(sqlResult\.results \|\| \[\]\)\.length/)
    // 折叠判据 = "有没有选中格"。重新执行会清掉选中，面板跟着收起；
    // 只看"展开偏好"的话，重跑后 bottom 挂着半屏空气把网格压成一小条
    // （CDP 实测 top 186 / bottom 503 空白）
    assert.match(src, /const sqlPaneShown = !!sqlCellInfo/)
    assert.match(src, /collapsed=\{!sqlPaneShown\}/)
    assert.ok(!/sqlPaneOpen/.test(src), '不再有"折叠/展开"中间态：点一格直接展开')
    assert.ok(!/sqlValueBar/.test(src), '折叠提示条已删除')
    // bottom 只有一种内容：完整值面板（无选中时由 collapsed 收起）
    assert.match(src, /bottom=\{sqlValuePane\}/)
  })

  test('单击选中：三元组用绝对行下标；不给双击编辑', () => {
    const src = codeOf(jsx())
    const colSrc = codeOf(colFactory())
    // 三元组 (rs, col, rowKey) 的组装在调用点 selectCell 适配器里，onClick 在列工厂
    assert.match(src, /selectCell: \(row, k\) => setSqlCell\(\{ rs: i, col: k, rowKey: row\.__rowKey \}\)/)
    assert.match(colSrc, /onClick: \(\) => selectCell\(row, k\)/)
    const block = src.slice(src.indexOf('const sqlResultColumns = useMemo('), src.indexOf('const sqlSortNumeric'))
    assert.ok(!/\beditable\b/.test(block), 'SQL 结果是只读视图，不该进可编辑能力')
    assert.ok(!/startEdit/.test(block), '同上')
  })

  test('选中格有落点标记，判定只长在列定义里', () => {
    const src = codeOf(jsx())
    const colSrc = codeOf(colFactory())
    // 两处 = 列工厂（数据页/SQL 共用那份列定义）+ Redis 详情的选中格工厂
    // （5 张详情表共用那一个工厂）；再冒出新的一处就说明有人把 class 写到了 render 里
    const total = (src.match(/db-cell-selected/g) || []).length +
      (colSrc.match(/db-cell-selected/g) || []).length
    assert.equal(total, 2, 'class 只应出现在列工厂与 Redis 选中格工厂里')
    const css = /\.db-cell-selected\n((?: {2}.*\n)+)/.exec(styl())
    assert.ok(css, '.db-cell-selected 未定义')
    assert.match(css[1], /box-shadow inset 0 0 0 1px var\(--primary\)/)
    assert.ok(!/#[0-9a-f]{3,6}/i.test(css[1]), '描边色必须走 token')
  })

  test('重新执行 = 清选中（与列宽同一批"新一轮"语义）', () => {
    const src = codeOf(jsx())
    assert.match(src, /setSqlPages\(\{\}\)\n {4}setSqlCell\(null\)/)
  })
})

describe('sqlCellInfo：面板数据取自结果集与类型契约（真实源码）', () => {
  const results = (rows, extra) => [{ rows, fields: Object.keys(rows[0] || {}), ...(extra || {}) }]
  const maps = types => [Object.keys(types).reduce((acc, k) => {
    acc[k.toLowerCase()] = types[k]
    return acc
  }, Object.create(null))]

  test('未选中 / 行取不到 → null（不留指向空气的面板）', () => {
    const info = loadSqlCellInfo()
    assert.equal(info(null, [], []), null)
    assert.equal(info({ rs: 0, col: 'a', rowKey: 3 }, results([{ a: 1 }]), maps({ a: 'int' })), null)
    assert.equal(info({ rs: 5, col: 'a', rowKey: 0 }, results([{ a: 1 }]), maps({ a: 'int' })), null)
  })

  test('值按绝对行下标现取；列名大小写不影响类型查找', () => {
    const info = loadSqlCellInfo()
    const rows = [{ ID: 1 }, { ID: 2 }, { ID: 3 }]
    const got = info({ rs: 0, col: 'ID', rowKey: 2 }, results(rows), maps({ id: 'bigint' }))
    assert.equal(got.value, 3)
    assert.equal(got.column.type, 'bigint')
    assert.equal(got.column.isBinary, false)
  })

  test('二进制列把 isBinary 交给值面板的呈现器选型（否则只给文本视图）', () => {
    const info = loadSqlCellInfo()
    const got = info({ rs: 0, col: 'blob_col', rowKey: 0 }, results([{ blob_col: 'x' }]), maps({ blob_col: 'blob' }))
    assert.equal(got.column.isBinary, true)
  })

  test('长字符串给字符数、二进制信封给字节数、短值与其余不硬凑', () => {
    const info = loadSqlCellInfo()
    const min = metaMin()
    assert.ok(Number.isInteger(min) && min > 0, 'VALUE_META_MIN 必须是个正整数常量')
    // 阈值两侧都要钉住：格子本来就看得全的短值不该挂计数，超出的必须挂
    assert.equal(info({ rs: 0, col: 'a', rowKey: 0 }, results([{ a: 'note-5' }]), maps({ a: 'varchar' })).meta, '')
    assert.equal(
      info({ rs: 0, col: 'a', rowKey: 0 }, results([{ a: 'x'.repeat(min) }]), maps({ a: 'varchar' })).meta, ''
    )
    assert.equal(
      info({ rs: 0, col: 'a', rowKey: 0 }, results([{ a: 'x'.repeat(min + 1) }]), maps({ a: 'varchar' })).meta,
      (min + 1) + ' chars'
    )
    assert.equal(
      info({ rs: 0, col: 'b', rowKey: 0 }, results([{ b: { __bin: { size: 8 } } }]), maps({ b: 'blob' })).meta,
      '8 bytes'
    )
    assert.equal(info({ rs: 0, col: 'c', rowKey: 0 }, results([{ c: 12 }]), maps({ c: 'int' })).meta, '')
  })

  test('单结果集标题不带"结果 N"，多结果集必须带（页签在上、面板在下要对得上号）', () => {
    const info = loadSqlCellInfo()
    const rows = () => [{ a: 'A-0' }, { a: 'A-1' }, { a: 'A-2' }, { a: 'A-3' }, { a: 'A-4' }]
    const one = info({ rs: 0, col: 'a', rowKey: 4 }, results(rows()), maps({ a: 'int' }))
    assert.equal(one.title, 'a · row 5')
    assert.equal(one.value, 'A-4')
    const two = info({ rs: 1, col: 'a', rowKey: 4 },
      [{ rows: rows() }, { rows: rows() }],
      [Object.create(null), { a: 'int' }])
    assert.equal(two.title, 'result 2 · a · row 5')
  })
})

describe('完整值面板：只读复用 DbValuePane', () => {
  test('editable=false 且不传 onSave（SQL 结果不写回）', () => {
    // N11b-#23：SQL 侧的 DbValuePane 挂载点已迁到 use-db-sql-result-columns.jsx。
    // 这里必须只读 hook 文件：owner 里数据页还有别的 <DbValuePane>（带 onSave），
    // 拼在一起时非贪婪正则会先命中数据页那处，断言就成了假阳性
    const m = /<DbValuePane[\s\S]*?onClose=\{\(\) => setSqlCell\(null\)\}/.exec(sqlPaneSrc())
    assert.ok(m, 'SQL 侧的 DbValuePane 挂载点没找到')
    assert.match(m[0], /editable=\{false\}/)
    assert.ok(!/onSave/.test(m[0]), '只读面板不该有保存回调')
    assert.match(m[0], /column=\{sqlCellInfo\.column\}/)
  })

  test('面板的 × 直接取消选中（与数据页关闭预览框同一语义）', () => {
    assert.match(codeOf(sqlPaneSrc()), /onClose=\{\(\) => setSqlCell\(null\)\}/)
  })
})

describe('悬停预览卡已移除（全部数据库网格）', () => {
  test('组件文件已删除，渲染器里也不再引用', () => {
    assert.ok(!fs.existsSync(PREVIEW), 'db-cell-preview.jsx 应已删除')
    const src = jsx()
    assert.ok(!/DbCellPreview|useCellPreview|previewProps/.test(src), 'db-session 里不该再有预览卡接线')
    assert.ok(!/openFullText|db-full-text/.test(src), '"查看完整"弹窗随预览卡一起删除')
  })

  test('单元格截断仍关闭原生 title（保留单一路径的悬停观感）', () => {
    // CELL_ELLIPSIS 随列定义搬进公共列工厂
    assert.match(codeOf(colFactory()), /const CELL_ELLIPSIS = \{ showTitle: false \}/)
  })

  test('CSS：预览卡与折叠工具条样式一并清掉', () => {
    const css = styl()
    for (const cls of ['db-cell-preview', 'db-sql-value-bar', 'db-full-text-pre', 'db-full-text-meta']) {
      assert.ok(!css.includes(cls), cls + ' 样式应已删除')
    }
  })
})

describe('词条与既有呈现一致', () => {
  test('本批保留词条中英成对', () => {
    const src = fs.readFileSync(LOCALES, 'utf8')
    for (const k of ['dbRowN']) {
      assert.equal((src.match(new RegExp('\\n\\s*' + k + ':', 'g')) || []).length, 2, k + ' 必须中英各一条')
    }
    assert.match(src, /dbRowN: 'row \{n\}'/)
    assert.match(src, /dbRowN: '第 \{n\} 行'/)
  })

  test('预览卡/工具条词条随组件一起删除', () => {
    const src = fs.readFileSync(LOCALES, 'utf8')
    for (const k of ['dbCellChars', 'dbCellTruncated', 'dbViewFullText',
      'dbSqlValueBarHint', 'dbSqlValueBarClose']) {
      assert.ok(!new RegExp('\\n\\s*' + k + ':').test(src), k + ' 已无引用，应删除')
    }
  })

  test('数据页标题不再出现裸英文 " - row "（与 SQL 面板同一套文案）', () => {
    assert.ok(!codeOf(jsx()).includes("' - row '"), '数据页标题应改走 dbRowN')
    // 三处 = 数据页 + SQL 结果 + Redis 详情：三张表的"第 N 行"必须是同一条文案
    assert.equal((jsx().match(/e\('dbRowN'\)/g) || []).length, 3)
  })
})
