/**
 * H7a-2 键树纯函数（src/client/common/db-key-tree.js）
 *
 * 钉的都是"平铺键名折成树"这件事的边界：SCAN 会重复返回同一个键、键里会有空段、
 * 一个键可能正好是另一个键的前缀、分隔符是用户可配的（配成空串不能把键拆成单字）。
 * 这些一旦漏到渲染层，表现就是"树里少键/重复 key 警告/整棵树炸掉"。
 */
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')

const load = () => import('../../client/common/db-key-tree.js')

// 把树拍平成 [{depth, key, title, keyName, count}] 方便逐节点断言
const flat = (nodes, depth = 1, out = []) => {
  for (const n of nodes) {
    out.push({ depth, key: n.key, title: n.title, keyName: n.keyName, count: n.count })
    if (n.children) flat(n.children, depth + 1, out)
  }
  return out
}

const keysOf = (nodes, out = []) => {
  for (const n of nodes) {
    out.push(n.key)
    if (n.children) keysOf(n.children, out)
  }
  return out
}

describe('H7a-2 buildRedisKeyTree：分层与形状', () => {
  test('基本分层：顶层按第一段分组，count 为子树键数', async () => {
    const { buildRedisKeyTree } = await load()
    const { nodes, total } = buildRedisKeyTree(['user:1', 'user:2', 'order:9'])
    assert.equal(total, 3)
    assert.deepEqual(nodes.map(n => n.title), ['order', 'user'])
    const user = nodes.find(n => n.title === 'user')
    assert.equal(user.count, 2)
    assert.equal(user.keyName, null, 'user 本身不是键 → 纯目录不可选')
    assert.deepEqual(user.children.map(c => c.keyName), ['user:1', 'user:2'])
    assert.deepEqual(user.children.map(c => c.count), [1, 1])
  })

  test('不含分隔符的键留在顶层，且与目录混排时排在目录之后', async () => {
    const { buildRedisKeyTree } = await load()
    const { nodes } = buildRedisKeyTree(['zeta', 'alpha', 'user:1'])
    assert.deepEqual(nodes.map(n => n.title), ['user', 'alpha', 'zeta'])
    assert.equal(nodes[1].keyName, 'alpha')
    assert.equal(nodes[1].children, undefined, '叶子不该带空 children 数组')
  })

  test('前缀键既是目录又是叶子（user:1 与 user:1:profile 同时存在）', async () => {
    const { buildRedisKeyTree } = await load()
    const { nodes } = buildRedisKeyTree(['user:1', 'user:1:profile', 'user:1:session'])
    const one = flat(nodes).find(x => x.key === 'user:1')
    assert.equal(one.keyName, 'user:1', '这个路径本身是真实键 → 可选中')
    const kid = nodes.find(n => n.title === 'user').children[0]
    assert.deepEqual(kid.children.map(c => c.title), ['profile', 'session'])
    assert.equal(kid.count, 3, '自身 + 两个子键')
  })

  test('SCAN 重复返回同一个键：去重，total 只算唯一键', async () => {
    const { buildRedisKeyTree } = await load()
    const { nodes, total } = buildRedisKeyTree(['a:1', 'a:1', 'b:2', 'a:1'])
    assert.equal(total, 2)
    assert.equal(flat(nodes).filter(x => x.key === 'a:1').length, 1)
    assert.equal(nodes.find(n => n.title === 'a').count, 1, '重复不能把计数灌水')
  })

  test('空段（a::b / :x / y:）不产生空标题节点', async () => {
    const { buildRedisKeyTree } = await load()
    const { nodes, total } = buildRedisKeyTree(['a::b', ':x', 'y:'])
    assert.equal(total, 3)
    assert.equal(keysOf(nodes).includes(''), false)
    assert.equal(flat(nodes).some(x => x.title === ''), false)
    // 每一层都要还能定位回原键
    assert.deepEqual(flat(nodes).filter(x => x.keyName).map(x => x.keyName).sort(),
      [':x', 'a::b', 'y:'])
  })

  test('整名都是分隔符的键（: / ::）当成一个顶层叶子，不丢键', async () => {
    const { buildRedisKeyTree } = await load()
    const { nodes, total } = buildRedisKeyTree([':', '::'])
    assert.equal(total, 2)
    assert.deepEqual(nodes.map(n => n.title), [':', '::'])
    assert.deepEqual(nodes.map(n => n.keyName), [':', '::'])
  })

  test('分隔符可配；空串/纯空白按"不分层"处理（不把键拆成单字）', async () => {
    const { buildRedisKeyTree } = await load()
    const slash = buildRedisKeyTree(['a/b/c'], { separator: '/' })
    assert.deepEqual(flat(slash.nodes).map(x => x.key), ['a', 'a/b', 'a/b/c'])
    for (const sep of ['', '   ']) {
      const r = buildRedisKeyTree(['a/b/c', 'user:1'], { separator: sep })
      assert.equal(r.nodes.length, 2, '分隔符「' + sep + '」不该分层')
      assert.deepEqual(r.nodes.map(n => n.title), ['a/b/c', 'user:1'])
      assert.equal(r.nodes[0].children, undefined)
    }
  })

  test('数字感知排序：user:2 在 user:10 前；同层目录排在叶子前', async () => {
    const { buildRedisKeyTree } = await load()
    const { nodes } = buildRedisKeyTree(['user:10', 'user:2', 'user:1'])
    const user = nodes.find(n => n.title === 'user')
    assert.deepEqual(user.children.map(c => c.title), ['1', '2', '10'])
    const mixed = buildRedisKeyTree(['k:deep', 'kz', 'k:other', 'ab'], {})
    assert.deepEqual(mixed.nodes.map(n => n.title), ['k', 'ab', 'kz'])
  })

  test('key 全树唯一（antd Tree 的 key 重复会直接报 React 警告）', async () => {
    const { buildRedisKeyTree } = await load()
    const { nodes } = buildRedisKeyTree(['a:b', 'a', 'a:b:c', 'b', 'a::b'])
    const ks = keysOf(nodes)
    assert.equal(new Set(ks).size, ks.length, '有重复 key：' + ks.join(','))
  })

  test('收 getPageData 的 { name } 行形状（前端不用先 map 一遍）', async () => {
    const { buildRedisKeyTree } = await load()
    const { nodes, total } = buildRedisKeyTree([{ name: 'user:1' }, { name: 'user:2' }, null, 42])
    assert.equal(total, 2)
    assert.equal(nodes.find(n => n.title === 'user').count, 2)
  })

  test('空输入 → 空树，total 0（不抛）', async () => {
    const { buildRedisKeyTree } = await load()
    for (const v of [[], null, undefined]) {
      const r = buildRedisKeyTree(v)
      assert.deepEqual(r.nodes, [])
      assert.equal(r.total, 0)
    }
  })

  test('1 万键（上限口径）能建出来且计数正确', async () => {
    const { buildRedisKeyTree } = await load()
    const names = Array.from({ length: 10000 }, (_, i) => 'ns' + (i % 50) + ':sub' + (i % 7) + ':k' + i)
    const t0 = Date.now()
    const { nodes, total } = buildRedisKeyTree(names)
    assert.equal(total, 10000)
    assert.equal(nodes.length, 50)
    assert.equal(nodes.reduce((s, n) => s + n.count, 0), 10000)
    // 建树本身不该成为卡顿来源（抓取循环另算）
    assert.ok(Date.now() - t0 < 2000, '建 1 万键树耗时 ' + (Date.now() - t0) + 'ms')
  })
})

describe('H7a-2 collectFolderKeys：默认展开', () => {
  test('默认只给第一层目录（上万键全展开会把 DOM 撑爆）', async () => {
    const { buildRedisKeyTree, collectFolderKeys } = await load()
    const { nodes } = buildRedisKeyTree(['a:b:c', 'a:d', 'e:f:g'])
    assert.deepEqual(collectFolderKeys(nodes), ['a', 'e'])
    assert.deepEqual(collectFolderKeys(nodes, 2), ['a', 'a:b', 'e', 'e:f'])
    assert.deepEqual(collectFolderKeys([]), [])
  })

  test('前缀键这种"既是目录又是叶子"的节点也算目录（要能展开看到子键）', async () => {
    const { buildRedisKeyTree, collectFolderKeys } = await load()
    const { nodes } = buildRedisKeyTree(['user:1', 'user:1:profile'])
    assert.deepEqual(collectFolderKeys(nodes), ['user'])
    assert.deepEqual(collectFolderKeys(nodes, 2), ['user', 'user:1'])
  })
})
