/**
 * db-exporter 单测（C 批，设计 §10）
 *
 * 三轨：
 * 1. dump 头尾与方言（纯函数）：FOREIGN_KEY_CHECKS 头尾 / pg 空头尾 / 信封 X'hex'、
 *    '\xhex' / 分号在字符串字面量内不破句
 * 2. 格式化器（纯函数）：csv BOM、json 可解析、markdown 竖线转义等
 * 3. 分批切分（insert-batch，mysql/pg 共用）：500 行上限 / 1MB 体积 / 空批 / 末批不足
 * 4. 任务状态机（vm + 打桩 './db-client' 与 'fs'）：start 立即返回 / 各 status 态 /
 *    cancel 块边界生效 / 单块失败转 failed 且文件保留 / 并发上限 4 / done 惰性清理
 */
process.env.NODE_ENV = 'development'

const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')

const ROOT = path.join(__dirname, '../../..')
const EXPORTER_JS = path.join(ROOT, 'src/app/lib/db-exporter.js')

const LOG_STUB = { debug () {}, info () {}, warn () {}, error () {} }

// ---------- vm 装配 ----------

// 假写流：write 全收（不背压），end 异步发 finish
function makeFakeStream () {
  const s = new EventEmitter()
  s.chunks = []
  s.bytesWritten = 0
  s.destroyed = false
  s.writableEnded = false
  s.write = t => {
    s.chunks.push(String(t))
    s.bytesWritten += Buffer.byteLength(String(t))
    return true
  }
  s.end = () => {
    s.writableEnded = true
    process.nextTick(() => s.emit('finish'))
  }
  return s
}

// 假 db-client：getTableStructure / getPageData 可配置；onPage 钩子在每次
// getPageData 时同步回调（cancel 测试借此在块间置取消位）
function makeFakeClient (opts = {}) {
  const calls = { pages: 0, structures: 0, pageArgs: [] }
  const pages = opts.pages || [[{ id: 1, name: 'a' }, { id: 2, name: 'b' }]]
  const client = {
    calls,
    dbClientOp: async (tabId, op, args) => {
      if (op === 'getTableStructure') {
        calls.structures++
        if (opts.structureFail) {
          throw new Error('structure fail')
        }
        return opts.structure || {
          columns: [
            { name: 'id', isPrimaryKey: true },
            { name: 'name', isPrimaryKey: false }
          ]
        }
      }
      if (op === 'getPageData') {
        calls.pages++
        calls.pageArgs.push(args)
        if (opts.onPage) {
          opts.onPage(calls.pages)
        }
        if (opts.pageFailOn && calls.pages === opts.pageFailOn) {
          throw new Error(opts.pageErr || 'page fail')
        }
        if (opts.hangPages && calls.pages <= opts.hangPages) {
          return new Promise(() => {})
        }
        const rows = pages[calls.pages - 1] || []
        return { rows, hasMore: calls.pages < pages.length }
      }
      throw new Error('unexpected op: ' + op)
    },
    getDbTabContext: tabId => ({
      dbType: opts.dbType || 'mysql',
      adapter: {},
      conn: {},
      readOnly: true
    })
  }
  return client
}

function loadExporterInVm (stubs) {
  const mod = { exports: {} }
  const sandbox = {
    module: mod,
    exports: mod.exports,
    require: spec => {
      assert.ok(stubs[spec], 'unexpected require: ' + spec)
      return stubs[spec]
    },
    console,
    setTimeout,
    clearTimeout,
    Promise,
    Buffer
  }
  vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(EXPORTER_JS, 'utf8'), sandbox, { filename: 'db-exporter.js' })
  return mod.exports
}

// 每个状态机用例独立装配（任务表是模块级状态，互不串扰）
function setup (opts = {}) {
  const fake = makeFakeClient(opts)
  const stream = makeFakeStream()
  const ex = loadExporterInVm({
    '../common/log': LOG_STUB,
    './db-client': fake,
    fs: { createWriteStream: () => stream }
  })
  return { ex, fake, stream }
}

const waitFor = async (fn, tries = 400) => {
  for (let i = 0; i < tries; i++) {
    if (fn()) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail('condition not met in time')
}

const BASE_ARGS = {
  tabId: 't1',
  database: 'db',
  table: 't',
  format: 'csv',
  targetPath: '/tmp/x.csv'
}

// ---------- dump 头尾与方言 ----------

describe('db-exporter dump 头尾与方言', () => {
  const ex = loadExporterInVm({ '../common/log': LOG_STUB, './db-client': {}, fs: {} })

  test('mysql 头尾：FOREIGN_KEY_CHECKS=0 开、=1 恢复', () => {
    assert.equal(ex.sqlHeader('mysql'), 'SET FOREIGN_KEY_CHECKS=0;\n')
    assert.equal(ex.sqlTail('mysql'), 'SET FOREIGN_KEY_CHECKS=1;\n')
  })

  test('pg 空头尾（无会话级外键开关，照抄会让 dump 首句报错）', () => {
    assert.equal(ex.sqlHeader('postgres'), '')
    assert.equal(ex.sqlTail('postgres'), '')
  })

  test('格式选择：mysql 反引号 + X\'hex\'', () => {
    const env = { __bin: { size: 2, b64: Buffer.from([1, 2]).toString('base64'), truncated: false } }
    const sql = ex.rowToInsertSql({
      fullTable: '`db`.`t`', headers: ['id', 'bin'], row: { id: 1, bin: env }, dialect: 'mysql'
    })
    assert.equal(sql, "INSERT INTO `db`.`t` (`id`, `bin`) VALUES (1, X'0102');")
  })

  test('格式选择：pg 双引号 + \'\\xhex\'', () => {
    const env = { __bin: { size: 2, b64: Buffer.from([1, 2]).toString('base64'), truncated: false } }
    const sql = ex.rowToInsertSql({
      fullTable: '"public"."t"', headers: ['id', 'bin'], row: { id: 1, bin: env }, dialect: 'postgres'
    })
    assert.equal(sql, "INSERT INTO \"public\".\"t\" (\"id\", \"bin\") VALUES (1, '\\x0102');")
  })

  test('分号转义：字符串值内的 ; 在引号内是数据，不破句', () => {
    const sql = ex.rowToInsertSql({
      fullTable: '`t`', headers: ['v'], row: { v: "a';b\nc" }, dialect: 'mysql'
    })
    // ' 翻倍后值内分号无法提前闭合字面量；换行也包在引号内
    assert.equal(sql, "INSERT INTO `t` (`v`) VALUES ('a'';b\nc');")
  })

  test('截断信封 → 显式标记字符串（不冒充完整数据）', () => {
    const env = { __bin: { size: 99999, b64: 'AAAA', truncated: true } }
    assert.equal(ex.sqlQuoteVal(env, 'mysql'), "'<binary 99999 bytes, truncated>'")
    assert.equal(ex.binCell(env), '<binary 99999 bytes, truncated>')
  })

  test('fullTableName：mysql 库前缀可省 / pg 默认 public', () => {
    assert.equal(ex.fullTableName({ database: 'db', table: 't' }, 'mysql'), '`db`.`t`')
    assert.equal(ex.fullTableName({ table: 't' }, 'mysql'), '`t`')
    assert.equal(ex.fullTableName({ schema: 's', table: 't' }, 'postgres'), '"s"."t"')
    assert.equal(ex.fullTableName({ table: 't' }, 'postgres'), '"public"."t"')
  })
})

// ---------- 格式化器 ----------

describe('db-exporter 格式化器', () => {
  const ex = loadExporterInVm({ '../common/log': LOG_STUB, './db-client': {}, fs: {} })
  const { csvEscapeField, projectRow, formatWriters } = ex

  test('csvEscapeField：RFC4180 包裹与 " 翻倍、信封 → b64', () => {
    assert.equal(csvEscapeField('plain'), 'plain')
    assert.equal(csvEscapeField('a,b'), '"a,b"')
    assert.equal(csvEscapeField('say "hi"'), '"say ""hi"""')
    assert.equal(csvEscapeField(null), '')
    const env = { __bin: { size: 2, b64: 'AQI=', truncated: false } }
    assert.equal(csvEscapeField(env), 'AQI=')
  })

  test('csv：BOM + 表头行 + \\r\\n 行块，tail 空', () => {
    const w = formatWriters('csv', 'mysql', { fullTable: '`t`', headers: ['a', 'b'] })
    assert.ok(w.header().startsWith('\uFEFFa,b\r\n'))
    assert.equal(w.chunk([{ a: 1, b: 'x,y' }], true), '1,"x,y"\r\n')
    assert.equal(w.tail(), '')
  })

  test('json：头 [\\n、块间逗号、尾 \\n]；零行输出仍是合法空数组', () => {
    const w = formatWriters('json', 'mysql', { fullTable: '`t`', headers: ['a'] })
    const out = w.header() + w.chunk([{ a: 1 }, { a: 2 }], true) + w.tail()
    assert.deepEqual(JSON.parse(out), [{ a: 1 }, { a: 2 }])
    const empty = w.header() + w.tail()
    assert.deepEqual(JSON.parse(empty), [])
  })

  test('json：信封对象原样保留（消费方需要 size/truncated 元信息）', () => {
    const env = { __bin: { size: 2, b64: 'AQI=', truncated: false } }
    const w = formatWriters('json', 'mysql', { fullTable: '`t`', headers: ['b'] })
    assert.deepEqual(JSON.parse(w.header() + w.chunk([{ b: env }], true) + w.tail()), [{ b: env }])
  })

  test('jsonl：每行一个 JSON，无头尾', () => {
    const w = formatWriters('jsonl', 'mysql', { fullTable: '`t`', headers: ['a'] })
    assert.equal(w.header(), '')
    assert.equal(w.chunk([{ a: 1 }, { a: 2 }], true), '{"a":1}\n{"a":2}\n')
    assert.equal(w.tail(), '')
  })

  test('markdown：表头 + 分隔行 + 竖线转义/换行压空格', () => {
    const w = formatWriters('markdown', 'mysql', { fullTable: '`t`', headers: ['a', 'b'] })
    assert.equal(w.header(), '| a | b |\n| --- | --- |\n')
    assert.equal(w.chunk([{ a: 'x|y', b: 'p\nq' }], true), '| x\\|y | p q |\n')
  })

  test('tsv：制表分隔 + 值内制表/换行压空格 + 信封 b64', () => {
    const w = formatWriters('tsv', 'mysql', { fullTable: '`t`', headers: ['a', 'b'] })
    assert.equal(w.header(), 'a\tb\n')
    const env = { __bin: { size: 2, b64: 'AQI=', truncated: false } }
    assert.equal(w.chunk([{ a: 'x\ty', b: env }], true), 'x y\tAQI=\n')
  })

  test('projectRow：以 headers 为准，缺列补 null（JSON 序列化比较：vm 域对象原型不同）', () => {
    assert.equal(JSON.stringify(projectRow({ a: 1 }, ['a', 'b'])), '{"a":1,"b":null}')
    assert.equal(JSON.stringify(projectRow(null, ['a'])), '{"a":null}')
  })
})

// ---------- 分批切分（insert-batch，mysql/pg 共用） ----------

describe('planInsertBatches 分批切分', () => {
  const { planInsertBatches, DEFAULT_MAX_ROWS, DEFAULT_MAX_BYTES } =
    require('../../app/lib/db-client/insert-batch')

  test('常量：500 行 / 1MB', () => {
    assert.equal(DEFAULT_MAX_ROWS, 500)
    assert.equal(DEFAULT_MAX_BYTES, 1024 * 1024)
  })

  test('空批 → 空计划', () => {
    assert.deepEqual(planInsertBatches([]), [])
    assert.deepEqual(planInsertBatches(null), [])
  })

  test('500 行上限：600 行 → 500 + 100，firstRow 正确', () => {
    const rows = Array.from({ length: 600 }, (_, i) => ({ i }))
    const batches = planInsertBatches(rows)
    assert.equal(batches.length, 2)
    assert.equal(batches[0].rows.length, 500)
    assert.equal(batches[0].firstRow, 0)
    assert.equal(batches[1].rows.length, 100)
    assert.equal(batches[1].firstRow, 500)
  })

  test('恰好 500 行 → 单批', () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({ i }))
    const batches = planInsertBatches(rows)
    assert.equal(batches.length, 1)
    assert.equal(batches[0].rows.length, 500)
  })

  test('1MB 体积切批：大行各自成批', () => {
    const big = 'x'.repeat(600 * 1024)
    const rows = [{ v: big }, { v: big }, { v: big }]
    const batches = planInsertBatches(rows)
    assert.equal(batches.length, 3)
    assert.deepEqual(batches.map(b => b.firstRow), [0, 1, 2])
  })

  test('末批不足：999 行 → 500 + 499', () => {
    const rows = Array.from({ length: 999 }, (_, i) => ({ i }))
    const batches = planInsertBatches(rows)
    assert.equal(batches.length, 2)
    assert.deepEqual(batches.map(b => b.rows.length), [500, 499])
  })

  test('单行超限不再切（单行 INSERT 无法拆分），照常成批', () => {
    const big = 'x'.repeat(2 * 1024 * 1024)
    const batches = planInsertBatches([{ v: big }])
    assert.equal(batches.length, 1)
    assert.equal(batches[0].rows.length, 1)
  })
})

// ---------- 状态机（vm + 打桩） ----------

describe('db-exporter 任务状态机', () => {
  test('start 立即返回 exportId，status running（分页挂起时）', async () => {
    const { ex } = setup({ hangPages: 1 })
    const { exportId } = ex.startExport(BASE_ARGS.tabId, BASE_ARGS)
    assert.match(exportId, /^exp-/)
    assert.equal(ex.exportStatus(exportId).status, 'running')
    // 挂起页永不返回：取消收尾，验证 running → cancelled
    ex.cancelExport(exportId)
    await waitFor(() => ex.exportStatus(exportId).status === 'cancelled')
  })

  test('正常完成 → done + rowsWritten + bytes', async () => {
    const { ex, stream } = setup({
      pages: [[{ id: 1, name: 'a' }], [{ id: 2, name: 'b' }], [{ id: 3, name: 'c' }]]
    })
    const { exportId } = ex.startExport(BASE_ARGS.tabId, BASE_ARGS)
    await waitFor(() => ex.exportStatus(exportId).status === 'done')
    const st = ex.exportStatus(exportId)
    assert.equal(st.rowsWritten, 3)
    assert.ok(st.bytes > 0)
    assert.equal(st.filePath, BASE_ARGS.targetPath)
    const text = stream.chunks.join('')
    assert.ok(text.startsWith('\uFEFFid,name\r\n'), 'BOM + 表头（结构列序）')
    assert.ok(text.includes('1,a\r\n2,b\r\n3,c\r\n'))
  })

  test('sql 格式端到端：头含 FOREIGN_KEY_CHECKS=0、INSERT 语句、尾恢复', async () => {
    const { ex, stream } = setup({ pages: [[{ id: 1, name: "O'Neil" }]] })
    const { exportId } = ex.startExport(BASE_ARGS.tabId, { ...BASE_ARGS, format: 'sql' })
    await waitFor(() => ex.exportStatus(exportId).status === 'done')
    const text = stream.chunks.join('')
    assert.ok(text.startsWith('SET FOREIGN_KEY_CHECKS=0;\n'))
    assert.ok(text.includes('INSERT INTO `db`.`t` (`id`, `name`) VALUES (1, \'O\'\'Neil\');\n'))
    assert.ok(text.endsWith('SET FOREIGN_KEY_CHECKS=1;\n'))
  })

  test('json 格式端到端：整文件 JSON.parse 通过（含信封保留）', async () => {
    const env = { __bin: { size: 2, b64: 'AQI=', truncated: false } }
    const { ex, stream } = setup({ pages: [[{ id: 1, name: env }]] })
    const { exportId } = ex.startExport(BASE_ARGS.tabId, { ...BASE_ARGS, format: 'json' })
    await waitFor(() => ex.exportStatus(exportId).status === 'done')
    const parsed = JSON.parse(stream.chunks.join(''))
    assert.deepEqual(parsed, [{ id: 1, name: env }])
  })

  test('无主键排序时把 pk 追加进 orderClauses（分页导出对账前提）', async () => {
    const { ex, fake } = setup({
      pages: [[{ id: 1 }]],
      structure: {
        columns: [
          { name: 'id', isPrimaryKey: true },
          { name: 'name', isPrimaryKey: false }
        ]
      }
    })
    const { exportId } = ex.startExport(BASE_ARGS.tabId, BASE_ARGS)
    await waitFor(() => ex.exportStatus(exportId).status === 'done')
    const pageArg = fake.calls.pageArgs[0]
    // JSON 比较：vm 域对象与测试域原型不同，deepStrictEqual 会误报
    assert.equal(JSON.stringify(pageArg.orderClauses), JSON.stringify([{ column: 'id', desc: false }]))
    assert.equal(pageArg.pageSize, ex.EXPORT_PAGE_SIZE)
  })

  test('用户已有排序列时不重复追加 pk', async () => {
    const { ex, fake } = setup({ pages: [[{ id: 1 }]] })
    const { exportId } = ex.startExport(BASE_ARGS.tabId, {
      ...BASE_ARGS,
      orderClauses: [{ column: 'name', desc: true }]
    })
    await waitFor(() => ex.exportStatus(exportId).status === 'done')
    assert.equal(JSON.stringify(fake.calls.pageArgs[0].orderClauses), JSON.stringify([
      { column: 'name', desc: true },
      { column: 'id', desc: false }
    ]))
  })

  test('columns 投影：只导出指定列（结构内子集）', async () => {
    const { ex, stream } = setup({ pages: [[{ id: 1, name: 'a' }]] })
    const { exportId } = ex.startExport(BASE_ARGS.tabId, { ...BASE_ARGS, columns: ['name'] })
    await waitFor(() => ex.exportStatus(exportId).status === 'done')
    assert.ok(stream.chunks.join('').startsWith('\uFEFFname\r\na\r\n'))
  })

  test('结构获取失败降级：表头取首行键，无 pk 排序，任务仍 done', async () => {
    const { ex, fake, stream } = setup({ structureFail: true, pages: [[{ z: 1, a: 2 }]] })
    const { exportId } = ex.startExport(BASE_ARGS.tabId, BASE_ARGS)
    await waitFor(() => ex.exportStatus(exportId).status === 'done')
    assert.equal(fake.calls.pageArgs[0].orderClauses, undefined)
    assert.ok(stream.chunks.join('').startsWith('\uFEFFz,a\r\n'))
  })

  test('cancel：取完第 2 页时取消 → 已完成块保留、取回未写的页丢弃', async () => {
    // onPage 在第 2 次取数时置取消位：第 1 页已写盘保留；第 2 页取回但未写（块边界语义）
    let ref = null
    const { ex, fake, stream } = setup({
      pages: [
        [{ id: 1, name: 'a' }, { id: 2, name: 'b' }],
        [{ id: 3, name: 'c' }, { id: 4, name: 'd' }]
      ],
      onPage: n => {
        if (n === 2 && ref) {
          ex.cancelExport(ref.exportId)
        }
      }
    })
    ref = ex.startExport(BASE_ARGS.tabId, BASE_ARGS)
    await waitFor(() => ex.exportStatus(ref.exportId).status === 'cancelled')
    const text = stream.chunks.join('')
    assert.ok(text.includes('1,a\r\n2,b\r\n'), '已完成块数据保留')
    assert.equal(fake.calls.pages, 2, '取消发生在第 2 次取数')
    assert.equal(ex.exportStatus(ref.exportId).rowsWritten, 2, '取回未写的页不计入')
  })

  test('单块失败 → failed，error 透出，已写文件保留', async () => {
    const { ex, stream } = setup({
      pages: [[{ id: 1, name: 'a' }], [{ id: 2, name: 'b' }]],
      pageFailOn: 2,
      pageErr: 'mock page fail'
    })
    const { exportId } = ex.startExport(BASE_ARGS.tabId, BASE_ARGS)
    await waitFor(() => ex.exportStatus(exportId).status === 'failed')
    const st = ex.exportStatus(exportId)
    assert.match(st.error, /mock page fail/)
    assert.ok(stream.chunks.join('').includes('1,a\r\n'), '失败前内容保留')
    assert.equal(st.rowsWritten, 1)
  })

  test('并发上限 4：第 5 个 start 抛错', async () => {
    const { ex } = setup({ hangPages: 10 })
    for (let i = 0; i < 4; i++) {
      ex.startExport(BASE_ARGS.tabId, BASE_ARGS)
    }
    assert.throws(() => ex.startExport(BASE_ARGS.tabId, BASE_ARGS), /上限 4/)
  })

  test('status/cancel 未知 id 抛错', () => {
    const { ex } = setup()
    assert.throws(() => ex.exportStatus('nope'), /unknown exportId/)
    assert.throws(() => ex.cancelExport('nope'), /unknown exportId/)
  })

  test('非法参数：格式 / targetPath / tables 缺失或多余', () => {
    const { ex } = setup()
    assert.throws(() => ex.startExport(BASE_ARGS.tabId, { ...BASE_ARGS, format: 'xml' }), /unsupported export format/)
    assert.throws(() => ex.startExport(BASE_ARGS.tabId, { ...BASE_ARGS, targetPath: '' }), /targetPath/)
    assert.throws(() => ex.startExport(BASE_ARGS.tabId, { ...BASE_ARGS, tables: ['a', 'b'] }), /one task per table/)
    assert.throws(() => ex.startExport(BASE_ARGS.tabId, { ...BASE_ARGS, table: undefined }), /table/)
  })

  test('done 清理：TTL 内可查、过期惰性清除', async () => {
    const { ex } = setup({ pages: [[{ id: 1 }]] })
    const { exportId } = ex.startExport(BASE_ARGS.tabId, BASE_ARGS)
    await waitFor(() => ex.exportStatus(exportId).status === 'done')
    // TTL 内：status 查询顺手的清理不该误删
    ex.sweepDoneTasks(Date.now())
    assert.equal(ex.exportStatus(exportId).status, 'done')
    // 过期：sweep 用未来时刻触发
    ex.sweepDoneTasks(Date.now() + ex.DONE_TTL_MS + 1000)
    assert.throws(() => ex.exportStatus(exportId), /unknown exportId/)
  })
})

// ---------- 适配器 buildInsertBatch（方言语句构建） ----------

describe('适配器 buildInsertBatch（mysql/pg）', () => {
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
  const mysql = require('../../app/lib/db-client/mysql')
  const postgres = require('../../app/lib/db-client/postgres')

  test('mysql append：multi-row VALUES 全占位符', () => {
    const sql = mysql.buildInsertBatch({
      fullTable: '`db`.`t`', cols: ['id', 'name'], rowCount: 2
    })
    assert.equal(sql, 'INSERT INTO `db`.`t` (`id`, `name`) VALUES (?, ?), (?, ?)')
  })

  test('mysql upsert：ON DUPLICATE KEY UPDATE，主键列不在 SET 里', () => {
    const sql = mysql.buildInsertBatch({
      fullTable: '`t`', cols: ['id', 'name'], rowCount: 1, mode: 'upsert', pkColumns: ['id']
    })
    assert.equal(sql, 'INSERT INTO `t` (`id`, `name`) VALUES (?, ?) ' +
      'ON DUPLICATE KEY UPDATE `name` = VALUES(`name`)')
  })

  test('mysql upsert 无主键抛错', () => {
    assert.throws(
      () => mysql.buildInsertBatch({ fullTable: '`t`', cols: ['id'], rowCount: 1, mode: 'upsert' }),
      /upsert requires primary key/
    )
  })

  test('mysql expressions：片段内联、参数跳过表达式列', () => {
    const sql = mysql.buildInsertBatch({
      fullTable: '`t`', cols: ['id', 'ts'], rowCount: 1, expressions: { ts: 'NOW()' }
    })
    assert.equal(sql, 'INSERT INTO `t` (`id`, `ts`) VALUES (?, NOW())')
    assert.deepEqual(
      mysql.insertBatchParams([{ id: 1, ts: undefined }], ['id', 'ts'], { ts: 'NOW()' }),
      [1]
    )
  })

  test('mysql insertRows：只读拒绝 / rebuild 占位拒绝（不触网）', async () => {
    await assert.rejects(
      mysql.insertRows(null, { rows: [{ a: 1 }], readOnly: true }),
      /read-only mode/
    )
    await assert.rejects(
      mysql.insertRows(null, { rows: [{ a: 1 }], readOnly: false, mode: 'rebuild' }),
      /insertRows mode: rebuild/
    )
  })

  test('pg append：$n 全批连续编号', () => {
    const sql = postgres.buildInsertBatch({
      fullTable: '"public"."t"', cols: ['id', 'name'], batchRows: [{ id: 1 }, { id: 2 }]
    })
    assert.equal(sql, 'INSERT INTO "public"."t" ("id", "name") VALUES ($1, $2), ($3, $4)')
  })

  test('pg upsert：ON CONFLICT ... DO UPDATE SET col = EXCLUDED.col', () => {
    const sql = postgres.buildInsertBatch({
      fullTable: '"public"."t"',
      cols: ['id', 'name'],
      batchRows: [{ id: 1 }],
      mode: 'upsert',
      pkColumns: ['id']
    })
    assert.equal(sql, 'INSERT INTO "public"."t" ("id", "name") VALUES ($1, $2) ' +
      'ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name"')
  })

  test('pg expressions：$n 编号跳过表达式列，params 顺序与编号一致', () => {
    const sql = postgres.buildInsertBatch({
      fullTable: '"t"',
      cols: ['id', 'a', 'ts'],
      batchRows: [{ id: 1, a: 'x' }, { id: 2, a: 'y' }],
      expressions: { ts: 'NOW()' }
    })
    assert.equal(sql, 'INSERT INTO "t" ("id", "a", "ts") VALUES ($1, $2, NOW()), ($3, $4, NOW())')
    assert.deepEqual(
      postgres.insertBatchParams(
        [{ id: 1, a: 'x' }, { id: 2, a: 'y' }], ['id', 'a', 'ts'], { ts: 'NOW()' }
      ),
      [1, 'x', 2, 'y']
    )
  })

  test('pg insertRows：只读拒绝 / rebuild 占位拒绝（不触网）', async () => {
    await assert.rejects(
      postgres.insertRows(null, { rows: [{ a: 1 }], readOnly: true }),
      /read-only mode/
    )
    await assert.rejects(
      postgres.insertRows(null, { rows: [{ a: 1 }], readOnly: false, mode: 'rebuild' }),
      /insertRows mode: rebuild/
    )
  })

  test('insertRows 空行集：不触网直接返回零批', async () => {
    const r = await mysql.insertRows(null, { rows: [], readOnly: false })
    assert.deepEqual(r, { affected: 0, batchCount: 0, failures: [] })
    const p = await postgres.insertRows(null, { rows: [], readOnly: false })
    assert.deepEqual(p, { affected: 0, batchCount: 0, failures: [] })
  })

  // ---------- QA Round1 回归：mock 驱动捕获真实语句 ----------

  // 独立补丁：外层补丁只挡 electron/electron-log，这里再叠一层挡驱动模块；
  // 委托回捕获的上一层，finally 恢复，不影响同 describe 其他用例
  function patchDriver (request, factory) {
    const M = require('node:module')
    const prev = M._load
    M._load = function (req, parent, isMain) {
      if (req === request) {
        return factory()
      }
      return prev.call(this, req, parent, isMain)
    }
    return () => {
      M._load = prev
    }
  }

  test('pg overwrite：批次前独立事务 DELETE，DELETE 失败中止整个导入', async () => {
    const queries = []
    const fakeClient = {
      connect: async () => {},
      end: async () => {},
      query: async (sql) => {
        queries.push(sql)
        if (String(sql).startsWith('DELETE FROM')) {
          throw new Error('mock delete denied')
        }
        return { rowCount: 1 }
      }
    }
    const restore = patchDriver('pg', () => ({
      Client: function () {
        return fakeClient
      }
    }))
    try {
      // conn 参数唯一，避免命中模块级 clients 缓存拿到别的用例的连接
      const conn = { dbHost: 'qa-pg-ow-fail', dbPort: 5432, dbUser: 'u', dbName: 'd' }
      await assert.rejects(
        postgres.insertRows(conn, {
          schema: 'public', table: 't', rows: [{ a: 1 }], readOnly: false, mode: 'overwrite'
        }),
        /overwrite 清空目标表失败/
      )
      assert.deepEqual(queries, ['BEGIN', 'DELETE FROM "public"."t"', 'ROLLBACK'])
    } finally {
      restore()
    }
  })

  test('pg overwrite：DELETE 成功后批次正常写入（语句顺序）', async () => {
    const queries = []
    const fakeClient = {
      connect: async () => {},
      end: async () => {},
      query: async (sql) => {
        queries.push(sql)
        return { rowCount: 1 }
      }
    }
    const restore = patchDriver('pg', () => ({
      Client: function () {
        return fakeClient
      }
    }))
    try {
      const conn = { dbHost: 'qa-pg-ow-ok', dbPort: 5432, dbUser: 'u', dbName: 'd' }
      const r = await postgres.insertRows(conn, {
        schema: 'public', table: 't', rows: [{ a: 1 }], readOnly: false, mode: 'overwrite'
      })
      assert.equal(r.failures.length, 0)
      assert.deepEqual(queries, [
        'BEGIN',
        'DELETE FROM "public"."t"',
        'COMMIT',
        'BEGIN',
        'INSERT INTO "public"."t" ("a") VALUES ($1)',
        'COMMIT'
      ])
    } finally {
      restore()
    }
  })

  test('mysql insertRows e2e：expression 列进 INSERT 列清单，VALUES 为字面量、params 正确', async () => {
    const calls = []
    const fakeConn = {
      query: async (sql, params) => {
        calls.push([sql, params])
        return [{ affectedRows: 1 }]
      },
      release: () => {}
    }
    const restore = patchDriver('mysql2/promise', () => ({
      createPool: () => ({
        getConnection: async () => fakeConn,
        end: async () => {}
      })
    }))
    try {
      const conn = { dbHost: 'qa-my-expr', dbPort: 3306, dbUser: 'u', dbName: 'db' }
      // 首行键含 expression 列（值为 undefined，mapRowToInsert 占键位）
      const r = await mysql.insertRows(conn, {
        database: 'db',
        table: 't',
        rows: [{ id: 1, note: 'K', ts: undefined }],
        readOnly: false,
        expressions: { ts: 'NOW()' }
      })
      assert.equal(r.failures.length, 0)
      const insertCall = calls.find(c => String(c[0]).startsWith('INSERT INTO'))
      assert.ok(insertCall, '未发出 INSERT')
      assert.equal(
        insertCall[0],
        'INSERT INTO `db`.`t` (`id`, `note`, `ts`) VALUES (?, ?, NOW())'
      )
      // 绑定参数只有非表达式列：id=1, note='K'，表达式列不占位
      assert.deepEqual(insertCall[1], [1, 'K'])
    } finally {
      restore()
    }
  })

  test('pg insertRows e2e：expression 列进 INSERT 列清单，$n 编号跳过表达式列', async () => {
    const calls = []
    const fakeClient = {
      connect: async () => {},
      end: async () => {},
      query: async (sql, params) => {
        calls.push([sql, params])
        return { rowCount: 1 }
      }
    }
    const restore = patchDriver('pg', () => ({
      Client: function () {
        return fakeClient
      }
    }))
    try {
      const conn = { dbHost: 'qa-pg-expr', dbPort: 5432, dbUser: 'u', dbName: 'd' }
      const r = await postgres.insertRows(conn, {
        schema: 'public',
        table: 't',
        rows: [{ id: 1, note: 'K', ts: undefined }],
        readOnly: false,
        expressions: { ts: 'NOW()' }
      })
      assert.equal(r.failures.length, 0)
      const insertCall = calls.find(c => String(c[0]).startsWith('INSERT INTO'))
      assert.ok(insertCall, '未发出 INSERT')
      assert.equal(
        insertCall[0],
        'INSERT INTO "public"."t" ("id", "note", "ts") VALUES ($1, $2, NOW())'
      )
      assert.deepEqual(insertCall[1], [1, 'K'])
    } finally {
      restore()
    }
  })
})
