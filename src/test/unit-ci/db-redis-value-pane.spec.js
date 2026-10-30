// Redis 详情四张表（hash / list / set / zset）的"单击一格 → 底部只读值面板"
// （设计 §1A.12 里记下的那条成本：悬停预览卡下线后，长键值只剩拖宽列和双击编辑两条路，
//  只读连接连编辑都没有，等于看不到全文）
//
// 钉的是接线契约，实现从真实源码里抽出来在 vm 里跑，不放拷贝实现：
// 1) 折叠判据是"有没有选中格"，且折叠走 DbSplitPane 的同一条 DOM 链路（网格不重挂）；
// 2) string 键的详情本身就是值面板，不能再套一层分区容器；
// 3) 选中态记 (列, 列标签, rowKey, rowNo) 四元组：zset 的 __rowKey 是平铺数组下标
//    （0/2/4），行号必须由点击时的 index 单独给，否则标题写成「第 3 行」而用户点的是第 2 行；
// 4) 单击与双击行内编辑共存（展开面板不能抢走 D 批那条写路径）；
// 5) 面板只读（editable=false、无 onSave），× 即取消选中；
// 6) 换键清选中，追加下一页不清（那一行还在原地）。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const SESSION = path.join(ROOT, 'src/client/components/database/db-session.jsx')

const jsx = () => fs.readFileSync(SESSION, 'utf8')

// 去掉行注释：契约钉的是"代码里有没有这一句"，不是"注释里提没提"
function codeOf (src) {
  return src.split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n')
}

function metaMin () {
  return Number((/const VALUE_META_MIN = (\d+)/.exec(jsx()) || [])[1])
}

// 抽出 redisCellInfo 这个 useMemo 的函数体，在 vm 里真跑
function loadRedisCellInfo () {
  const m = /const redisCellInfo = useMemo\(\(\) => \{([\s\S]*?)\n {2}\}, \[redisCell, redisDetailRows\]\)/
    .exec(jsx())
  assert.ok(m, 'redisCellInfo useMemo 没找到（改名或依赖表变了）')
  const ctx = vm.createContext({
    String,
    Number,
    VALUE_META_MIN: metaMin(),
    isBinEnvelope: v => !!(v && typeof v === 'object' && v.__bin),
    e: k => ({ dbRowN: 'row {n}' })[k] || k
  })
  const fn = vm.runInContext('(function () {' + m[1] + ' })', ctx)
  return (redisCell, redisDetailRows) => {
    ctx.redisCell = redisCell
    ctx.redisDetailRows = redisDetailRows
    return fn()
  }
}

describe('Redis 详情值面板：折叠与容器接线', () => {
  test('本批用独立的分区键（不与 SQL / 键列表共用一个高度比例）', () => {
    const src = codeOf(jsx())
    assert.match(src, /const REDIS_VALUE_SPLIT_KEY = 'electerm-db-redis-value-split'/)
    assert.match(src, /storageKey=\{REDIS_VALUE_SPLIT_KEY\}/)
  })

  test('折叠判据 = 没有选中格；bottom 只有值面板一种内容', () => {
    const src = codeOf(jsx())
    assert.match(src, /collapsed=\{!redisCellInfo\}/)
    assert.match(src, /bottom=\{redisValuePane\}/)
  })

  test('只有 hash/list/set/zset 四类套分区：string 详情本身就是面板，不套两层', () => {
    const src = codeOf(jsx())
    assert.match(src, /d && d\.type !== 'string'\n {12}\?\s*\(\n {14}<DbSplitPane/)
    assert.match(src, /d && d\.type !== 'string'\n {12}\?\s*\(\n {14}<DbSplitPane[\s\S]*?\n {12}: body/)
  })

  test('面板只读：editable=false、不传 onSave、× 就是取消选中', () => {
    const src = jsx()
    const m = /<DbValuePane\n {8}title=\{redisCellInfo\.title\}[\s\S]*?\n {6}\/>/.exec(src)
    assert.ok(m, 'Redis 侧 DbValuePane 挂载点没找到')
    assert.match(m[0], /meta=\{redisCellInfo\.meta\}/)
    assert.match(m[0], /value=\{redisCellInfo\.value\}/)
    assert.match(m[0], /column=\{redisCellInfo\.column\}/)
    assert.match(m[0], /patterns=\{keywordPatterns\}/)
    assert.match(m[0], /themeConfig=\{themeConfig\}/)
    assert.match(m[0], /editable=\{false\}/)
    assert.match(m[0], /onClose=\{\(\) => setRedisCell\(null\)\}/)
    assert.ok(!/onSave/.test(m[0]), '详情值面板是只读视图，不该有保存回调')
  })
})

describe('Redis 详情选中：四元组与四张表的接线', () => {
  test('单击记 (列, 列标签, rowKey, rowNo)，行号来自点击时的 index', () => {
    const src = codeOf(jsx())
    assert.match(src, /onClick: \(\) => setRedisCell\(\{ col, label, rowKey: record\.__rowKey, rowNo: \(index \|\| 0\) \+ 1 \}\)/)
    // 选中态与 SQL 结果那条路径同类：class 只在选中时挂
    const helper = /const redisCellProps = \(col, label\) => \(record, index\) => \(\{([\s\S]*?)\n {2}\}\)/.exec(src)
    assert.ok(helper, 'redisCellProps 结构变了')
    assert.match(helper[1], /db-cell-selected/)
  })

  test('四张表的可点列都接上，且双击行内编辑仍在同一条 onCell 里', () => {
    const src = codeOf(jsx())
    const want = [
      ["redisCellProps('field', e('dbField'))", 1],
      ["redisCellProps('value', e('dbValue'))", 2],
      ["redisCellProps('member', e('dbMember'))", 2],
      ["redisCellProps('score', e('dbScore'))", 1]
    ]
    for (const [frag, n] of want) {
      assert.equal((src.split(frag).length || 1) - 1, n, frag + ' 出现次数不对')
    }
    // 合并写法：展开单击的 props 后再挂 onDoubleClick，两者共用一个 onCell
    const merged = /\.\.\.redisCellProps\('value', e\('dbValue'\)\)\(r, i\),\n {18}onDoubleClick: \(\) => editRedisCell\(r, 'value', r\.value\)/
    assert.ok(merged.test(src), 'hash value 列的"单击开面板 + 双击编辑"合并写法丢了')
    assert.equal((src.match(/\.\.\.redisCellProps\(/g) || []).length, 5,
      'hash 值 / list 值 / set 成员 / zset 成员 / zset 分数是"展开单击 props 再挂双击"的合并写法，' +
      '只有 hash 字段列直接传函数引用')
  })

  test('换键清选中，追加下一页不清（那一行还在原地）', () => {
    const src = jsx()
    const sel = /const selectRedisKey = \(key, cursor = '0', append = false\) => \{\n {4}if \(!append\) \{([\s\S]*?)\n {4}\}/.exec(src)
    assert.ok(sel, 'selectRedisKey 的 !append 分支变了')
    assert.match(sel[1], /setRedisCell\(null\)/)
    // 清选中的位置只有两处：换键（!append 分支）与面板 ×；追加下一页不该动选中态
    assert.equal((src.match(/setRedisCell\(null\)/g) || []).length, 2)
  })
})

describe('redisCellInfo：面板数据按 rowKey 现取（真实源码）', () => {
  const hashRows = [
    { __rowKey: 0, field: 'payload', value: 'x'.repeat(metaMin() + 1) },
    { __rowKey: 1, field: 'note', value: 'short' }
  ]

  test('未选中 / 行取不到 → null，不给一个指向空气的面板', () => {
    const info = loadRedisCellInfo()
    assert.equal(info(null, hashRows), null)
    assert.equal(info({ col: 'value', label: '值', rowKey: 9, rowNo: 10 }, hashRows), null)
    assert.equal(info({ col: 'value', label: '值', rowKey: 0, rowNo: 1 }, []), null)
  })

  test('标题 = 列标签 + 行号；值按 rowKey 现取', () => {
    const info = loadRedisCellInfo()
    const got = info({ col: 'value', label: 'Value', rowKey: 0, rowNo: 1 }, hashRows)
    assert.equal(got.title, 'Value · row 1')
    assert.equal(got.value, hashRows[0].value)
    assert.equal(got.column.name, 'value')
  })

  test('zset 的 rowKey 是平铺数组下标，行号必须由点击 index 单独给', () => {
    const info = loadRedisCellInfo()
    const zset = [
      { __rowKey: 0, member: 'a', score: 1 },
      { __rowKey: 2, member: 'b', score: 3 }
    ]
    const got = info({ col: 'member', label: 'Member', rowKey: 2, rowNo: 2 }, zset)
    assert.equal(got.value, 'b')
    assert.equal(got.title, 'Member · row 2', '不能把 __rowKey 当行号（会写成 row 3）')
  })

  test('长字符串给字符数；阈值两侧钉住；短值与数字列不硬凑', () => {
    const info = loadRedisCellInfo()
    const min = metaMin()
    assert.ok(Number.isInteger(min) && min > 0, 'VALUE_META_MIN 必须是正整数常量')
    assert.equal(info({ col: 'value', label: 'V', rowKey: 0, rowNo: 1 },
      [{ __rowKey: 0, value: 'y'.repeat(min) }]).meta, '')
    assert.equal(info({ col: 'value', label: 'V', rowKey: 0, rowNo: 1 },
      [{ __rowKey: 0, value: 'y'.repeat(min + 1) }]).meta, (min + 1) + ' chars')
    assert.equal(info({ col: 'score', label: 'S', rowKey: 0, rowNo: 1 },
      [{ __rowKey: 0, score: 42 }]).meta, '')
    assert.equal(info({ col: 'value', label: 'V', rowKey: 0, rowNo: 1 },
      [{ __rowKey: 0, value: null }]).meta, '')
  })

  test('二进制信封交给面板选 hex 呈现器，列类型留空由呈现器自判', () => {
    const info = loadRedisCellInfo()
    const got = info({ col: 'value', label: 'V', rowKey: 0, rowNo: 1 },
      [{ __rowKey: 0, value: { __bin: { buf: 'AAEC', size: 4 } } }])
    assert.equal(got.column.isBinary, true)
    assert.equal(got.column.type, '')
    assert.equal(got.meta, '')
  })

  test('五张表的行数组取自同一份 memo（不复制大值）', () => {
    const src = codeOf(jsx())
    const m = /const redisDetailRows = useMemo\(\(\) => \{([\s\S]*?)\n {2}\}, \[redisDetail, redisHashRows, redisListRows, redisSetRows, redisZsetRows, redisStreamEntries\]\)/
      .exec(src)
    assert.ok(m, 'redisDetailRows memo 的依赖表变了')
    for (const t of ['hash', 'list', 'set', 'zset', 'stream']) {
      assert.ok(m[1].includes("d.type === '" + t + "'") || new RegExp("'" + t + "'").test(m[1]),
        'redisDetailRows 少了 ' + t + ' 分支')
    }
    assert.match(m[1], /return \[\]/)
  })

  test('字符数阈值与 SQL 结果共用一个常量（不再各留一份）', () => {
    const src = jsx()
    assert.equal((src.match(/const VALUE_META_MIN = /g) || []).length, 1)
    assert.ok(!/SQL_VALUE_META_MIN/.test(src), '旧的 SQL 专用阈值常量该已改名')
    assert.equal((src.match(/VALUE_META_MIN/g) || []).length >= 3, true)
  })
})
