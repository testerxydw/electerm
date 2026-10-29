// H1a-4 · SQL 结果完整查看（设计 §1A.6 / §1A.11）
//
// 这一批只做"看得全"：单击结果网格的一格 → 底部挂完整值面板（只读），
// 预览卡超过 4000 字符时"查看完整" → 弹窗给全文。不改执行语义、不做行内编辑。
//
// 这里钉的是**接线契约**（真实源码抽取，不放拷贝实现）：
// 1) 折叠/展开走 DbSplitPane 的 collapsed，且**网格在 DOM 里的位置不变** ——
//    折叠时不渲染 DbSplitPane 会让表格整块重挂，虚拟滚动的滚动位置全丢；
// 2) 选中三元组 (rs, rowKey, col) 用的是结果内的绝对下标，翻页不指错行；
//    行取不到就当没选中，不留一个指向空气的面板；
// 3) 面板 editable=false 且不传 onSave —— SQL 结果是只读视图；
// 4) 全文弹窗挂在唯一那份预览卡上（5 处网格共用），并且开弹窗要先把卡片收掉。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const SESSION = path.join(ROOT, 'src/client/components/database/db-session.jsx')
const SPLIT = path.join(ROOT, 'src/client/components/database/db-split-pane.jsx')
const STYL = path.join(ROOT, 'src/client/components/database/db-session.styl')
const LOCALES = path.join(ROOT, 'src/app/common/locales-extra.js')

const jsx = () => fs.readFileSync(SESSION, 'utf8')
const splitSrc = () => fs.readFileSync(SPLIT, 'utf8')
const styl = () => fs.readFileSync(STYL, 'utf8')

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
    SQL_VALUE_META_MIN: Number((/const SQL_VALUE_META_MIN = (\d+)/.exec(jsx()) || [])[1]),
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

describe('SQL 结果区：选中一格才出现下方面板', () => {
  test('有结果时永远套 DbSplitPane，且用本批自己的持久化键', () => {
    const src = codeOf(jsx())
    assert.match(src, /const SQL_VALUE_SPLIT_KEY = 'electerm-db-sql-value-split'/)
    assert.match(src, /storageKey=\{SQL_VALUE_SPLIT_KEY\}/)
    assert.match(src, /\(sqlResult\.results \|\| \[\]\)\.length/)
    // 折叠判据 = "展开偏好 且 有选中格"，两个都不能少：
    // - 只看"有没有选中"：单击的一瞬间就切进 50/50 分区，而下面只有一条工具条，
    //   网格凭空矮一半
    // - 只看"展开偏好"：重新执行会清掉选中，面板还开着但内容没了 —— bottom 挂着
    //   半屏空气把网格压成一小条（CDP 实测 top 186 / bottom 503 空白）
    assert.match(src, /const sqlPaneShown = sqlPaneOpen && !!sqlCellInfo/)
    assert.match(src, /collapsed=\{!sqlPaneShown\}/)
    assert.ok(!/collapsed=\{!sqlValuePane\}/.test(src),
      'collapsed 不能只由"有没有选中"驱动，否则工具条态会占掉半个结果区')
    assert.ok(!/collapsed=\{!sqlPaneOpen\}/.test(src),
      'collapsed 不能只由"展开偏好"驱动，否则重跑清掉选中后半屏是空气')
    // 折叠态与展开态共用同一个 bottom 表达式位：展开出面板，否则出工具条
    assert.match(src, /bottom=\{sqlPaneShown \? sqlValuePane : sqlValueBar\}/)
  })

  test('单击选中：三元组用绝对行下标；不给双击编辑', () => {
    const src = codeOf(jsx())
    assert.match(src, /onClick: \(\) => setSqlCell\(\{ rs: i, col: k, rowKey: row\.__rowKey \}\)/)
    const onCell = /onCell: row => \(\{\n {12}onClick: \(\) => setSqlCell\([\s\S]*?\n {10}\}\),/.exec(src)
    assert.ok(onCell, 'SQL 结果的 onCell 结构变了')
    assert.ok(!/onDoubleClick/.test(onCell[1]), 'SQL 结果是只读视图，不该挂双击编辑')
    assert.ok(!/startEdit/.test(onCell[1]), '同上')
  })

  test('选中格有落点标记，且只有一处判定', () => {
    const src = codeOf(jsx())
    assert.equal((src.match(/db-cell-selected/g) || []).length, 1, 'class 只应在 SQL 列定义里出现一次')
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
    const min = Number((/const SQL_VALUE_META_MIN = (\d+)/.exec(jsx()) || [])[1])
    assert.ok(Number.isInteger(min) && min > 0, 'SQL_VALUE_META_MIN 必须是个正整数常量')
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
    const src = jsx()
    const m = /<DbValuePane[\s\S]*?onClose=\{\(\) => setSqlPaneOpen\(false\)\}/.exec(src)
    assert.ok(m, 'SQL 侧的 DbValuePane 挂载点没找到')
    assert.match(m[0], /editable=\{false\}/)
    assert.ok(!/onSave/.test(m[0]), '只读面板不该有保存回调')
    assert.match(m[0], /column=\{sqlCellInfo\.column\}/)
  })

  test('面板的 × 是"收回工具条"，不是清选中（还想用同一个面板）', () => {
    assert.match(codeOf(jsx()), /onClose=\{\(\) => setSqlPaneOpen\(false\)\}/)
  })

  test('工具条 × 取消选中且不冒泡成展开', () => {
    const src = codeOf(jsx())
    const m = /className='db-sql-value-bar-close'[\s\S]*?\n {10}\/>/.exec(src)
    assert.ok(m, '工具条的关闭按钮没找到')
    assert.match(m[0], /ev\.stopPropagation\(\)/)
    assert.match(m[0], /setSqlCell\(null\)/)
  })
})

describe('预览卡「查看完整」→ 全文弹窗', () => {
  test('onFullText 挂在唯一那份预览卡上（5 处网格共用一个入口）', () => {
    const src = jsx()
    assert.equal((src.match(/<DbCellPreview/g) || []).length, 1)
    assert.match(src, /onFullText=\{openFullText\}/)
  })

  test('开弹窗前先收卡片：否则浮层带着旧坐标压在弹窗上', () => {
    const src = codeOf(jsx())
    const m = /const openFullText = useCallback\(\(s\) => \{([\s\S]*?)\n {2}\}, \[handlePreviewHide\]\)/.exec(src)
    assert.ok(m, 'openFullText 结构变了')
    assert.match(m[1], /setFullText\(\{ col: s\.col, text: s\.text \}\)/)
    assert.match(m[1], /handlePreviewHide\(\)/)
  })

  test('弹窗给全文不截断，带字符数与复制（A2 DDL 弹窗同款）', () => {
    const src = codeOf(jsx())
    assert.match(src, /<pre className='db-full-text-pre'>\{fullText\.text\}<\/pre>/)
    assert.match(src, /onClick=\{\(\) => copy\(fullText\.text\)\}/)
    assert.match(src, /\{e\('dbCellChars'\)\.replace\('\{n\}', fullText\.text\.length\)\}/)
    assert.ok(!/fullText\.text\.slice/.test(src), '弹窗是全文出口，不该再截断')
  })

  test('CSS：全文区等宽、可滚动、可选中复制', () => {
    const css = /\.db-full-text-pre\n((?: {2}.*\n)+)/.exec(styl())
    assert.ok(css, '.db-full-text-pre 未定义')
    for (const want of ['white-space pre-wrap', 'word-break break-all', 'user-select text',
      'max-height 60vh', 'overflow auto', 'font-family var(--db-code-font']) {
      assert.ok(css[1].includes(want), '缺 ' + want)
    }
    assert.ok(!/#[0-9a-f]{3,6}/i.test(css[1]), '配色必须走 token')
  })
})

describe('词条与既有呈现一致', () => {
  test('本批新增词条中英成对', () => {
    const src = fs.readFileSync(LOCALES, 'utf8')
    for (const k of ['dbRowN', 'dbSqlValueBarHint', 'dbSqlValueBarClose']) {
      assert.equal((src.match(new RegExp('\\n\\s*' + k + ':', 'g')) || []).length, 2, k + ' 必须中英各一条')
    }
    assert.match(src, /dbRowN: 'row \{n\}'/)
    assert.match(src, /dbRowN: '第 \{n\} 行'/)
  })

  test('数据页标题不再出现裸英文 " - row "（与 SQL 面板同一套文案）', () => {
    assert.ok(!codeOf(jsx()).includes("' - row '"), '数据页标题应改走 dbRowN')
    assert.equal((jsx().match(/e\('dbRowN'\)/g) || []).length, 2)
  })
})
