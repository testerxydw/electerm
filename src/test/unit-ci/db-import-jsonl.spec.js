/**
 * JSONL 导入与格式注册表单测（N4a，设计 §N4）
 *
 * 三层都跑真实源码：db-import/parsers.js（解析 + 注册表）与
 * db-import/mapping.js（行→插入行）。经 electron/electron-log 桩后 plain require。
 *
 * 两类判据钉在这里：
 * 1. 流式对称 —— 任意切块喂入必须与整串一次解析结果一致（块边界是解析器的主风险面）。
 * 2. 与导出侧闭环 —— db-exporter 的 formatWriters('jsonl') 写出的文件，
 *    本模块读回来必须逐值等于导出前的行（含 null、数字、布尔、`__bin` 信封还原成 Buffer）。
 *    这条是"导出 → 清空 → 导入 → 内容一致"验收的纯函数版本，实机探针再跑一遍全链路。
 */
process.env.NODE_ENV = 'development'

const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')

const electronStub = { app: { getPath: () => '/tmp', isPackaged: false }, dialog: {} }
const electronLogStub = {
  transports: { console: {}, file: {} },
  info: () => {},
  error: () => {},
  warn: () => {},
  log: () => {},
  debug: () => {}
}
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return electronStub
  }
  if (request === 'electron-log') {
    return electronLogStub
  }
  return originalLoad.call(this, request, parent, isMain)
}

const P = require('../../app/lib/db-import/parsers')
const {
  createJsonlState,
  feedJsonlChunk,
  finishJsonl,
  parseJsonlSample,
  jsonValueToCell,
  resolveFormat,
  dialogFilters,
  createRowState,
  feedRows,
  finishRows,
  previewSample,
  IMPORT_FORMAT_IDS
} = P
const { mapObjectToInsert, normalizeMapping } = require('../../app/lib/db-import/mapping')
const exporter = require('../../app/lib/db-exporter')

// 整串一次解析
const parseAll = text => {
  const st = createJsonlState()
  return feedJsonlChunk(st, text).concat(finishJsonl(st))
}

// 每 n 字符切一块：结果必须与整串一致
const parseByChunks = (text, n) => {
  const st = createJsonlState()
  let rows = []
  for (let i = 0; i < text.length; i += n) {
    rows = rows.concat(feedJsonlChunk(st, text.slice(i, i + n)))
  }
  return rows.concat(finishJsonl(st))
}

describe('JSONL 解析：整串', () => {
  test('两行对象（末行有换行）', () => {
    assert.deepEqual(parseAll('{"a":1}\n{"a":2}\n'), [{ a: 1 }, { a: 2 }])
  })

  test('末行没有换行也要收下', () => {
    assert.deepEqual(parseAll('{"a":1}\n{"a":2}'), [{ a: 1 }, { a: 2 }])
  })

  test('CRLF 行尾：\r 不残留在值里', () => {
    assert.deepEqual(parseAll('{"a":1}\r\n{"a":2}\r\n'), [{ a: 1 }, { a: 2 }])
  })

  test('BOM 剥离（只作用首个字符）', () => {
    assert.deepEqual(parseAll('\uFEFF{"a":1}\n'), [{ a: 1 }])
  })

  test('空行/纯空白行跳过，但计入行号（报错要能定位到文件的行）', () => {
    assert.deepEqual(parseAll('\n{"a":1}\n   \n{"b":2}\n'), [{ a: 1 }, { b: 2 }])
  })

  test('字符串里的转义换行不会被当成行分隔（JSONL 一行一个值的根据）', () => {
    const rows = parseAll('{"a":"x\\ny"}\n')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].a, 'x\ny')
  })
})

describe('JSONL 解析：报错定位', () => {
  test('非法 JSON 报行号', () => {
    assert.throws(() => parseAll('{"a":1}\n{oops}\n'), /第 2 行不是合法 JSON/)
  })

  test('数组/标量/null 不是合法行：报"不是 JSON 对象"', () => {
    assert.throws(() => parseAll('[1,2]\n'), /第 1 行不是 JSON 对象/)
    assert.throws(() => parseAll('123\n'), /第 1 行不是 JSON 对象/)
    assert.throws(() => parseAll('null\n'), /第 1 行不是 JSON 对象/)
  })

  test('空行不算错：只有真写了非对象才拒', () => {
    assert.deepEqual(parseAll('\n\n'), [])
  })
})

describe('JSONL 解析：块边界差分', () => {
  const cases = [
    '{"a":1}\n{"b":"x,y"}\n{"c":null,"d":[1,2]}\n',
    '{"a":"\\u00e9\\n"}\r\n{"a":2}',
    '\uFEFF{"k":"v"}\n\n{"k2":0}\n',
    '{"bin":{"__bin":{"size":3,"b64":"YWJj","truncated":false}}}\n'
  ]
  cases.forEach((text, i) => {
    for (const n of [1, 2, 3, 7, 13]) {
      test(`样例 ${i} · 每 ${n} 字符切块 = 整串`, () => {
        assert.deepEqual(parseByChunks(text, n), parseAll(text))
      })
    }
  })
})

describe('jsonValueToCell：类型还原（与导出侧对称的地方）', () => {
  test('null / undefined（键不存在）→ null', () => {
    assert.equal(jsonValueToCell(null, 1), null)
    assert.equal(jsonValueToCell(undefined, 1), null)
  })

  test('字符串/数字/布尔原样（不做字符串化）', () => {
    assert.equal(jsonValueToCell('x', 1), 'x')
    assert.equal(jsonValueToCell(0, 1), 0)
    assert.equal(jsonValueToCell(false, 1), false)
    assert.equal(jsonValueToCell(1.5, 1), 1.5)
  })

  test('空串与 0 不被当缺值（CSV 空字段语义的对照面）', () => {
    assert.equal(jsonValueToCell('', 1), '')
    assert.equal(jsonValueToCell(0, 1), 0)
  })

  test('普通对象/数组 → JSON 文本（json/jsonb 列的对称形态）', () => {
    assert.equal(jsonValueToCell({ k: 1 }, 1), '{"k":1}')
    assert.equal(jsonValueToCell([1, 2], 1), '[1,2]')
  })

  test('__bin 信封 → Buffer（完整导出可直接还原）', () => {
    const v = { __bin: { size: 3, b64: Buffer.from('abc').toString('base64'), truncated: false } }
    const out = jsonValueToCell(v, 1)
    assert.ok(Buffer.isBuffer(out))
    assert.equal(out.toString('utf8'), 'abc')
  })

  test('截断的信封拒绝导入：半截字节串落库比中止难查', () => {
    const v = { __bin: { size: 100000, b64: 'YWJj', truncated: true } }
    assert.throws(() => jsonValueToCell(v, 7), /第 7 行的二进制列是截断导出/)
  })

  test('shape 不对的伪信封不当二进制（走对象→JSON 文本）', () => {
    const v = { __bin: { size: 'x', b64: 'YWJj', truncated: false } }
    assert.equal(jsonValueToCell(v, 1), '{"__bin":{"size":"x","b64":"YWJj","truncated":false}}')
  })
})

describe('parseJsonlSample：预览', () => {
  test('列名 = 键的首次出现顺序（跨行取并集）', () => {
    const r = parseJsonlSample('{"b":1,"a":2}\n{"c":3,"b":4}\n')
    assert.deepEqual(r.columns, ['b', 'a', 'c'])
  })

  test('值转展示文本：对象成 JSON、null 成空串、缺键成空串', () => {
    const r = parseJsonlSample('{"a":1,"o":{"k":"v"}}\n{"n":null}\n')
    assert.deepEqual(r.columns, ['a', 'o', 'n'])
    assert.deepEqual(r.sampleRows, [['1', '{"k":"v"}', ''], ['', '', '']])
  })

  test('截断的二进制信封在预览不抛错（执行才拦）', () => {
    const r = parseJsonlSample('{"b":{"__bin":{"size":9,"b64":"YQ","truncated":true}}}\n')
    assert.equal(typeof r.sampleRows[0][0], 'string')
    assert.match(r.sampleRows[0][0], /truncated":true/)
  })

  test('maxRows 截断样例，列名取全部解析到的行', () => {
    const text = '{"a":1}\n{"a":2,"b":3}\n{"a":4}\n'
    const r = parseJsonlSample(text, { maxRows: 1 })
    assert.deepEqual(r.columns, ['a', 'b'])
    assert.equal(r.sampleRows.length, 1)
  })

  test('非法 JSON 抛错（预览阶段就把坏文件挡在门外）', () => {
    assert.throws(() => parseJsonlSample('{"a":\n'), /不是合法 JSON/)
  })
})

describe('mapObjectToInsert：按键名取值', () => {
  const setters = normalizeMapping([
    { fileCol: 'a', target: 'col_a' },
    { fileCol: 'n', target: 'col_n' },
    { fileCol: 'x', target: { mode: 'constant', value: 'K', column: 'note' } },
    { fileCol: 'y', target: { mode: 'null', column: 'del' } },
    { fileCol: 'z', target: { mode: 'expression', sql: 'UPPER(a)', column: 'expr' } }
  ])
  const insertCols = setters.map(s => s.column)

  test('键不存在 → null；键存在按 JSON 类型还原', () => {
    const row = mapObjectToInsert({ a: 1, n: null }, setters, insertCols, 1)
    assert.deepEqual(Object.keys(row), ['col_a', 'col_n', 'note', 'del', 'expr'])
    assert.equal(row.col_a, 1)
    assert.equal(row.col_n, null)
    assert.equal(row.note, 'K')
    assert.equal(row.del, null)
    // expression 只占键位不产参（与 mapRowToInsert 同一条契约）
    assert.equal(row.expr, undefined)
  })

  test('映射里没有的源键不参与（多余键忽略）', () => {
    const row = mapObjectToInsert({ a: 9, extra: 'zzz' }, [{ kind: 'field', fileCol: 'a', column: 'col_a' }], ['col_a'], 1)
    assert.deepEqual(row, { col_a: 9 })
  })

  test('二进制信封还原成 Buffer 进绑定值', () => {
    const s = [{ kind: 'field', fileCol: 'b', column: 'col_b' }]
    const row = mapObjectToInsert({ b: { __bin: { size: 3, b64: 'YWJj', truncated: false } } }, s, ['col_b'], 1)
    assert.ok(Buffer.isBuffer(row.col_b))
  })

  test('截断信封抛错并带文件行号', () => {
    const s = [{ kind: 'field', fileCol: 'b', column: 'col_b' }]
    assert.throws(
      () => mapObjectToInsert({ b: { __bin: { size: 9, b64: 'YQ', truncated: true } } }, s, ['col_b'], 42),
      /第 42 行/
    )
  })
})

describe('resolveFormat：格式判定唯一口径', () => {
  test('注册表覆盖 csv/tsv/jsonl/sql', () => {
    assert.deepEqual(IMPORT_FORMAT_IDS, ['csv', 'tsv', 'jsonl', 'sql'])
  })

  test('显式格式优先于扩展名（.txt 里放 JSONL 的场景）', () => {
    assert.equal(resolveFormat('a.txt', 'jsonl').id, 'jsonl')
    assert.equal(resolveFormat('a.csv', 'tsv').id, 'tsv')
  })

  test('未知 id 直接拒绝：静默回落会让"选了 JSONL 却按逗号切"无声发生', () => {
    assert.throws(() => resolveFormat('a.csv', 'excel'), /unknown import format/)
    assert.throws(() => resolveFormat('a.csv', 'json'), /unknown import format/)
  })

  test('按扩展名推断（大小写不敏感）', () => {
    assert.equal(resolveFormat('/x/a.TSV').id, 'tsv')
    assert.equal(resolveFormat('a.ndjson').id, 'jsonl')
    assert.equal(resolveFormat('a.SQL').id, 'sql')
    assert.equal(resolveFormat('a.txt').id, 'csv')
  })

  test('无扩展名 / 空格式回落 csv（与旧行为一致）', () => {
    assert.equal(resolveFormat('Makefile').id, 'csv')
    assert.equal(resolveFormat('a.csv', '').id, 'csv')
    assert.equal(resolveFormat('').id, 'csv')
  })

  test('kind / rowShape 分派字段：sql 是脚本，jsonl 是对象行，csv 是数组行', () => {
    assert.equal(resolveFormat('a.sql').kind, 'script')
    assert.equal(resolveFormat('a.sql').rowShape, 'script')
    assert.equal(resolveFormat('a.jsonl').rowShape, 'object')
    assert.equal(resolveFormat('a.tsv').rowShape, 'array')
    assert.equal(resolveFormat('a.tsv').delimiter, '\t')
  })
})

describe('dialogFilters：打开对话框的过滤器', () => {
  test('首条是"全部支持"，聚合所有扩展名', () => {
    const f = dialogFilters()
    assert.equal(f[0].name, 'CSV/TSV/JSONL/SQL')
    assert.deepEqual(f[0].extensions, ['csv', 'txt', 'tsv', 'jsonl', 'ndjson', 'sql'])
  })

  test('每种格式各一条，可按名选中', () => {
    const names = dialogFilters().slice(1).map(x => x.name)
    assert.deepEqual(names, ['CSV', 'TSV', 'JSONL', 'SQL'])
  })
})

describe('createRowState / feedRows / finishRows：统一入口按格式分派', () => {
  test('csv 默认逗号、tsv 默认制表符（定界符不再靠调用方猜）', () => {
    const cs = createRowState('csv')
    assert.deepEqual(feedRows('csv', cs, 'a,b\nc,d\n'), [['a', 'b'], ['c', 'd']])
    const ts = createRowState('tsv')
    assert.deepEqual(feedRows('tsv', ts, 'a\tb\n'), [['a', 'b']])
  })

  test('jsonl 走对象解析器：没有换行的尾行留到收尾才出（与 csv 同一条流式契约）', () => {
    const st = createRowState('jsonl')
    assert.deepEqual(feedRows('jsonl', st, '{"a":1}'), [])
    assert.deepEqual(finishRows('jsonl', st), [{ a: 1 }])
  })

  test('未知格式 id 建状态时回落 csv（执行层只可能拿到注册表里的 id）', () => {
    const st = createRowState('nope')
    assert.equal(st.delimiter, ',')
  })
})

describe('previewSample：预览入口', () => {
  test('csv 首行表头 + 样例', () => {
    const r = previewSample('h1,h2\n1,2\n3,4\n', { filePath: 'a.csv' })
    assert.equal(r.format, 'csv')
    assert.deepEqual(r.columns, ['h1', 'h2'])
    assert.deepEqual(r.sampleRows, [['1', '2'], ['3', '4']])
  })

  test('jsonl 无表头：列名来自键，样例是数据行', () => {
    const r = previewSample('{"h1":1,"h2":"x"}\n', { filePath: 'a.jsonl' })
    assert.equal(r.format, 'jsonl')
    assert.deepEqual(r.columns, ['h1', 'h2'])
    assert.deepEqual(r.sampleRows, [['1', 'x']])
  })

  test('sql 没有列概念：columns/sampleRows 均空，由渲染层切语句', () => {
    const r = previewSample('SELECT 1;\n', { filePath: 'a.sql' })
    assert.equal(r.format, 'sql')
    assert.deepEqual(r.columns, [])
    assert.deepEqual(r.sampleRows, [])
  })

  test('显式 format 覆盖扩展名判定', () => {
    const r = previewSample('{"a":1}\n', { filePath: 'a.txt', format: 'jsonl' })
    assert.equal(r.format, 'jsonl')
    assert.deepEqual(r.columns, ['a'])
  })
})

describe('导出 → 导入闭环对称（纯函数版）', () => {
  const headers = ['id', 'name', 'score', 'ok', 'note', 'meta', 'blob']
  // 行对象按适配器归一后的形态给（Buffer 已经是 __bin 信封，与 db-exporter 收到的一致）
  const rows = [
    { id: 1, name: '张三', score: 9.5, ok: true, note: null, meta: { k: 'v' }, blob: { __bin: { size: 3, b64: 'YWJj', truncated: false } } },
    { id: 2, name: '', score: 0, ok: false, note: 'a"b,c', meta: [1, 2], blob: null }
  ]

  test('formatWriters(jsonl) 的产物解析回来逐值等于原行', () => {
    const w = exporter.formatWriters('jsonl', 'mysql', { fullTable: 't', headers })
    const text = w.header() + w.chunk(rows) + w.tail()
    // 每行一个 JSON 对象、'\n' 分隔、末行也有换行 —— 解析器只认这个形状
    assert.ok(text.endsWith('\n'))
    const parsed = parseAll(text)
    assert.equal(parsed.length, rows.length)
    const setters = normalizeMapping(headers.map(h => ({ fileCol: h, target: h })))
    const insertCols = setters.map(s => s.column)
    parsed.forEach((obj, i) => {
      const got = mapObjectToInsert(obj, setters, insertCols, i + 1)
      const want = rows[i]
      headers.forEach(h => {
        if (h === 'blob' && want.blob) {
          assert.ok(Buffer.isBuffer(got.blob), 'blob 还原成 Buffer')
          assert.equal(got.blob.toString('utf8'), 'abc')
          return
        }
        if (h === 'meta') {
          // 对象/数组按 JSON 文本进列（数据库按列类型存），与导出写 JSON 文本对称
          assert.equal(got.meta, JSON.stringify(want.meta))
          return
        }
        assert.deepEqual(got[h], want[h], `${h} 第 ${i + 1} 行`)
      })
    })
  })

  test('projectRow 补齐缺列 + 信封原样保留（导入侧靠这两条才能对称）', () => {
    const text = exporter.formatWriters('jsonl', 'sqlite', { fullTable: 't', headers })
      .chunk([{ id: 7 }])
    const obj = JSON.parse(text.trim())
    assert.equal(obj.name, null)
    assert.equal(obj.id, 7)
  })

  test('零行导出的 JSONL 解析回空数组（不把空文件当错误）', () => {
    const w = exporter.formatWriters('jsonl', 'mysql', { fullTable: 't', headers })
    const text = w.header() + w.tail()
    assert.deepEqual(parseAll(text), [])
  })

  test('SQL 导出格式不在导入注册表里（sql 的导入走脚本通道，不认列映射）', () => {
    assert.equal(resolveFormat('dump.sql').kind, 'script')
    assert.ok(!IMPORT_FORMAT_IDS.includes('json'))
    assert.ok(!IMPORT_FORMAT_IDS.includes('markdown'))
  })
})
