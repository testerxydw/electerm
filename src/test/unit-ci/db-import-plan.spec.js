/**
 * 导入向导纯逻辑层单测（N4a，设计 §N4）
 *
 * 两条责任线：
 * 1. 载荷形状 —— 行通道带 table/mapping/mode/batchSize，脚本通道带 statements
 *    且**不带**那四件（表名写在语句里，模式与分批对它无意义）；缺件抛的是文案 key。
 * 2. 与主进程的契约 —— 界面能选的格式集合必须等于解析器注册表、语句上限必须与
 *    执行层同一数字。这两条是跨进程口径，一旦漂移就是"界面选了 JSONL、主进程按
 *    逗号切"，单靠 UI 测试抓不到，所以在 unit-ci 里钉死。
 *
 * 加载方式：客户端 ESM 用动态 import 跑真实源码（同 db-sql-risk.spec.js）；
 * 主进程侧要 electron / electron-log 桩（同 db-importer.spec.js）。
 */
process.env.NODE_ENV = 'development'

const { describe, test, before } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')
const { pathToFileURL } = require('node:url')

const ROOT = path.join(__dirname, '../../..')
const PLAN = path.join(ROOT, 'src/client/common/db-import-plan.js')

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

const { IMPORT_FORMATS, IMPORT_FORMAT_IDS: MAIN_IDS } = require('../../app/lib/db-import/parsers')
const { MAX_IMPORT_STATEMENTS } = require('../../app/lib/db-importer')

let P
before(async () => {
  P = await import(pathToFileURL(PLAN).href)
})

describe('与主进程注册表的契约', () => {
  test('界面格式候选 = 解析器注册表 id（同集同序）', () => {
    assert.deepEqual(P.IMPORT_FORMAT_IDS, MAIN_IDS)
    assert.deepEqual(P.IMPORT_FORMAT_IDS, IMPORT_FORMATS.map(f => f.id))
  })

  test('UI 语句上限 = 执行层语句上限', () => {
    assert.equal(P.MAX_UI_STATEMENTS, MAX_IMPORT_STATEMENTS)
  })

  test('AUTO 是空串：判定权留在主进程', () => {
    assert.equal(P.FORMAT_AUTO, '')
    assert.ok(!P.IMPORT_FORMAT_IDS.includes(P.FORMAT_AUTO))
  })
})

describe('stepsOf / stepTitles / kindOfFile', () => {
  test('行通道 4 步、脚本通道 3 步（没有映射与写入模式）', () => {
    assert.deepEqual(P.stepsOf('rows'), P.ROWS_STEPS)
    assert.deepEqual(P.stepsOf('script'), ['file', 'statements', 'run'])
    assert.ok(!P.SCRIPT_STEPS.includes('mapping'))
    assert.ok(!P.SCRIPT_STEPS.includes('mode'))
  })

  test('未知 kind 回落行通道（预览没给 kind 时步骤条不能变短）', () => {
    assert.deepEqual(P.stepsOf(undefined), P.ROWS_STEPS)
  })

  test('stepTitles 每步都有词条 key', () => {
    const seen = []
    const items = P.stepTitles('script', k => {
      seen.push(k)
      return 'x'
    })
    assert.deepEqual(items.map(i => i.title), ['x', 'x', 'x'])
    assert.deepEqual(seen, ['dbImportFile', 'dbImportStatements', 'dbImportRun'])
  })

  test('kindOfFile：只有主进程给的 kind 算数', () => {
    assert.equal(P.kindOfFile(null), 'rows')
    assert.equal(P.kindOfFile({ kind: 'script' }), 'script')
    assert.equal(P.kindOfFile({ kind: 'rows' }), 'rows')
    // 渲染层自己写 format 不改变通道：通道只由 kind 决定
    assert.equal(P.kindOfFile({ format: 'sql' }), 'rows')
  })
})

describe('statementPlan：切分与分级同源', () => {
  test('多条语句逐条给出文本与风险级', () => {
    const r = P.statementPlan('SELECT 1; DELETE FROM t; ', 'mysql')
    assert.deepEqual(r.statements.map(s => s.text), ['SELECT 1', 'DELETE FROM t'])
    assert.deepEqual(r.statements.map(s => s.level), ['read', 'dangerous'])
    assert.equal(r.level, 'dangerous')
    assert.ok(r.reasons.length)
  })

  test('空文本 → 空清单（不是抛错，UI 据此灰掉下一步）', () => {
    assert.deepEqual(P.statementPlan('', 'mysql').statements, [])
    assert.deepEqual(P.statementPlan(null, 'mysql').statements, [])
    assert.deepEqual(P.statementPlan('-- 只是注释', 'mysql').statements, [])
  })

  test('方言影响切分：# 只在 mysql 是行注释，pg/sqlite 里的 ; 照样断句', () => {
    const sql = 'SELECT 1 # c;\nSELECT 2;'
    assert.deepEqual(
      P.statementPlan(sql, 'mysql').statements.map(s => s.text),
      ['SELECT 1 # c;\nSELECT 2']
    )
    assert.deepEqual(
      P.statementPlan(sql, 'pg').statements.map(s => s.text),
      ['SELECT 1 # c', 'SELECT 2']
    )
    assert.equal(P.statementPlan(sql, 'sqlite').statements.length, 2)
  })

  test('双引号标识符/字符串里的分号不断句（三家一致）', () => {
    for (const d of ['mysql', 'pg', 'sqlite']) {
      const r = P.statementPlan('SELECT "a;b" FROM t;', d)
      assert.deepEqual(r.statements.map(s => s.text), ['SELECT "a;b" FROM t'])
    }
  })
})

describe('buildStartPayload：两条通道的载荷', () => {
  const file = { filePath: '/tmp/x.csv', format: 'csv', kind: 'rows' }
  const rowsState = {
    file,
    kind: 'rows',
    tabId: 't1',
    database: 'db',
    schema: '',
    table: 'users',
    rows: [
      { fileCol: 'id', mode: 'field', target: 'id' },
      { fileCol: 'name', mode: 'field', target: 'name' },
      { fileCol: 'junk', mode: 'ignore' }
    ],
    mode: 'append',
    batchSize: 200
  }

  test('行通道：table/mapping/mode/batchSize + filePath/format 回传', () => {
    const p = P.buildStartPayload(rowsState)
    assert.equal(p.filePath, '/tmp/x.csv')
    assert.equal(p.format, 'csv')
    assert.equal(p.table, 'users')
    assert.equal(p.mode, 'append')
    assert.equal(p.batchSize, 200)
    assert.deepEqual(p.mapping, [
      { fileCol: 'id', target: 'id' },
      { fileCol: 'name', target: 'name' }
    ])
    assert.equal('statements' in p, false)
  })

  test('xlsx 通道：sheetName 只在该格式回传（N4b）', () => {
    const p = P.buildStartPayload({
      ...rowsState,
      file: { filePath: '/tmp/x.xlsx', format: 'xlsx', kind: 'rows', sheetName: 'S2' }
    })
    assert.equal(p.sheetName, 'S2')
    // 非 xlsx 不带 sheetName（主进程匹配不到时回落第一个 sheet，但这里根本不该有）
    const q = P.buildStartPayload(rowsState)
    assert.equal('sheetName' in q, false)
  })

  test('脚本通道：只带 statements，不带 table/mapping/mode/batchSize', () => {
    const p = P.buildStartPayload({
      file: { filePath: '/tmp/x.sql', format: 'sql', kind: 'script' },
      kind: 'script',
      tabId: 't1',
      database: 'db',
      schema: 'public',
      statements: [' INSERT INTO t VALUES (1) ', 'DELETE FROM t']
    })
    assert.deepEqual(p.statements, ['INSERT INTO t VALUES (1)', 'DELETE FROM t'])
    assert.equal(p.format, 'sql')
    assert.equal(p.schema, 'public')
    for (const k of ['table', 'mapping', 'mode', 'batchSize']) {
      assert.equal(k in p, false, k + ' 不应出现在脚本通道载荷里')
    }
  })

  test('缺文件 / 缺表 / 无语句 / 空语句：抛的都是文案 key', () => {
    assert.throws(() => P.buildStartPayload({ ...rowsState, file: null }), /dbImportNoFile/)
    assert.throws(() => P.buildStartPayload({ ...rowsState, file: { filePath: '' } }), /dbImportNoFile/)
    assert.throws(() => P.buildStartPayload({ ...rowsState, table: '' }), /dbImportNoTable/)
    const s = { file: { filePath: '/x.sql', format: 'sql' }, kind: 'script' }
    assert.throws(() => P.buildStartPayload({ ...s, statements: [] }), /dbImportNoStatements/)
    assert.throws(() => P.buildStartPayload({ ...s, statements: ['   '] }), /dbImportEmptyStatement/)
  })

  test('payloadProblem 与抛错同一口径（UI 用它禁用按钮）', () => {
    assert.equal(P.payloadProblem(rowsState), null)
    assert.equal(P.payloadProblem({ ...rowsState, table: '' }), 'dbImportNoTable')
  })

  test('非数组 statements 不炸（防御 IPC 侧形态）', () => {
    const s = { file: { filePath: '/x.sql', format: 'sql' }, kind: 'script' }
    assert.throws(() => P.buildStartPayload({ ...s, statements: null }), /dbImportNoStatements/)
  })
})

describe('statementsProblem：条数护栏', () => {
  test('0 条 → 没语句；上限内 → null', () => {
    assert.equal(P.statementsProblem(0), 'dbImportNoStatements')
    assert.equal(P.statementsProblem(1), null)
    assert.equal(P.statementsProblem(P.MAX_UI_STATEMENTS), null)
  })

  test('超上限 → 提示而不是静默截断', () => {
    assert.equal(P.statementsProblem(P.MAX_UI_STATEMENTS + 1), 'dbImportTooManyStatements')
  })
})
