/**
 * db-importer 单测（C 批，设计 §10）
 *
 * 覆盖重点：RFC4180 解析器纯函数（createParserState / feedChunk / finish /
 * parseSample）+ 映射归一 + 行映射。解析器跑真实源码（模块顶层仅依赖 log，
 * 经 electron/electron-log 桩后可 plain require）。
 *
 * 块边界是解析器的主风险面（4KB 流式喂入）：任何切块方式都必须与整串解析
 * 一致 —— 用 parseByChunks 逐字符切块做差分验证。
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

const {
  createParserState,
  feedChunk,
  finish,
  parseSample,
  isEmptyRow,
  normalizeMapping,
  mapRowToInsert,
  DEFAULT_BATCH_SIZE
} = require('../../app/lib/db-importer')

// 整串一次性解析
const parseAll = (text, opts) => {
  const st = createParserState(opts)
  return feedChunk(st, text).concat(finish(st))
}

// 任意切块解析：结果必须与整串一致
const parseByChunks = (text, n, opts) => {
  const st = createParserState(opts)
  let rows = []
  for (let i = 0; i < text.length; i += n) {
    rows = rows.concat(feedChunk(st, text.slice(i, i + n)))
  }
  return rows.concat(finish(st))
}

// ---------- 解析器：整串 ----------

describe('RFC4180 解析器：整串', () => {
  test('简单两行（LF 行尾，末行无换行）', () => {
    assert.deepEqual(parseAll('a,b\nc,d'), [['a', 'b'], ['c', 'd']])
  })

  test('CRLF 行尾', () => {
    assert.deepEqual(parseAll('a,b\r\nc,d\r\n'), [['a', 'b'], ['c', 'd']])
  })

  test('CRLF/LF 混合', () => {
    assert.deepEqual(parseAll('a\r\nb\nc\r\nd'), [['a'], ['b'], ['c'], ['d']])
  })

  test('UTF-8 BOM 剥离（仅文件首字符）', () => {
    assert.deepEqual(parseAll('\uFEFFa,b\nc,d'), [['a', 'b'], ['c', 'd']])
    // 文件中间出现 BOM 字符是普通数据，不剥
    assert.deepEqual(parseAll('a\n\uFEFFb'), [['a'], ['\uFEFFb']])
  })

  test('引号字段内逗号不切列', () => {
    assert.deepEqual(parseAll('a,"b,c",d'), [['a', 'b,c', 'd']])
  })

  test('引号内 "" 双写转义', () => {
    assert.deepEqual(parseAll('"say ""hi""",x'), [['say "hi"', 'x']])
  })

  test('引号内换行不算行尾', () => {
    assert.deepEqual(parseAll('"a\nb",c'), [['a\nb', 'c']])
    assert.deepEqual(parseAll('"a\r\nb",c'), [['a\r\nb', 'c']])
  })

  test('空字段：中间空 / 尾随空 / 开头空', () => {
    assert.deepEqual(parseAll('a,,c'), [['a', '', 'c']])
    assert.deepEqual(parseAll('a,'), [['a', '']])
    assert.deepEqual(parseAll(',a'), [['', 'a']])
  })

  test('空行忠实产出 [""]（导入执行层负责跳过）', () => {
    const rows = parseAll('a\n\nb')
    assert.deepEqual(rows, [['a'], [''], ['b']])
    assert.equal(rows.filter(isEmptyRow).length, 1)
  })

  test('截断引号宽松收尾（截断文件收下半行不整单失败）', () => {
    assert.deepEqual(parseAll('a,"bc'), [['a', 'bc']])
    assert.deepEqual(parseAll('a,"b\nc'), [['a', 'b\nc']])
  })

  test('引号后垃圾按字面量续接（宽松于 RFC）', () => {
    assert.deepEqual(parseAll('"ab"cd,e'), [['abcd', 'e']])
  })

  test('字段中间的引号是字面量', () => {
    assert.deepEqual(parseAll('a"b,c'), [['a"b', 'c']])
  })

  test('全引号字段 """" → 单个引号', () => {
    assert.deepEqual(parseAll('""""'), [['"']])
  })

  test('引号空字段后跟定界符', () => {
    assert.deepEqual(parseAll('"",x'), [['', 'x']])
  })

  test('TSV 定界符', () => {
    assert.deepEqual(parseAll('a\tb\nc\td', { delimiter: '\t' }), [['a', 'b'], ['c', 'd']])
    // 定界符在引号内是数据；TSV 下逗号不是定界符，也是数据
    assert.deepEqual(parseAll('"a\tb",c', { delimiter: '\t' }), [['a\tb,c']])
  })

  test('单列多行', () => {
    assert.deepEqual(parseAll('1\n2\n3'), [['1'], ['2'], ['3']])
  })
})

// ---------- 解析器：块边界差分 ----------

describe('RFC4180 解析器：任意切块与整串一致', () => {
  const SAMPLES = [
    'a,"b""c",d\r\ne,f',
    'a,b\r\nc,d',
    '"a\nb",c\r\n"x","y""z"',
    '\uFEFFh1,h2\n1,"2,3"\n',
    '"a""b"',
    'a\r\nb',
    'x,,\r\n,"",z'
  ]

  for (const text of SAMPLES) {
    for (const n of [1, 2, 3, 5, 7]) {
      test(`切块大小 ${n}：${JSON.stringify(text).slice(0, 40)}`, () => {
        assert.deepEqual(parseByChunks(text, n), parseAll(text))
      })
    }
  }

  test('空 chunk 容错', () => {
    const st = createParserState()
    assert.deepEqual(feedChunk(st, ''), [])
    assert.deepEqual(feedChunk(st, 'a'), [])
    assert.deepEqual(finish(st), [['a']])
  })

  test('跨块 CRLF（\\r 在块尾、\\n 在下一块头）', () => {
    const st = createParserState()
    const r1 = feedChunk(st, 'a,b\r')
    assert.deepEqual(r1, [['a', 'b']])
    // '\nc,d'：吞掉 \n 后 'c,d' 无行尾，属未完成行（finish 冲刷）
    const r2 = feedChunk(st, '\nc,d')
    assert.deepEqual(r2, [])
    assert.deepEqual(finish(st), [['c', 'd']])
  })

  test('跨块 "" 双写（第一个 " 在块尾）', () => {
    const st = createParserState()
    const r1 = feedChunk(st, '"a"')
    assert.deepEqual(r1, [])
    const r2 = feedChunk(st, '"b"')
    assert.deepEqual(r2, [])
    assert.deepEqual(finish(st), [['a"b']])
  })

  test('跨块引号内换行', () => {
    const st = createParserState()
    assert.deepEqual(feedChunk(st, '"a\n'), [])
    assert.deepEqual(finish(st), [['a\n']])
  })
})

// ---------- finish / parseSample ----------

describe('finish 收尾', () => {
  test('干净结尾（已换行）不产出幻影空行', () => {
    assert.deepEqual(finish(createParserState()), [])
    const st = createParserState()
    feedChunk(st, 'a,b\n')
    assert.deepEqual(finish(st), [])
  })

  test('尾随 \\r 的行已收，finish 不重复产出', () => {
    assert.deepEqual(parseAll('a\r'), [['a']])
  })

  test('文件终止在闭合引号上', () => {
    assert.deepEqual(parseAll('"abc"'), [['abc']])
  })

  test('未闭合引号宽松收尾', () => {
    assert.deepEqual(parseAll('"abc'), [['abc']])
  })

  test('尾随定界符产出空尾字段', () => {
    assert.deepEqual(parseAll('a,'), [['a', '']])
  })
})

describe('parseSample 样例预览', () => {
  test('首条非空行为表头，其余为样例', () => {
    const r = parseSample('h1,h2\n1,2\n3,4')
    assert.deepEqual(r.columns, ['h1', 'h2'])
    assert.deepEqual(r.sampleRows, [['1', '2'], ['3', '4']])
  })

  test('maxRows 截断样例', () => {
    const r = parseSample('h\n1\n2\n3\n4', { maxRows: 2 })
    assert.deepEqual(r.columns, ['h'])
    assert.deepEqual(r.sampleRows, [['1'], ['2']])
  })

  test('空串输入 → 空列空样例', () => {
    assert.deepEqual(parseSample(''), { columns: [], sampleRows: [] })
  })

  test('只有表头 → sampleRows 空', () => {
    const r = parseSample('h1,h2')
    assert.deepEqual(r.columns, ['h1', 'h2'])
    assert.deepEqual(r.sampleRows, [])
  })

  test('空行跳过不影响表头识别', () => {
    const r = parseSample('\n\nh1\n1\n')
    assert.deepEqual(r.columns, ['h1'])
    assert.deepEqual(r.sampleRows, [['1']])
  })
})

// ---------- 映射归一与行映射 ----------

describe('normalizeMapping 映射归一', () => {
  test('字符串 target → field 映射', () => {
    assert.deepEqual(
      normalizeMapping([{ fileCol: 'a', target: 'col_a' }]),
      [{ kind: 'field', fileCol: 'a', column: 'col_a' }]
    )
  })

  test('null/空串 target → 跳过该文件列', () => {
    assert.deepEqual(
      normalizeMapping([{ fileCol: 'a', target: null }, { fileCol: 'b', target: '' }, { fileCol: 'c', target: 'col_c' }]),
      [{ kind: 'field', fileCol: 'c', column: 'col_c' }]
    )
  })

  test('constant/null/expression：column 缺省取 fileCol', () => {
    assert.deepEqual(
      normalizeMapping([
        { fileCol: 'a', target: { mode: 'constant', value: 7 } },
        { fileCol: 'b', target: { mode: 'null' } },
        { fileCol: 'c', target: { mode: 'expression', sql: 'UPPER(c)' } }
      ]),
      [
        { kind: 'constant', column: 'a', value: 7 },
        { kind: 'null', column: 'b' },
        { kind: 'expression', column: 'c', sql: 'UPPER(c)' }
      ]
    )
  })

  test('constant/null/expression 可显式指定 column', () => {
    assert.deepEqual(
      normalizeMapping([{ fileCol: 'a', target: { mode: 'constant', value: 'x', column: 'note' } }]),
      [{ kind: 'constant', column: 'note', value: 'x' }]
    )
  })

  test('expression 缺 sql 抛错', () => {
    assert.throws(() => normalizeMapping([{ fileCol: 'a', target: { mode: 'expression' } }]), /缺少 sql/)
  })

  test('未知 mode 抛错', () => {
    assert.throws(() => normalizeMapping([{ fileCol: 'a', target: { mode: 'weird' } }]), /unknown mapping target mode/)
  })

  test('全空映射抛错', () => {
    assert.throws(() => normalizeMapping([]), /导入映射为空/)
    assert.throws(() => normalizeMapping([{ fileCol: 'a', target: null }]), /导入映射为空/)
  })
})

describe('mapRowToInsert 行映射', () => {
  const setters = [
    { kind: 'field', fileCol: 'a', column: 'col_a' },
    { kind: 'constant', column: 'note', value: 'K' },
    { kind: 'null', column: 'del' },
    { kind: 'expression', column: 'expr', sql: 'UPPER(a)' }
  ]
  const insertCols = ['col_a', 'note', 'del', 'expr']
  const headerCols = ['a', 'b']

  test('field 按表头下标取值 / constant / null / expression 仅占键位不产参', () => {
    const row = mapRowToInsert(['v1', 'v2'], setters, insertCols, headerCols)
    // expression 列必须占键位（insertRows 以首行 keys 生成 INSERT 列清单），
    // 值为 undefined 时不进绑定参数（insertBatchParams 跳过表达式列）
    assert.deepEqual(Object.keys(row), ['col_a', 'note', 'del', 'expr'])
    assert.equal(row.col_a, 'v1')
    assert.equal(row.note, 'K')
    assert.equal(row.del, null)
    assert.equal(row.expr, undefined)
  })

  test('映射引用表头不存在的文件列 → null（预览侧拦截后的兜底）', () => {
    const s = [{ kind: 'field', fileCol: 'zzz', column: 'c' }]
    const row = mapRowToInsert(['v1'], s, ['c'], headerCols)
    assert.deepEqual(row, { c: null })
  })

  test('短行缺尾字段 → null', () => {
    const s = [{ kind: 'field', fileCol: 'a', column: 'c1' }, { kind: 'field', fileCol: 'b', column: 'c2' }]
    const row = mapRowToInsert(['only'], s, ['c1', 'c2'], headerCols)
    assert.deepEqual(row, { c1: 'only', c2: null })
  })

  test('无表头（headerCols null）→ field 全 null', () => {
    const s = [{ kind: 'field', fileCol: 'a', column: 'c1' }]
    const row = mapRowToInsert(['v'], s, ['c1'], null)
    assert.deepEqual(row, { c1: null })
  })

  test('CSV 空字段忠实导入为空串（不做静默转 NULL）', () => {
    const s = [{ kind: 'field', fileCol: 'a', column: 'c1' }]
    const row = mapRowToInsert([''], s, ['c1'], headerCols)
    assert.deepEqual(row, { c1: '' })
  })
})

describe('常量', () => {
  test('默认批次 500', () => {
    assert.equal(DEFAULT_BATCH_SIZE, 500)
  })
})
