const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const JSX = path.join(ROOT, 'src/client/components/database/db-session.jsx')
// N11a #15：Redis 详情渲染已拆成独立 shipped 模块 db-redis-detail.jsx；
// 源码文本契约跟着代码走，组合读两份发布源码，断言语义与计数阈值保持原样（总数守恒）。
const DETAIL = path.join(ROOT, 'src/client/components/database/db-redis-detail.jsx')

// redis 详情空值守卫回归（239f8b9f 引入、a376c9b5 修复的线上崩溃）：
// renderRedisDetail 尾部 return 不在 if (!d) 作用域内；redisDetail 未加载
// （d=null）时点击 redis 键即触发渲染，裸 d.type 会 TypeError 崩掉数据库页。
// 契约：信息栏条件必须保留 d 空值守卫，body 的 !d 早退分支不得删。

const loadJsx = () => fs.readFileSync(JSX, 'utf8') + '\n' + fs.readFileSync(DETAIL, 'utf8')

// 从真实源码抽出信息栏渲染条件并执行（跑发布代码而非拷贝，同 db-grid-scroll 口径）
// N5d：判断归一成 isStringLike（string + ReJSON 模块键同走值面板），
// 抽源码里的 isStringLike 定义真跑，null guard（d &&）语义不变
const loadBarCond = () => {
  const src = loadJsx()
  assert.ok(
    src.includes('d && !isStringLike(d)'),
    'detail bar condition must keep the null guard (d && !isStringLike(d))'
  )
  const def = /const isStringLike = (d => [^\n]+)/.exec(src)
  assert.ok(def, 'isStringLike 定义没找到（归一判断被移走了？）')
  const ctx = vm.createContext({})
  vm.runInContext('const isStringLike = ' + def[1], ctx)
  return vm.runInContext('(function (d) { return d && !isStringLike(d) })', ctx)
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

  test('ReJSON module keys also take the value-pane branch (N5d)', () => {
    assert.equal(cond({ type: 'ReJSON-RL' }), false)
    assert.equal(cond({ type: 'ReJSON-RLType' }), false)
  })

  test('exclusion is normalized into isStringLike (no bare d.type !== string left)', () => {
    const src = loadJsx()
    assert.ok(!src.includes("d.type !== 'string'"),
      '排除判断必须归一进 isStringLike，不留裸比较')
    const bare = (src.match(/(?<!d && )!isStringLike\(d\)/g) || []).length
    const guarded = (src.match(/d && !isStringLike\(d\)/g) || []).length
    assert.equal(bare, 0, 'isStringLike 排除必须全部带 d && 空值守卫')
    assert.ok(guarded >= 2, '信息栏与 SplitPane 两处排除都要在')
  })

  test('renderRedisDetail keeps the if (!d) early-out for body', () => {
    assert.match(loadJsx(), /if \(!d\) \{/, 'body branch must early-out on null detail')
  })
})
