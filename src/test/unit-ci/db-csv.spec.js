const { describe, test, before } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const ROOT = path.join(__dirname, '../../..')
const SRC = path.join(ROOT, 'src/client/common/db-csv.js')

// S3-B CSV 导出（doc/设计-数据库阶段3-2026-10-22.md §1）：
// RFC 4180 转义 + BOM 头 + \r\n 行间。直接 import 真实源码，防测试拷贝与实现漂移。
// downloadCsv / downloadText 为 DOM 逻辑不在单测覆盖内。
//
// 曾经是 vm + strip `export`：那份沙箱只给 atob/btoa，故意不给 Buffer，
// 这样"实现里用了 Buffer"会在跑测试时直接 ReferenceError。现在改用 import()
// （模块里新增了 import 语句，vm.Script 解析不了），运行时那道 catch 没了，
// 由 value-renderers.spec.js 的"渲染层数据库模块不得引用 Buffer"源码扫描接替。
let csvEscape
let toCsv
let isBinEnvelope
let sqlQuoteVal
let sqlQuoteIdent
let sqlQuoteModeOf
let buildCopyStatements
let toJsonl
let toMarkdownTable

before(async () => {
  const m = await import(pathToFileURL(SRC).href)
  ;({
    csvEscape, toCsv, isBinEnvelope, sqlQuoteVal, sqlQuoteIdent, sqlQuoteModeOf,
    buildCopyStatements, toJsonl, toMarkdownTable
  } = m)
})

describe('db-csv csvEscape', () => {
  test('null/undefined 输出空串', () => {
    assert.equal(csvEscape(null), '')
    assert.equal(csvEscape(undefined), '')
  })

  test('普通值原样输出', () => {
    assert.equal(csvEscape('abc'), 'abc')
    assert.equal(csvEscape(123), '123')
    assert.equal(csvEscape(0), '0')
    assert.equal(csvEscape(true), 'true')
  })

  test('含逗号字段双引号包裹', () => {
    assert.equal(csvEscape('a,b'), '"a,b"')
  })

  test('含引号字段包裹且内部引号翻倍', () => {
    assert.equal(csvEscape('say "hi"'), '"say ""hi"""')
  })

  test('含换行/回车字段包裹', () => {
    assert.equal(csvEscape('a\nb'), '"a\nb"')
    assert.equal(csvEscape('a\rb'), '"a\rb"')
    assert.equal(csvEscape('a\r\nb'), '"a\r\nb"')
  })

  test('普通字符串不额外包裹', () => {
    assert.equal(csvEscape('plain'), 'plain')
  })

  test('bigint/Date 走 String 化不丢精度', () => {
    assert.equal(csvEscape(12345678901234567890n), '12345678901234567890')
    assert.equal(csvEscape(new Date('2026-01-02T03:04:05Z')), String(new Date('2026-01-02T03:04:05Z')))
  })
})

describe('db-csv toCsv', () => {
  test('isBinEnvelope 识别 F3 信封、拒认普通对象', () => {
    assert.equal(isBinEnvelope({ __bin: { size: 5, b64: 'aGVsbG8=', truncated: false } }), true)
    assert.equal(isBinEnvelope({ __bin: { size: 5 } }), false) // 字段不全
    assert.equal(isBinEnvelope({ other: 1 }), false)
    assert.equal(isBinEnvelope('x'), false)
    assert.equal(isBinEnvelope(null), false)
    assert.equal(isBinEnvelope([{ __bin: {} }]), false) // 数组
  })

  test('小二进制：整列 base64 导出不丢数据', () => {
    const bin = { __bin: { size: 5, b64: 'aGVsbG8=', truncated: false } }
    const csv = toCsv(['blob'], [{ blob: bin }])
    assert.equal(csv, '\uFEFFblob\r\naGVsbG8=\r\n')
  })

  test('截断的大二进制：toCsv 抛错（不静默导出残缺数据）', () => {
    const bin = { __bin: { size: 200000, b64: 'YWJj', truncated: true } }
    assert.throws(() => toCsv(['blob'], [{ blob: bin }]), /请用 SQL 模式导出/)
  })

  test('文件头 BOM + 表头行 + \r\n 行间', () => {
    const csv = toCsv(['a', 'b'], [{ a: 1, b: 2 }])
    assert.ok(csv.startsWith('\uFEFF'), 'missing BOM')
    assert.ok(csv.startsWith('\uFEFFa,b\r\n'), 'header row wrong')
    assert.ok(csv.endsWith('1,2\r\n'), 'data row wrong')
  })

  test('列顺序跟随 headers，行缺列补空', () => {
    const csv = toCsv(['x', 'y'], [{ y: 2 }, { x: 1 }])
    assert.equal(csv, '\uFEFFx,y\r\n,2\r\n1,\r\n')
  })

  test('特殊字符行整体转义正确', () => {
    const csv = toCsv(['c'], [{ c: 'a,"b"\nc' }])
    assert.equal(csv, '\uFEFFc\r\n"a,""b""\nc"\r\n')
  })

  test('空行集只剩表头', () => {
    assert.equal(toCsv(['h'], []), '\uFEFFh\r\n')
  })

  test('rows 非数组容错', () => {
    assert.equal(toCsv(['h'], null), '\uFEFFh\r\n')
  })

  test('Excel 中文兼容：BOM 在最前', () => {
    const csv = toCsv(['名称'], [{ 名称: '值' }])
    assert.equal(csv.charCodeAt(0), 0xFEFF)
    assert.ok(csv.includes('名称\r\n'), 'header row missing')
    assert.ok(csv.includes('值\r\n'), 'data row missing')
  })
})

// A1 复制为 SQL/JSON/TSV（doc/设计-数据库阶段3-2026-10-22.md §7.2）

describe('db-csv sqlQuoteVal / sqlQuoteIdent', () => {
  test('null/undefined → NULL', () => {
    assert.equal(sqlQuoteVal(null), 'NULL')
    assert.equal(sqlQuoteVal(undefined), 'NULL')
  })

  test('数字/布尔/bigint 原样不引', () => {
    assert.equal(sqlQuoteVal(3), '3')
    assert.equal(sqlQuoteVal(true), 'true')
    assert.equal(sqlQuoteVal(12345678901234567890n), '12345678901234567890')
  })

  test('字符串单引号包裹，内部单引号翻倍', () => {
    assert.equal(sqlQuoteVal("O'Neil"), "'O''Neil'")
    assert.equal(sqlQuoteVal('中文'), "'中文'")
  })

  test('mysql 系反斜杠翻倍，pg 不翻', () => {
    assert.equal(sqlQuoteVal('a\\b', 'backtick'), "'a\\\\b'")
    assert.equal(sqlQuoteVal('a\\b', 'double'), "'a\\b'")
  })

  test('Date → ISO 字符串', () => {
    assert.equal(sqlQuoteVal(new Date('2026-01-02T03:04:05Z')), "'2026-01-02T03:04:05.000Z'")
  })

  test('标识符引用：反引号 / 双引号，注入字符剔除', () => {
    assert.equal(sqlQuoteIdent('t', 'backtick'), '`t`')
    assert.equal(sqlQuoteIdent('my`table', 'backtick'), '`mytable`')
    assert.equal(sqlQuoteIdent('my"t', 'double'), '"myt"')
  })

  test('F3 小二进制：mysql X 十六进制字面量、pg \\x 字面量', () => {
    const bin = { __bin: { size: 3, b64: Buffer.from('abc').toString('base64'), truncated: false } }
    assert.equal(sqlQuoteVal(bin, 'backtick'), "X'" + Buffer.from('abc').toString('hex') + "'")
    assert.equal(sqlQuoteVal(bin, 'double'), "'\\x" + Buffer.from('abc').toString('hex') + "'")
  })

  test('F3 截断大二进制：sqlQuoteVal 抛错（不静默写出残缺值）', () => {
    const bin = { __bin: { size: 200000, b64: 'YWJj', truncated: true } }
    assert.throws(() => sqlQuoteVal(bin, 'backtick'), /请用 SQL 模式导出/)
  })

  test('F3 二进制不被 String() 成 [object Object]', () => {
    const bin = { __bin: { size: 1, b64: 'YQ==', truncated: false } }
    const out = buildCopyStatements('insert', {
      table: 't', headers: ['blob'], rows: [{ blob: bin }], pkColumn: '', quote: 'backtick'
    })
    assert.ok(!out.includes('[object Object]'), '出现 [object Object] 说明未识别信封')
  })
})

// 复制为 SQL 时"标识符怎么引"由引擎决定：调用方（db-session.jsx）传的是书签里
// 原样的 tab.dbType，不是归一后的方言 id，所以这里点名每个引擎都有确定的引号风格。
describe('db-csv sqlQuoteModeOf', () => {
  test('mysql 系反引号 / pg 系双引号 / sqlite 用双引号风格标识符', () => {
    assert.equal(sqlQuoteModeOf('mysql'), 'backtick')
    assert.equal(sqlQuoteModeOf('tidb'), 'backtick')
    assert.equal(sqlQuoteModeOf('oceanbase'), 'backtick')
    assert.equal(sqlQuoteModeOf('redis'), 'backtick')
    assert.equal(sqlQuoteModeOf('postgres'), 'double')
    assert.equal(sqlQuoteModeOf('sqlite'), 'sqlite')
  })

  test('方言别名与大小写/空格同样认得（上游传的是方言 id 时不误判成反引号）', () => {
    assert.equal(sqlQuoteModeOf('PostgreSQL'), 'double')
    assert.equal(sqlQuoteModeOf(' pg '), 'double')
    assert.equal(sqlQuoteModeOf('sqlite3'), 'sqlite')
  })

  test('认不出的引擎回落反引号，不返回 undefined（拼出的 SQL 会带 undefined 引号）', () => {
    assert.equal(sqlQuoteModeOf('unknown-db'), 'backtick')
    assert.equal(sqlQuoteModeOf(undefined), 'backtick')
  })
})

describe('db-csv buildCopyStatements', () => {
  const rows = [
    { id: 1, name: "O'Neil", note: null },
    { id: 2, name: '张三', note: 'a\\b' }
  ]

  test('insert：反引号 + 占位值转义', () => {
    const out = buildCopyStatements('insert', {
      table: 't', headers: ['id', 'name', 'note'], rows, pkColumn: 'id', quote: 'backtick'
    })
    const lines = out.split('\n')
    assert.equal(lines.length, 2)
    assert.equal(lines[0], 'INSERT INTO `t` (`id`, `name`, `note`) VALUES (1, \'O\'\'Neil\', NULL);')
    assert.equal(lines[1], 'INSERT INTO `t` (`id`, `name`, `note`) VALUES (2, \'张三\', \'a\\\\b\');')
  })

  test('insert：pg 双引号风格', () => {
    const out = buildCopyStatements('insert', {
      table: 't', headers: ['id'], rows: [{ id: 1 }], pkColumn: 'id', quote: 'double'
    })
    assert.equal(out, 'INSERT INTO "t" ("id") VALUES (1);')
  })

  test('insert/update 带库名限定（连接无默认库时裸表名报 No database selected）', () => {
    const out = buildCopyStatements('insert', {
      table: 't', database: 'db1', headers: ['id'], rows: [{ id: 1 }], pkColumn: 'id', quote: 'backtick'
    })
    assert.equal(out, 'INSERT INTO `db1`.`t` (`id`) VALUES (1);')
    const up = buildCopyStatements('update', {
      table: 't', database: 'db1', headers: ['id', 'name'], rows: [{ id: 7, name: 'x' }], pkColumn: 'id', quote: 'double'
    })
    assert.equal(up, 'UPDATE "db1"."t" SET "name" = \'x\' WHERE "id" = 7;')
  })

  test('update：SET 排除主键列，WHERE 主键定位', () => {
    const out = buildCopyStatements('update', {
      table: 't', headers: ['id', 'name'], rows: [{ id: 7, name: 'x' }], pkColumn: 'id', quote: 'backtick'
    })
    assert.equal(out, 'UPDATE `t` SET `name` = \'x\' WHERE `id` = 7;')
  })

  test('update：无主键返回空串（UI 禁用兜底）', () => {
    const out = buildCopyStatements('update', {
      table: 't', headers: ['id', 'name'], rows, pkColumn: '', quote: 'backtick'
    })
    assert.equal(out, '')
  })

  test('json：2 空格缩进，headers 驱动剔除辅助键，null 保留', () => {
    const out = buildCopyStatements('json', {
      table: 't', headers: ['id', 'name'], rows: [{ id: 1, name: null, __rowKey: 0 }], quote: 'backtick'
    })
    assert.equal(out, '[\n  {\n    "id": 1,\n    "name": null\n  }\n]')
  })

  test('F3 json：二进制列输出提示串而非裸 b64 信封（防误以为是完整数据）', () => {
    const bin = { __bin: { size: 5, b64: 'aGVsbG8=', truncated: false } }
    const out = buildCopyStatements('json', {
      table: 't', headers: ['id', 'blob'], rows: [{ id: 1, blob: bin }], quote: 'backtick'
    })
    assert.ok(out.includes('"<binary 5 bytes>"'), '应给出提示串')
    assert.ok(!out.includes('"__bin"'), 'json 里不应泄露信封结构')
  })

  test('tsv：首行列名，值内制表/换行替换为空格，null → 空串', () => {
    const out = buildCopyStatements('tsv', {
      table: 't', headers: ['a', 'b'], rows: [{ a: 'x\ty', b: 'p\nq' }, { a: null, b: 'z' }], quote: 'backtick'
    })
    assert.equal(out, 'a\tb\nx y\tp q\n\tz')
  })

  test('F3 tsv：二进制列显示提示串而非字节串（TSV 给人看）', () => {
    const bin = { __bin: { size: 5, b64: 'aGVsbG8=', truncated: false } }
    const out = buildCopyStatements('tsv', {
      table: 't', headers: ['a', 'blob'], rows: [{ a: 'x', blob: bin }], quote: 'backtick'
    })
    assert.equal(out, 'a\tblob\nx\t<binary 5 bytes>')
  })

  test('rows 非数组容错', () => {
    assert.equal(buildCopyStatements('insert', { table: 't', headers: ['a'], rows: null }), '')
  })
})

describe('db-csv toJsonl / toMarkdownTable（SQL 结果导出补齐）', () => {
  test('toJsonl：一行一个独立 JSON 对象，逐行可 parse 回来', () => {
    const out = toJsonl(['a', 'b'], [{ a: 1, b: 'x' }, { a: 2, b: 'y' }])
    const lines = out.split('\n')
    assert.equal(lines.length, 2)
    assert.deepEqual(lines.map(l => JSON.parse(l)), [{ a: 1, b: 'x' }, { a: 2, b: 'y' }])
  })

  test('toJsonl：列序与取值以 headers 为准（滤掉 __rowKey 辅助键），缺列补 null', () => {
    const out = toJsonl(['a', 'c'], [{ a: 1, __rowKey: 9 }])
    assert.deepEqual(JSON.parse(out), { a: 1, c: null })
  })

  test('toJsonl：二进制信封换占位串（b64 信封结构不进数据文件）', () => {
    const bin = { __bin: { size: 5, b64: 'aGVsbG8=', truncated: false } }
    const out = toJsonl(['blob'], [{ blob: bin }])
    assert.equal(JSON.parse(out).blob, '<binary 5 bytes>')
  })

  test('toJsonl：字符串内的换行/引号走 JSON 转义（一行永远是一条记录）', () => {
    const out = toJsonl(['v'], [{ v: 'a"b\nc' }])
    assert.equal(out.split('\n').length, 1)
    assert.equal(JSON.parse(out).v, 'a"b\nc')
  })

  test('toJsonl：rows 非数组 → 空串；headers 非数组 → 每行空对象', () => {
    assert.equal(toJsonl(['a'], null), '')
    assert.equal(toJsonl(null, [{ a: 1 }]), '{}')
  })

  test('toMarkdownTable：表头 + 分隔行 + 数据行', () => {
    const out = toMarkdownTable(['a', 'b'], [{ a: 1, b: 'x' }])
    const lines = out.split('\n')
    assert.equal(lines.length, 3)
    assert.equal(lines[0], '| a | b |')
    assert.equal(lines[1], '| --- | --- |')
    assert.equal(lines[2], '| 1 | x |')
  })

  test('toMarkdownTable：竖线转义不破表结构，换行变 <br>', () => {
    const out = toMarkdownTable(['v'], [{ v: 'a|b' }, { v: 'x\ny' }])
    const lines = out.split('\n')
    assert.equal(lines.length, 4, '换行必须压成 <br>，不能拆行')
    assert.ok(lines[2].includes('a\\|b'), lines[2])
    assert.ok(lines[3].includes('x<br>y'), lines[3])
  })

  test('toMarkdownTable：反引号转义；null → 空单元格；二进制占位', () => {
    const bin = { __bin: { size: 8, b64: 'AAAAAAAAAA==', truncated: false } }
    const out = toMarkdownTable(['v', 'n', 'b'], [{ v: 'a`b', n: null, b: bin }])
    const cells = out.split('\n')[2].split('|').slice(1, -1).map(s => s.trim())
    assert.ok(cells[0].includes('\\`'))
    assert.equal(cells[1], '')
    assert.equal(cells[2], '<binary 8 bytes>')
  })

  test('toMarkdownTable：rows 非数组 → 只有表头和分隔行', () => {
    const out = toMarkdownTable(['a'], null)
    assert.equal(out.split('\n').length, 2)
  })
})
