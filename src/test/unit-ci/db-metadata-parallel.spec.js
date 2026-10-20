// P1-7 MySQL 元数据修复回归：限并发 + 系统库过滤 + per-db 降级
// 真实源码 + vm 跑（require 打桩），不依赖 electron/真实驱动：
//  - 系统库（information_schema/mysql/performance_schema/sys）不入树
//  - SHOW TABLES 并发受限（峰值 ≤ 4）且 > 1（并发化生效）
//  - 单库失败整体不抛：降级节点 { name, children: [], error }
//  - 结果保序（与 SHOW DATABASES 一致）
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const JS = path.join(ROOT, 'src/app/lib/db-client/mysql.js')

// 假 pool：可配置每库表数据/延迟/失败；记录并发峰值
function makePool (opts) {
  let running = 0
  let maxConcurrent = 0
  return {
    stats: { maxConcurrent, queries: [] },
    async query (sql) {
      this.stats.queries.push(sql)
      running++
      maxConcurrent = Math.max(maxConcurrent, running)
      if (maxConcurrent > 999) { /* guard */ }
      // 把峰值回写（闭包对象共享）
      this.stats.maxConcurrent = maxConcurrent
      try {
        if (/^SHOW DATABASES/.test(sql)) {
          await sleep(opts.dbListDelay || 1)
          return [opts.databases.map(d => ({ Database: d }))]
        }
        const m = sql.match(/^SHOW TABLES FROM `([^`]+)`/)
        if (m) {
          const conf = opts.tables[m[1]]
          if (!conf) {
            throw new Error('mock: no tables config for ' + m[1])
          }
          if (conf.fail) {
            throw new Error(conf.err || 'mock table load fail')
          }
          await sleep(conf.delay || 1)
          return [conf.list.map(n => ({ Tables_in_x: n }))]
        }
        throw new Error('mock: unexpected sql ' + sql)
      } finally {
        running--
      }
    }
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function loadMysql (pool) {
  const src = fs.readFileSync(JS, 'utf8')
  const stubs = {
    '../../common/log': { debug () {}, info () {}, warn () {}, error () {} },
    'mysql2/promise': {
      createPool () { return pool }
    }
  }
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require: spec => {
      if (stubs[spec]) {
        return stubs[spec]
      }
      return require(spec) // 相对导入（../../common/log 之外的都会被上面桩住）
    }
  }
  vm.runInNewContext(src, sandbox, { filename: 'mysql.js' })
  return sandbox.module.exports
}

function buildConn () {
  return { dbHost: 'h', dbPort: 1, dbUser: 'u', dbPassword: 'p' }
}

describe('mysql getMetadata: 系统库过滤参数化 + 限并发 + per-db 降级', () => {
  const DBS = ['zzz', 'information_schema', 'tgfsom', 'mysql', 'performance_schema', 'sys', 'aaa']

  function makeMetaPool (tables) {
    return makePool({ databases: DBS, tables })
  }

  test('默认全显（不传参/传 false）：系统库也在树中，业务库保序', async () => {
    const pool = makeMetaPool({
      zzz: { list: ['t1'] },
      information_schema: { list: ['TABLES'] },
      tgfsom: { list: ['a', 'b'] },
      mysql: { list: ['user'] },
      performance_schema: { list: [] },
      sys: { list: [] },
      aaa: { list: [] }
    })
    const mod = loadMysql(pool)
    // 不传 args：全显
    const meta = await mod.getMetadata(buildConn())
    assert.deepEqual([...meta].map(d => d.name), DBS, '默认全显且保序')
    // 显式传 false：同样全显
    const meta2 = await mod.getMetadata(buildConn(), { hideSystemSchemas: false })
    assert.equal(meta2.length, DBS.length)
  })

  test('hideSystemSchemas:true 过滤系统库，业务库保序', async () => {
    const pool = makeMetaPool({
      zzz: { list: ['t1'] },
      information_schema: { list: ['TABLES'] },
      tgfsom: { list: ['a', 'b'] },
      mysql: { list: ['user'] },
      performance_schema: { list: [] },
      sys: { list: [] },
      aaa: { list: [] }
    })
    const mod = loadMysql(pool)
    const meta = await mod.getMetadata(buildConn(), { hideSystemSchemas: true })
    assert.deepEqual([...meta].map(d => d.name), ['zzz', 'tgfsom', 'aaa'], '系统库被滤掉且保序')
    assert.deepEqual([...meta[1].children].map(c => c.name), ['a', 'b'])
    assert.equal(meta[1].type, 'database')
    assert.equal(meta[1].children[0].type, 'table')
  })

  test('SHOW TABLES 并发受限：峰值 >1 且 ≤4（并发化生效且不打满池）', async () => {
    const dbs = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9', 'd10']
    const tables = {}
    dbs.forEach(d => { tables[d] = { list: ['t'], delay: 20 } })
    const pool = makePool({ databases: dbs, tables })
    const mod = loadMysql(pool)
    await mod.getMetadata(buildConn())
    const peak = pool.stats.maxConcurrent
    assert.ok(peak > 1, '并发应 >1（若为 1 则退化成串行 N+1）')
    assert.ok(peak <= 4, '并发峰值须 ≤4（与 connectionLimit 一致），实测 ' + peak)
  })

  test('单库失败不抛：降级节点 children 空 + error，其余库正常', async () => {
    const pool = makePool({
      databases: ['ok1', 'bad', 'ok2'],
      tables: {
        ok1: { list: ['t1'] },
        bad: { fail: true, err: 'mock permission denied' },
        ok2: { list: ['t2'] }
      }
    })
    const mod = loadMysql(pool)
    const meta = await mod.getMetadata(buildConn())
    const bad = meta.find(d => d.name === 'bad')
    assert.ok(bad, '失败库节点保留')
    assert.deepEqual([...bad.children], [], '失败库 children 置空')
    assert.match(bad.error, /permission denied/, '带 error 信息供前端提示')
    assert.deepEqual([...meta.find(d => d.name === 'ok1').children].map(c => c.name), ['t1'])
    assert.deepEqual([...meta.find(d => d.name === 'ok2').children].map(c => c.name), ['t2'])
  })

  test('库名含反引号时 SHOW TABLES 不破语法', async () => {
    const pool = makePool({
      databases: ['we`ird'],
      tables: { weird: { list: ['t'] } }
    })
    const mod = loadMysql(pool)
    const meta = await mod.getMetadata(buildConn())
    const shown = pool.stats.queries.find(s => s.startsWith('SHOW TABLES'))
    assert.ok(!shown.includes('``'), '反引号应被剥离，不产生空反引号')
    assert.equal(meta[0].name, 'we`ird', '树展示保留原名')
  })
})
