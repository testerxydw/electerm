/**
 * N10a 语义层数据词典纯函数单测：parse/serialize roundtrip + storage 读写。
 * db-ai-dictionary.js 零 React 依赖，可直接 import。
 */

const test = require('node:test')
const assert = require('node:assert')

let dict

test.before(async () => {
  dict = await import('../../client/common/db-ai-dictionary.js')
})

function fakeStorage () {
  const m = new Map()
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v))
  }
}

test('parseDictionaryText: 基本解析 term = meaning', () => {
  assert.deepEqual(
    dict.parseDictionaryText('user = 用户表\norder = 订单表'),
    [{ term: 'user', meaning: '用户表' }, { term: 'order', meaning: '订单表' }]
  )
})

test('parseDictionaryText: = 只按首次出现分隔（含义里可以再有 =）', () => {
  const r = dict.parseDictionaryText('expr = a = b = c')
  assert.deepEqual(r, [{ term: 'expr', meaning: 'a = b = c' }])
})

test('parseDictionaryText: 空行/# 注释/无 = 行/半截行全部跳过', () => {
  const r = dict.parseDictionaryText([
    '',
    '# 这是注释',
    'not-a-pair',
    '=no-term',
    'no-meaning =',
    '  ok = fine  ',
    '   '
  ].join('\n'))
  assert.deepEqual(r, [{ term: 'ok', meaning: 'fine' }])
})

test('parseDictionaryText: 空输入返回空数组', () => {
  assert.deepEqual(dict.parseDictionaryText(''), [])
  assert.deepEqual(dict.parseDictionaryText(null), [])
})

test('serialize ↔ parse roundtrip', () => {
  const entries = [
    { term: 'user:session', meaning: '用户会话缓存，TTL 30min' },
    { term: 'amt', meaning: '金额（分）' }
  ]
  const text = dict.serializeDictionary(entries)
  assert.deepEqual(dict.parseDictionaryText(text), entries)
})

test('serializeDictionary: 空数组/null → 空串', () => {
  assert.equal(dict.serializeDictionary([]), '')
  assert.equal(dict.serializeDictionary(null), '')
})

test('load/save: 按 bookmarkId 隔离，无 id 直接返回空串', () => {
  const st = fakeStorage()
  dict.saveDictionaryText('bm1', 'user = 用户表', st)
  assert.equal(dict.loadDictionaryText('bm1', st), 'user = 用户表')
  assert.equal(dict.loadDictionaryText('bm2', st), '')
  assert.equal(dict.loadDictionaryText('', st), '')
})

test('load/save: 无 storage（node 默认）静默，不抛错', () => {
  // 当前进程没有 localStorage → 走 guard 分支
  assert.equal(typeof dict.loadDictionaryText('bmX'), 'string')
  dict.saveDictionaryText('bmX', 'a = b')
})

test('常量上限存在且有界', () => {
  assert.ok(dict.MAX_DICT_ITEMS >= 1)
  assert.ok(dict.MAX_DICT_MEANING_CHARS > 0)
})
