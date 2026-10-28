/**
 * B3-2/B3-3 纯计算层单测：批量同列改值 / 查找替换的"算哪些行"逻辑。
 * 不依赖 DOM/IPC，只测 src/client/common/db-grid-replace.js 的纯函数。
 */
import assert from 'assert'
import { test } from 'node:test'
import {
  planSameValue,
  planReplace,
  replaceText,
  escapeRegExp,
  sameCellValue,
  usableKey,
  previewKeyList
} from '../../client/common/db-grid-replace.js'

const rows = (vals) => vals.map((v, i) => ({ id: i + 1, name: v }))

test('planSameValue：只挑出值变了且有主键的行', () => {
  const r = rows(['a', 'b', 'a', null, 'a'])
  const plan = planSameValue(r, { column: 'name', pkColumn: 'id', value: 'a' })
  // 第 2、4 行当前不是 'a'；第 1/3/5 已等于目标 → 不计更新
  assert.strictEqual(plan.updates.length, 2)
  assert.deepStrictEqual(plan.updates.map(u => u.pk).sort(), [2, 4])
  assert.strictEqual(plan.unchanged, 3)
  assert.strictEqual(plan.noKey, 0)
})

test('planSameValue：NULL 新值可规划（NULL 与空串不同）', () => {
  const r = rows(['a', ''])
  const plan = planSameValue(r, { column: 'name', pkColumn: 'id', value: null })
  assert.strictEqual(plan.updates.length, 2)
  assert.strictEqual(plan.updates[0].value, null)
})

test('planSameValue：缺主键的行计入 noKey 不发更新', () => {
  const r = [{ id: 1, name: 'x' }, { name: 'x' }, { id: '', name: 'x' }]
  const plan = planSameValue(r, { column: 'name', pkColumn: 'id', value: 'y' })
  assert.strictEqual(plan.updates.length, 1)
  assert.strictEqual(plan.noKey, 2)
})

test('replaceText：区分大小写为默认（matchCase 不传）', () => {
  assert.strictEqual(replaceText('Ana and ana', 'ana', 'X'), 'Ana and X')
})

test('replaceText：整格匹配只对整格等于查找串的生效', () => {
  assert.strictEqual(
    replaceText('banana', 'ana', 'X', { wholeCell: true }),
    'banana'
  )
  assert.strictEqual(
    replaceText('ana', 'ana', 'X', { wholeCell: true }),
    'X'
  )
})

test('replaceText：不区分大小写 + 转义查找串里的正则元字符', () => {
  assert.strictEqual(
    replaceText('a.b and aXb', 'a.b', 'Z', { matchCase: false }),
    'Z and aXb'
  )
})

test('replaceText：替换串里的 $& 不被当成正则反向引用', () => {
  assert.strictEqual(replaceText('ababa', 'aba', '$&!', { matchCase: true }), '$&!ba')
})

test('replaceText：非字符串单元格原样返回（不替用户改写数值列）', () => {
  assert.strictEqual(replaceText(123, '1', '9', {}), 123)
  assert.strictEqual(replaceText(null, '1', '9', {}), null)
  assert.strictEqual(replaceText('', '1', '9', {}), '')
})

test('planReplace：统计匹配数 / 跳过非字符串 / 丢弃缺主键', () => {
  const r = [
    { id: 1, name: 'banana' },
    { id: 2, name: 'anaconda' },
    { id: 3, name: 123 }, // 数值列不参与替换
    { id: 4, name: 'manager' },
    { name: 'anaconda2' } // 无主键：命中但无法定位，计入 noKey
  ]
  const plan = planReplace(r, {
    column: 'name', pkColumn: 'id', find: 'ana', replace: 'ANA', matchCase: false
  })
  // 1/2/4/5 四个字符串单元格命中 'ana'（anaconda / manager / anaconda2）
  assert.strictEqual(plan.matched, 4)
  assert.strictEqual(plan.noKey, 1) // anaconda2 无主键
  assert.strictEqual(plan.updates.length, 3)
  // 第 4 行 'manager' → 'mANAger'（不区分大小写时子串也命中）
  const mgr = plan.updates.find(u => u.pk === 4)
  assert.strictEqual(mgr.value, 'mANAger')
})

test('planReplace：空查找串不发任何更新', () => {
  const plan = planReplace(rows(['a', 'b']), { column: 'name', pkColumn: 'id', find: '' })
  assert.strictEqual(plan.updates.length, 0)
  assert.strictEqual(plan.matched, 0)
})

test('escapeRegExp / sameCellValue / usableKey / previewKeyList 辅助', () => {
  assert.strictEqual(escapeRegExp('a.b*c'), 'a\\.b\\*c')
  assert.strictEqual(sameCellValue('12.50', '12.5'), true) // 文本相等，跨类型
  assert.strictEqual(sameCellValue('a', 'b'), false)
  assert.strictEqual(usableKey(''), false)
  assert.strictEqual(usableKey(null), false)
  assert.strictEqual(usableKey(0), true)
  assert.strictEqual(
    previewKeyList([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 10).endsWith(', …'),
    true
  )
})
