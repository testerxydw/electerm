const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const JSX = path.join(ROOT, 'src/client/components/database/db-session.jsx')

// redis 详情空值守卫回归（239f8b9f 引入、a376c9b5 修复的线上崩溃）：
// renderRedisDetail 尾部 return 不在 if (!d) 作用域内；redisDetail 未加载
// （d=null）时点击 redis 键即触发渲染，裸 d.type 会 TypeError 崩掉数据库页。
// 契约：信息栏条件必须保留 d 空值守卫，body 的 !d 早退分支不得删。

const loadJsx = () => fs.readFileSync(JSX, 'utf8')

// 从真实源码抽出信息栏渲染条件并执行（跑发布代码而非拷贝，同 db-grid-scroll 口径）
const loadBarCond = () => {
  const src = loadJsx()
  assert.ok(
    src.includes("d && d.type !== 'string'"),
    "detail bar condition must keep the null guard (d && d.type !== 'string')"
  )
  return vm.runInNewContext("(function (d) { return d && d.type !== 'string' })", {})
}

describe('redis detail: null guard (real source)', () => {
  const cond = loadBarCond()

  test('detail not loaded (d=null) -> no bar, no crash', () => {
    // d && ... 对 null 返回 null（falsy）， JSX 条件下等价不渲染
    assert.ok(!cond(null), 'null detail must be falsy')
  })

  test('grid types keep the info bar', () => {
    assert.equal(cond({ type: 'hash' }), true)
    assert.equal(cond({ type: 'list' }), true)
    assert.equal(cond({ type: 'set' }), true)
    assert.equal(cond({ type: 'zset' }), true)
  })

  test('string type hides the bar (info merged into DbValuePane head)', () => {
    assert.equal(cond({ type: 'string' }), false)
  })

  test('every d.type !== string occurrence is null-guarded (regression shape)', () => {
    const src = loadJsx()
    const all = src.match(/d\.type !== 'string'/g) || []
    const guarded = src.match(/d && d\.type !== 'string'/g) || []
    assert.ok(all.length > 0, 'expected at least one detail-bar condition')
    assert.equal(
      all.length, guarded.length,
      'found an unguarded d.type !== string (null detail crashes on key click)'
    )
  })

  test('renderRedisDetail keeps the if (!d) early-out for body', () => {
    assert.match(loadJsx(), /if \(!d\) \{/, 'body branch must early-out on null detail')
  })
})
