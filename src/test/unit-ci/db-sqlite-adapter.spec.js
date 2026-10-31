/**
 * H8a：SQLite 适配器单测。
 *
 * 两条轨：
 * - 纯函数轨：真实 require（quoteIdent / splitStatements / buildInsertBatch / checkReadonly /
 *   parseSqlitePlan …），不碰数据库；
 * - 集成轨：在 os.tmpdir() 建真实 .db 文件，用 node:sqlite 建表造数，再把适配器放在 vm 里
 *   加载后跑完整 op（元数据/结构/DDL/分页/CRUD/多语句/只读/行数上限/事务）。
 *
 * 为什么用 vm 而不是直接 require：适配器顶层 require 了 electron-log，
 * 单测环境没有 electron；vm 白名单只注入 node:sqlite / fs / path 与三个纯模块。
 *
 * 为什么用真实文件而不是 :memory:：`node:sqlite` 的 :memory: 库在连接关闭后即消失，
 * 而适配器的引用计数、按路径缓存、事务独立连接这些行为都只在文件上才有意义。
 */
process.env.NODE_ENV = 'development'

const { describe, test, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { DatabaseSync } = require('node:sqlite')

const ROOT = path.join(__dirname, '../../..')
const SQLITE_JS = path.join(ROOT, 'src/app/lib/db-client/sqlite.js')
const INDEX_JS = path.join(ROOT, 'src/app/lib/db-client/index.js')
const SAFE_CLAUSE_JS = path.join(ROOT, 'src/app/lib/db-client/safe-clause.js')
const TYPE_NORM_JS = path.join(ROOT, 'src/app/common/db-type-normalize.js')

const structureV2 = require(path.join(ROOT, 'src/app/lib/db-client/structure-v2.js'))
const insertBatch = require(path.join(ROOT, 'src/app/lib/db-client/insert-batch.js'))
const erGraph = require(path.join(ROOT, 'src/app/lib/db-client/er-graph.js'))
const typeNorm = require(TYPE_NORM_JS)
const safeClause = require(SAFE_CLAUSE_JS)

const LOG_STUB = { debug () {}, info () {}, warn () {}, error () {} }

// vm 里的对象字面量属于 vm realm，deepStrictEqual 会因原型不同失败；
// 断言前统一过一次 JSON 往返（行数据只含原始值与纯对象）
function plain (v) {
  return JSON.parse(JSON.stringify(v))
}

function loadAdapter () {
  const src = fs.readFileSync(SQLITE_JS, 'utf8')
  const mod = { exports: {} }
  const sandbox = {
    module: mod,
    exports: mod.exports,
    require: spec => {
      switch (spec) {
        case '../../common/log': return LOG_STUB
        case '../../common/db-type-normalize': return typeNorm
        case 'node:fs': return fs
        case 'node:path': return path
        case 'node:sqlite': return { DatabaseSync }
        case './structure-v2': return structureV2
        case './insert-batch': return insertBatch
        case './er-graph': return erGraph
        default: throw new Error('unexpected require: ' + spec)
      }
    },
    console,
    Buffer,
    // 注入宿主 realm 的这几个：适配器用 `instanceof` 判定 Uint8Array/Date，
    // vm 自带的那几个与宿主不是同一个构造器，判定会恒为 false
    Uint8Array,
    Date,
    setTimeout,
    clearTimeout,
    Promise
  }
  vm.createContext(sandbox)
  vm.runInContext(src, sandbox, { filename: SQLITE_JS })
  return mod.exports
}

const adapter = loadAdapter()

const SCHEMA = `
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  score REAL,
  code VARCHAR(32),
  born DATE,
  avatar BLOB,
  note TEXT DEFAULT 'x'
);
CREATE TABLE tags (
  id INTEGER,
  lang TEXT,
  label TEXT,
  PRIMARY KEY (id, lang)
);
CREATE TABLE posts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT,
  UNIQUE (title)
);
CREATE INDEX idx_posts_user ON posts(user_id);
CREATE TABLE post_tags (
  post_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  tag_lang TEXT NOT NULL,
  PRIMARY KEY (post_id, tag_id, tag_lang),
  FOREIGN KEY (tag_id, tag_lang) REFERENCES tags(id, lang) ON DELETE CASCADE
);
CREATE TABLE nopk (a TEXT);
CREATE VIEW v_users AS SELECT id, name FROM users;
INSERT INTO users (id, name, score, code, born, note) VALUES
  (1, 'alice', 1.5, 'A1', '2024-01-05', 'n1'),
  (2, 'bob', 2.5, 'B2', '2024-02-06', 'n2'),
  (3, 'carol', 3.5, 'C3', '2024-03-07', 'n3');
INSERT INTO users (id, name, avatar) VALUES (4, 'dave', X'0102FF');
INSERT INTO tags VALUES (1, 'en', 'one'), (1, 'zh', '一');
INSERT INTO posts (id, user_id, title) VALUES (10, 1, 'hello'), (11, 2, 'world');
`

function makeDbFile () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-sqlite-adapter-'))
  const file = path.join(dir, 'test.db')
  const db = new DatabaseSync(file)
  db.exec(SCHEMA)
  db.close()
  return { dir, file }
}

// ---------------------------------------------------------------- 纯函数

describe('sqlite adapter · pure helpers', () => {
  test('quoteIdent 用双引号并把内部双引号双写', () => {
    assert.equal(adapter.quoteIdent('users'), '"users"')
    assert.equal(adapter.quoteIdent('a"b'), '"a""b"')
    assert.equal(adapter.quoteIdent(''), '""')
  })

  test('splitStatements 不切字符串/标识符/注释里的分号', () => {
    assert.deepEqual(
      plain(adapter.splitStatements("SELECT ';' FROM t; SELECT 2")),
      ["SELECT ';' FROM t", 'SELECT 2']
    )
    assert.deepEqual(
      plain(adapter.splitStatements('SELECT ";" FROM t;')),
      ['SELECT ";" FROM t']
    )
    assert.deepEqual(
      plain(adapter.splitStatements('SELECT `;` FROM t')),
      ['SELECT `;` FROM t']
    )
    assert.deepEqual(
      plain(adapter.splitStatements('SELECT [;] FROM t')),
      ['SELECT [;] FROM t']
    )
    assert.deepEqual(
      plain(adapter.splitStatements('SELECT 1 -- ; here\n; SELECT 2')),
      ['SELECT 1 -- ; here', 'SELECT 2']
    )
    assert.deepEqual(
      plain(adapter.splitStatements('SELECT 1 /* ; */; SELECT 2')),
      ['SELECT 1 /* ; */', 'SELECT 2']
    )
    // 只有注释/空白的段丢弃
    assert.deepEqual(plain(adapter.splitStatements('; -- note\n ;')), [])
    assert.deepEqual(plain(adapter.splitStatements('')), [])
  })

  test('bindValue 把驱动不认的类型先归一', () => {
    assert.equal(adapter.bindValue(undefined), null)
    assert.equal(adapter.bindValue(true), 1)
    assert.equal(adapter.bindValue(false), 0)
    assert.equal(adapter.bindValue(new Date('2024-01-05T00:00:00.000Z')), '2024-01-05T00:00:00.000Z')
    assert.equal(adapter.bindValue({ a: 1 }), '{"a":1}')
    const buf = Buffer.from([1, 2, 3])
    assert.equal(adapter.bindValue(buf), buf)
    assert.equal(adapter.bindValue(42), 42)
    assert.equal(adapter.bindValue('x'), 'x')
  })

  test('pageWindow 默认值、上下限与 offset', () => {
    assert.deepEqual(plain(adapter.pageWindow(undefined, undefined)), { page: 1, pageSize: 100, offset: 0 })
    assert.deepEqual(plain(adapter.pageWindow(3, 50)), { page: 3, pageSize: 50, offset: 100 })
    // 每页上限 1000：同步 API 阻塞主进程，不允许一屏取更多
    assert.deepEqual(plain(adapter.pageWindow(1, 999999)), { page: 1, pageSize: 1000, offset: 0 })
    assert.deepEqual(plain(adapter.pageWindow(0, 0)), { page: 1, pageSize: 100, offset: 0 })
  })

  test('buildOrderSql 接受多列并限制 3 列，orderBy 只认裸标识符', () => {
    assert.equal(
      adapter.buildOrderSql([
        { column: 'a', desc: true },
        { column: 'b' },
        { column: 'c', desc: true },
        { column: 'd' }
      ]),
      '"a" DESC, "b" ASC, "c" DESC'
    )
    assert.equal(adapter.buildOrderSql(null, 'name', 'descend'), '"name" DESC')
    assert.equal(adapter.buildOrderSql(null, 'name', 'ascend'), '"name" ASC')
    assert.equal(adapter.buildOrderSql(null, 'a; DROP TABLE t', 'ascend'), '')
    assert.equal(adapter.buildOrderSql(null, '', 'ascend'), '')
  })

  test('buildInsertBatch：append / upsert / 表达式列', () => {
    const append = adapter.buildInsertBatch({
      table: 't',
      cols: ['a', 'b'],
      rowCount: 2
    })
    assert.equal(append, 'INSERT INTO "t" ("a", "b") VALUES (?, ?), (?, ?)')

    const upsert = adapter.buildInsertBatch({
      table: 't',
      cols: ['id', 'a'],
      rowCount: 1,
      mode: 'upsert',
      pkColumns: ['id']
    })
    assert.equal(
      upsert,
      'INSERT INTO "t" ("id", "a") VALUES (?, ?) ON CONFLICT ("id") DO UPDATE SET "a" = excluded."a"'
    )
    assert.throws(
      () => adapter.buildInsertBatch({ table: 't', cols: ['a'], rowCount: 1, mode: 'upsert', pkColumns: [] }),
      /upsert requires primary key columns/
    )
    assert.throws(
      () => adapter.buildInsertBatch({ table: 't', cols: ['id'], rowCount: 1, mode: 'upsert', pkColumns: ['id'] }),
      /updatable columns/
    )

    const withExpr = adapter.buildInsertBatch({
      table: 't',
      cols: ['a', 'b'],
      rowCount: 2,
      expressions: { b: 'CURRENT_TIMESTAMP' }
    })
    assert.equal(
      withExpr,
      'INSERT INTO "t" ("a", "b") VALUES (?, CURRENT_TIMESTAMP), (?, CURRENT_TIMESTAMP)'
    )
    assert.deepEqual(
      plain(adapter.insertBatchParams([{ a: 1, b: 'x' }, { a: 2, b: 'y' }], ['a', 'b'], { b: 'CURRENT_TIMESTAMP' })),
      [1, 2]
    )
  })

  test('checkReadonly：放行只读、拦写与带 = 的 PRAGMA', () => {
    assert.doesNotThrow(() => adapter.checkReadonly('SELECT 1', true))
    assert.doesNotThrow(() => adapter.checkReadonly('  with x as (select 1) select * from x', true))
    assert.doesNotThrow(() => adapter.checkReadonly('VALUES (1)', true))
    assert.doesNotThrow(() => adapter.checkReadonly('PRAGMA table_info("t")', true))
    assert.doesNotThrow(() => adapter.checkReadonly('DELETE FROM t', false))

    assert.throws(() => adapter.checkReadonly('DELETE FROM t', true), /read-only/)
    assert.throws(() => adapter.checkReadonly('WITH x AS (SELECT 1) DELETE FROM t', true), /read-only/)
    assert.throws(() => adapter.checkReadonly('PRAGMA journal_mode = WAL', true), /read-only/)
    assert.throws(() => adapter.checkReadonly('PRAGMA writable_schema = 1', true), /read-only/)
    assert.throws(() => adapter.checkReadonly('VACUUM', true), /read-only/)
  })

  test('checkWritable 只在只读时抛错', () => {
    assert.doesNotThrow(() => adapter.checkWritable(false))
    assert.throws(() => adapter.checkWritable(true), /read-only/)
  })

  test('parseSqlitePlan 按 id/parent 建成节点树', () => {
    const plan = adapter.parseSqlitePlan([
      { id: 2, parent: 0, notused: 0, detail: 'SCAN posts' },
      { id: 0, parent: 0, notused: 0, detail: 'SEARCH users USING INTEGER PRIMARY KEY (rowid=?)' },
      { id: 5, parent: 0, notused: 0, detail: 'USE TEMP B-TREE FOR ORDER BY' }
    ])
    assert.equal(plan.nodeType, 'QUERY PLAN')
    assert.equal(plan.children.length, 1)
    const root = plan.children[0]
    assert.equal(root.nodeType, 'SEARCH')
    assert.equal(root.table, 'users')
    assert.equal(root.key, 'PRIMARY')
    // id=0 是自己，不挂到 children 里造成自环
    assert.deepEqual(plain(root.children.map(c => c.nodeType)), ['SCAN', 'USE TEMP B-TREE'])
    assert.equal(root.children[0].table, 'posts')
  })

  test('常量口径与设计一致', () => {
    assert.equal(adapter.MAX_SQL_ROWS, 10000)
    assert.equal(adapter.DELETE_ROWS_LIMIT, 200)
    assert.equal(adapter.UPDATE_CELLS_LIMIT, 200)
  })
})

// ---------------------------------------------------------------- 类型归一

describe('sqlite type normalize', () => {
  test('声明类型 → 与 db-format-value 同源的归一类型', () => {
    assert.equal(typeNorm.normalizeSqliteType('INTEGER'), 'integer')
    assert.equal(typeNorm.normalizeSqliteType('INT'), 'integer')
    assert.equal(typeNorm.normalizeSqliteType('BIGINT'), 'integer')
    assert.equal(typeNorm.normalizeSqliteType('TEXT'), 'text')
    assert.equal(typeNorm.normalizeSqliteType('VARCHAR(32)'), 'text')
    assert.equal(typeNorm.normalizeSqliteType('NVARCHAR(10)'), 'text')
    assert.equal(typeNorm.normalizeSqliteType('CLOB'), 'text')
    assert.equal(typeNorm.normalizeSqliteType('REAL'), 'real')
    assert.equal(typeNorm.normalizeSqliteType('DOUBLE'), 'real')
    assert.equal(typeNorm.normalizeSqliteType('FLOAT'), 'real')
    assert.equal(typeNorm.normalizeSqliteType('BLOB'), 'blob')
    assert.equal(typeNorm.normalizeSqliteType('DATETIME'), 'datetime')
    assert.equal(typeNorm.normalizeSqliteType('DATE'), 'datetime')
    assert.equal(typeNorm.normalizeSqliteType('TIMESTAMP'), 'datetime')
    assert.equal(typeNorm.normalizeSqliteType('DECIMAL(10,2)'), 'numeric')
    assert.equal(typeNorm.normalizeSqliteType('BOOLEAN'), 'numeric')
    assert.equal(typeNorm.normalizeSqliteType('WEIRD'), 'numeric')
    // 无声明类型（表达式 / 无类型列）：返回 '' 按未知处理，
    // 不能回落 blob —— 否则 `SELECT 1+1` 会被前端当二进制呈现
    assert.equal(typeNorm.normalizeSqliteType(''), '')
    assert.equal(typeNorm.normalizeSqliteType(null), '')
  })
})

// ---------------------------------------------------------------- 集成

describe('sqlite adapter · integration', () => {
  let ctx = null

  beforeEach(() => {
    const { dir, file } = makeDbFile()
    const conn = { dbType: 'sqlite', dbFile: file }
    ctx = { dir, file, conn }
    return adapter.acquire(conn)
  })

  afterEach(async () => {
    if (!ctx) {
      return
    }
    await adapter.release(ctx.conn)
    fs.rmSync(ctx.dir, { recursive: true, force: true })
    ctx = null
  })

  test('testSqliteConnection：文件不存在给出明确错误，存在则返回 sqlite ok', async () => {
    assert.equal(await adapter.testSqliteConnection(ctx.conn), 'sqlite ok')
    await assert.rejects(
      adapter.testSqliteConnection({ dbType: 'sqlite', dbFile: path.join(ctx.dir, 'missing.db') }),
      /SQLite 数据库文件不存在/
    )
    await assert.rejects(adapter.testSqliteConnection({ dbType: 'sqlite' }), /sqlite database file required/)
  })

  test('acquire 遇到不存在的文件直接失败，不隐式创建空库', async () => {
    const missing = { dbType: 'sqlite', dbFile: path.join(ctx.dir, 'missing.db') }
    await assert.rejects(adapter.acquire(missing), /SQLite 数据库文件不存在/)
    assert.equal(fs.existsSync(missing.dbFile), false)
  })

  test('getMetadata：main 下表格 + 视图，过滤 sqlite_ 系统表', async () => {
    const meta = await adapter.getMetadata(ctx.conn)
    assert.equal(meta.length, 1)
    assert.equal(meta[0].name, 'main')
    assert.equal(meta[0].type, 'database')
    const names = meta[0].children.map(c => c.name)
    assert.ok(names.includes('users'))
    assert.ok(names.includes('v_users'))
    assert.ok(!names.some(n => n.startsWith('sqlite_')))
    assert.equal(meta[0].children.find(c => c.name === 'v_users').type, 'view')
    assert.equal(meta[0].children.find(c => c.name === 'users').type, 'table')
  })

  test('getTableStructure：列类型/可空/默认值/长度/主键/索引/外键', async () => {
    const users = await adapter.getTableStructure(ctx.conn, { table: 'users' })
    assert.equal(users.type, 'table')
    assert.deepEqual(plain(users.columns.map(c => c.name)), ['id', 'name', 'score', 'code', 'born', 'avatar', 'note'])

    const id = users.columns.find(c => c.name === 'id')
    // INTEGER PRIMARY KEY 是 rowid 别名，notnull 声明为 0 也必须报不可空
    assert.equal(id.dataType, 'integer')
    assert.equal(id.nullable, false)
    assert.equal(id.isPrimaryKey, true)
    assert.equal(id.ordinal, 1)

    const name = users.columns.find(c => c.name === 'name')
    assert.equal(name.dataType, 'text')
    assert.equal(name.nullable, false)

    const code = users.columns.find(c => c.name === 'code')
    assert.equal(code.dataType, 'varchar')
    assert.equal(code.maxLength, 32)

    const note = users.columns.find(c => c.name === 'note')
    assert.equal(note.defaultValue, "'x'")

    const avatar = users.columns.find(c => c.name === 'avatar')
    assert.equal(avatar.isBinary, true)

    const pk = users.indexes.find(ix => ix.primary)
    assert.equal(pk.name, 'PRIMARY')
    assert.deepEqual(plain(pk.columns), ['id'])
    assert.equal(pk.unique, true)

    const posts = await adapter.getTableStructure(ctx.conn, { table: 'posts' })
    const fk = posts.foreignKeys.find(f => f.refTable === 'users')
    assert.deepEqual(plain(fk.columns), ['user_id'])
    assert.deepEqual(plain(fk.refColumns), ['id'])
    assert.equal(fk.onDelete, 'CASCADE')
    const uniqueTitle = posts.indexes.find(ix => ix.unique && !ix.primary)
    assert.deepEqual(plain(uniqueTitle.columns), ['title'])

    // 复合外键必须聚合成一条约束，列顺序按 seq 排
    const pt = await adapter.getTableStructure(ctx.conn, { table: 'post_tags' })
    const composite = pt.foreignKeys.find(f => f.refTable === 'tags')
    assert.deepEqual(plain(composite.columns), ['tag_id', 'tag_lang'])
    assert.deepEqual(plain(composite.refColumns), ['id', 'lang'])
    assert.equal(composite.onDelete, 'CASCADE')
    const compositePk = pt.indexes.find(ix => ix.primary)
    assert.deepEqual(plain(compositePk.columns), ['post_id', 'tag_id', 'tag_lang'])
  })

  test('getTableStructure：视图不带索引且类型为 view', async () => {
    const v = await adapter.getTableStructure(ctx.conn, { table: 'v_users' })
    assert.equal(v.type, 'view')
    assert.deepEqual(plain(v.columns.map(c => c.name)), ['id', 'name'])
    assert.deepEqual(plain(v.indexes), [])
  })

  test('getTableStructure：表不存在时报错', async () => {
    await assert.rejects(adapter.getTableStructure(ctx.conn, { table: 'nope' }), /table not found/)
    await assert.rejects(adapter.getTableStructure(ctx.conn, { table: '' }), /requires table/)
  })

  test('getObjectDdl：表/视图/索引原始定义，类型白名单', async () => {
    const table = await adapter.getObjectDdl(ctx.conn, { name: 'users', objectType: 'table' })
    assert.match(table.ddl, /^CREATE TABLE users/)
    const view = await adapter.getObjectDdl(ctx.conn, { name: 'v_users', objectType: 'view' })
    assert.match(view.ddl, /^CREATE VIEW v_users/)
    const index = await adapter.getObjectDdl(ctx.conn, { name: 'idx_posts_user', objectType: 'index' })
    assert.match(index.ddl, /^CREATE INDEX idx_posts_user/)
    await assert.rejects(
      adapter.getObjectDdl(ctx.conn, { name: 'users', objectType: 'procedure' }),
      /unsupported object type/
    )
    await assert.rejects(
      adapter.getObjectDdl(ctx.conn, { name: 'nope', objectType: 'table' }),
      /object not found/
    )
    await assert.rejects(
      adapter.getObjectDdl(ctx.conn, { name: '', objectType: 'table' }),
      /object name required/
    )
  })

  test('describeTable：归一成 MySQL DESC 形状', async () => {
    const rows = await adapter.describeTable(ctx.conn, { table: 'users' })
    const id = rows.find(r => r.Field === 'id')
    assert.equal(id.Type, 'INTEGER')
    assert.equal(id.Null, 'NO')
    assert.equal(id.Key, 'PRI')
    assert.equal(id.Extra, 'auto_increment')
    const name = rows.find(r => r.Field === 'name')
    assert.equal(name.Null, 'NO')
    assert.equal(name.Key, '')
    const score = rows.find(r => r.Field === 'score')
    assert.equal(score.Null, 'YES')
  })

  test('getPageData：分页 hasMore / 总数 / 条件绑定 / 排序', async () => {
    const p1 = await adapter.getPageData(ctx.conn, { table: 'users', page: 1, pageSize: 2 })
    assert.equal(p1.rows.length, 2)
    assert.equal(p1.hasMore, true)

    const p2 = await adapter.getPageData(ctx.conn, { table: 'users', page: 2, pageSize: 2 })
    assert.equal(p2.rows.length, 2)
    assert.equal(p2.hasMore, false)

    const total = await adapter.getPageData(ctx.conn, { table: 'users', count: true })
    assert.equal(total.total, 4)

    const filtered = await adapter.getPageData(ctx.conn, {
      table: 'users', page: 1, pageSize: 10, where: 'name = ?', whereParams: ['bob']
    })
    assert.deepEqual(plain(filtered.rows).map(r => r.name), ['bob'])

    const filteredCount = await adapter.getPageData(ctx.conn, {
      table: 'users', count: true, where: 'name = ?', whereParams: ['bob']
    })
    assert.equal(filteredCount.total, 1)

    const desc = await adapter.getPageData(ctx.conn, {
      table: 'users', page: 1, pageSize: 10, orderClauses: [{ column: 'id', desc: true }]
    })
    assert.deepEqual(plain(desc.rows).map(r => r.id), [4, 3, 2, 1])

    const legacy = await adapter.getPageData(ctx.conn, {
      table: 'users', page: 1, pageSize: 10, orderBy: 'id', order: 'ascend'
    })
    assert.deepEqual(plain(legacy.rows).map(r => r.id), [1, 2, 3, 4])
  })

  test('BLOB 走 __bin 信封，rowid 主键原样返回数字', async () => {
    const page = await adapter.getPageData(ctx.conn, {
      table: 'users', page: 1, pageSize: 10, where: 'id = ?', whereParams: [4]
    })
    const row = plain(page.rows[0])
    assert.equal(row.id, 4)
    assert.equal(row.avatar.__bin.size, 3)
    assert.equal(row.avatar.__bin.b64, Buffer.from([1, 2, 255]).toString('base64'))
    assert.equal(row.avatar.__bin.truncated, false)
  })

  test('countRows / listColumns', async () => {
    assert.deepEqual(plain(await adapter.countRows(ctx.conn, { table: 'users' })), { count: 4 })
    const cols = await adapter.listColumns(ctx.conn)
    const users = cols.tables.find(t => t.table === 'users')
    assert.deepEqual(plain(users.columns.map(c => c.name)), ['id', 'name', 'score', 'code', 'born', 'avatar', 'note'])
    assert.equal(users.columns[0].pk, true)
    assert.ok(cols.tables.some(t => t.table === 'v_users'))
    assert.ok(!cols.tables.some(t => t.table.startsWith('sqlite_')))
  })

  test('getReferences：反向引用与按列过滤', async () => {
    const all = await adapter.getReferences(ctx.conn, { table: 'users' })
    assert.equal(all.degraded, false)
    assert.equal(all.references.length, 1)
    assert.equal(all.references[0].table, 'posts')
    assert.deepEqual(plain(all.references[0].refColumns), ['id'])
    assert.deepEqual(plain(all.references[0].columns), ['user_id'])

    const hit = await adapter.getReferences(ctx.conn, { table: 'users', columns: ['id'] })
    assert.equal(hit.references.length, 1)
    const miss = await adapter.getReferences(ctx.conn, { table: 'users', columns: ['name'] })
    assert.deepEqual(plain(miss.references), [])

    const tags = await adapter.getReferences(ctx.conn, { table: 'tags' })
    assert.equal(tags.references.length, 1)
    assert.deepEqual(plain(tags.references[0].refColumns), ['id', 'lang'])
  })

  test('listForeignKeys：整库外键 → ER 图数据', async () => {
    const graph = await adapter.listForeignKeys(ctx.conn)
    assert.ok(Array.isArray(graph.tables))
    assert.ok(graph.tables.some(t => t.name === 'users'))
    assert.ok(graph.tables.some(t => t.name === 'post_tags'))
    const edge = graph.edges.find(e => e.to.name === 'users')
    assert.equal(edge.from.name, 'posts')
    assert.deepEqual(plain(edge.columns), [{ from: 'user_id', to: 'id' }])
    const tagEdge = graph.edges.find(e => e.to.name === 'tags')
    assert.deepEqual(plain(tagEdge.columns), [
      { from: 'tag_id', to: 'id' },
      { from: 'tag_lang', to: 'lang' }
    ])
  })

  test('updateCell：写值 / 只读拒绝 / 主键必需', async () => {
    const res = await adapter.updateCell(ctx.conn, {
      table: 'users', pkColumn: 'id', pkValue: 2, column: 'name', value: 'bobby'
    })
    assert.equal(res.affected, 1)
    const row = await adapter.getPageData(ctx.conn, {
      table: 'users', page: 1, pageSize: 1, where: 'id = ?', whereParams: [2]
    })
    assert.equal(plain(row.rows[0]).name, 'bobby')

    await assert.rejects(
      adapter.updateCell(ctx.conn, {
        table: 'users', pkColumn: 'id', pkValue: 2, column: 'name', value: 'x', readOnly: true
      }),
      /read-only/
    )
    await assert.rejects(
      adapter.updateCell(ctx.conn, { table: 'users', pkColumn: 'id', pkValue: null, column: 'name', value: 'x' }),
      /primary key value/
    )
  })

  test('insertRow：返回受影响行数与自增主键', async () => {
    const res = await adapter.insertRow(ctx.conn, {
      table: 'users', values: { name: 'erin', score: 4.5 }
    })
    assert.equal(res.affected, 1)
    assert.equal(res.insertId, 5)
    await assert.rejects(
      adapter.insertRow(ctx.conn, { table: 'users', values: {}, readOnly: false }),
      /at least one column value/
    )
  })

  test('insertRows：append / upsert / overwrite 与逐批失败记录', async () => {
    const append = await adapter.insertRows(ctx.conn, {
      table: 'users',
      rows: [{ id: 5, name: 'e' }, { id: 6, name: 'f' }]
    })
    assert.equal(append.affected, 2)
    assert.equal(append.batchCount, 1)
    assert.deepEqual(plain(append.failures), [])

    // 唯一约束冲突：整批失败被记录，已提交批次不受影响
    const dup = await adapter.insertRows(ctx.conn, {
      table: 'posts',
      rows: [{ id: 12, user_id: 1, title: 'hello' }]
    })
    assert.equal(dup.affected, 0)
    assert.equal(dup.failures.length, 1)
    assert.match(dup.failures[0].message, /UNIQUE/i)

    const upsert = await adapter.insertRows(ctx.conn, {
      table: 'users',
      mode: 'upsert',
      pkColumns: ['id'],
      rows: [{ id: 1, name: 'alice2' }, { id: 7, name: 'g' }]
    })
    assert.equal(upsert.affected, 2)
    const alice = await adapter.getPageData(ctx.conn, {
      table: 'users', page: 1, pageSize: 1, where: 'id = ?', whereParams: [1]
    })
    assert.equal(plain(alice.rows[0]).name, 'alice2')

    const overwrite = await adapter.insertRows(ctx.conn, {
      table: 'nopk', mode: 'overwrite', rows: [{ a: 'only' }]
    })
    assert.equal(overwrite.affected, 1)
    assert.deepEqual(plain(await adapter.countRows(ctx.conn, { table: 'nopk' })), { count: 1 })

    await assert.rejects(
      adapter.insertRows(ctx.conn, { table: 'users', rows: [{ name: 'x' }], mode: 'rebuild' }),
      /unsupported insertRows mode/
    )
    await assert.rejects(
      adapter.insertRows(ctx.conn, { table: 'users', rows: [{ name: 'x' }], readOnly: true }),
      /read-only/
    )
  })

  test('deleteRows：IN 批量删除、上限、无主键拒绝', async () => {
    const res = await adapter.deleteRows(ctx.conn, {
      table: 'users', pkColumn: 'id', pkValues: [1, 2]
    })
    assert.equal(res.affected, 2)
    assert.deepEqual(plain(await adapter.countRows(ctx.conn, { table: 'users' })), { count: 2 })

    await assert.rejects(
      adapter.deleteRows(ctx.conn, { table: 'users', pkColumn: 'id', pkValues: [] }),
      /at least one primary key value/
    )
    await assert.rejects(
      adapter.deleteRows(ctx.conn, {
        table: 'users', pkColumn: 'id', pkValues: Array.from({ length: 201 }, (_, i) => i + 100)
      }),
      /up to 200 rows/
    )
    await assert.rejects(
      adapter.deleteRows(ctx.conn, { table: 'nopk', pkColumn: '', pkValues: [1] }),
      /no-pk table/
    )
  })

  test('updateCells：同值走一条 UPDATE，异值逐行且记录失败', async () => {
    const same = await adapter.updateCells(ctx.conn, {
      table: 'users',
      pkColumn: 'id',
      column: 'note',
      updates: [{ pk: 1, value: 'same' }, { pk: 2, value: 'same' }]
    })
    assert.equal(same.affected, 2)
    assert.deepEqual(plain(same.failed), [])

    // NOT NULL 上的异值，第二条给 null 必失败
    const mixed = await adapter.updateCells(ctx.conn, {
      table: 'users',
      pkColumn: 'id',
      column: 'name',
      updates: [{ pk: 1, value: 'a1' }, { pk: 2, value: null }, { pk: 3, value: 'c3' }]
    })
    assert.equal(mixed.affected, 2)
    assert.equal(mixed.failed.length, 1)
    assert.equal(mixed.failed[0].pk, 2)
    assert.match(mixed.failed[0].message, /NOT NULL/)
  })

  test('executeSql：单语句/多语句/写语句/类型契约', async () => {
    const single = await adapter.executeSql(ctx.conn, {
      sql: 'SELECT id, name, score, avatar FROM users WHERE id = 1'
    })
    assert.equal(single.results.length, 1)
    const r = single.results[0]
    assert.deepEqual(plain(r.fields), ['id', 'name', 'score', 'avatar'])
    assert.deepEqual(plain(r.columns), [
      { name: 'id', type: 'integer' },
      { name: 'name', type: 'text' },
      { name: 'score', type: 'real' },
      { name: 'avatar', type: 'blob' }
    ])
    assert.equal(plain(r.rows[0]).name, 'alice')
    assert.equal(typeof single.elapsedMs, 'number')

    const multi = await adapter.executeSql(ctx.conn, {
      sql: "SELECT 1 AS a; UPDATE users SET score = 9 WHERE id = 2; SELECT 'x' AS b"
    })
    assert.equal(multi.results.length, 3)
    assert.deepEqual(plain(multi.results[0].rows), [{ a: 1 }])
    assert.equal(multi.results[1].affected, 1)
    assert.deepEqual(plain(multi.results[2].rows), [{ b: 'x' }])

    // 表达式列没有声明类型：type 必须是 ''（未知即字符串），不能标成 blob
    const expr = await adapter.executeSql(ctx.conn, { sql: 'SELECT 1 + 1 AS n' })
    assert.deepEqual(plain(expr.results[0].columns), [{ name: 'n', type: '' }])
  })

  test('executeSql：参数绑定只接受单语句；只读白名单', async () => {
    const bound = await adapter.executeSql(ctx.conn, {
      sql: 'SELECT name FROM users WHERE score > ?', params: [3]
    })
    assert.deepEqual(plain(bound.results[0].rows), [{ name: 'carol' }])

    await assert.rejects(
      adapter.executeSql(ctx.conn, { sql: 'SELECT 1; SELECT 2', params: [1] }),
      /single statement only/
    )
    await assert.rejects(
      adapter.executeSql(ctx.conn, { sql: 'SELECT 1', params: 'x' }),
      /params must be an array/
    )
    await assert.rejects(
      adapter.executeSql(ctx.conn, { sql: 'UPDATE users SET name = ?', params: ['x'], readOnly: true }),
      /read-only/
    )
    const ro = await adapter.executeSql(ctx.conn, { sql: 'PRAGMA table_info("users")', readOnly: true })
    assert.ok(ro.results[0].rows.length > 0)
    // 空 SQL 不产生结果集，也不报错
    const empty = await adapter.executeSql(ctx.conn, { sql: '  -- nothing\n ' })
    assert.deepEqual(plain(empty.results), [])
  })

  test('executeSql：结果行数上限，truncated/rowLimit 标记', async () => {
    const res = await adapter.executeSql(ctx.conn, {
      sql: 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 10005) SELECT x FROM c'
    })
    const set = res.results[0]
    assert.equal(set.rows.length, adapter.MAX_SQL_ROWS)
    assert.equal(set.truncated, true)
    assert.equal(set.rowLimit, adapter.MAX_SQL_ROWS)

    const small = await adapter.executeSql(ctx.conn, { sql: 'SELECT 1 AS x' })
    assert.equal(small.results[0].truncated, false)
  })

  test('explainQuery：EXPLAIN QUERY PLAN → 统一节点树', async () => {
    const res = await adapter.explainQuery(ctx.conn, {
      sql: 'SELECT * FROM posts WHERE user_id = 1'
    })
    assert.equal(res.dialect, 'sqlite')
    assert.equal(res.root.nodeType, 'QUERY PLAN')
    assert.ok(res.root.children.length > 0)
    assert.ok(res.raw.length > 0)
    await assert.rejects(adapter.explainQuery(ctx.conn, { sql: '' }), /requires sql/)
    await assert.rejects(
      adapter.explainQuery(ctx.conn, { sql: 'SELECT 1; SELECT 2' }),
      /一次只接受一条语句/
    )
  })

  test('手动事务：提交落盘、回滚丢弃、:memory: 不可用', async () => {
    const db = await adapter.beginTx(ctx.conn)
    db.prepare('UPDATE users SET name = ? WHERE id = ?').run('tx-commit', 3)
    await adapter.commitTx(db)
    const afterCommit = await adapter.getPageData(ctx.conn, {
      table: 'users', page: 1, pageSize: 1, where: 'id = ?', whereParams: [3]
    })
    assert.equal(plain(afterCommit.rows[0]).name, 'tx-commit')

    const db2 = await adapter.beginTx(ctx.conn)
    db2.prepare('UPDATE users SET name = ? WHERE id = ?').run('tx-rollback', 3)
    await adapter.rollbackTx(db2)
    const afterRollback = await adapter.getPageData(ctx.conn, {
      table: 'users', page: 1, pageSize: 1, where: 'id = ?', whereParams: [3]
    })
    assert.equal(plain(afterRollback.rows[0]).name, 'tx-commit')

    await assert.rejects(adapter.beginTx({ dbType: 'sqlite', dbFile: ':memory:' }), /:memory:/)
  })

  test('引用计数：最后一次 release 才关闭连接，之后可重新打开', async () => {
    const conn = ctx.conn
    await adapter.acquire(conn)
    await adapter.release(conn)
    // 还有一个引用（beforeEach 的 acquire），仍然可用
    assert.ok((await adapter.getMetadata(conn)).length === 1)

    // release 到 0 后再取数会自动重开
    await adapter.release(conn)
    const meta = await adapter.getMetadata(conn)
    assert.equal(meta[0].name, 'main')
    // 给 afterEach 留一个引用，避免重复关闭
    await adapter.acquire(conn)
  })

  test('evict 后连接可重建', async () => {
    await adapter.evict(ctx.conn)
    const meta = await adapter.getMetadata(ctx.conn)
    assert.equal(meta[0].name, 'main')
  })
})

// ---------------------------------------------------------------- 注册与安全边界

describe('sqlite adapter · registration & main-process gates', () => {
  const indexSrc = fs.readFileSync(INDEX_JS, 'utf8')

  test('DB_ADAPTER / testers 登记 sqlite', () => {
    assert.match(indexSrc, /sqlite:\s*'sqlite'/)
    assert.match(indexSrc, /sqlite:\s*opts => require\('\.\/sqlite'\)\.testSqliteConnection\(opts\)/)
  })

  test('OP_MAP.sqlite 覆盖适配器全部 op', () => {
    const blockMatch = /sqlite:\s*\{([\s\S]*?)\n\s*\},\n\s*redis:/.exec(indexSrc)
    assert.ok(blockMatch, 'OP_MAP.sqlite 不存在')
    const block = blockMatch[1]
    for (const op of [
      'getMetadata', 'getPageData', 'describeTable', 'getTableStructure', 'getReferences',
      'updateCell', 'insertRow', 'deleteRows', 'updateCells', 'countRows', 'executeSql',
      'explainQuery', 'listColumns', 'getObjectDdl', 'listForeignKeys'
    ]) {
      assert.match(block, new RegExp(op + ":\\s*'" + op + "'"), 'OP_MAP.sqlite 缺少 ' + op)
    }
  })

  test('主进程闸门：sqlite 不走隧道、方言独立、全量关闭包含 sqlite', () => {
    assert.match(indexSrc, /useTunnel = !!sshBookmark && dbType !== 'sqlite'/)
    assert.match(indexSrc, /adapter === 'sqlite'/)
    assert.match(indexSrc, /require\('\.\/sqlite'\)\.closeSqliteConnection\(\)/)
  })

  test('safe-clause 认识 sqlite：反斜杠不是转义，双引号是标识符', () => {
    // SQLite 里 'a\' 在第二个引号结束，后面的 OR 1=1 -- 是真语句 → 必须拒绝
    assert.throws(
      () => safeClause.assertSafeClause("name = 'a\\' OR 1=1 --'", ['name'], 'sqlite'),
      /注释/
    )
    // 同一串按 mysql 口径是"一个完整的字符串字面量"，历史上会被放过 ——
    // 这条断言是"sqlite 不能复用 mysql 词法"的证据
    assert.doesNotThrow(
      () => safeClause.assertSafeClause("name = 'a\\' OR 1=1 --'", ['name'], 'mysql')
    )
    // 双引号标识符参与列白名单：未知列必须报错
    assert.deepEqual(
      safeClause.assertSafeClause('"name" = ?', ['name'], 'sqlite'),
      { placeholders: 1 }
    )
    assert.throws(
      () => safeClause.assertSafeClause('"nope" = ?', ['name'], 'sqlite'),
      /不存在的列/
    )
    // 反引号标识符（SQLite 兼容 MySQL）与 [ident] 同样放行
    assert.deepEqual(safeClause.assertSafeClause('`name` = ?', ['name'], 'sqlite'), { placeholders: 1 })
    assert.deepEqual(safeClause.assertSafeClause('[name] = ?', ['name'], 'sqlite'), { placeholders: 1 })
    // 占位符只认 ?，$n 必须在本地就被拒（sqlite 驱动绑定的是数组位置）
    assert.throws(
      () => safeClause.assertSafeClause('name = $1', ['name'], 'sqlite'),
      /必须写成 \? 形式/
    )
    assert.deepEqual(
      safeClause.assertSafeClause("name = 'x''y' AND score > 1", ['name', 'score'], 'sqlite'),
      { placeholders: 0 }
    )
  })
})
