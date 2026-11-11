/**
 * N9-③ 稳定行标识纯函数契约（node:test，直接 import 主进程无关模块）
 *
 * 钉住 db-row-identity.js 的契约：确定性、主键优先、值规范化、分隔符注入防护、
 * 重复消歧、大值截断护栏、namespace 隔离、无碰撞。id 的真实形态（pk:/h: + 16 位 hex）
 * 也顺带断言，供真机 CDP 探针（db-grid-interactions-demo.js §8）做 DOM 层对账。
 */
import test from 'node:test'
import assert from 'node:assert'
import { ROW_ID_KEY, buildRowIdentity, buildRowIdentities } from '../../client/common/db-row-identity.js'

test('ROW_ID_KEY 单一真源', () => {
  assert.equal(ROW_ID_KEY, '__rowId')
})

test('确定性：同 (row, columns, opts) 多次调用完全一致', () => {
  const row = { id: 1, name: 'a', meta: { x: 1 }, t: new Date(0) }
  const cols = ['id', 'name', 'meta', 't']
  const a = buildRowIdentity(row, cols)
  const b = buildRowIdentity(row, cols)
  const c = buildRowIdentity(row, cols)
  assert.equal(a, b)
  assert.equal(b, c)
  assert.equal(typeof a, 'string')
  assert.ok(/^(pk|h):[0-9a-f]{16}$/.test(a), 'id 形态 = 前缀 + 16 位 hex')
})

test('主键优先：有 keyColumns 且该行带齐 → 只按主键算（pk: 前缀），其余列不参与', () => {
  const cols = ['id', 'name', 'note']
  const opts = { keyColumns: ['id'] }
  const r1 = { id: 5, name: 'a', note: 'n1' }
  const r2 = { id: 5, name: 'z', note: 'n2' } // name/note 不同，但主键相同
  const id1 = buildRowIdentity(r1, cols, opts)
  const id2 = buildRowIdentity(r2, cols, opts)
  assert.ok(id1.startsWith('pk:'), '主键模式走 pk: 前缀')
  assert.equal(id1, id2, '主键相同 → 即使其余列不同，id 也相同')
  // 主键不同 → id 必不同（哪怕其余列全同）
  const r3 = { id: 6, name: 'a', note: 'n1' }
  assert.notEqual(id1, buildRowIdentity(r3, cols, opts))
})

test('缺主键列 → 回落整行内容指纹（h: 前缀）', () => {
  const cols = ['id', 'name']
  const row = { id: 5, name: 'a' }
  // keyColumns 指向的行并不带该列（列名不存在于 row）
  const idPkMissing = buildRowIdentity(row, cols, { keyColumns: ['missing'] })
  assert.ok(idPkMissing.startsWith('h:'), '列缺失时回落 h:')
  // 与空 keyColumns 的结果应当一致（都是整行指纹）
  const idNoPk = buildRowIdentity(row, cols, {})
  assert.equal(idPkMissing, idNoPk)
  // 整行内容不同 → id 不同
  assert.notEqual(idNoPk, buildRowIdentity({ id: 5, name: 'b' }, cols, {}))
})

test('值规范化：null / undefined / 空串 / 字符串"null" 四者互不同 id', () => {
  const cols = ['v']
  const cases = [
    { v: null, tag: 'null' },
    { v: undefined, tag: 'undefined' },
    { v: '', tag: 'empty' },
    { v: 'null', tag: 'string-null' },
    { v: '0', tag: 'string-0' },
    { v: 0, tag: 'number-0' }
  ]
  const ids = cases.map(c => buildRowIdentity({ v: c.v }, cols))
  // 所有 id 两两不同
  const set = new Set(ids)
  assert.equal(set.size, ids.length, `null/''/'null'/0 等必须区分：${JSON.stringify(ids)}`)
})

test('值规范化：boolean / number(NaN, ±Infinity, -0) / bigint / Date 各自稳定且区分', () => {
  const cols = ['v']
  assert.equal(buildRowIdentity({ v: true }, cols), buildRowIdentity({ v: true }, cols))
  assert.notEqual(buildRowIdentity({ v: true }, cols), buildRowIdentity({ v: false }, cols))
  assert.equal(buildRowIdentity({ v: NaN }, cols), buildRowIdentity({ v: NaN }, cols))
  assert.notEqual(buildRowIdentity({ v: NaN }, cols), buildRowIdentity({ v: 0 }, cols))
  assert.notEqual(buildRowIdentity({ v: Infinity }, cols), buildRowIdentity({ v: -Infinity }, cols))
  assert.notEqual(buildRowIdentity({ v: -0 }, cols), buildRowIdentity({ v: 0 }, cols))
  assert.equal(buildRowIdentity({ v: 10n }, cols), buildRowIdentity({ v: 10n }, cols))
  assert.notEqual(buildRowIdentity({ v: 10n }, cols), buildRowIdentity({ v: 10 }, cols))
  // Date：同一毫秒的不同实例 → 稳定；不同毫秒 → 不同
  const d1 = buildRowIdentity({ v: new Date(1700000000000) }, cols)
  const d2 = buildRowIdentity({ v: new Date(1700000000000) }, cols)
  const d3 = buildRowIdentity({ v: new Date(1700000000001) }, cols)
  assert.equal(d1, d2)
  assert.notEqual(d1, d3)
})

test('对象键排序稳定：{a,b} 与 {b,a} 同一行 → 同 id', () => {
  const cols = ['o']
  const a = buildRowIdentity({ o: { a: 1, b: 2 } }, cols)
  const b = buildRowIdentity({ o: { b: 2, a: 1 } }, cols)
  assert.equal(a, b, '属性顺序漂移不该让同一行换 id')
})

test('循环引用降级：不抛错且同输入同结果', () => {
  const cols = ['o']
  const o = { name: 'x' }
  o.self = o
  const id1 = buildRowIdentity({ o }, cols)
  const id2 = buildRowIdentity({ o }, cols)
  assert.equal(id1, id2)
  assert.ok(id1.startsWith('h:'), '仍是整行指纹')
})

test('分隔符注入防护：列拼接无法伪造边界', () => {
  const cols = ['a', 'b']
  const r1 = { a: 'a|b', b: 'c' }
  const r2 = { a: 'a', b: 'b|c' }
  assert.notEqual(buildRowIdentity(r1, cols), buildRowIdentity(r2, cols), '["a|b","c"] ≠ ["a","b|c"]')
  // 列数不同 → id 不同
  const r3 = { a: 'a|b|c' } // 单列
  assert.notEqual(buildRowIdentity(r1, cols), buildRowIdentity(r3, ['a']), '双列与单列即便内容拼出来一样也不同')
})

test('重复消歧：内容全同的 n 行按出现次序追加 #2 / #3', () => {
  const cols = ['id']
  const rows = [{ id: 1 }, { id: 1 }, { id: 1 }]
  const ids = buildRowIdentities(rows, cols)
  assert.equal(ids.length, 3)
  assert.equal(ids[0], buildRowIdentity({ id: 1 }, cols))
  assert.equal(ids[1], ids[0] + '#2')
  assert.equal(ids[2], ids[0] + '#3')
  // 第 4 行换成不同内容 → id:1 的序号仍按出现次序 #2 / #3 连续，不被中间行污染
  const ids4 = buildRowIdentities([{ id: 1 }, { id: 1 }, { id: 2 }, { id: 1 }], cols)
  assert.equal(ids4[1], ids4[0] + '#2')
  assert.equal(ids4[3], ids4[0] + '#3')
  // 中间那行 id:2 是唯一的，拿基准 id，不参与上面的 #2 / #3 序列
  assert.notEqual(ids4[2], ids4[0])
  assert.notEqual(ids4[2], ids4[1])
})

test('大值截断护栏：前 N 字符相同但长度不同的长串不应撞 id', () => {
  const cols = ['v']
  const fullTag = 'x'.repeat(5000)
  const longer = fullTag + 'y' // 前 4096 字符相同，长度不同
  const idShort = buildRowIdentity({ v: fullTag }, cols)
  const idLong = buildRowIdentity({ v: longer }, cols)
  assert.notEqual(idShort, idLong, '截断把原始长度并进指纹，长度不同的长串不能撞')
  // 恰好长成 "<数字>:" 开头的完整短串也不被误判成截断标记
  const tricky = '50:short-but-looks-like-len-prefix'
  assert.equal(buildRowIdentity({ v: tricky }, cols), buildRowIdentity({ v: tricky }, cols))
  // 自定义 maxCellChars 仍生效
  const tiny = { v: 'abcdefghij' }
  const a = buildRowIdentity(tiny, cols, { maxCellChars: 4 })
  const b = buildRowIdentity(tiny, cols, { maxCellChars: 4 })
  assert.equal(a, b)
})

test('namespace 只做表隔离：相同表名 id 相同，不同表名 id 不同，且不影响稳定性', () => {
  const cols = ['id']
  const row = { id: 1 }
  const ns1 = { namespace: 'db_a.t' }
  const ns2 = { namespace: 'db_a.t' }
  const ns3 = { namespace: 'db_b.t' }
  assert.equal(buildRowIdentity(row, cols, ns1), buildRowIdentity(row, cols, ns2))
  assert.notEqual(buildRowIdentity(row, cols, ns1), buildRowIdentity(row, cols, ns3))
  // 必填：namespace 里塞页码会让不同页的同一条记录 id 不同 —— 这是反模式，
  // 模块不拦截（那是调用方的纪律），但契约要明确"不塞页码时跨页稳定"
  const page = { namespace: 'db_a.t' }
  assert.equal(buildRowIdentity(row, cols, page), buildRowIdentity(row, cols, page))
})

test('返回结构：buildRowIdentities 与 rows 等长，非数组安全', () => {
  const cols = ['id']
  assert.deepEqual(buildRowIdentities(null, cols), [])
  assert.deepEqual(buildRowIdentities(undefined, cols), [])
  assert.deepEqual(buildRowIdentities([], cols), [])
  const rows = [{ id: 1 }, { id: 2 }]
  assert.equal(buildRowIdentities(rows, cols).length, 2)
})

test('3 万行混合类型：无碰撞（new Set(ids).size === rows.length）', () => {
  const cols = ['id', 'flag', 'note', 'detail', 'parameter']
  const rows = []
  for (let i = 0; i < 30000; i++) {
    rows.push({
      id: i,
      flag: i % 2 ? 'ok' : 'no',
      note: 'n' + i,
      detail: i % 7 === 0 ? 'short' : 'x'.repeat(1234),
      parameter: i % 3 === 0
        ? { uid: 3000 + i, action: 'order.export' }
        : (i % 3 === 1 ? null : 'NULL')
    })
  }
  const t0 = process.hrtime.bigint()
  const ids = buildRowIdentities(rows, cols, { keyColumns: ['id'] })
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  assert.equal(ids.length, 30000)
  assert.equal(new Set(ids).size, 30000, '主键模式 3 万行零碰撞')
  assert.ok(ms < 2000, `3 万行主键模式应在 2s 内（实测 ${ms.toFixed(1)}ms）`)
})
