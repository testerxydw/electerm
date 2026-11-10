const { describe, test, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const MOD = path.join(ROOT, 'src/app/lib/db-edit-history.js')
const FRONT = path.join(ROOT, 'src/client/common/db-edit-history.js')
const IPC = path.join(ROOT, 'src/app/lib/ipc.js')
const LOCALES = path.join(ROOT, 'src/app/common/locales-extra.js')
const HOOKS = [
  path.join(ROOT, 'src/client/components/database/use-db-cell-edit.js'),
  path.join(ROOT, 'src/client/components/database/use-db-insert.js'),
  path.join(ROOT, 'src/client/components/database/use-db-bulk-edit.js'),
  path.join(ROOT, 'src/client/components/database/use-db-changes.js')
]
const SESSION = path.join(ROOT, 'src/client/components/database/db-session.jsx')
const CHANGE_PANEL = path.join(ROOT, 'src/client/components/database/db-change-panel.jsx')

// N12c 数据修改历史（query edit history）：
// 主进程实现与 db-sql-history 同策略（userData 固定 JSON 文件），但语义刻意不同——
// 编辑历史是修改流水，同语句两次执行是两次真实修改，**不做去重**。本 spec 双层：
// 1) 主进程纯 fs 实现的单测（临时目录隔离）
// 2) 四个写 hook + 变更面板入口的接线契约（源码事实，防接线被静默拆掉）
const h = require(MOD)

const entry = (sql, extra = {}) => ({
  sql,
  kind: 'cell',
  database: 'db1',
  schema: '',
  table: 't1',
  n: 1,
  fail: 0,
  ok: true,
  dbType: 'mysql',
  dbHost: 'h1',
  dbName: 'db1',
  ...extra
})

describe('db-edit-history (main-process file store)', () => {
  let dir
  let file

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-db-edit-history-'))
    file = path.join(dir, 'db-edit-history.json')
  })

  test('append 后 list 返回最新在前，跨调用（跨启动）可读', () => {
    h.appendEditHistory(entry('UPDATE t1 SET a=1'), file)
    h.appendEditHistory(entry('UPDATE t1 SET a=2'), file)
    const list = h.listEditHistory(file)
    assert.equal(list.length, 2)
    assert.equal(list[0].sql, 'UPDATE t1 SET a=2')
    assert.equal(list[1].sql, 'UPDATE t1 SET a=1')
  })

  test('流水语义：同语句两次执行都留痕，不合并不去重（与 db-sql-history 刻意相反）', () => {
    h.appendEditHistory(entry('UPDATE t1 SET a=1', { ts: 100 }), file)
    h.appendEditHistory(entry('UPDATE t1 SET a=1', { ts: 200 }), file)
    h.appendEditHistory(entry('UPDATE t1 SET a=1', { ts: 300 }), file)
    const list = h.listEditHistory(file)
    assert.equal(list.length, 3)
    assert.deepEqual(list.map(x => x.ts), [300, 200, 100])
  })

  test('环形上限跟随 MAX：超出丢最旧', () => {
    for (let i = 0; i < h.MAX + 5; i++) {
      h.appendEditHistory(entry('UPDATE t1 SET a=' + i), file)
    }
    const list = h.listEditHistory(file)
    assert.equal(list.length, h.MAX)
    assert.equal(list[0].sql, 'UPDATE t1 SET a=' + (h.MAX + 4))
    assert.equal(list[h.MAX - 1].sql, 'UPDATE t1 SET a=5')
  })

  test('白名单清洗：未知字段（含疑似敏感字段）不落盘，字段类型归一', () => {
    h.appendEditHistory(entry('UPDATE t1 SET a=1', {
      password: 'SHOULD-NOT-PERSIST',
      results: [{ big: 'blob' }],
      n: '3',
      fail: undefined,
      ts: '1699999999999'
    }), file)
    const it = h.listEditHistory(file)[0]
    assert.equal(it.password, undefined)
    assert.equal(it.results, undefined)
    assert.equal(it.n, 3)
    assert.equal(it.fail, 0)
    assert.equal(it.ts, 1699999999999)
    // 字段形状固定：白名单键一个不多一个不少
    assert.deepEqual(Object.keys(it).sort(), [
      'database', 'dbFile', 'dbHost', 'dbName', 'dbType',
      'fail', 'kind', 'n', 'ok', 'schema', 'sql', 'table', 'ts'
    ].sort())
  })

  test('sql 摘要截断到 SQL_MAX 并留标记（防大批次撑爆存储文件）', () => {
    h.appendEditHistory(entry('x'.repeat(h.SQL_MAX + 500)), file)
    const it = h.listEditHistory(file)[0]
    assert.ok(it.sql.length < h.SQL_MAX + 100)
    assert.ok(it.sql.endsWith('…[truncated]'))
  })

  test('remove 按 (ts + sql) 定位：重复条目一次删一条', () => {
    h.appendEditHistory(entry('UPDATE t1 SET a=1', { ts: 100 }), file)
    h.appendEditHistory(entry('UPDATE t1 SET a=1', { ts: 200 }), file)
    const after = h.removeEditHistory({ ts: 200, sql: 'UPDATE t1 SET a=1' }, file)
    assert.equal(after.length, 1)
    assert.equal(after[0].ts, 100)
    // 定位不中：原样返回，不误删
    const again = h.removeEditHistory({ ts: 999, sql: 'nope' }, file)
    assert.equal(again.length, 1)
  })

  test('clear 删文件；损坏/半截文件视作空历史不抛错', () => {
    h.appendEditHistory(entry('UPDATE t1 SET a=1'), file)
    h.clearEditHistory(file)
    assert.equal(fs.existsSync(file), false)
    fs.writeFileSync(file, '{"half":')
    assert.deepEqual(h.listEditHistory(file), [])
    // 坏条目自愈：无 sql 的条目被过滤
    fs.writeFileSync(file, JSON.stringify([{ noSql: 1 }, entry('good')]))
    const list = h.listEditHistory(file)
    assert.equal(list.length, 1)
    assert.equal(list[0].sql, 'good')
  })

  test('exportFile 白名单清洗写 JSON，返回条数', () => {
    const out = path.join(dir, 'export.json')
    const n = h.exportEditHistory([
      entry('UPDATE t1 SET a=1', { password: 'x' }),
      { bad: true }
    ], out)
    assert.equal(n, 1)
    const arr = JSON.parse(fs.readFileSync(out, 'utf8'))
    assert.equal(arr.length, 1)
    assert.equal(arr[0].password, undefined)
  })
})

describe('db-edit-history wiring (N12c contract)', () => {
  const read = p => fs.readFileSync(p, 'utf8')

  test('渲染层接口走 dbEditHistoryOp 白名单 action', () => {
    const src = read(FRONT)
    for (const action of ['list', 'append', 'remove', 'clear', 'exportFile']) {
      assert.ok(src.includes(`'dbEditHistoryOp', '${action}'`), action)
    }
  })

  test('主进程 ipc.js 登记 dbEditHistoryOp 通道（userData 固定文件）', () => {
    const src = read(IPC)
    assert.ok(src.includes('dbEditHistoryOp: async (action, arg) =>'))
    assert.ok(src.includes("join(app.getPath('userData'), 'db-edit-history.json')"))
    assert.ok(src.includes("require('./db-edit-history')"))
  })

  test('四个写 hook 全部接线 appendEditHistory 且注入 editHistoryBase', () => {
    // 期望 kind 覆盖全部即时写路径：cell / insert+delete / cells / changes
    const expectKind = {
      'use-db-cell-edit.js': 'cell',
      'use-db-insert.js': ['insert', 'delete'],
      'use-db-bulk-edit.js': 'cells',
      'use-db-changes.js': 'changes'
    }
    for (const file of HOOKS) {
      const name = path.basename(file)
      const src = read(file)
      assert.ok(src.includes("from '../../common/db-edit-history'"), name + ': import missing')
      assert.ok(src.includes('appendEditHistory('), name + ': append call missing')
      assert.ok(src.includes('editHistoryBase'), name + ': editHistoryBase missing')
      const kinds = [].concat(expectKind[name])
      for (const k of kinds) {
        assert.ok(src.includes(`kind: '${k}'`), name + ': kind ' + k + ' missing')
      }
    }
  })

  test('db-session.jsx 构造 editHistoryBase 并传给四个 hook；不含密码字段', () => {
    const src = read(SESSION)
    assert.ok(src.includes('const editHistoryBase = useMemo'))
    assert.ok(src.includes('useDbEditHistory()'))
    assert.ok(src.includes('<DbEditHistoryPanel'))
    // 传递点：changes + 三个写 hook
    const passes = src.match(/editHistoryBase$/gm) || []
    assert.ok(passes.length >= 4, 'editHistoryBase pass count: ' + passes.length)
    // 连接识别只用 tab 的公开字段，绝不带 dbPassword
    const base = src.slice(src.indexOf('const editHistoryBase'), src.indexOf('}, [tab.dbType'))
    assert.ok(base.includes('dbType: tab.dbType'))
    assert.ok(base.includes('dbFile: tab.dbFile'))
    assert.ok(!base.includes('Password'))
  })

  test('变更面板暴露历史入口；词条 en/zh 成对且含面板全部键', () => {
    const panel = read(CHANGE_PANEL)
    assert.ok(panel.includes('onOpenHistory'))
    assert.ok(panel.includes('dbEditHistoryTip'))
    const loc = read(LOCALES)
    const keys = [
      'dbEditHistory:', 'dbEditHistoryTip:', 'dbEditHistoryKindChanges:',
      'dbEditHistoryFilterTip:', 'dbEditHistoryCount:', 'dbEditHistoryPartial:',
      'dbEditHistoryRemove:', 'dbEditHistoryClear:', 'dbEditHistoryClearConfirm:',
      'dbEditHistoryEmpty:'
    ]
    for (const k of keys) {
      const n = loc.split(k).length - 1
      assert.equal(n, 2, k + ' should appear exactly twice (en + zhCn), got ' + n)
    }
  })
})
