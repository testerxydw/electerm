/**
 * 导入执行层 + CSV/TSV 解析单测（C 批 §10 + N4a §N4）
 *
 * 覆盖重点：RFC4180 解析器纯函数（createParserState / feedChunk / finish /
 * parseSample，现居 db-import/parsers.js）+ 映射归一与行映射（现居
 * db-import/mapping.js）+ SQL 脚本通道（runScriptImport / normalizeStatements /
 * affectedOf，注入假 exec，不碰连接）。跑真实源码（模块顶层仅依赖 log，
 * 经 electron/electron-log 桩后可 plain require）。
 *
 * 块边界是解析器的主风险面（4KB 流式喂入）：任何切块方式都必须与整串解析
 * 一致 —— 用 parseByChunks 逐字符切块做差分验证。
 */
process.env.NODE_ENV = 'development'

const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
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
  resolveFormat
} = require('../../app/lib/db-import/parsers')
const {
  normalizeMapping,
  mapRowToInsert
} = require('../../app/lib/db-import/mapping')
const {
  runScriptImport,
  runRowImport,
  normalizeStatements,
  affectedOf,
  DEFAULT_BATCH_SIZE,
  MAX_IMPORT_STATEMENTS
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

// ---------- SQL 脚本通道（N4a） ----------

const newScriptTask = () => ({
  status: 'running',
  totalStatements: 0,
  executedStatements: 0,
  failedStatements: 0,
  statementNo: 0,
  committedRows: 0,
  errors: []
})

describe('normalizeStatements 语句数组校验', () => {
  test('非空文本原样通过（顺序不变）', () => {
    assert.deepEqual(normalizeStatements(['A;', 'B;', 'C;']), ['A;', 'B;', 'C;'])
  })

  test('空数组 / 非数组 → 抛错', () => {
    assert.throws(() => normalizeStatements([]), /SQL 导入需要至少一条语句/)
    assert.throws(() => normalizeStatements(undefined), /SQL 导入需要至少一条语句/)
  })

  test('空串 / 纯空白 / 非字符串 → 抛错并给出行号', () => {
    assert.throws(() => normalizeStatements(['A;', '']), /第 2 条语句为空或不是文本/)
    assert.throws(() => normalizeStatements(['  ']), /第 1 条/)
    assert.throws(() => normalizeStatements([123]), /第 1 条/)
  })

  test('超过条数上限 → 抛错（IPC 载荷护栏）', () => {
    const many = new Array(MAX_IMPORT_STATEMENTS + 1).fill('SELECT 1')
    assert.throws(() => normalizeStatements(many), new RegExp(`上限 ${MAX_IMPORT_STATEMENTS}`))
  })
})

describe('affectedOf 影响行数汇总', () => {
  test('results[].affected 求和，缺字段按 0', () => {
    assert.equal(affectedOf({ results: [{ affected: 2 }, { affected: 3 }] }), 5)
    assert.equal(affectedOf({ results: [{ affected: undefined }, { affected: 1 }] }), 1)
  })

  test('空结果 / 非对象 → 0', () => {
    assert.equal(affectedOf(null), 0)
    assert.equal(affectedOf({}), 0)
    assert.equal(affectedOf({ results: [] }), 0)
  })
})

describe('runScriptImport 逐条执行', () => {
  test('按顺序原样下发每条语句，进度与影响行数累计', async () => {
    const task = newScriptTask()
    const seen = []
    await runScriptImport(
      { statements: ['A;', 'B;', 'C;'] },
      task,
      async sql => {
        seen.push(sql)
        return { results: [{ affected: 2 }] }
      }
    )
    assert.deepEqual(seen, ['A;', 'B;', 'C;'])
    assert.equal(task.status, 'done')
    assert.equal(task.totalStatements, 3)
    assert.equal(task.executedStatements, 3)
    assert.equal(task.statementNo, 3)
    assert.equal(task.committedRows, 6)
    assert.deepEqual(task.errors, [])
  })

  test('取消在语句边界止步：已执行的保留，未执行的一条不发', async () => {
    const task = newScriptTask()
    const seen = []
    await runScriptImport(
      { statements: ['A;', 'B;', 'C;'] },
      task,
      async sql => {
        seen.push(sql)
        if (sql === 'A;') {
          task.cancelRequested = true
        }
        return { results: [{ affected: 1 }] }
      }
    )
    assert.deepEqual(seen, ['A;'])
    assert.equal(task.status, 'cancelled')
    assert.equal(task.executedStatements, 1)
  })

  // 真实取消来自另一个宏任务（IPC 消息），不是 exec 内部。同步 await 链会把宏任务
  // 饿死：循环不主动让出事件循环的话，这条 cancel 请求永远排不到，任务一路跑到 done。
  test('取消请求来自宏任务时接得住：每条语句之间让出事件循环', async () => {
    const task = newScriptTask()
    const seen = []
    setImmediate(() => {
      task.cancelRequested = true
    })
    await runScriptImport(
      { statements: Array.from({ length: 50 }, (_, i) => `S${i};`) },
      task,
      async sql => {
        seen.push(sql)
        return { results: [{ affected: 1 }] }
      }
    )
    assert.equal(task.status, 'cancelled')
    assert.ok(seen.length < 50, `50 条全跑完了，说明循环没有让出事件循环：${seen.length}`)
    assert.equal(task.executedStatements, seen.length)
  })

  test('失败即止：不再执行后续语句，错误带语句序号', async () => {
    const task = newScriptTask()
    const seen = []
    await assert.rejects(
      runScriptImport(
        { statements: ['A;', 'B;', 'C;'] },
        task,
        async sql => {
          seen.push(sql)
          if (sql === 'B;') {
            throw new Error('no such table')
          }
          return { results: [{ affected: 1 }] }
        }
      ),
      /第 2 条语句失败，导入已停止：no such table/
    )
    assert.deepEqual(seen, ['A;', 'B;'])
    assert.equal(task.executedStatements, 1)
    assert.equal(task.failedStatements, 1)
    assert.deepEqual(task.errors, [{ no: 2, message: 'no such table' }])
  })

  test('语句校验失败时一条都不执行', async () => {
    const task = newScriptTask()
    const seen = []
    await assert.rejects(
      runScriptImport({ statements: ['A;', ''] }, task, async sql => { seen.push(sql); return {} }),
      /第 2 条语句为空或不是文本/
    )
    assert.deepEqual(seen, [])
    assert.equal(task.executedStatements, 0)
  })
})

// ---------- 行通道分批提交（N4a 缺陷回归） ----------
//
// 适配器每次 insertRows 都能清空目标表，而导入按 batchSize 把一份文件拆成多次
// insertRows：若每次都清，最后一批提交后只剩最后一批的行，committedRows 与库内
// 行数就此对不上。这里钉住"一个任务只清一次"的调用口径。
describe('runRowImport 分批提交：overwrite 只在首批清空目标表', () => {
  const writeCsv = (dir, rows) => {
    const filePath = path.join(dir, 'src.csv')
    fs.writeFileSync(filePath, ['id,name'].concat(rows).join('\n') + '\n')
    return filePath
  }

  const fakeCtx = (calls, structure) => {
    const dbClientPath = require.resolve('../../app/lib/db-client')
    const saved = require.cache[dbClientPath]
    // runRowImport 取表结构走 dbClientOp，这里只替换这一个入口
    require.cache[dbClientPath] = {
      id: dbClientPath,
      filename: dbClientPath,
      loaded: true,
      exports: { dbClientOp: async () => structure }
    }
    return {
      ctx: {
        conn: {},
        readOnly: false,
        adapter: {
          insertRows: async (conn, arg) => {
            calls.push(arg)
            return { affected: arg.rows.length, batchCount: 1, failures: [] }
          }
        }
      },
      restore: () => {
        if (saved) {
          require.cache[dbClientPath] = saved
        } else {
          delete require.cache[dbClientPath]
        }
      }
    }
  }

  const structure = { columns: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }] }
  const mapping = [
    { fileCol: 'id', target: 'id' },
    { fileCol: 'name', target: 'name' }
  ]
  const taskOf = () => ({
    status: 'running', committedRows: 0, failedBatches: 0, errors: [], cancelRequested: false
  })

  const runOverwrite = async (mode, batchSize, rows) => {
    const calls = []
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-importer-clear-'))
    const { ctx, restore } = fakeCtx(calls, structure)
    try {
      const filePath = writeCsv(dir, rows)
      const task = taskOf()
      await runRowImport(
        { filePath, database: 'main', schema: '', table: 't', mapping, mode, batchSize },
        task,
        ctx,
        'sqlite',
        resolveFormat(filePath)
      )
      return { calls, task }
    } finally {
      restore()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  test('5 行 / batchSize 2 → 三次调用，clearTarget 依次 true,false,false', async () => {
    const { calls, task } = await runOverwrite('overwrite', 2, [
      '1,a', '2,b', '3,c', '4,d', '5,e'
    ])
    assert.equal(calls.length, 3)
    assert.deepEqual(calls.map(c => c.clearTarget), [true, false, false])
    assert.deepEqual(calls.map(c => c.rows.length), [2, 2, 1])
    assert.deepEqual(calls.map(c => c.mode), ['overwrite', 'overwrite', 'overwrite'])
    assert.equal(task.committedRows, 5)
    assert.equal(task.failedBatches, 0)
  })

  test('append 全程不清空（clearTarget 恒为 false）', async () => {
    const { calls } = await runOverwrite('append', 2, ['1,a', '2,b', '3,c'])
    assert.equal(calls.length, 2)
    assert.deepEqual(calls.map(c => c.clearTarget), [false, false])
  })
})

// ================================ 子进程纯度契约（实机回归锁） ================================
// 起因：2026-11-12 实机 /opt/electerm 报 Cannot find module 'electron' ——
// db-importer 运行在 db-client fork 子进程（纯 node），openFile 里的
// require('electron') 在打包产物（asar 无 electron npm 包）下必炸。
// 文件选择已上移到主进程 db-client-remote.dbImportOp，本文件从此禁止再引 electron。

describe('db-client 子进程纯度契约', () => {
  const readSrc = p => fs.readFileSync(
    path.join(__dirname, '../../app', p), 'utf8'
  )

  test('db-importer.js 不允许 require electron（fork 子进程无 electron 模块）', () => {
    const src = readSrc('lib/db-importer.js')
    assert.ok(!src.includes("require('electron')"), 'db-importer.js 不得 require electron')
    assert.ok(!src.includes('require("electron")'), 'db-importer.js 不得 require electron')
  })

  test('openFile 的 dialog 拦截必须在主进程 db-client-remote（含取消转发口径）', () => {
    const src = readSrc('lib/db-client-remote.js')
    // openFile 特判存在且不进通用转发循环
    assert.ok(src.includes("action === 'openFile'"), 'db-client-remote 须特判 openFile')
    assert.ok(src.includes('dialog.showOpenDialogSync'), '主进程侧须真实调用 dialog')
    assert.ok(src.includes('dialogFilters'), '过滤口径须复用 parsers 的 SSOT')
    // 通用转发循环里不得再有 dbImportOp（避免 openFile 被转发进子进程）
    const loop = src.slice(src.indexOf('const remote = {}'), src.indexOf('remote.dbImportOp'))
    assert.ok(loop.includes('dbExportOp') && !loop.includes("'dbImportOp'"),
      'dbImportOp 不得留在通用转发列表')
    // 取消（未选文件）与 preview 转发口径
    assert.ok(src.includes('filePath: null'), '未选文件须返回 filePath: null')
    assert.ok(src.includes("'preview'"), '选中文件须以 preview + filePath 转发子进程')
  })
})

// ================================ 子进程数据目录契约（同类问题回归锁） ================================
// 起因：2026-11-12 同类排查 —— fork 子进程无 electron，app-props 必炸，
// widgets/paths、instance-log、terminal-output-archive 都可能静默落 /tmp。
// 治本口径：主进程 child-process.js 解析好 DATA_PATH 经 fork env 传入，
// 孙进程（session-server）整链继承；兜底模块吃 DATA_PATH → env.appPath 两级。

describe('子进程数据目录契约', () => {
  const readSrc = p => fs.readFileSync(
    path.join(__dirname, '../../app', p), 'utf8'
  )

  test('child-process.js fork env 必须携带 DATA_PATH（由 appPath 解析，显式 DATA_PATH 优先）', () => {
    const src = readSrc('server/child-process.js')
    assert.ok(src.includes('DATA_PATH:'), 'fork env 须显式传 DATA_PATH')
    assert.ok(src.includes('env.DATA_PATH ||'), '用户显式 DATA_PATH 优先')
    assert.ok(src.includes("resolve(env.appPath, 'electerm')"), '须由 appPath 解析数据目录')
  })

  test('terminal-output-archive 不得在 DATA_PATH 下再拼一层 electerm（双 electerm 目录），且须有 appPath 兜底', () => {
    const src = readSrc('server/terminal-output-archive.js')
    assert.ok(!src.includes('process.env.DATA_PATH || os.tmpdir()'), '旧的双层拼法必须移除')
    assert.ok(src.includes('process.env.appPath'), '子进程须吃 env.appPath 兜底')
    assert.ok(src.includes('process.env.DATA_PATH ||'), 'DATA_PATH 语义 = 数据目录本身')
  })

  test('widgets/paths 与 instance-log 的兜底链须为 DATA_PATH → env.appPath → app-props → tmp', () => {
    for (const f of ['widgets/paths.js', 'widgets/instance-log.js']) {
      const src = readSrc(f)
      assert.ok(src.includes('process.env.DATA_PATH'), f + ' 须先吃 DATA_PATH')
      assert.ok(src.includes('process.env.appPath'), f + ' 须有 env.appPath 层（子进程无 electron）')
      // app-props 只能出现在 try/catch 内的最后一层（主进程才可用）
      const appPropsPos = src.indexOf('../common/app-props')
      const tmpPos = src.indexOf('os.tmpdir()')
      assert.ok(appPropsPos > -1 && tmpPos > appPropsPos, f + ' tmp 兜底须在 app-props 之后')
    }
  })
})
