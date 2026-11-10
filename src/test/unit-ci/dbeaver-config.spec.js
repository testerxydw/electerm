const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')
const load = () => import('../../client/common/dbeaver-config.js')

// 真实 DBeaver data-sources.json 的形状样例（字段名/嵌套以 DBeaver 23+ 导出为准）
const SAMPLE = {
  folders: { production: ['uuid-1'] },
  connections: {
    'uuid-1': {
      provider: 'mysql',
      driver: 'mysql8',
      name: 'mysql-prod',
      configuration: {
        host: '192.168.115.67',
        port: '13306',
        database: 'tgfsom',
        user: 'root',
        'save-password': true
      }
    },
    'uuid-2': {
      provider: 'postgresql',
      driver: 'postgres',
      name: 'pg-report',
      description: '报表库',
      configuration: {
        host: '10.0.0.2',
        port: 5433,
        database: 'report',
        user: 'analyst'
      }
    },
    'uuid-3': {
      provider: 'redis',
      driver: 'redis',
      configuration: { host: '192.168.115.67', port: '16379' }
    },
    'uuid-4': {
      provider: 'sqlite',
      driver: 'sqlite_jdbc',
      name: 'local-db',
      configuration: { path: '/data/demo/tgfs.db' }
    },
    'uuid-5': {
      provider: 'oracle',
      driver: 'oracle_thin',
      name: 'not-supported',
      configuration: { host: '1.2.3.4', port: 1521 }
    },
    'uuid-6': {
      provider: 'sqlite',
      driver: 'sqlite_jdbc',
      name: 'no-path',
      configuration: {}
    },
    'uuid-7': null,
    'uuid-8': 'garbage'
  }
}

describe('dbeaver data-sources import', () => {
  test('shape detection: dbeaver yes, electerm export / array / scalars no', async () => {
    const { isDbeaverDataSources, parseDbeaverDataSources } = await load()
    assert.equal(isDbeaverDataSources(SAMPLE), true)
    // electerm 自身导出永远优先：即使同时有 connections 键也不判成 DBeaver
    assert.equal(isDbeaverDataSources({ bookmarks: [], bookmarkGroups: [], connections: {} }), false)
    assert.equal(isDbeaverDataSources([]), false)
    assert.equal(isDbeaverDataSources(null), false)
    assert.equal(isDbeaverDataSources('txt'), false)
    assert.equal(isDbeaverDataSources({ connections: [] }), false)
    assert.equal(parseDbeaverDataSources({ bookmarks: [] }), null)
    assert.equal(parseDbeaverDataSources('nope'), null)
  })

  test('mysql/postgres: port string coerced, dbName mapped, password never imported', async () => {
    const { parseDbeaverDataSources } = await load()
    const r = parseDbeaverDataSources(SAMPLE)
    assert.equal(r.length, 4)
    const mysql = r.find(b => b.dbType === 'mysql')
    assert.equal(mysql.type, 'database')
    assert.equal(mysql.title, 'mysql-prod')
    assert.equal(mysql.dbHost, '192.168.115.67')
    assert.equal(mysql.dbPort, 13306)
    assert.equal(mysql.dbUser, 'root')
    assert.equal(mysql.dbName, 'tgfsom')
    assert.equal(mysql.dbPassword, '')
    const pg = r.find(b => b.dbType === 'postgres')
    assert.equal(pg.dbPort, 5433)
    assert.equal(pg.dbName, 'report')
    assert.equal(pg.description, '报表库')
  })

  test('redis: port fallback and no dbName; sqlite: dbFile required', async () => {
    const { parseDbeaverDataSources } = await load()
    const r = parseDbeaverDataSources(SAMPLE)
    const redis = r.find(b => b.dbType === 'redis')
    assert.equal(redis.dbPort, 16379)
    assert.equal(redis.title, '192.168.115.67')
    assert.ok(!('dbName' in redis))
    const lite = r.find(b => b.dbType === 'sqlite')
    assert.equal(lite.dbFile, '/data/demo/tgfs.db')
    assert.ok(!('dbHost' in lite))
    // 凭据位统一存在且为空（与网络引擎一致，书签表单/导出比较不缺位）
    assert.equal(lite.dbPassword, '')
    // 无路径的 sqlite 连不上，跳过
    assert.equal(r.filter(b => b.dbType === 'sqlite').length, 1)
    assert.ok(!r.some(b => b.title === 'not-supported'), 'oracle 等不支持的 provider 跳过')
    // null / 字符串条目跳过不抛
    assert.ok(!r.some(b => b.title === 'garbage'))
  })

  test('malformed: password-like fields in configuration are ignored entirely', async () => {
    const { parseDbeaverDataSources } = await load()
    const r = parseDbeaverDataSources({
      connections: {
        a: { provider: 'mysql', configuration: { host: 'h', password: 'should-not-leak', credentials: 'x' } }
      }
    })
    assert.equal(r.length, 1)
    assert.equal(r[0].dbPassword, '')
    assert.ok(!('credentials' in r[0]))
    assert.equal(r[0].dbPort, 3306, '缺端口回落引擎默认')
  })

  test('empty connections map yields empty array (valid dbeaver shape)', async () => {
    const { parseDbeaverDataSources } = await load()
    assert.deepEqual(parseDbeaverDataSources({ connections: {} }), [])
    assert.deepEqual(parseDbeaverDataSources({ connections: { a: 'junk' } }), [])
  })

  test('wiring: bookmark-upload 分流在 JSON.parse 之后且 electerm 形状优先', () => {
    const src = read('src/client/components/tree-list/bookmark-upload.js')
    assert.match(src, /import \{ parseDbeaverDataSources \} from '\.\.\/\.\.\/common\/dbeaver-config'/)
    assert.match(src, /parseDbeaverDataSources\(content\)/)
    // 分流只能发生在非 ncx 分支的 JSON.parse 之后
    const idx = src.indexOf('JSON.parse(txt)')
    assert.ok(idx > 0)
    assert.ok(src.indexOf('parseDbeaverDataSources(content)') > idx)
    assert.ok(src.indexOf('dbeaver !== null') > idx)
  })

  test('wiring: 引用全部判重落空的新建分组不落地（重复导入不堆空 imported_ 分组）', () => {
    const src = read('src/client/components/tree-list/bookmark-upload.js')
    assert.match(src, /const importedIds = new Set\(\)/)
    assert.match(src, /importedIds\.add\(bg\.id\)/)
    const grp = src.indexOf("label: e('bookmarkCategory')")
    assert.ok(grp > 0)
    const guard = src.indexOf('!ids.some(id => importedIds.has(id))')
    assert.ok(guard > grp, '分组 step 内必须有死引用守卫')
  })
})
