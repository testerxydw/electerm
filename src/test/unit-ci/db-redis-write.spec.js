/**
 * D 批：Redis 类型化写前端接口层（db-redis-write.js）纯函数单测
 *
 * buildWriteArgs 是"UI 输入 → IPC 参数"的唯一组装点，测它 = 测 10 个 op 的参数形状；
 * redisWrite 的刷新纪律（成功/失败都 refresh）依赖 window.pre / 组件闭包，
 * 不在 node 环境跑（组件联调由 QA 冒烟覆盖），这里只钉纯部分。
 *
 * 加载方式对齐 db-sql-complete.spec：strip `export ` 后 vm 跑真实源码。
 * 断言前把 vm-realm 对象 JSON 搬回宿主 realm（跨 realm deepEqual 按引用比较会炸）。
 */
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const SRC = path.join(ROOT, 'src/client/common/db-redis-write.js')

function load () {
  const src = fs.readFileSync(SRC, 'utf8').replace(/^export /gm, '')
  const sandbox = { window: undefined }
  vm.createContext(sandbox)
  return vm.runInContext(
    `(function () { ${src}; return { buildWriteArgs } })()`,
    sandbox
  )
}

const { buildWriteArgs } = load()
const plain = o => JSON.parse(JSON.stringify(o))

describe('D 批：db-redis-write 参数组装（buildWriteArgs）', () => {
  test('hashSetField：dbIndex 强转数字、field/value 归一为字符串', () => {
    assert.deepEqual(
      plain(buildWriteArgs('hashSetField', { dbIndex: '2', key: 'h', field: 'f', value: 'v' })),
      { dbIndex: 2, key: 'h', field: 'f', value: 'v' }
    )
    assert.deepEqual(
      plain(buildWriteArgs('hashSetField', { dbIndex: 0, key: 'h', field: 'f', value: null })),
      { dbIndex: 0, key: 'h', field: 'f', value: '' }
    )
    assert.deepEqual(
      plain(buildWriteArgs('hashSetField', { dbIndex: 0, key: 'h', field: 'f', value: 123 })),
      { dbIndex: 0, key: 'h', field: 'f', value: '123' }
    )
  })

  test('hashDelField：数组透传、字符串归一单元素、空值归一空数组（后端拒绝空）', () => {
    assert.deepEqual(
      plain(buildWriteArgs('hashDelField', { dbIndex: 0, key: 'h', fields: ['a', 'b'] })),
      { dbIndex: 0, key: 'h', fields: ['a', 'b'] }
    )
    assert.deepEqual(
      plain(buildWriteArgs('hashDelField', { dbIndex: 0, key: 'h', fields: 'a' })),
      { dbIndex: 0, key: 'h', fields: ['a'] }
    )
    assert.deepEqual(
      plain(buildWriteArgs('hashDelField', { dbIndex: 0, key: 'h', fields: [] })),
      { dbIndex: 0, key: 'h', fields: [] }
    )
    assert.deepEqual(
      plain(buildWriteArgs('hashDelField', { dbIndex: 0, key: 'h', fields: ['', 'a', 3] })),
      { dbIndex: 0, key: 'h', fields: ['a', '3'] }
    )
  })

  test('setAdd/setRem/zsetRem：members 统一归一', () => {
    for (const op of ['setAdd', 'setRem', 'zsetRem']) {
      assert.deepEqual(
        plain(buildWriteArgs(op, { dbIndex: 1, key: 's', members: 'm' })),
        { dbIndex: 1, key: 's', members: ['m'] },
        op
      )
      assert.deepEqual(
        plain(buildWriteArgs(op, { dbIndex: 1, key: 's', members: [] })),
        { dbIndex: 1, key: 's', members: [] },
        op
      )
    }
  })

  test('zsetAdd：score Number 强转（数字字符串 OK，非有限数交给后端抛错）', () => {
    assert.deepEqual(
      plain(buildWriteArgs('zsetAdd', { dbIndex: 0, key: 'z', score: '1.5', member: 'a' })),
      { dbIndex: 0, key: 'z', score: 1.5, member: 'a' }
    )
    // NaN 经 JSON 序列化会变 null，这里直取原值断言（NaN 是原始值，跨 realm 安全）
    const raw = buildWriteArgs('zsetAdd', { dbIndex: 0, key: 'z', score: 'abc', member: 'a' })
    assert.deepEqual({ ...plain(raw), score: raw.score }, { dbIndex: 0, key: 'z', score: NaN, member: 'a' })
  })

  test('listPush：position 原样透传（left/right 校验在后端）', () => {
    assert.deepEqual(
      plain(buildWriteArgs('listPush', { dbIndex: 0, key: 'l', value: 'v', position: 'left' })),
      { dbIndex: 0, key: 'l', value: 'v', position: 'left' }
    )
    assert.deepEqual(
      plain(buildWriteArgs('listPush', { dbIndex: 0, key: 'l', value: undefined, position: 'right' })),
      { dbIndex: 0, key: 'l', value: '', position: 'right' }
    )
  })

  test('listSetAt：index 强转数字', () => {
    assert.deepEqual(
      plain(buildWriteArgs('listSetAt', { dbIndex: 0, key: 'l', index: '3', value: 'v' })),
      { dbIndex: 0, key: 'l', index: 3, value: 'v' }
    )
    assert.deepEqual(
      plain(buildWriteArgs('listSetAt', { dbIndex: 0, key: 'l', index: -1, value: null })),
      { dbIndex: 0, key: 'l', index: -1, value: '' }
    )
  })

  test('listRemAt：count 缺省 1、显式 0（全删）透传', () => {
    assert.deepEqual(
      plain(buildWriteArgs('listRemAt', { dbIndex: 0, key: 'l', index: 'v' })),
      { dbIndex: 0, key: 'l', index: 'v', count: 1 }
    )
    assert.deepEqual(
      plain(buildWriteArgs('listRemAt', { dbIndex: 0, key: 'l', index: 'v', count: 0 })),
      { dbIndex: 0, key: 'l', index: 'v', count: 0 }
    )
    assert.deepEqual(
      plain(buildWriteArgs('listRemAt', { dbIndex: 0, key: 'l', index: 'v', count: '2' })),
      { dbIndex: 0, key: 'l', index: 'v', count: 2 }
    )
  })

  test('renameKeyNx：newKey 归一字符串', () => {
    assert.deepEqual(
      plain(buildWriteArgs('renameKeyNx', { dbIndex: 0, key: 'a', newKey: 'b' })),
      { dbIndex: 0, key: 'a', newKey: 'b' }
    )
    assert.deepEqual(
      plain(buildWriteArgs('renameKeyNx', { dbIndex: 0, key: 'a', newKey: 99 })),
      { dbIndex: 0, key: 'a', newKey: '99' }
    )
  })

  test('dbIndex 缺省 0、key 强转字符串（形状兜底，语义校验在后端）', () => {
    assert.deepEqual(
      plain(buildWriteArgs('hashSetField', { key: 7, field: 'f' })),
      { dbIndex: 0, key: '7', field: 'f', value: '' }
    )
  })

  test('未知 op 抛可读错（防渲染层误传 op 名静默失败）', () => {
    assert.throws(
      () => buildWriteArgs('flushdb', { dbIndex: 0, key: 'a' }),
      /unsupported redis write op: flushdb/
    )
  })
})
