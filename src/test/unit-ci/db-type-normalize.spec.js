/**
 * H1a-3 · 字段类型契约单测（设计 §1A.5）
 *
 * 三层，从"最会出错的地方"往下排：
 *  1) 词表对齐：归一出来的类型名必须被 `db-format-value.js` 的 isNumberType/isDateType
 *     认得。这条最要命 —— 名字对不上不会报错，只会"数值列不右对齐、日期仍是 ISO 串"，
 *     属于用户看得出、我查半天的那类静默失效。
 *  2) 与驱动常量对表：映射表逐条对 mysql2 的 `constants/types.js`，驱动升级新增类型码
 *     时这里会红，逼着做一次有意识的决定，而不是让新列默默回落成字符串。
 *  3) 契约形状：`columns` 与 `fields` 同长同序；未知一律 `''`；TEXT/BLOB 分流只看字符集。
 * 最后附一条接线契约（源码抽取，不复制实现）：适配层真的输出 columns、前端真的把
 * 类型喂给 renderCell 并给数值列加 class。
 */
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const NORM = require(path.join(ROOT, 'src/app/common/db-type-normalize.js'))
const MYSQL_ADAPTER = path.join(ROOT, 'src/app/lib/db-client/mysql.js')
const PG_ADAPTER = path.join(ROOT, 'src/app/lib/db-client/postgres.js')
const JSX = path.join(ROOT, 'src/client/components/database/db-session.jsx')
const STYL = path.join(ROOT, 'src/client/components/database/db-session.styl')
const DRIVER_TYPES = require(path.join(ROOT, 'node_modules/mysql2/lib/constants/types.js'))
const DRIVER_FLAGS = require(path.join(ROOT, 'node_modules/mysql2/lib/constants/field_flags.js'))

// 刻意不映射的类型码：写死在这里，新增码时必须要么进表、要么进这张说明表
const INTENTIONAL_GAPS = {
  // NULL：只在预处理协议里作为值类型出现，information_schema 里没有这一列类型
  6: 'NULL'
}

// ---------- 前端格式化词表（ESM 源码，vm + strip export 取同一份实现） ----------

function loadFormatMod () {
  const src = fs.readFileSync(
    path.join(ROOT, 'src/client/common/db-format-value.js'), 'utf8'
  ).replace(/^export /gm, '')
  const sandbox = {
    Intl,
    Date,
    Number,
    String,
    Boolean,
    Object,
    Array,
    JSON,
    RegExp,
    Math,
    module: { exports: {} }
  }
  sandbox.module.exports = {}
  sandbox.exports = sandbox.module.exports
  vm.createContext(sandbox)
  vm.runInContext(
    src + '\n;module.exports = ({ isNumberType, isDateType, formatCellValue, cellAlignClass })',
    sandbox,
    { filename: 'db-format-value.js' }
  )
  return sandbox.module.exports
}

const fmt = loadFormatMod()

// 协议 MYSQL_TYPE 码 → 该列在库里该被认成哪一类呈现（num / date / 都不算）
const MYSQL_PRESENTATION = {
  num: [0, 1, 2, 3, 4, 5, 8, 9, 13, 16],
  date: [7, 10, 11, 12, 17, 18, 19]
}

describe('db-type-normalize：与驱动常量对表', () => {
  const driverCodes = Object.keys(DRIVER_TYPES).filter(k => /^\d+$/.test(k)).map(Number)

  test('驱动里的每一个类型码都要么进映射表，要么写进"刻意不映射"清单', () => {
    const missing = driverCodes.filter(code =>
      !(code in NORM.MYSQL_TYPE_NAMES) &&
      !(code in NORM.MYSQL_LOB_TYPES) &&
      !(code in INTENTIONAL_GAPS)
    )
    assert.deepEqual(missing, [], 'unmapped mysql type codes: ' + missing.join(','))
  })

  test('映射表里的每一个码都能在驱动常量或协议扩展码里找到（防手写错码位）', () => {
    // 17/18/19 是 MySQL 5.6.5 的二进制协议扩展（TIMESTAMP2/DATETIME2/TIME2），
    // mysql2 的 types.js 只列到 16 就跳到 0xf2，所以这三个码在驱动表里查不到 ——
    // 它们来自 mysql_com.h，是我们**有意**多认的，不是写错
    const protocolOnly = [17, 18, 19]
    for (const code of [...Object.keys(NORM.MYSQL_TYPE_NAMES), ...Object.keys(NORM.MYSQL_LOB_TYPES)]) {
      const n = Number(code)
      assert.ok(
        driverCodes.includes(n) || protocolOnly.includes(n),
        'code ' + code + ' 既不在 mysql2 常量里，也不是协议扩展码'
      )
    }
  })

  test('BINARY/BLOB 标志位与字符集 63 取自驱动，不凭记忆', () => {
    // 分流判据用的是字符集 63（binary）；标志位只作 253/254 的兜底
    assert.equal(DRIVER_FLAGS.BLOB, 16)
    const encodings = require(path.join(ROOT, 'node_modules/mysql2/lib/constants/charset_encodings.js'))
    assert.equal(encodings[63], 'binary')
  })

  test('pg：数组 OID 不在映射表里（回落 ""，与"未知不猜"同一条规则）', () => {
    // 1007 = _int4（int[]）、1015 = _text（text[]）：builtins.js 只收 typelem = 0 的基础类型
    assert.equal(NORM.normalizePgType(1007), '')
    assert.equal(NORM.normalizePgType(1015), '')
  })
})

describe('词表对齐：归一类型名必须被前端格式化认得', () => {
  test('mysql 数值码 → isNumberType 为真', () => {
    for (const code of MYSQL_PRESENTATION.num) {
      const type = NORM.normalizeMysqlType(code, {})
      assert.ok(type, 'code ' + code + ' 应有类型名')
      assert.ok(fmt.isNumberType(type), code + ' → ' + type + ' 必须被 isNumberType 认到')
    }
  })

  test('mysql 日期/时间码 → isDateType 为真', () => {
    for (const code of MYSQL_PRESENTATION.date) {
      const type = NORM.normalizeMysqlType(code, {})
      assert.ok(fmt.isDateType(type), code + ' → ' + type + ' 必须被 isDateType 认到')
    }
  })

  test('mysql 文本/二进制/JSON 码既不是数值也不是日期（不会被右对齐或本地化）', () => {
    // 253/254 文本档、249~252 文本档、245 json、247 enum、248 set、255 geometry
    const texts = [253, 254, 249, 250, 251, 252, 245, 247, 248, 255, 15]
    for (const code of texts) {
      const type = NORM.normalizeMysqlType(code, {})
      assert.ok(type, 'code ' + code + ' 应有类型名')
      assert.equal(fmt.isNumberType(type), false, code + ' → ' + type + ' 不该是数值')
      assert.equal(fmt.isDateType(type), false, code + ' → ' + type + ' 不该是日期')
    }
  })

  test('pg 数值 OID → isNumberType；时间 OID → isDateType；其余都不算', () => {
    const numeric = [20, 21, 23, 700, 701, 790, 1700]
    const dates = [1082, 1083, 1114, 1184, 1266]
    for (const oid of numeric) {
      assert.ok(fmt.isNumberType(NORM.normalizePgType(oid)), oid + ' 必须是数值')
    }
    for (const oid of dates) {
      assert.ok(fmt.isDateType(NORM.normalizePgType(oid)), oid + ' 必须是日期/时间')
    }
    for (const oid of [16, 17, 25, 114, 1042, 1043, 2950, 3802, 1562]) {
      const type = NORM.normalizePgType(oid)
      assert.equal(fmt.isNumberType(type), false, oid + ' → ' + type + ' 不该是数值')
      assert.equal(fmt.isDateType(type), false, oid + ' → ' + type + ' 不该是日期')
    }
  })

  test('pg 的 time 系列给出**全称**，命中 formatCellValue 的纯时刻分支', () => {
    // '10:30:00' 会被当日期格式化就成"1970/01/01 10:30:00"，那比不格式化更难看
    assert.equal(fmt.formatCellValue('10:30:00', NORM.normalizePgType(1083), 'os'), fmt.formatCellValue('10:30:00', 'time', 'os'))
    assert.doesNotMatch(fmt.formatCellValue('10:30:00', NORM.normalizePgType(1083), 'os'), /1970/)
  })
})

describe('normalizeMysqlType', () => {
  test('常见类型码给出 DATA_TYPE 口径名（不带长度、不带 unsigned）', () => {
    assert.equal(NORM.normalizeMysqlType(3, {}), 'int')
    assert.equal(NORM.normalizeMysqlType(8, {}), 'bigint')
    assert.equal(NORM.normalizeMysqlType(246, {}), 'decimal')
    assert.equal(NORM.normalizeMysqlType(12, {}), 'datetime')
    assert.equal(NORM.normalizeMysqlType(245, {}), 'json')
    assert.equal(NORM.normalizeMysqlType(253, {}), 'varchar')
    assert.equal(NORM.normalizeMysqlType(254, {}), 'char')
  })

  test('UNSIGNED 标志位不改变类型名（int unsigned 仍是 int）', () => {
    // 数据页那一侧的 DATA_TYPE 同样不含 unsigned；带上就会掉出词表、不右对齐
    assert.equal(NORM.normalizeMysqlType(3, { flags: DRIVER_FLAGS.UNSIGNED | DRIVER_FLAGS.NOT_NULL }), 'int')
    assert.equal(NORM.normalizeMysqlType(8, { flags: DRIVER_FLAGS.UNSIGNED }), 'bigint')
  })

  test('TEXT 与 BLOB 同为 252：只看字符集分流，BLOB 标志位不能参与判定', () => {
    // 服务端给 TEXT 列也置 BLOB 位（mysql2 注释 "Field is a blob" 指的是这一族），
    // 用它当判据会把 TEXT 说成 BLOB —— 这里两个都按文本判
    const textFlags = DRIVER_FLAGS.BLOB | DRIVER_FLAGS.NOT_NULL
    assert.equal(NORM.normalizeMysqlType(252, { characterSet: 45, flags: textFlags }), 'text')
    assert.equal(NORM.normalizeMysqlType(252, { characterSet: 63, flags: textFlags }), 'blob')
    assert.equal(NORM.normalizeMysqlType(249, { characterSet: 45, flags: textFlags }), 'tinytext')
    assert.equal(NORM.normalizeMysqlType(251, { characterSet: 63, flags: textFlags }), 'longblob')
  })

  test('253/254 的二进制档：字符集 63 优先，缺字符集时才允许 BLOB 位兜底', () => {
    assert.equal(NORM.normalizeMysqlType(253, { characterSet: 63 }), 'varbinary')
    assert.equal(NORM.normalizeMysqlType(254, { characterSet: 63 }), 'binary')
    // mysql2 的实际字段名是 characterSet；charsetnr 是协议里的旧名，别的驱动/stub 可能只给这个
    assert.equal(NORM.normalizeMysqlType(253, { charsetnr: 63 }), 'varbinary')
    assert.equal(NORM.normalizeMysqlType(253, { encoding: 'binary' }), 'varbinary')
    assert.equal(NORM.normalizeMysqlType(253, { flags: DRIVER_FLAGS.BLOB }), 'varbinary')
    assert.equal(NORM.normalizeMysqlType(254, { characterSet: 45 }), 'char')
  })

  test('未知码 / 非整数 / 缺字段 → ""（绝不猜）', () => {
    assert.equal(NORM.normalizeMysqlType(6, {}), '')
    assert.equal(NORM.normalizeMysqlType(999, {}), '')
    assert.equal(NORM.normalizeMysqlType(undefined, {}), '')
    assert.equal(NORM.normalizeMysqlType('3', {}), 'int') // 驱动给字符串码位也认（stub 常见）
    assert.equal(NORM.normalizeMysqlType(NaN, {}), '')
    assert.equal(NORM.normalizeMysqlType(3, undefined), 'int')
  })

  test('null 类型码显式回落 ""（Number(null)===0 不得误判 decimal）', () => {
    // 观察项修复：null 类型码经 Number(null)===0 会撞上 MYSQL_TYPE_DECIMAL(0)；
    // "认不上返回 ''" 的契约要求显式拦截，不能吐 'decimal'。
    assert.equal(NORM.normalizeMysqlType(null, {}), '')
    assert.equal(NORM.normalizeMysqlType(null), '')
  })
})

describe('normalizePgType', () => {
  test('基础类型 OID → pg 的 data_type 全称', () => {
    assert.equal(NORM.normalizePgType(23), 'integer')
    assert.equal(NORM.normalizePgType(20), 'bigint')
    assert.equal(NORM.normalizePgType(1043), 'character varying')
    assert.equal(NORM.normalizePgType(1114), 'timestamp without time zone')
    assert.equal(NORM.normalizePgType(1184), 'timestamp with time zone')
    assert.equal(NORM.normalizePgType(17), 'bytea')
    assert.equal(NORM.normalizePgType(3802), 'jsonb')
  })

  test('未知 OID / 非整数 → ""', () => {
    assert.equal(NORM.normalizePgType(0), '')
    assert.equal(NORM.normalizePgType(900001), '')
    assert.equal(NORM.normalizePgType(undefined), '')
  })
})

describe('toColumns：与 fields 同长同序', () => {
  test('逐个转 {name,type}，顺序与长度都跟着驱动字段数组', () => {
    const fields = [
      { name: 'id', columnType: 3 },
      { name: 'created_at', columnType: 12 },
      { name: 'payload', columnType: 245 }
    ]
    const cols = NORM.toColumns(fields, f => NORM.normalizeMysqlType(f.columnType, f))
    assert.deepEqual(cols, [
      { name: 'id', type: 'int' },
      { name: 'created_at', type: 'datetime' },
      { name: 'payload', type: 'json' }
    ])
    assert.deepEqual(cols.map(c => c.name), fields.map(f => f.name))
  })

  test('字段名缺失/为数字（聚合列 "count(*)"）时 name 仍转成字符串', () => {
    const cols = NORM.toColumns([{ name: 'count(*)', columnType: 8 }, { columnType: 3 }], () => 'x')
    assert.deepEqual(cols, [{ name: 'count(*)', type: 'x' }, { name: '', type: 'x' }])
  })

  test('fields 不是数组（非查询语句）→ 空数组', () => {
    assert.equal(NORM.toColumns(undefined, () => 'x').length, 0)
    assert.equal(NORM.toColumns(null, () => 'x').length, 0)
    assert.equal(NORM.toColumns({}, () => 'x').length, 0)
  })

  test('type 恒为字符串：normalize 返回 undefined 也不会漏出 undefined', () => {
    const cols = NORM.toColumns([{ name: 'a' }], () => undefined)
    // 契约允许 ''，不允许 undefined：漏出去前端读到的是 undefined，
    // 而 JSON 序列化后 columns[0] 干脆少一个键，"同长同序"就没法比了
    assert.deepEqual(cols, [{ name: 'a', type: '' }])
  })
})

describe('接线契约（真实源码抽取）', () => {
  const mysqlSrc = () => fs.readFileSync(MYSQL_ADAPTER, 'utf8')
  const pgSrc = () => fs.readFileSync(PG_ADAPTER, 'utf8')
  const jsx = () => fs.readFileSync(JSX, 'utf8')
  // H1a-4（网格复用整合）：数据页 / SQL 结果页的列定义并入公共列工厂，
  // 类型 → renderCell / 右对齐的接线契约跟着挪进工厂
  const colFactory = () => fs.readFileSync(path.join(ROOT, 'src/client/components/database/db-grid-columns.jsx'), 'utf8')

  test('两个适配器都 require 类型归一模块，且 executeSql 结果带 columns', () => {
    assert.match(mysqlSrc(), /require\('\.\.\/\.\.\/common\/db-type-normalize'\)/)
    assert.match(pgSrc(), /require\('\.\.\/\.\.\/common\/db-type-normalize'\)/)
    // mysql 只在 toResult 一处出 columns（多语句由 normalizeResults 复用它）
    const toResult = mysqlSrc().slice(mysqlSrc().indexOf('function toResult'))
    // 多语句模式下 fields 可能含 undefined：先 filter(Boolean)，同一份 fs 既喂
    // fields 又喂 columns，两者"同长同序"的契约才不会被过滤时机打破
    assert.match(toResult.slice(0, 900), /const fs = Array\.isArray\(fields\) \? fields\.filter\(Boolean\) : \[\]/)
    assert.match(toResult.slice(0, 900), /columns: toColumns\(fs, f => normalizeMysqlType\(f\.columnType, f\)\)/)
    assert.match(pgSrc(), /columns: toColumns\(r\.fields, f => normalizePgType\(f\.dataTypeID\)\)/)
  })

  test('fields 保持字符串数组不动（契约是"只增不改"）', () => {
    assert.match(mysqlSrc(), /fields: fs\.map\(f => f\.name\)/)
    assert.match(pgSrc(), /fields: Array\.isArray\(r\.fields\) \? r\.fields\.map\(f => f\.name\) : \[\]/)
  })

  test('前端按结果集建 name→type 表，并把类型喂进 renderCell', () => {
    assert.match(jsx(), /const sqlColTypeMaps = useMemo/)
    // 结果集下标必须对上：跨结果集查类型会把 A 结果集的 int 用到 B 结果集的同名列上
    assert.match(jsx(), /const typeMap = sqlColTypeMaps\[i\] \|\| \{\}/)
    // 类型 → dataType 的解析与 render 的喂入都住在列工厂里（两页同一份）
    assert.match(colFactory(), /const dataType = typeMap\[String\(k\)\.toLowerCase\(\)\] \|\| ''/)
    assert.match(colFactory(), /renderCell\(v, filterKw, dataType\)/)
    // 裸 `render: renderCell` 在**代码行**上必须绝迹（注释里留了说明，所以按行过滤）：
    // antd 的 render(text, record, index) 会把整行对象当关键字、行下标当类型传进来
    const codeLines = (jsx() + '\n' + colFactory()).split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l))
    assert.equal(codeLines.filter(l => /render: renderCell\b/.test(l)).length, 0)
    // 显式表态（拿类型 or 明说不拿）不靠参数位置的巧合：调用点 8 处（原 6 处
    // + Stream 组表 2 处、条目表 2 处；Redis 键列表的类型/TTL 两列已改成芯片，
    // 不再走 renderCell）+ 列工厂 1 处
    assert.equal((jsx().match(/render: v => renderCell\(/g) || []).length, 8)
    assert.equal((colFactory().match(/renderCell\(v, filterKw, dataType\)/g) || []).length, 2)
  })

  test('数值列右对齐：两个网格用同一个 cellAlignClass，class 打在 td 上', () => {
    // cellAlignClass 的消费方是列工厂（数据页 / SQL 结果共用同一份列定义）
    assert.match(colFactory(), /import \{[^}]*cellAlignClass[^}]*\} from '\.\.\/\.\.\/common\/db-format-value'/)
    assert.equal((colFactory().match(/const numCls = cellAlignClass\(dataType\)/g) || []).length, 1)
    // class 组合两页一个口径：基础 class + numCls（+ SQL 选中态），空段过滤后拼接
    assert.match(colFactory(), /const cls = \[cellBaseClass, numCls, selected \? 'db-cell-selected' : ''\]/)
    assert.match(colFactory(), /className: cls/)
  })

  test('CSS：.db-cell-num 右对齐 + tabular-nums；不动表头（手柄占着右边沿）', () => {
    const styl = fs.readFileSync(STYL, 'utf8')
    const i = styl.indexOf('.db-cell-num')
    assert.ok(i > 0, '.db-cell-num 缺失')
    const block = styl.slice(i, styl.indexOf('\n\n', i))
    assert.match(block, /text-align right/)
    assert.match(block, /font-variant-numeric tabular-nums/)
    assert.doesNotMatch(block, /ant-table-thead/)
  })
})
