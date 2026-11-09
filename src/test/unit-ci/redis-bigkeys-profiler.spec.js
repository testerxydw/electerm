/**
 * N5b/N5c 契约测试：主进程 redis.js 的 scanBigKeys（大 Key 扫描）与
 * Redis Profiler（MONITOR）环形缓冲逻辑。
 *
 * redis.js 顶层依赖 ioredis（真实连接类），无法在 Node 测试环境直接建连，
 * 按项目既有"读源码 + vm 沙箱求值"模式：vm.runInThisContext 保持同 realm
 * （避免跨 realm deepEqual 原型链误报），require 注入 FakeRedis 等 mock。
 */

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')

const srcPath = path.join(__dirname, '../../app/lib/db-client/redis.js')
const src = fs.readFileSync(srcPath, 'utf8')

// ---- FakeRedis：按测试脚本可编程响应 ----
class FakeRedis extends EventEmitter {
  constructor (opts) {
    super()
    this.opts = opts
    this.script = FakeRedis.script || {}
    FakeRedis.instances.push(this)
  }

  async connect () {}

  disconnect () {
    this.disconnected = true
  }

  async ping () {
    return 'PONG'
  }

  async select () {}

  // scanBigKeys 的游标分页：script.scanImpl(cursor, args) → [next, keys]
  async scan (cursor, ...args) {
    return this.script.scanImpl(String(cursor), args)
  }

  // pipeline：记录命令序列，exec 时按 script.execImpl(cmds) 出结果
  // 响应格式与 ioredis 对齐：[[err, val], ...]
  pipeline () {
    const c = this
    const cmds = []
    return {
      type: k => cmds.push({ cmd: 'type', k }),
      strlen: k => cmds.push({ cmd: 'strlen', k }),
      call: (...a) => cmds.push({ cmd: a.join(' '), k: a[2] }),
      exec: async () => (c.script.execImpl ? c.script.execImpl(cmds, c) : cmds.map(() => [null, 0]))
    }
  }

  // monitor：ioredis 签名 monitor(cb) → Promise。fatal 用 script.monitorReject 模拟
  async monitor (cb) {
    this.monitorCb = cb
    if (this.script.monitorReject) {
      throw new Error(this.script.monitorReject)
    }
    return null
  }
}

FakeRedis.instances = []

// ---- 沙箱加载：mock 三个依赖，其余走真 require ----
function loadModule () {
  const fakes = {
    './db-tls': { resolveTlsProfile: () => null, tlsSigTag: () => '' },
    './redis-console': { runRedisCommand: async () => ({}), listRedisCommands: () => [] },
    ioredis: FakeRedis
  }
  const baseDir = path.dirname(srcPath)
  const fakeRequire = (id) => {
    if (fakes[id]) return fakes[id]
    return require(path.resolve(baseDir, id))
  }
  const module_ = { exports: {} }
  const wrapper = vm.runInThisContext(
    `(function (exports, require, module, __filename, __dirname) { ${src} })`,
    { filename: srcPath }
  )
  wrapper(module_.exports, fakeRequire, module_, srcPath, baseDir)
  return module_.exports
}

// conn 形状只要 sig() 用得到即可
const conn = { dbHost: '127.0.0.1', dbPort: 6379 }

function fresh (script = {}) {
  FakeRedis.instances = []
  FakeRedis.script = script
}

// ---- N5b scanBigKeys ----

test('N5b scanBigKeys: string 取 STRLEN、非 string 取 MEMORY USAGE，结果按 size 降序', async () => {
  fresh({
    // 两页游标：第一页 k1/k2，第二页 k3 后 cursor=0
    scanImpl: (cursor) => cursor === '0'
      ? ['1', ['k1', 'k2']]
      : ['0', ['k3']],
    execImpl: (cmds) => cmds.map(({ cmd, k }) => {
      if (cmd === 'type') {
        return [null, { k1: 'string', k2: 'hash', k3: 'string' }[k]]
      }
      if (cmd === 'strlen') {
        return [null, { k1: 1024, k2: 0, k3: 5 }[k]]
      }
      // pipeline.call('MEMORY', 'USAGE', k) 整条命令 join 后是 'MEMORY USAGE k2'，
      // 匹配用前缀而不是全等
      if (cmd.startsWith('MEMORY USAGE')) {
        return [null, { k2: 8192 }[k] ?? 0]
      }
      return [new Error('unexpected cmd: ' + cmd), null]
    })
  })
  const db = loadModule()
  const res = await db.scanBigKeys(conn, { dbIndex: 0 })

  assert.equal(res.cancelled, false)
  assert.equal(res.scanned, 3)
  assert.equal(res.truncated, false)
  assert.deepEqual(res.rows, [
    { name: 'k2', type: 'hash', size: 8192 }, // hash 走 MEMORY USAGE
    { name: 'k1', type: 'string', size: 1024 }, // string 走 STRLEN
    { name: 'k3', type: 'string', size: 5 }
  ])
})

test('N5b scanBigKeys: maxScan 截断 → truncated + scanned 封顶', async () => {
  fresh({
    scanImpl: () => ['0', ['a', 'b', 'c', 'd']],
    execImpl: (cmds) => cmds.map(({ cmd, k }) => cmd === 'type'
      ? [null, 'string']
      : [null, k.charCodeAt(0)])
  })
  const db = loadModule()
  const res = await db.scanBigKeys(conn, { dbIndex: 0, maxScan: 2 })
  assert.equal(res.scanned, 2)
  assert.equal(res.truncated, true)
  assert.equal(res.rows.length, 2)
})

test('N5b scanBigKeys: cancelToken 非零 → 立即返回 cancelled 且不扫描', async () => {
  let scanCalled = 0
  fresh({
    scanImpl: () => {
      scanCalled++
      return ['0', ['a']]
    },
    execImpl: () => []
  })
  const db = loadModule()
  const res = await db.scanBigKeys(conn, { dbIndex: 0, cancelToken: 1 })
  assert.equal(scanCalled, 0, '取消后不应发起任何 SCAN')
  assert.equal(res.cancelled, true)
  assert.equal(res.scanned, 0)
  assert.deepEqual(res.rows, [])
})

test('N5b scanBigKeys: TYPE 出错 → unknown + size 0，不炸整轮', async () => {
  fresh({
    scanImpl: () => ['0', ['bad', 'ok']],
    execImpl: (cmds) => cmds.map(({ cmd, k }) => {
      if (cmd === 'type') return k === 'bad' ? [new Error('ERR'), null] : [null, 'string']
      if (cmd === 'strlen') return [null, 7]
      return [null, 0]
    })
  })
  const db = loadModule()
  const res = await db.scanBigKeys(conn, { dbIndex: 0 })
  assert.equal(res.rows.length, 2)
  const bad = res.rows.find(r => r.name === 'bad')
  assert.deepEqual({ name: bad.name, type: bad.type, size: bad.size }, { name: 'bad', type: 'unknown', size: 0 })
})

// ---- N5c Profiler（MONITOR）----

test('N5c profiler: start → cb 推行 → pull 增量 diff（lastSeq 之后才有）', async () => {
  fresh({})
  const db = loadModule()
  const { handleId } = await db.startRedisProfiler(conn, { dbIndex: 0 })
  const c = FakeRedis.instances[0]
  assert.equal(typeof c.monitorCb, 'function', 'monitor 回调应已挂上')

  // 推 3 行
  c.monitorCb('1731.1', ['set', 'a'], 'raw set a')
  c.monitorCb('1731.2', ['get', 'b'], 'raw get b')
  c.monitorCb('1731.3', ['del', 'c'], 'raw del c')

  const first = db.getRedisProfilerData(handleId, -1)
  assert.equal(first.rows.length, 3)
  assert.equal(first.overflow, false)
  assert.deepEqual(first.rows.map(r => r.text), ['raw set a', 'raw get b', 'raw del c'])
  const maxSeq = first.rows[2].id

  // 再推 2 行，按 lastSeq 增量拉 → 只回新的
  c.monitorCb('1731.4', ['ping'], 'raw ping')
  c.monitorCb('1731.5', ['echo'], 'raw echo')
  const inc = db.getRedisProfilerData(handleId, maxSeq)
  assert.deepEqual(inc.rows.map(r => r.text), ['raw ping', 'raw echo'])

  db.stopRedisProfiler(handleId)
})

test('N5c profiler: 主进程 filter 只收录包含子串的行（大小写敏感）', async () => {
  fresh({})
  const db = loadModule()
  const { handleId } = await db.startRedisProfiler(conn, { dbIndex: 0, filter: '"set"' })
  const c = FakeRedis.instances[0]
  c.monitorCb('t1', ['set', 'a'], 'raw "set" a b')
  c.monitorCb('t2', ['get', 'x'], 'raw "get" x')
  c.monitorCb('t3', ['set', 'z'], 'raw "SET" z') // 大写 SET 不含小写 '"set"' → 过滤掉
  const res = db.getRedisProfilerData(handleId, -1)
  assert.deepEqual(res.rows.map(r => r.text), ['raw "set" a b'])
  db.stopRedisProfiler(handleId)
})

test('N5c profiler: pause → 不收录；resume → 恢复', async () => {
  fresh({})
  const db = loadModule()
  const { handleId } = await db.startRedisProfiler(conn, { dbIndex: 0 })
  const c = FakeRedis.instances[0]

  assert.equal(await db.toggleRedisProfilerPause(handleId, true), true)
  c.monitorCb('t1', ['get'], 'paused line')
  assert.equal(db.getRedisProfilerData(handleId, -1).rows.length, 0)

  assert.equal(await db.toggleRedisProfilerPause(handleId, false), false)
  c.monitorCb('t2', ['get'], 'resumed line')
  assert.deepEqual(
    db.getRedisProfilerData(handleId, -1).rows.map(r => r.text),
    ['resumed line']
  )
  db.stopRedisProfiler(handleId)
})

test('N5c profiler: 环形覆盖 → 超过 1000 行时最老被覆写，lastSeq 落后被覆盖区间 → overflow', async () => {
  fresh({})
  const db = loadModule()
  const { handleId } = await db.startRedisProfiler(conn, { dbIndex: 0 })
  const c = FakeRedis.instances[0]

  // 模拟渲染侧早期拉到 lastSeq=3，之后很久没拉
  c.monitorCb('t', ['x'], 'line 0')
  c.monitorCb('t', ['x'], 'line 1')
  c.monitorCb('t', ['x'], 'line 2')
  c.monitorCb('t', ['x'], 'line 3')
  const early = db.getRedisProfilerData(handleId, -1)
  assert.equal(early.rows.length, 4)

  // 疯狂推 1005 行（环形上限 1000 → id 0..4 被覆盖）
  for (let i = 0; i < 1005; i++) {
    c.monitorCb('t', ['x'], 'burst ' + i)
  }
  const res = db.getRedisProfilerData(handleId, 3)
  assert.equal(res.overflow, true, 'lastSeq=3 已落后于环形最老行(id=5) → overflow')
  assert.equal(res.rows.length, 1000)
  assert.equal(res.rows[0].text, 'burst 5', '环形最老一行应是 id=5（0..4 被覆盖）')
  db.stopRedisProfiler(handleId)
})

test('N5c profiler: stop 后 pull 返回 stopped，handle 清理', async () => {
  fresh({})
  const db = loadModule()
  const { handleId } = await db.startRedisProfiler(conn, { dbIndex: 0 })
  db.stopRedisProfiler(handleId)
  const res = db.getRedisProfilerData(handleId, -1)
  assert.equal(res.stopped, true)
  assert.deepEqual(res.rows, [])
  // monitor client 应被断开
  assert.equal(FakeRedis.instances[0].disconnected, true)
})

test('N5c profiler: monitor 命令被拒（fatal）→ 自动清理，pull 得 stopped', async () => {
  fresh({ monitorReject: 'ERR command not allowed' })
  const db = loadModule()
  const { handleId } = await db.startRedisProfiler(conn, { dbIndex: 0 })
  // fatal cleanup 是异步 catch，等一拍
  await new Promise(resolve => setTimeout(resolve, 20))
  const res = db.getRedisProfilerData(handleId, -1)
  assert.equal(res.stopped, true, 'fatal 后 handle 应已被清掉')
  assert.equal(FakeRedis.instances[0].disconnected, true)
})
