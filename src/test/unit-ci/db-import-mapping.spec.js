/**
 * db-import-mapping 单测（C 批前端）：映射折算/校验/upsert 主键覆盖。
 * ES 模块跑真实源码（strip export + vm，模式同 db-csv.spec.js）。
 */
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const SRC = path.join(ROOT, 'src/client/common/db-import-mapping.js')

const loadFns = () => {
  const code = fs.readFileSync(SRC, 'utf8').replace(/^export /gm, '')
  const ctx = {}
  vm.createContext(ctx)
  vm.runInContext(code, ctx)
  assert.equal(typeof ctx.buildImportMapping, 'function', 'buildImportMapping missing')
  assert.equal(typeof ctx.mappingProblem, 'function', 'mappingProblem missing')
  assert.equal(typeof ctx.pkCovered, 'function', 'pkCovered missing')
  return ctx
}

describe('db-import-mapping buildImportMapping', () => {
  const { buildImportMapping } = loadFns()

  test('field 模式：折算为字符串 target', () => {
    const out = buildImportMapping([
      { fileCol: 'a', mode: 'field', target: 'col_a' },
      { fileCol: 'b', mode: 'ignore' }
    ])
    assert.equal(JSON.stringify(out), JSON.stringify([{ fileCol: 'a', target: 'col_a' }]))
  })

  test('忽略行被剔除，全忽略抛空映射', () => {
    assert.throws(() => buildImportMapping([{ fileCol: 'a', mode: 'ignore' }]), /dbImportMappingEmpty/)
    assert.throws(() => buildImportMapping([]), /dbImportMappingEmpty/)
  })

  test('field 缺 target 抛错', () => {
    assert.throws(
      () => buildImportMapping([{ fileCol: 'a', mode: 'field', target: '' }]),
      /dbImportMappingNoTarget/
    )
  })

  test('constant：column 缺省取 fileCol，value 透传（含 null）', () => {
    const out = buildImportMapping([
      { fileCol: 'a', mode: 'constant', constVal: 'K' },
      { fileCol: 'b', mode: 'constant', objCol: 'note', constVal: null }
    ])
    assert.equal(JSON.stringify(out), JSON.stringify([
      { fileCol: 'a', target: { mode: 'constant', value: 'K', column: 'a' } },
      { fileCol: 'b', target: { mode: 'constant', value: null, column: 'note' } }
    ]))
  })

  test('expression：sql 必填、去首尾空白、column 可指定', () => {
    const out = buildImportMapping([
      { fileCol: 'c', mode: 'expression', exprSql: '  UPPER(c)  ', objCol: 'name' }
    ])
    assert.equal(JSON.stringify(out), JSON.stringify([
      { fileCol: 'c', target: { mode: 'expression', sql: 'UPPER(c)', column: 'name' } }
    ]))
    assert.throws(
      () => buildImportMapping([{ fileCol: 'c', mode: 'expression', exprSql: '  ' }]),
      /dbImportMappingNoExpr/
    )
  })

  test('null 模式：column 缺省取 fileCol', () => {
    const out = buildImportMapping([{ fileCol: 'del', mode: 'null', objCol: 'deleted_at' }])
    assert.equal(JSON.stringify(out), JSON.stringify([
      { fileCol: 'del', target: { mode: 'null', column: 'deleted_at' } }
    ]))
  })

  test('未知模式抛错', () => {
    assert.throws(
      () => buildImportMapping([{ fileCol: 'a', mode: 'weird' }]),
      /dbImportMappingUnknownMode/
    )
  })
})

describe('db-import-mapping mappingProblem', () => {
  const { mappingProblem } = loadFns()

  test('合法映射返回 null，非法返回消息 key', () => {
    assert.equal(mappingProblem([{ fileCol: 'a', mode: 'field', target: 'c' }]), null)
    assert.equal(mappingProblem([]), 'dbImportMappingEmpty')
    assert.equal(mappingProblem(null), 'dbImportMappingEmpty')
    assert.equal(
      mappingProblem([{ fileCol: 'a', mode: 'expression', exprSql: '' }]),
      'dbImportMappingNoExpr'
    )
  })
})

describe('db-import-mapping pkCovered（upsert 前置）', () => {
  const { pkCovered } = loadFns()

  test('无主键 → 不可 upsert', () => {
    assert.equal(pkCovered([], [{ fileCol: 'id', mode: 'field', target: 'id' }]), false)
    assert.equal(pkCovered(null, []), false)
  })

  test('主键列全部被 field 映射覆盖（大小写不敏感）→ 可 upsert', () => {
    assert.equal(pkCovered(
      ['ID'],
      [{ fileCol: 'id', mode: 'field', target: 'id' }, { fileCol: 'n', mode: 'ignore' }]
    ), true)
  })

  test('缺任一主键列 / 主键列走了 ignore → 不可 upsert', () => {
    assert.equal(pkCovered(
      ['id', 'tenant'],
      [{ fileCol: 'id', mode: 'field', target: 'id' }]
    ), false)
    assert.equal(pkCovered(
      ['id'],
      [{ fileCol: 'id', mode: 'ignore' }]
    ), false)
    // constant/null/expression 不算覆盖：pk 值必须来自文件字段
    assert.equal(pkCovered(
      ['id'],
      [{ fileCol: 'x', mode: 'constant', constVal: 1, objCol: 'id' }]
    ), false)
  })
})
