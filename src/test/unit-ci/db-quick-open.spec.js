// E2 命令面板纯函数层：打分 / 稳定排序 / 截断 / 分组
// （设计 doc/设计-数据库阶段4-增量批次-2026-10-23.md §7.5 附带项）
//
// 为什么用 vm 跑 src 下的同一份源码（与 db-grid-view.spec.js 同样做法）：
// - 源码是 ESM（export），CJS 测试进程里 require 吃不下；
// - 更关键的是**不许出现"测试拷贝"**：打分口径一旦在实现与测试之间漂移，
//   测试就变成自证（实现怎么写都能过）。
//
// 沙箱只给 Array：实现里唯一的全局引用是 Array.isArray，其余全是
// 原型方法（startsWith / includes / slice / sort）和 typeof 运算符。
// 少给不是抠门 —— 多给的全局会替实现瞒下"在测试环境里恰好存在"的依赖。
//
// 断言里的 plain()：vm 里造出来的数组/对象属于另一个 realm，原型链不是
// 宿主的那几个，node:assert 的 strict deepEqual 会连原型一起比。序列化
// 一次把值搬回宿主 realm，断言失败信息也跟着变得好读。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const QO = path.join(ROOT, 'src/client/common/db-quick-open.js')

const QO_EXPORTS = '({ scoreItem, rankItems, groupItems, isSubsequence, ' +
  'QUICK_OPEN_LIMIT, GROUP_ORDER })'

function loadFrom (file, exportsExpr) {
  const src = fs.readFileSync(file, 'utf8').replace(/^export /gm, '')
  const sandbox = { Array }
  vm.createContext(sandbox)
  return vm.runInContext(src + '\n' + exportsExpr, sandbox, { filename: 'db-quick-open.js' })
}

const {
  scoreItem,
  rankItems,
  groupItems,
  isSubsequence,
  QUICK_OPEN_LIMIT,
  GROUP_ORDER
} = loadFrom(QO, QO_EXPORTS)

// 值搬回宿主 realm，便于 strict deepEqual
const plain = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

// 测试专用 item 工厂：id 缺省等于 title，断言时好认
const mk = (kind, title) => ({ kind, id: title, title, subtitle: '', hint: '', run: () => {} })

describe('db-quick-open: 契约常量', () => {
  test('QUICK_OPEN_LIMIT = 30（全局上限，不是每组各 30）', () => {
    assert.equal(QUICK_OPEN_LIMIT, 30)
  })

  test('GROUP_ORDER = 动作→对象→历史（空 query 默认清单的顺序）', () => {
    assert.deepEqual(plain(GROUP_ORDER), ['action', 'object', 'history'])
  })
})

describe('db-quick-open: scoreItem 三档匹配分 × 类型权重', () => {
  test('前缀 100 / 子串 60 / 子序列 30，各加类型权重（精确值）', () => {
    // [title, query, 期望匹配分]
    const matches = [
      ['Select', 'sel', 100], // 前缀
      ['xSelect', 'sel', 60], // 子串（非前缀）
      ['s e l e c t', 'sel', 30], // 子序列（字符按序出现，不连续）
      ['Select', 'xyz', 0] // 三档都不中
    ]
    const weights = { action: 20, object: 10, history: 5 }
    for (const [title, query, match] of matches) {
      for (const [kind, weight] of Object.entries(weights)) {
        const want = match === 0 ? 0 : match + weight
        assert.equal(scoreItem(mk(kind, title), query), want, `${kind} ${title} ~ ${query}`)
      }
    }
  })

  test('匹配用 trim 后的 title：首尾空白不影响前缀判定', () => {
    // 不 trim 的话 '  Select  ' 搜 'sel' 会掉到子串档（60+20=80）；
    // 用户看到的标题没有那圈空白，理应算前缀命中。
    assert.equal(scoreItem(mk('action', '  Select  '), 'sel'), 120)
  })

  test('空 query：分数 = 类型权重，不淘汰任何 item', () => {
    assert.equal(scoreItem(mk('action', 'Run'), ''), 20)
    assert.equal(scoreItem(mk('object', 'users'), '   '), 10)
    // query 非字符串按空 query 处理（面板刚打开、输入框还没值的形态）
    assert.equal(scoreItem(mk('history', 'SELECT 1'), undefined), 5)
    assert.equal(scoreItem(mk('history', 'SELECT 1'), null), 5)
  })

  test('匹配分 0 时总分为 0：权重再高也不留', () => {
    // "不匹配却排前面"比"少了几个结果"更难排查
    assert.equal(scoreItem(mk('action', 'zzz'), 'sel'), 0)
  })

  test('脏 item 一律 0：非对象 / title 非字符串 / title 空白', () => {
    assert.equal(scoreItem(null, 'sel'), 0)
    assert.equal(scoreItem('Run', 'sel'), 0)
    assert.equal(scoreItem(42, 'sel'), 0)
    assert.equal(scoreItem(undefined, 'sel'), 0)
    assert.equal(scoreItem({ kind: 'action' }, 'sel'), 0)
    assert.equal(scoreItem({ kind: 'action', title: 5 }, 'sel'), 0)
    assert.equal(scoreItem({ kind: 'action', title: null }, 'sel'), 0)
    assert.equal(scoreItem({ kind: 'action', title: '   ' }, 'sel'), 0)
    // 空 query 下同口径：没有 title 的行画不出来（与 rankItems 一致）
    assert.equal(scoreItem({ kind: 'action', title: '' }, ''), 0)
  })

  test('未知 kind 按权重 0 计分（rankItems 会直接剔除，见脏数据组）', () => {
    assert.equal(scoreItem({ kind: 'weird', title: 'Run' }, 'run'), 100)
    assert.equal(scoreItem({ kind: 'weird', title: 'Run' }, ''), 0)
  })
})

describe('db-quick-open: rankItems 剔除与截断', () => {
  test('不匹配的 item 被剔除（0 分不进结果）', () => {
    const items = [mk('action', 'Run'), mk('object', 'users'), mk('history', 'SELECT 1')]
    assert.deepEqual(plain(rankItems(items, 'zzz')), [])
  })

  test('截断到 QUICK_OPEN_LIMIT：35 个同分 item 只留前 30 且保持输入序', () => {
    const items = Array.from({ length: 35 }, (_, i) =>
      mk('action', `cmd ${String(i).padStart(2, '0')}`))
    const r = rankItems(items, 'cmd')
    assert.equal(r.length, 30)
    assert.deepEqual(plain(r.map(x => x.item.title)), items.slice(0, 30).map(x => x.title))
  })

  test('截断发生在排序后：低分铺满前 30 也不挡高分存活', () => {
    // 30 个历史子串命中（60+5=65）铺满额度，再加 1 个前缀命中（100+5=105）。
    // filler 用 xsub 前缀：'xsub 0' 含 'sub' 但不以 'sub' 开头，
    // 否则它自己也是前缀命中，铺不满"低分"这个前提。
    const filler = Array.from({ length: 30 }, (_, i) => mk('history', `xsub ${i}`))
    const star = mk('history', 'subway')
    const r = rankItems([...filler, star], 'sub')
    assert.equal(r.length, 30)
    // 前缀命中的排第一，且挤掉的是输入链末尾的那个低分项
    assert.equal(r[0].item, star)
    assert.equal(r[0].score, 105)
    assert.equal(r[29].item, filler[28])
    assert.ok(!r.some(x => x.item === filler[29]), '先截后排会把 star 挤掉')
  })

  test('返回 { item, score } 且 item 是原引用（UI 要直接调 item.run）', () => {
    const it = mk('action', 'Run')
    const r = rankItems([it], 'run')
    assert.equal(r.length, 1)
    assert.equal(r[0].item, it, '复制对象会让 run 闭包和选中态对不上')
    assert.equal(r[0].score, 120)
  })
})

describe('db-quick-open: 稳定排序', () => {
  test('>10 个同分 item：输入顺序不变（V8 快排的暗坑）', () => {
    // 同分比较器返回 0 时，顺序取决于引擎排序算法实现；装饰原始下标后
    // "稳定"是比较函数自身的性质，与数组长度无关。15 > 10 是敏感长度。
    const items = Array.from({ length: 15 }, (_, i) => mk('object', `same ${i}`))
    const r = rankItems(items, 'same')
    assert.deepEqual(plain(r.map(x => x.item.title)), items.map(x => x.title))
  })

  test('同分跨输入位置混合：先来的排前面（分数相同不插队）', () => {
    // 四个 title 都含 '1'：a1/b1 是动作（子串 60+20=80），x1/y1 是历史
    // （子串 60+5=65）。两对同分，各对内部按输入位置定序。
    const items = [
      mk('history', 'x1'), // 65，输入位 0
      mk('action', 'a1'), // 80，输入位 1
      mk('history', 'y1'), // 65，输入位 2
      mk('action', 'b1') // 80，输入位 3
    ]
    const r = rankItems(items, '1')
    assert.deepEqual(plain(r.map(x => [x.item.title, x.score])), [
      ['a1', 80], ['b1', 80], ['x1', 65], ['y1', 65]
    ])
  })

  test('全局排序跨组：对象子串(70) 压过动作子序列(50)，分组不改全局序', () => {
    const items = [
      mk('action', 'sXeXlXeXcXt'), // 子序列 30+20=50
      mk('object', 'my select') // 子串 60+10=70
    ]
    const r = rankItems(items, 'sel')
    assert.deepEqual(plain(r.map(x => [x.item.kind, x.score])), [
      ['object', 70], ['action', 50]
    ])
    const g = groupItems(r)
    assert.equal(g.object[0].item, items[1])
    assert.equal(g.action[0].item, items[0])
  })
})

describe('db-quick-open: 空 query 默认清单', () => {
  test('空 query 全保留，按权重排序：动作 → 对象 → 历史', () => {
    const items = [
      mk('history', 'SELECT 1'),
      mk('object', 'users'),
      mk('action', 'Run'),
      mk('action', 'Format'),
      mk('object', 'orders')
    ]
    const r = rankItems(items, '   ')
    assert.deepEqual(plain(r.map(x => [x.item.kind, x.score])), [
      ['action', 20], ['action', 20],
      ['object', 10], ['object', 10],
      ['history', 5]
    ])
    // 组内保持输入顺序：Run 在 Format 前（调用方保证动作表顺序 = 菜单顺序）
    assert.deepEqual(plain(r.map(x => x.item.title)),
      ['Run', 'Format', 'users', 'orders', 'SELECT 1'])
  })

  test('空 query 分组：三个 key 恒在，组内即全局序在该组的投影', () => {
    const items = [
      mk('history', 'h1'),
      mk('action', 'a1'),
      mk('object', 'o1'),
      mk('action', 'a2')
    ]
    const g = groupItems(rankItems(items, ''))
    assert.deepEqual(Object.keys(g), plain(GROUP_ORDER))
    assert.deepEqual(plain(g.action.map(x => x.item.title)), ['a1', 'a2'])
    assert.deepEqual(plain(g.object.map(x => x.item.title)), ['o1'])
    assert.deepEqual(plain(g.history.map(x => x.item.title)), ['h1'])
  })
})

describe('db-quick-open: groupItems', () => {
  test('空输入也有三个 key（缺 key 在 UI 里就是白屏）', () => {
    const want = { action: [], object: [], history: [] }
    assert.deepEqual(Object.keys(groupItems([])), plain(GROUP_ORDER))
    assert.deepEqual(plain(groupItems([])), want)
    assert.deepEqual(plain(groupItems(undefined)), want)
    assert.deepEqual(plain(groupItems(null)), want)
  })

  test('只有动作时 object/history 仍是空数组，不是 undefined', () => {
    const g = groupItems(rankItems([mk('action', 'Run')], 'run'))
    assert.deepEqual(plain(g), {
      action: [{ item: plain(mk('action', 'Run')), score: 120 }],
      object: [],
      history: []
    })
  })

  test('脏 ranked 元素被跳过，不抛', () => {
    const g = groupItems([
      null,
      'x',
      42,
      { item: null },
      { item: 'nope' },
      { item: { kind: 'weird', title: 't' } },
      { item: mk('action', 'Run') }
    ])
    assert.equal(g.action.length, 1)
    assert.equal(g.object.length, 0)
    assert.equal(g.history.length, 0)
  })
})

describe('db-quick-open: query trim 与大小写', () => {
  test('首尾空格不算匹配失败理由，内部空格是普通字符', () => {
    // '  sel  ' 按 'sel' 匹配（trim 只去首尾）
    assert.equal(scoreItem(mk('action', 'Select'), '  sel  '), 120)
    // 内部空格必须真的出现在 title 里：'select table' 只有一个空格
    assert.equal(scoreItem(mk('action', 'Select Table'), 'sel tab'), 50) // 子序列 30+20
    assert.equal(scoreItem(mk('action', 'Select Table'), 'sel  tab'), 0) // 两个空格 → 不中
  })

  test('大小写不敏感：query / title 任意大小写都命中', () => {
    assert.equal(scoreItem(mk('action', 'SELECT'), 'sel'), 120)
    assert.equal(scoreItem(mk('action', 'select'), 'SEL'), 120)
    assert.equal(scoreItem(mk('object', 'Users'), 'USER'), 110)
  })
})

describe('db-quick-open: 只匹配 title', () => {
  test('subtitle / hint 不参与匹配：搜 "public.users" 不冒幽灵结果', () => {
    const ghost = { kind: 'object', title: 'zzz', subtitle: 'public.users', hint: 'sel' }
    const real = mk('object', 'public.users')
    assert.equal(scoreItem(ghost, 'public.users'), 0)
    assert.equal(scoreItem(ghost, 'sel'), 0)
    assert.equal(scoreItem(ghost, 'users'), 0)
    const r = rankItems([ghost, real], 'public')
    assert.equal(r.length, 1)
    assert.equal(r[0].item, real)
    // 完整点名搜法同理：subtitle 里的 "public.users" 救不了标题 "zzz"
    const r2 = rankItems([ghost, real], 'public.users')
    assert.equal(r2.length, 1)
    assert.equal(r2[0].item, real)
  })
})

describe('db-quick-open: isSubsequence', () => {
  test('按顺序即可，不必连续；乱序不中', () => {
    assert.equal(isSubsequence('abc', 'a b c'), true)
    assert.equal(isSubsequence('abc', 'abc'), true)
    assert.equal(isSubsequence('abc', 'cba'), false)
    assert.equal(isSubsequence('abcd', 'abc'), false, 'query 更长不中')
  })

  test('大小写不敏感', () => {
    assert.equal(isSubsequence('ABC', 'xaybzc'), true)
  })

  test('空 query 是任意字符串的子序列（vacuously true）', () => {
    assert.equal(isSubsequence('', 'anything'), true)
    // 但 rankItems 不走这条路：空 query 直接给权重分
    assert.equal(scoreItem(mk('action', 'Run'), ''), 20)
  })

  test('非字符串入参返回 false：脏 query 不该"匹配一切"', () => {
    assert.equal(isSubsequence(null, 'abc'), false)
    assert.equal(isSubsequence(undefined, 'abc'), false)
    assert.equal(isSubsequence(123, 'a1b2c3'), false)
    assert.equal(isSubsequence('abc', null), false)
  })
})

describe('db-quick-open: 脏数据容错', () => {
  test('items 非数组 → 空结果，不抛', () => {
    assert.deepEqual(plain(rankItems(null, 'sel')), [])
    assert.deepEqual(plain(rankItems(undefined, 'sel')), [])
    assert.deepEqual(plain(rankItems('nope', 'sel')), [])
    assert.deepEqual(plain(rankItems(42, 'sel')), [])
    assert.deepEqual(plain(rankItems({}, 'sel')), [])
  })

  test('脏元素逐个跳过：null / 字符串 / 数字 / 缺 title / 空白 title', () => {
    const items = [
      null,
      'Run',
      42,
      undefined,
      { kind: 'action' },
      { kind: 'action', title: 5 },
      { kind: 'action', title: '   ' },
      mk('action', 'Run')
    ]
    const r = rankItems(items, 'run')
    assert.equal(r.length, 1)
    assert.equal(r[0].item, items[7])
  })

  test('title 不可渲染的 item 在空 query 下也剔除（两个 query 一副面孔）', () => {
    // 空 query 保留它们会让用户清空输入框的一瞬间多出几行空白幽灵
    const items = [
      mk('action', 'Run'),
      { kind: 'action', title: '' },
      { kind: 'action', title: '  ' },
      { kind: 'object' },
      { kind: 'object', title: 7 }
    ]
    const r = rankItems(items, '')
    assert.equal(r.length, 1)
    assert.equal(r[0].item, items[0])
  })

  test('未知 kind：scoreItem 给匹配分，rankItems 当脏数据剔除', () => {
    // 分组表只有三个 key，排进来也会在 groupItems 时凭空蒸发 ——
    // "排了但看不见"比当场跳过更难查
    const r = rankItems([{ kind: 'weird', title: 'Run' }], 'run')
    assert.deepEqual(plain(r), [])
  })
})
