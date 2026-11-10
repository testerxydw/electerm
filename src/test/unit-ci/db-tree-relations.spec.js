const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')

const ROOT = path.join(__dirname, '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')
const plain = v => JSON.parse(JSON.stringify(v))
function loadAdapter (name) {
  const file = path.join(ROOT, 'src/app/lib/db-client', name + '.js')
  const mod = { exports: {} }
  const localRequire = createRequire(file)
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module: mod,
    exports: mod.exports,
    require: p => p === '../../common/log' ? { warn () {} } : localRequire(p),
    Buffer,
    setTimeout,
    clearTimeout
  }, { filename: file })
  return mod.exports
}
const mysql = loadAdapter('mysql')
const pg = loadAdapter('postgres')
const constSrc = read('src/client/common/db-session-const.js')
const constants = constSrc.slice(constSrc.indexOf('\nconst isLeafNode ='), constSrc.indexOf('// U1c：空态'))
const { treeNodeKey, nodeKey } = vm.runInNewContext(constants + '; ({ treeNodeKey, nodeKey })')

function pgFixture (failKind = '') {
  const calls = []
  const client = {
    database: 'demo',
    query: async (sql, args) => {
      calls.push({ sql, args })
      if (sql.includes('FROM pg_database')) return { rows: [{ datname: 'demo' }] }
      if (sql.includes('SELECT nspname')) return { rows: [{ nspname: 'public' }, { nspname: 'other' }] }
      if (sql.includes('AS schemaname')) return { rows: [{ schemaname: 'public', relname: 'indexes', relkind: 'r' }] }
      if (sql.includes("c.relkind = 'S'")) {
        if (failKind === 'sequence') throw new Error('sequence permission denied')
        return { rows: [{ schema: 'public', name: 'serial_a' }, { schema: 'other', name: 'serial_a' }] }
      }
      if (sql.includes("c.relkind IN ('i', 'I')")) {
        if (failKind === 'index') throw new Error('index permission denied')
        return { rows: [{ schema: 'public', name: 'idx_a', tbl: 'orders' }] }
      }
      return { rows: [] }
    }
  }
  return { conn: { __txClient: client }, calls }
}

describe('N12a object identity', () => {
  test('tables, groups, object types, owning tables and overloads cannot collide', () => {
    const nodes = [
      { name: 'indexes', type: 'table' },
      { name: 'indexes', type: 'group', group: 'index' },
      { name: 'indexes', type: 'sequence' },
      { name: 'indexes', type: 'index', table: 'a' },
      { name: 'indexes', type: 'index', table: 'b' },
      { name: 'indexes', type: 'function', signature: 'f(int)' },
      { name: 'indexes', type: 'function', signature: 'f(text)' }
    ]
    const keys = nodes.map(n => treeNodeKey('db.with.dot', 's', n))
    assert.equal(new Set(keys).size, nodes.length)
    assert.equal(keys[0], nodeKey('db.with.dot', 's', 'indexes'))
    assert.notEqual(keys[2], treeNodeKey('db.with.dot', 'other', nodes[2]))
    assert.deepEqual(JSON.parse(keys[4]).slice(0, 3), ['db.with.dot', 's', 'indexes'])
  })

  test('tree and quick open share identity and retain owner labels', () => {
    for (const p of ['use-db-tree-data.jsx', 'use-db-quick-open.js']) {
      const src = read('src/client/components/database/' + p)
      assert.match(src, /treeNodeKey\(/)
      assert.match(src, /node\.table/)
    }
    assert.match(read('src/client/components/database/use-db-tree-data.jsx'), /node\.error && <Tooltip/)
  })

  test('object click never opens a table and preserves exact location', () => {
    const src = read('src/client/components/database/use-db-tree.js')
    const body = src.slice(src.indexOf('  const onSelectTree ='), src.indexOf('\n  // 表结构'))
    const seen = []
    const select = vm.runInNewContext(body + '; onSelectTree', {
      isRedis: false,
      isDbObjectType: t => ['sequence', 'index'].includes(t),
      showObjectDdl: x => seen.push(plain(x)),
      openTable: () => assert.fail('object opened a data grid')
    })
    select(null, {
      node: {
        key: treeNodeKey('db', 's', { name: ' a".b ', type: 'index', table: 't' }),
        nodeType: 'index',
        isLeaf: true,
        objMeta: { table: 't' }
      }
    })
    assert.deepEqual(seen, [{ database: 'db', schema: 's', name: ' a".b ', objectType: 'index', table: 't' }])
  })
})

describe('N12a bulk relation metadata', () => {
  test('PG lists sequences and indexes per schema with one query per kind', async () => {
    const { conn, calls } = pgFixture()
    const meta = await pg.getMetadata(conn)
    const schemas = meta[0].children
    assert.equal(schemas.length, 2)
    assert.equal(schemas.find(s => s.name === 'public').children[0].type, 'table')
    for (const schema of schemas) {
      assert.equal(schema.children.find(n => n.group === 'sequence').children[0].name, 'serial_a')
    }
    const group = schemas.find(s => s.name === 'public').children.find(n => n.group === 'index')
    assert.equal(group.name, 'indexes')
    assert.deepEqual(plain(group.children), [{ name: 'idx_a', type: 'index', table: 'orders' }])
    assert.equal(calls.filter(c => c.sql.includes("c.relkind = 'S'")).length, 1)
    assert.equal(calls.filter(c => c.sql.includes("c.relkind IN ('i', 'I')")).length, 1)
  })

  for (const kind of ['sequence', 'index']) {
    test(`PG ${kind} failure is visible without losing tables or other groups`, async () => {
      const { conn } = pgFixture(kind)
      const meta = await pg.getMetadata(conn)
      const children = meta[0].children.find(s => s.name === 'public').children
      assert.equal(children[0].type, 'table')
      const error = children.find(n => n.group === kind)
      assert.match(error.error, /permission denied/)
      assert.equal(error.children.length, 0)
      assert.ok(children.find(n => n.group === (kind === 'index' ? 'sequence' : 'index')))
    })
  }

  test('MySQL bulk indexes preserve repeated PRIMARY names and parameterize database', async () => {
    const calls = []
    const groups = await mysql.getDbObjects({
      query: async (sql, args) => {
        calls.push({ sql, args: plain(args) })
        return [sql.includes('STATISTICS') ? [{ name: 'PRIMARY', tbl: 'a' }, { name: 'PRIMARY', tbl: 'b' }] : []]
      }
    }, "db';--")
    assert.deepEqual(plain(groups[0].children), [
      { name: 'PRIMARY', type: 'index', table: 'a' }, { name: 'PRIMARY', type: 'index', table: 'b' }
    ])
    const reads = calls.filter(c => c.sql.includes('STATISTICS'))
    assert.equal(reads.length, 1)
    assert.deepEqual(reads[0].args, ["db';--"])
    assert.ok(!reads[0].sql.includes("db';--"))
  })

  test('MySQL index permissions produce a visible error group', async () => {
    const groups = await mysql.getDbObjects({
      query: async sql => {
        if (sql.includes('STATISTICS')) throw new Error('catalog denied')
        return [[]]
      }
    }, 'db')
    assert.equal(groups[0].group, 'index')
    assert.match(groups[0].error, /catalog denied/)
    assert.equal(groups[0].children.length, 0)
  })
})

describe('N12a read-only relation definitions', () => {
  for (const kind of ['index', 'sequence']) {
    test(`PG ${kind} uses exact schema/name parameters and never advances a sequence`, async () => {
      const calls = []
      const ddl = kind === 'index'
        ? 'CREATE UNIQUE INDEX ix ON public.t USING btree (lower(name)) WHERE active'
        : 'CREATE SEQUENCE public.s AS bigint INCREMENT BY -2 MINVALUE -9223372036854775808 MAXVALUE 9223372036854775807 START WITH 9007199254740993 CACHE 10 CYCLE;'
      const conn = {
        __txClient: {
          database: 'demo',
          query: async (sql, args) => {
            calls.push({ sql, args: plain(args) })
            return { rows: [{ ddl }] }
          }
        }
      }
      const out = await pg.getObjectDdl(conn, { objectType: kind, schema: 's".1', name: " a';-- ", table: 't' })
      assert.ok(out.ddl.endsWith(ddl))
      assert.deepEqual(calls[0].args.slice(0, 2), ['s".1', " a';-- "])
      assert.ok(!calls[0].sql.includes(" a';-- "))
      assert.doesNotMatch(calls[0].sql, /\b(nextval|setval|last_value)\b/i)
      assert.match(calls[0].sql, /^SELECT /)
      if (kind === 'sequence') {
        assert.match(calls[0].sql, /format\(/)
        assert.match(calls[0].sql, /seqtypid::regtype/)
        assert.match(out.ddl, /current value, grants and ownership are not included/)
      }
      await assert.rejects(pg.getObjectDdl(conn, { objectType: kind, name: 'x', database: 'other' }), /current connection/)
      await assert.rejects(pg.getObjectDdl(conn, { objectType: kind, name: '' }), /name required/)
      assert.equal(calls.length, 1)
      conn.__txClient.query = async () => ({ rows: [] })
      await assert.rejects(pg.getObjectDdl(conn, { objectType: kind, name: 'deleted' }), /not found/)
    })
  }

  test('MySQL preserves full server DDL, quotes identifiers and checks index ownership', async () => {
    const calls = []
    const ddl = 'CREATE TABLE `t` (`s` varchar(200), KEY `ix` (`s`(20))) ENGINE=InnoDB'
    const conn = {
      dbName: 'd`b',
      __txClient: {
        query: async (sql, args) => {
          calls.push({ sql, args: args && plain(args) })
          return [sql.startsWith('SELECT') ? [{ exists: 1 }] : [{ 'Create Table': ddl }]]
        }
      }
    }
    const out = await mysql.getObjectDdl(conn, { name: "i';--", table: 't`1', objectType: 'index' })
    assert.ok(out.ddl.endsWith(ddl))
    assert.match(out.ddl, /full table DDL/)
    assert.deepEqual(calls[0].args, ['d`b', 't`1', "i';--"])
    assert.equal(calls[1].sql, 'SHOW CREATE TABLE `d``b`.`t``1`')
    await assert.rejects(mysql.getObjectDdl(conn, { name: 'x', objectType: 'index' }), /table required/)
    assert.equal(calls.length, 2)
    conn.__txClient.query = async () => [[]]
    await assert.rejects(mysql.getObjectDdl(conn, { name: 'gone', table: 't', objectType: 'index' }), /index not found/)
  })
})
