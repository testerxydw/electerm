// AI 面板「会话来源上下文」提示（P-4：只提示、不绑定）的契约。
//
// 钉住四件事：
// - 快照记的是递交时的现值，且缺哪项就少显示哪项（没选表是常态，不是错误）；
// - 来源取自"本会话最近一条带来源的条目"，按数组顺序而不是 timestamp；
// - 错位判定只会在"确实知道当前页签、且它不是来源页签"时报错——不知道当前页签时
//   把每条会话都说成错位，这条提示就废了；
// - 库.模式.表 的拼接不能漏出空段（MySQL 没有模式层、Redis 只有库号）。
const { describe, it, before } = require('node:test')
const assert = require('node:assert/strict')

let mod

before(async () => {
  mod = await import('../../../src/client/components/ai/ai-source-context.js')
})

const DICT = {
  aiSourceContext: '来源上下文'
}
const e = k => DICT[k] || k

const dbTab = { id: 't1', title: '[db]10.0.0.9', host: '10.0.0.9', dbType: 'mysql' }
const dbCtx = { dbType: 'mysql', database: 'shop', schema: '', table: 'orders' }

describe('buildDbAiSource：递交那一刻的只读快照', () => {
  it('带上页签、方言与库表', () => {
    const s = mod.buildDbAiSource(dbTab, dbCtx)
    assert.equal(s.kind, 'db')
    assert.equal(s.tabId, 't1')
    assert.equal(s.tabTitle, '[db]10.0.0.9')
    assert.equal(s.dialect, 'mysql')
    assert.equal(s.database, 'shop')
    assert.equal(s.table, 'orders')
  })

  it('ctx 里的方言缺省时回落到页签的 dbType', () => {
    assert.equal(mod.buildDbAiSource(dbTab, { database: 'shop' }).dialect, 'mysql')
    assert.equal(mod.buildDbAiSource(dbTab, { database: 'shop', dbType: 'pg' }).dialect, 'pg')
  })

  it('没选表也照样有来源（只有库）', () => {
    const s = mod.buildDbAiSource(dbTab, { dbType: 'mysql', database: 'shop' })
    assert.equal(s.table, '')
    assert.equal(mod.aiSourceScope(s), 'shop')
  })

  it('页签没有标题时用主机名顶上', () => {
    const s = mod.buildDbAiSource({ id: 't9', host: 'h9' }, {})
    assert.equal(s.tabTitle, 'h9')
  })

  it('认不出页签（没有 id）就不产出来源，而不是产出半条', () => {
    assert.equal(mod.buildDbAiSource(null, dbCtx), null)
    assert.equal(mod.buildDbAiSource({ title: 'x' }, dbCtx), null)
  })
})

describe('buildTermAiSource：终端侧只有页签本身', () => {
  it('标成 term，且不编造库表字段', () => {
    const s = mod.buildTermAiSource({ id: 't2', title: 'ssh web-1', host: 'web-1' })
    assert.equal(s.kind, 'term')
    assert.equal(s.tabId, 't2')
    assert.equal(mod.aiSourceScope(s), '')
  })

  it('同样拒绝认不出的页签', () => {
    assert.equal(mod.buildTermAiSource(undefined), null)
  })
})

describe('aiSourceScope：库.模式.表', () => {
  it('PG 三段都齐', () => {
    const s = mod.buildDbAiSource(dbTab, { dbType: 'pg', database: 'd', schema: 'public', table: 't' })
    assert.equal(mod.aiSourceScope(s), 'd.public.t')
  })

  it('没有模式时不留空段', () => {
    const s = mod.buildDbAiSource(dbTab, { database: 'd', schema: '', table: 't' })
    assert.equal(mod.aiSourceScope(s), 'd.t')
  })

  it('只有表（没展开到库）也不打头多个点', () => {
    const s = mod.buildDbAiSource(dbTab, { table: 't' })
    assert.equal(mod.aiSourceScope(s), 't')
  })
})

describe('latestAiSource：本会话最近一条带来源的条目', () => {
  const mk = (id, sid, source) => ({ id, chatSessionId: sid, source })

  it('按会话过滤，别的会话不算', () => {
    const history = [mk('a', 's1', { tabId: 't1' }), mk('b', 's2', { tabId: 't2' })]
    assert.equal(mod.latestAiSource(history, 's1').tabId, 't1')
  })

  it('取最后一条带来源的（后面的手输消息没有来源，不改写上下文）', () => {
    const history = [
      mk('a', 's1', { tabId: 't1' }),
      mk('b', 's1', undefined),
      mk('c', 's1', { tabId: 't9' }),
      mk('d', 's1', undefined)
    ]
    assert.equal(mod.latestAiSource(history, 's1').tabId, 't9')
  })

  it('整个会话都是手输 → 没有来源，界面就不该画这条提示', () => {
    const history = [mk('a', 's1', undefined), mk('b', 's1', undefined)]
    assert.equal(mod.latestAiSource(history, 's1'), null)
  })

  it('空会话 / 坏输入不抛', () => {
    assert.equal(mod.latestAiSource([], 's1'), null)
    assert.equal(mod.latestAiSource(null, 's1'), null)
    assert.equal(mod.latestAiSource([mk('a', 's1', { tabId: 't1' })], ''), null)
  })

  it('按数组顺序而不是 timestamp：时间戳乱序也认最后一条', () => {
    const history = [
      { id: 'a', chatSessionId: 's1', timestamp: 900, source: { tabId: 't1' } },
      { id: 'b', chatSessionId: 's1', timestamp: 100, source: { tabId: 't2' } }
    ]
    assert.equal(mod.latestAiSource(history, 's1').tabId, 't2')
  })
})

describe('isAiSourceStale：只在说得清的时候报错位', () => {
  const source = { tabId: 't1' }
  it('当前页签就是来源页签 → 不错位', () => {
    assert.equal(mod.isAiSourceStale(source, 't1'), false)
  })
  it('切到别的页签 → 错位', () => {
    assert.equal(mod.isAiSourceStale(source, 't2'), true)
  })
  it('不知道当前页签（没有活动页签）→ 不说错位', () => {
    assert.equal(mod.isAiSourceStale(source, ''), false)
    assert.equal(mod.isAiSourceStale(source, undefined), false)
  })
  it('本来就没有来源 → 不报错位', () => {
    assert.equal(mod.isAiSourceStale(null, 't2'), false)
  })
})

describe('formatAiSource：文案分段', () => {
  it('有库表时"页签 · 库.表"，并带方言', () => {
    const f = mod.formatAiSource(mod.buildDbAiSource(dbTab, dbCtx), e)
    assert.equal(f.title, '来源上下文')
    assert.equal(f.where, '[db]10.0.0.9 · shop.orders')
    assert.equal(f.dialect, 'mysql')
  })
  it('只有页签（终端来源）时不拼多余的分隔符，也不标方言', () => {
    const f = mod.formatAiSource(mod.buildTermAiSource({ id: 't2', title: 'ssh web-1' }), e)
    assert.equal(f.where, 'ssh web-1')
    assert.equal(f.dialect, '')
  })
  it('没有来源 → null（界面据此不渲染整条提示）', () => {
    assert.equal(mod.formatAiSource(null, e), null)
  })
})
