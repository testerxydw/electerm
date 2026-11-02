// H8b-1：引擎 → 语法家族的唯一权威。
//
// 这个模块自己不难（一张表 + 三个谓词），它要钉的是**两件别处管不了的事**：
// 1. 表必须点名每一个引擎。漏一个不会报错，只会让那个引擎静悄悄落到 MySQL 那一支
//    ——拿 MySQL 的词法扫 PG 语句，双引号/反斜杠/`#` 三处判断当场全反。所以这里拿
//    `constants.js` 的引擎清单和主进程 `DB_ADAPTER` 双向对表，新增引擎漏登记直接红。
// 2. 两种回落口径不能混。`dbEngineFamily` 认不出回 mysql（调用方必须拿到一个方言），
//    `resolveDbEngineFamily` 认不出回 null（调用方要的是"这引擎有没有 SQL 可言"）。
//    统一成一个就会各错一半：前者变 null 会让引号拼接出 undefined，后者变 mysql
//    会让未知引擎假装支持、弹出 MySQL 补全表。
const { describe, test, before } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const ROOT = path.join(__dirname, '../../..')
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const FAMILY = path.join(ROOT, 'src/client/common/db-engine-family.js')
const CONSTANTS = 'src/client/common/constants.js'
const DB_CLIENT = 'src/app/lib/db-client/index.js'

let dbEngineFamily
let resolveDbEngineFamily
let isPgFamily
let isSqliteFamily
let hasSqlDialect

// constants.js 依赖 window，不能 require；引擎清单从源码里抠 buildConst 的数组本体
// （与 t1-sweep-guard.spec.js 同一抠法，两处口径一致才说明"这张表点全了名"）
function enginesFromConstants () {
  const body = /export const dbTypeMap = buildConst\(\[([\s\S]*?)\]\)/.exec(read(CONSTANTS))
  assert.ok(body, 'dbTypeMap parsed from constants.js')
  return [...body[1].matchAll(/'([^']+)'/g)].map(m => m[1])
}

// 主进程实际用哪个适配器 = 这个引擎在协议层究竟属于哪一家
function adapterByEngine () {
  const body = /const DB_ADAPTER = \{([\s\S]*?)\n\}/.exec(read(DB_CLIENT))
  assert.ok(body, 'DB_ADAPTER parsed from db-client/index.js')
  const map = {}
  for (const m of body[1].matchAll(/^\s*(\w+):\s*'([^']+)'/gm)) {
    map[m[1]] = m[2]
  }
  return map
}

before(async () => {
  ;({ dbEngineFamily, resolveDbEngineFamily, isPgFamily, isSqliteFamily, hasSqlDialect } =
    await import(pathToFileURL(FAMILY).href))
})

describe('db-engine-family: 与引擎清单/适配器表双向对表', () => {
  test('constants.js 的每个引擎都在家族表里点名（不靠回落）', () => {
    for (const e of enginesFromConstants()) {
      assert.notEqual(
        resolveDbEngineFamily(e),
        null,
        `${e} 未在家族表点名：它会静默落到 mysql 那一支`
      )
    }
  })

  test('家族归属与主进程 DB_ADAPTER 一致（渲染层按哪套语法 ↔ 主进程用哪个驱动）', () => {
    const adapters = adapterByEngine()
    const engines = enginesFromConstants()
    assert.ok(engines.length >= 6, '引擎清单非平凡，实得 ' + engines.length)
    for (const e of engines) {
      assert.ok(adapters[e], `${e} 在主进程没有适配器登记，家族表却认得它 → 连不上`)
      assert.equal(dbEngineFamily(e), adapters[e], `${e} 家族与适配器不一致`)
    }
  })

  test('家族 id 都能在方言表里查到条目（redis 除外，它没有 SQL 语法）', async () => {
    const { dialectMap } = await import(pathToFileURL(
      path.join(ROOT, 'src/client/common/sql-dialects.js')
    ).href)
    // 家族 id 取自表本身：把已知名字全过一遍，收集出现的家族
    const names = [...enginesFromConstants(), 'postgresql', 'pg', 'pgsql', 'mariadb', 'sqlite3']
    const families = new Set(names.map(n => resolveDbEngineFamily(n)).filter(Boolean))
    assert.ok(families.size >= 4, '家族数非平凡，实得 ' + families.size)
    for (const f of families) {
      if (f === 'redis') {
        continue
      }
      assert.ok(dialectMap[f], `家族 ${f} 在 dialectMap 里没有同名条目，getDialect 会回 null`)
      assert.equal(dialectMap[f].id, f)
    }
  })
})

describe('db-engine-family: 回落口径（两种，不许合并）', () => {
  test('dbEngineFamily：认不出/空值一律按 mysql', () => {
    for (const v of ['sqlserver', 'oracle', '', '   ', null, undefined, 123, {}]) {
      assert.equal(dbEngineFamily(v), 'mysql', String(v) + ' 应回落 mysql')
    }
  })

  test('resolveDbEngineFamily：认不出回 null（未知引擎不得假装成 MySQL）', () => {
    for (const v of ['sqlserver', '', null, undefined, {}]) {
      assert.equal(resolveDbEngineFamily(v), null, String(v) + ' 应是 null')
    }
  })

  test('redis 有家族但没有 SQL 语法', () => {
    assert.equal(resolveDbEngineFamily('redis'), 'redis')
    assert.equal(hasSqlDialect('redis'), false)
    // 有 SQL 语法的三家
    for (const e of ['mysql', 'tidb', 'oceanbase', 'postgres', 'sqlite']) {
      assert.equal(hasSqlDialect(e), true, e + ' 应有 SQL 语法')
    }
    assert.equal(hasSqlDialect('sqlserver'), false)
  })
})

describe('db-engine-family: 别名、大小写与空白', () => {
  test('PG 的四种写法与引擎名都落 postgres', () => {
    for (const n of ['postgres', 'postgresql', 'pg', 'pgsql', 'PG', ' Postgres ', 'kingbase']) {
      assert.equal(dbEngineFamily(n), 'postgres', n + ' 应归 postgres 家族')
      assert.equal(isPgFamily(n), true, n + ' 应是 PG 家族')
    }
  })

  test('MySQL 协议族与 sqlite 别名各归其位', () => {
    for (const n of ['mysql', 'mariadb', 'tidb', 'TiDB', 'oceanbase']) {
      assert.equal(dbEngineFamily(n), 'mysql', n)
      assert.equal(isPgFamily(n), false, n + ' 不该被判成 PG')
    }
    for (const n of ['sqlite', 'sqlite3', 'SQLite']) {
      assert.equal(dbEngineFamily(n), 'sqlite', n)
      assert.equal(isSqliteFamily(n), true, n)
    }
  })

  test('谓词互斥：同一个名字只会是一家', () => {
    for (const n of ['mysql', 'postgres', 'sqlite', 'redis', 'kingbase', 'sqlserver']) {
      const hits = [isPgFamily(n), isSqliteFamily(n)].filter(Boolean).length
      assert.ok(hits <= 1, `${n} 同时落进两家：PG 与 SQLite 的引号规则互斥`)
    }
  })
})

// 下面这组是"接线契约"：改天有人把某处又写回裸比，这里要红。
// 只扫已经被这条链覆盖的文件，不去管那些收**已归一方言 id**的地方
// （db-ref-utils / db-sql-snippets / db-sql-params 拿到的是 dialectIdOf 的输出，
//  比 'postgres' 是对的，不该也不该被换成家族调用）。
describe('db-engine-family: 落点收拢（引擎名比较只剩这一张表）', () => {
  const sqlDialects = read('src/client/common/sql-dialects.js')
  const grid = read('src/client/common/db-grid-view.js')
  const csv = read('src/client/common/db-csv.js')
  const risk = read('src/client/common/db-sql-risk.js')
  const dictionary = read('src/client/common/db-dictionary.js')
  const session = read('src/client/components/database/db-session.jsx')

  test('消费方都 import 了家族模块（漏 import 是运行时才炸的 undefined 调用）', () => {
    const need = [
      [sqlDialects, 'dbEngineFamily'],
      [grid, 'dbEngineFamily'],
      [csv, 'isPgFamily'],
      [risk, 'isPgFamily'],
      [dictionary, 'isPgFamily'],
      [session, 'isPgFamily']
    ]
    for (const [src, fn] of need) {
      assert.ok(
        src.includes(`import { ${fn} } from '`) || src.includes(`import { ${fn},`),
        `未 import ${fn}`
      )
    }
  })

  test('自己另写一份引擎名单的地方都下线了', () => {
    assert.ok(!sqlDialects.includes('DB_TYPE_TO_DIALECT'), '方言表里还留着一份引擎映射')
    assert.ok(!risk.includes('PG_NAMES'), '风险判定里还留着一份 PG 名单')
    assert.ok(!risk.includes('SQLITE_NAMES'), '风险判定里还留着一份 SQLite 名单')
  })

  test('这些文件里不再出现"引擎名 == postgres"的裸比（方言 id 比较不受此约束）', () => {
    for (const [name, src] of [['db-csv.js', csv], ['db-dictionary.js', dictionary],
      ['db-session.jsx', session], ['db-sql-risk.js', risk]]) {
      assert.ok(
        !/\bdbType === 'postgres'/.test(src) && !/=== 'pg'/.test(src),
        name + ' 还在直接比引擎名/裸别名'
      )
    }
  })

  test('归一函数把 redis 折给 mysql（它没有 SQL 语法，但不能返回 undefined）', () => {
    // sql-dialects 与 db-grid-view 各有一个"必须拿出方言 id"的入口，两处口径要一致
    assert.match(sqlDialects, /family === 'redis' \? 'mysql'/)
    assert.match(grid, /family === 'redis' \? 'mysql'/)
  })
})

describe('db-engine-family: 现有引擎的行为表（逐格钉住，新增引擎在此补行）', () => {
  test('dialectIdOf：每个引擎的方言 id', async () => {
    const { dialectIdOf } = await import(pathToFileURL(
      path.join(ROOT, 'src/client/common/sql-dialects.js')
    ).href)
    assert.deepEqual(enginesFromConstants().map(e => [e, dialectIdOf(e)]), [
      ['mysql', 'mysql'],
      ['redis', 'mysql'],
      ['postgres', 'postgres'],
      ['tidb', 'mysql'],
      ['oceanbase', 'mysql'],
      ['sqlite', 'sqlite'],
      ['kingbase', 'postgres']
    ])
  })

  test('sqlQuoteModeOf：每个引擎的复制 SQL 引号风格', async () => {
    const { sqlQuoteModeOf } = await import(pathToFileURL(
      path.join(ROOT, 'src/client/common/db-csv.js')
    ).href)
    assert.deepEqual(enginesFromConstants().map(e => [e, sqlQuoteModeOf(e)]), [
      ['mysql', 'backtick'],
      ['redis', 'backtick'],
      ['postgres', 'double'],
      ['tidb', 'backtick'],
      ['oceanbase', 'backtick'],
      ['sqlite', 'sqlite'],
      ['kingbase', 'double']
    ])
  })

  test('buildWhere 占位符：PG 家族用 $n，MySQL 家族用 ?（家族判错=条件被拒）', async () => {
    const { buildWhere } = await import(pathToFileURL(
      path.join(ROOT, 'src/client/common/db-grid-view.js')
    ).href)
    const columns = [{ name: 'id', type: 'int' }]
    const view = { conditions: [{ column: 'id', op: 'eq', value: '7' }] }
    for (const d of ['mysql', 'tidb', 'oceanbase', 'redis', 'sqlite']) {
      const { clause, params, rejected } = buildWhere(view, columns, d)
      assert.equal(rejected.length, 0, d + ' 的条件不该被拒')
      assert.equal(clause, d === 'sqlite' ? '"id" = ?' : '`id` = ?', d + ' 的标识符/占位符')
      assert.deepEqual(params, ['7'])
    }
    for (const d of ['postgres', 'kingbase']) {
      const { clause, params, rejected } = buildWhere(view, columns, d)
      assert.equal(rejected.length, 0, d + ' 的条件不该被拒')
      assert.equal(clause, '"id" = $1', d + ' 应是双引号 + $1')
      assert.deepEqual(params, ['7'])
    }
  })
})
