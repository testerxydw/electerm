// H7b-3 Redis 批量删键：后端 delKeys（UNLINK）+ 渲染侧分块/预览纯函数
//
// 这层薄，但每一处错都不是"少个功能"而是"删错东西"：
//   · 必须 UNLINK 不是 DEL —— DEL 在百万成员的 key 上同步回收内存，能把 redis 卡住几秒
//   · 键数组只能收非空字符串 —— `[null]` 经 String() 会变成 "null"，等于删一个真键
//   · 单次上限 1000 —— 一次误传整页/整树的键名不该变成一条几十万参数的命令
//   · 只读闸门在主进程（渲染层传参不可信），删键没有"前端忘了禁用"这条路
//   · 返回值是"实际删掉的键数"（不存在的键不计），进度只能拿它累加
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
// N1：适配器新增依赖 './db-tls'（只依赖 fs/crypto），沙箱给真模块，顺带钉住委托关系
const DB_TLS = require(path.join(ROOT, 'src/app/lib/db-client/db-tls.js'))
const REDIS_JS = path.join(ROOT, 'src/app/lib/db-client/redis.js')
const INDEX_JS = path.join(ROOT, 'src/app/lib/db-client/index.js')

// 与 db-redis-slowlog.spec.js 同一套路：vm 沙箱里跑真模块，ioredis 换成假 client
function loadRedis (opts = {}) {
  const calls = { unlink: [], del: [], select: [] }
  const inst = {
    on () {},
    async connect () {},
    disconnect () {},
    async select (...a) {
      calls.select.push(a)
    },
    async unlink (...a) {
      calls.unlink.push(a)
      if (opts.unlinkThrows) throw new Error(opts.unlinkThrows)
      return opts.unlink === undefined ? a.length : opts.unlink
    },
    async del (...a) {
      calls.del.push(a)
      return a.length
    },
    pipeline () {
      return { type () { return this }, ttl () { return this }, async exec () { return [] } }
    }
  }
  const Redis = function () {
    return inst
  }
  const mod = { exports: {} }
  const sandbox = {
    module: mod,
    exports: mod.exports,
    require: spec => {
      if (spec === './db-tls') return DB_TLS
      assert.equal(spec, 'ioredis', 'redis.js 多了新依赖，这个假沙箱得跟着补')
      return Redis
    },
    console,
    Promise
  }
  vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(REDIS_JS, 'utf8'), sandbox, { filename: 'redis.js' })
  return { mod: mod.exports, calls }
}

const CONN = { dbHost: 'h', dbPort: 6379 }

describe('H7b-3 delKeys（后端）', () => {
  test('一条 UNLINK 带上全部键名，按原序；绝不发 DEL', async () => {
    const { mod, calls } = loadRedis({ unlink: 2 })
    const n = await mod.delKeys(CONN, { dbIndex: 0, keys: ['a', 'b'] })
    assert.equal(n, 2)
    assert.deepEqual(calls.unlink, [['a', 'b']])
    assert.deepEqual(calls.del, [], 'DEL 会在大 key 上阻塞事件循环，批量删除只能走 UNLINK')
  })

  test('重复键去重：同一个键不删两次、也不占两格进度', async () => {
    const { mod, calls } = loadRedis({ unlink: 2 })
    await mod.delKeys(CONN, { dbIndex: 0, keys: ['a', 'b', 'a'] })
    assert.deepEqual(calls.unlink, [['a', 'b']])
  })

  test('返回值归一成数字：redis 回字符串/undefined 都不会把进度算成 NaN', async () => {
    const s = loadRedis({ unlink: '3' })
    assert.equal(await s.mod.delKeys(CONN, { dbIndex: 0, keys: ['a'] }), 3)
    const u = loadRedis({ unlink: undefined })
    assert.equal(await u.mod.delKeys(CONN, { dbIndex: 0, keys: ['a'] }), 1, '缺返回落成键数')
    const bad = loadRedis({ unlink: null })
    assert.equal(await bad.mod.delKeys(CONN, { dbIndex: 0, keys: ['a'] }), 0, 'null 不能变 NaN')
  })

  test('空数组 / 非数组 / 空串 / 非字符串一律抛参数错，且不发请求', async () => {
    const bad = [[], null, undefined, 'a', {}, [''], [null], [undefined], [1], ['a', '']]
    for (const keys of bad) {
      const { mod, calls } = loadRedis()
      await assert.rejects(
        () => mod.delKeys(CONN, { dbIndex: 0, keys }),
        /delKeys requires/,
        `keys=${JSON.stringify(keys)} 应被拒`
      )
      assert.deepEqual(calls.unlink, [], '参数错不能让请求先发出去')
    }
  })

  test('单次上限 1000：正好 1000 通过，1001 拒绝且不发请求', async () => {
    const ok = loadRedis({ unlink: 1000 })
    const keys = Array.from({ length: 1000 }, (_, i) => 'k' + i)
    assert.equal(await ok.mod.delKeys(CONN, { dbIndex: 0, keys }), 1000)
    assert.equal(ok.calls.unlink[0].length, 1000)

    const too = loadRedis()
    const many = Array.from({ length: 1001 }, (_, i) => 'k' + i)
    await assert.rejects(() => too.mod.delKeys(CONN, { dbIndex: 0, keys: many }), /at most 1000/)
    assert.deepEqual(too.calls.unlink, [])
  })

  test('只读模式在主进程拒绝：渲染层传 readOnly:true 才拦得住是不可接受的', async () => {
    const { mod, calls } = loadRedis()
    await assert.rejects(
      () => mod.delKeys(CONN, { dbIndex: 0, keys: ['a'], readOnly: true }),
      /read-only mode/
    )
    assert.deepEqual(calls.unlink, [])
  })

  test('在目标 db 上执行（首发改库才 select，同库不重复 select）', async () => {
    const { mod, calls } = loadRedis()
    await mod.delKeys(CONN, { dbIndex: 0, keys: ['a'] })
    await mod.delKeys(CONN, { dbIndex: 0, keys: ['b'] })
    await mod.delKeys(CONN, { dbIndex: 3, keys: ['c'] })
    // 连接上没有"当前库"记录时先 select 一次（不知道它是不是 db0），之后同库不再发
    assert.deepEqual(calls.select, [[0], [3]])
    assert.deepEqual(calls.unlink, [['a'], ['b'], ['c']])
  })

  test('服务端报错原样上抛（被 ACL 拒绝/集群 MOVED 都得让人看见）', async () => {
    const { mod } = loadRedis({ unlinkThrows: 'NOPERM this user has no permissions to run unlink' })
    await assert.rejects(() => mod.delKeys(CONN, { dbIndex: 0, keys: ['a'] }), /NOPERM/)
  })

  test('op 已挂进 redis 方法表且模块导出（漏一边就是 "unsupported op"）', () => {
    const src = fs.readFileSync(INDEX_JS, 'utf8')
    const redisBlock = /redis: \{[\s\S]*?\n {2}\}/.exec(src)
    assert.ok(redisBlock, 'OP_MAP.redis 未找到')
    assert.match(redisBlock[0], /delKeys: 'delKeys'/)
    const { mod } = loadRedis()
    assert.equal(typeof mod.delKeys, 'function')
  })
})

// ── 渲染侧纯函数（src/client/common/db-redis-del.js）──────────────────────
const load = () => import('../../client/common/db-redis-del.js')

describe('H7b-3 分块与预览纯函数', () => {
  test('默认一批 500：1200 个键切成 500/500/200，顺序不变', async () => {
    const { chunkRedisKeys, REDIS_DEL_BATCH } = await load()
    assert.equal(REDIS_DEL_BATCH, 500)
    const keys = Array.from({ length: 1200 }, (_, i) => 'k' + i)
    const chunks = chunkRedisKeys(keys)
    assert.deepEqual(chunks.map(c => c.length), [500, 500, 200])
    assert.deepEqual(chunks[0].slice(0, 2), ['k0', 'k1'])
    assert.equal(chunks[2][199], 'k1199')
  })

  test('去重保序：重复键只出现在第一批一次', async () => {
    const { chunkRedisKeys } = await load()
    assert.deepEqual(chunkRedisKeys(['b', 'a', 'b', 'c'], 2), [['b', 'a'], ['c']])
  })

  test('丢掉非字符串与空串；非数组回空列表', async () => {
    const { chunkRedisKeys } = await load()
    assert.deepEqual(chunkRedisKeys(['a', '', null, 3, undefined, 'b']), [['a', 'b']])
    assert.deepEqual(chunkRedisKeys(null), [])
    assert.deepEqual(chunkRedisKeys('a'), [])
  })

  test('非法 size 回落默认 500（0 会让 while 永远不前进）', async () => {
    const { chunkRedisKeys, REDIS_DEL_BATCH } = await load()
    const keys = Array.from({ length: 600 }, (_, i) => 'k' + i)
    for (const bad of [0, -5, NaN, 'x', undefined]) {
      const chunks = chunkRedisKeys(keys, bad)
      assert.equal(chunks.length, 2, `size=${String(bad)} 应回落 ${REDIS_DEL_BATCH}`)
      assert.equal(chunks[0].length, 500)
    }
  })

  test('预览：25 个键 → 列 20 个 + 剩 5；正好 20 个不报"还有 0 个"', async () => {
    const { delPreview } = await load()
    const keys = Array.from({ length: 25 }, (_, i) => 'k' + i)
    const p = delPreview(keys)
    assert.equal(p.shown.length, 20)
    assert.equal(p.shown[0], 'k0')
    assert.equal(p.rest, 5)
    assert.deepEqual(delPreview(keys.slice(0, 20)), { shown: keys.slice(0, 20), rest: 0 })
    assert.deepEqual(delPreview(null), { shown: [], rest: 0 })
    assert.deepEqual(delPreview(keys, 0), { shown: [], rest: 25 })
  })

  test('进度百分比：0/0 给 0 不给 NaN，超额夹到 100', async () => {
    const { delPercent } = await load()
    assert.equal(delPercent(0, 0), 0)
    assert.equal(delPercent(0, 500), 0)
    assert.equal(delPercent(250, 1000), 25)
    assert.equal(delPercent(600, 500), 100, '返回值按"实际删掉"累加，理论上不该超额，超额也不画出 >100')
    assert.equal(delPercent(NaN, 10), 0)
    assert.equal(delPercent(3, undefined), 0)
  })

  test('E1 确认文本：前 10 个键 + 还剩多少；单个超长键名截到 60', async () => {
    const { delCommandText } = await load()
    assert.equal(delCommandText(['a', 'b']), 'UNLINK a b')
    const many = Array.from({ length: 12 }, (_, i) => 'k' + i)
    assert.equal(delCommandText(many), 'UNLINK k0 k1 k2 k3 k4 k5 k6 k7 k8 k9 …(+2)')
    const long = 'x'.repeat(100)
    const text = delCommandText([long])
    assert.equal(text, 'UNLINK ' + 'x'.repeat(57) + '…', '截断后 57 字符 + 省略号')
  })
})

// ── 渲染侧接线（源码契约）────────────────────────────────────────────────
const SESSION = path.join(ROOT, 'src/client/components/database/db-session.jsx')
const STYL = path.join(ROOT, 'src/client/components/database/db-session.styl')
const LOCALES = path.join(ROOT, 'src/app/common/locales-extra.js')

const sessionSrc = () => fs.readFileSync(SESSION, 'utf8')

describe('H7b-3b 键列表多选与弹层接线', () => {
  test('键列表行键用键名 + 挂 rowSelection（下标 __rowKey 会随翻页指向别的键）', () => {
    const src = sessionSrc()
    const table = /<DbGridTable\n {24}className='db-redis-keys'[\s\S]*?\/>/.exec(src)
    assert.ok(table, '键列表 DbGridTable 未找到')
    assert.match(table[0], /rowKey='name'/, '行键必须是键名')
    assert.doesNotMatch(table[0], /rowKey='__rowKey'/)
    assert.match(table[0], /rowSelection=\{redisKeyRowSelection\}/)
  })

  test('勾选存键名、跨页保留、只读时复选框禁用、换库/改过滤即清空', () => {
    const src = sessionSrc()
    assert.match(src, /selectedRowKeys: redisKeySel,/)
    assert.match(src, /preserveSelectedRowKeys: true/, '翻页后行不在 dataSource 里，不保留就只能删本页')
    assert.match(src, /onChange: keys => setRedisKeySel\(keys\),/)
    assert.match(src, /getCheckboxProps: \(\) => \(\{ disabled: isReadonly \}\)/)
    assert.match(
      src,
      /useEffect\(\(\) => \{\n {4}setRedisKeySel\(\[\]\)\n {2}\}, \[redisDb, keyList\.match\]\)/,
      '跨页保留，但换库/改过滤必须清空（键名集合跨库没有意义）'
    )
    assert.doesNotMatch(src, /\}, \[redisDb, keyList\.cursor, keyList\.match\]\)/, '翻页不能清勾选')
  })

  test('跨页勾选有常驻提示 + 一键清空（当前页可能一个都没选）', () => {
    const src = sessionSrc()
    assert.match(src, /e\('dbRedisSelCount'\)\.replace\('\{n\}', String\(redisKeySel\.length\)\)/)
    assert.match(src, /className='db-redis-sel-clear'\n {34}onClick=\{\(\) => setRedisKeySel\(\[\]\)\}/)
  })

  test('入口只读禁用并说明原因，未勾选不可点', () => {
    const src = sessionSrc()
    assert.match(src, /title=\{isReadonly \? e\('dbRedisDelKeysReadonly'\) : ''\}/)
    assert.match(src, /disabled=\{!redisKeySel\.length \|\| isReadonly \|\| keyList\.loading\}/)
    assert.match(src, /\{e\('dbRedisDelKeys'\)\}\{redisKeySel\.length \? `\(\$\{redisKeySel\.length\}\)` : ''\}/)
  })

  test('弹层冻结键名快照：确认后翻页/刷新不改这一批', () => {
    const src = sessionSrc()
    assert.match(src, /const keys = redisKeySel\.slice\(\)/)
    assert.match(src, /setRedisDel\(\{ open: true, keys, running: false, done: 0, error: '' \}\)/)
  })

  test('生产走 E1：dangerous 级 + 只列前 10 个键的命令文本', () => {
    const src = sessionSrc()
    assert.match(src, /level: 'dangerous',\n {6}text: delCommandText\(targets\),\n {6}note: e\('dbRedisDelKeysBody'\)/)
    assert.match(src, /const ok = await confirmRedisWrite\(\{/)
    assert.match(src, /if \(!ok\) \{\n {6}return\n {4}\}/, '取消 = 零执行')
  })

  test('分批 UNLINK：只带 dbIndex + keys（readOnly 由主进程注入，渲染层传的是空子）', () => {
    const src = sessionSrc()
    assert.match(src, /for \(const chunk of chunkRedisKeys\(targets\)\) \{/)
    const call = /'delKeys', \{\n {10}dbIndex: redisDb,\n {10}keys: chunk\n {8}\}\)/.exec(src)
    assert.ok(call, 'delKeys 调用参数形状变了：readOnly 不该由渲染层传')
    assert.doesNotMatch(call[0], /readOnly/)
  })

  test('进度按 unlink 的实际删除数累加（发出去几个不等于删掉几个）', () => {
    const src = sessionSrc()
    assert.match(src, /done \+= Number\(n\) \|\| 0/)
    assert.match(src, /percent=\{delPercent\(redisDel\.done, redisDel\.keys\.length\)\}/)
  })

  test('中途失败停在弹层：报错 + "已删除 done/total"，且不给重试按钮', () => {
    const src = sessionSrc()
    assert.match(src, /error: cleanDbError\(err && err\.message \? err\.message : err\)\n {8}\}\)\)\n {8}return/)
    assert.match(src, /message=\{redisDel\.error\}/)
    assert.match(src, /e\('dbRedisDelKeysPartial'\)\n/)
    // 部分失败后只剩"关闭"：重试会把已删掉的键再发一遍，进度从 0 重来；
    // "取消"和"关闭"是同一个动作，同时出现只会让人以为还有别的选择
    assert.match(src, /redisDel\.error\n {18}\? \[\n {20}<Button key='close' onClick=\{closeRedisDel\}>/)
    assert.doesNotMatch(src, /key='ok'[\s\S]{0,120}redisDel\.error/, '失败后不该再给删除按钮')
  })

  test('删除中不可取消（已发出的 UNLINK 收不回来）', () => {
    const src = sessionSrc()
    assert.match(src, /const closeRedisDel = \(\) => \{\n {4}if \(redisDel\.running\) \{\n {6}return\n {4}\}/)
    assert.match(src, /<Button key='cancel' onClick=\{closeRedisDel\} disabled=\{redisDel\.running\}>/)
  })

  test('删完清勾选、清已删键的详情、原页重拉并刷新左侧键数', () => {
    const src = sessionSrc()
    assert.match(src, /if \(targets\.includes\(redisKey\)\) \{\n {6}setRedisKey\(''\)\n {6}setRedisDetail\(null\)\n {4}\}/)
    assert.match(src, /loadRedisKeys\(redisDb, keyList\.cursor, keyList\.match, keyList\.stack\)/, '应原页重拉而不是回第一页')
    assert.match(src, /message\.success\(e\('dbRedisDelKeysDone'\)\.replace\('\{n\}', String\(done\)\)\)/)
    assert.match(src, /loadTree\(\)/)
  })

  test('预览只列 20 个键，余下走"另有 N 个键未列出"', () => {
    const src = sessionSrc()
    assert.match(src, /const redisDelPreview = useMemo\(\(\) => delPreview\(redisDel\.keys\), \[redisDel\.keys\]\)/)
    assert.match(src, /redisDelPreview\.shown\.map\(k => \(/)
    assert.match(src, /redisDelPreview\.rest\n {20}\?/)
    assert.match(src, /e\('dbRedisDelKeysMore'\)\.replace\('\{n\}', String\(redisDelPreview\.rest\)\)/)
    // "另有 N 个"要在滚动列表之外：列表本身截到 220px 高，塞在末尾时正好被截掉
    const modal = src.slice(src.indexOf("className='db-redis-del'"))
    const listEnd = modal.indexOf('</div>')
    const moreAt = modal.indexOf('db-redis-del-more')
    assert.ok(listEnd >= 0 && moreAt > listEnd, '"另有 N 个"应放在滚动列表之外')
    assert.doesNotMatch(modal.slice(0, listEnd), /db-redis-del-more/)
  })

  test('删键文案键全部双语齐备', () => {
    const extra = require(LOCALES)
    const src = sessionSrc()
    const re = /(?:^|[^A-Za-z0-9_$.])e\('(dbRedisDel[A-Za-z]*)'\)/g
    const keys = [...new Set((src.match(re) || []).map(s => /e\('([A-Za-z]+)'\)$/.exec(s)[1]))]
    assert.ok(keys.length >= 8, `删键自造键应有 8+，实际 ${keys.length}：${keys.join(',')}`)
    for (const k of keys) {
      assert.ok(extra.en[k] !== undefined, `${k} 缺英文词条`)
      assert.ok(extra.zh_cn[k] !== undefined, `${k} 缺中文词条`)
    }
  })

  test('样式：键名走数据面字体链，颜色全部来自 token', () => {
    const src = fs.readFileSync(STYL, 'utf8')
    const i = src.indexOf('// H7b-3 批量删键弹层')
    const j = src.indexOf('// 上下可拖拽分区')
    assert.ok(i >= 0 && j > i, '删键样式块没找到')
    const block = src.slice(i, j)
    assert.match(block, /\.db-redis-del-list\n {4}[\s\S]*?font-family var\(--db-code-font, var\(--font-mono\)\)/)
    assert.doesNotMatch(block, /font-family var\(--font-mono\)/)
    assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b/)
  })
})
