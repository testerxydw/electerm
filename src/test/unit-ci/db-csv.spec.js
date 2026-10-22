const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const SRC = path.join(ROOT, 'src/client/common/db-csv.js')

// S3-B CSV 导出（doc/设计-数据库阶段3-2026-10-22.md §1）：
// RFC 4180 转义 + BOM 头 + \r\n 行间。vm 跑真实源码（strip ESM export），
// 防测试拷贝与实现漂移。downloadCsv 为 DOM 逻辑不在单测覆盖内。

const loadFns = () => {
  const code = fs.readFileSync(SRC, 'utf8').replace(/^export /gm, '')
  const ctx = {}
  vm.createContext(ctx)
  vm.runInContext(code, ctx)
  assert.equal(typeof ctx.csvEscape, 'function', 'csvEscape missing')
  assert.equal(typeof ctx.toCsv, 'function', 'toCsv missing')
  return ctx
}

describe('db-csv csvEscape', () => {
  const { csvEscape } = loadFns()

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
  const { toCsv } = loadFns()

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
  const { sqlQuoteVal, sqlQuoteIdent } = loadFns()

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
})

describe('db-csv buildCopyStatements', () => {
  const { buildCopyStatements } = loadFns()
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

  test('tsv：首行列名，值内制表/换行替换为空格，null → 空串', () => {
    const out = buildCopyStatements('tsv', {
      table: 't', headers: ['a', 'b'], rows: [{ a: 'x\ty', b: 'p\nq' }, { a: null, b: 'z' }], quote: 'backtick'
    })
    assert.equal(out, 'a\tb\nx y\tp q\n\tz')
  })

  test('rows 非数组容错', () => {
    assert.equal(buildCopyStatements('insert', { table: 't', headers: ['a'], rows: null }), '')
  })
})
