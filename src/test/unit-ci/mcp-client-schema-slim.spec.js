/**
 * MCP client · schema 裁剪与入参校验。
 *
 * 两条**硬契约**在这里钉死（QA 在 T1 压过的两条，见 lead 追加判据）：
 *
 * 1. `validateArgs` 只校验**已声明**的键，未声明键一律放行。把「多余键」当拒绝
 *    理由会造出「接上了但工具永远失败」的死局，且归因极难。
 * 2. schema 超预算时降级成 `properties: {}` 后，任何入参都必须放行 —— 降级分支
 *    必须保持**可调用**，否则这条分支等于把工具悄悄废掉。
 */

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')

const { LIMITS, toOpenAIParameters, validateArgs } = require('../../app/mcp/client/schema-slim')

/**
 * 造一个必定超出 jsonBytes 预算的 schema：200 条 80 字符 enum。
 * 宽 schema 会被 propsPerLevel 收缩掉，只有 enum 这种不随层级收缩的内容能把
 * 字节数顶穿到每个候选档位都过不去。
 * @returns {object}
 */
function hugeSchema () {
  const values = []
  for (let i = 0; i < 200; i++) {
    values.push(String(i).padStart(3, '0') + '-' + 'x'.repeat(77))
  }
  return {
    type: 'object',
    properties: {
      filter: { type: 'string', enum: values }
    },
    required: ['filter']
  }
}

describe('mcp-client schema-slim', () => {
  it('根永远是 object + properties（provider 不接受裸 {type}）', () => {
    const { parameters, degraded } = toOpenAIParameters({ type: 'string' })
    assert.equal(parameters.type, 'object')
    assert.deepEqual(parameters.properties, {})
    assert.equal(degraded, true)
  })

  it('$defs 不外发，$ref 解析成本地结构', () => {
    const { parameters } = toOpenAIParameters({
      type: 'object',
      $defs: {
        Point: {
          type: 'object',
          properties: { x: { type: 'number' } }
        }
      },
      properties: {
        start: { $ref: '#/$defs/Point' }
      }
    })
    assert.equal(parameters.$defs, undefined, '$defs 不能出现在 parameters 里（纯浪费 token）')
    assert.equal(parameters.properties.start.type, 'object')
    assert.equal(parameters.properties.start.properties.x.type, 'number')
  })

  it('描述按 descChars 截断，并带省略号', () => {
    const { parameters } = toOpenAIParameters({
      type: 'object',
      properties: {
        a: { type: 'string', description: 'y'.repeat(LIMITS.descChars + 50) }
      }
    })
    const desc = parameters.properties.a.description
    assert.equal(desc.length, LIMITS.descChars)
    assert.ok(desc.endsWith('…'))
  })

  it('字段过多时按 propsPerLevel 裁剪，required 优先保留，并报 degraded', () => {
    const properties = {}
    for (let i = 0; i < 60; i++) {
      properties[`p${i}`] = { type: 'string' }
    }
    const { parameters, degraded, notes } = toOpenAIParameters({
      type: 'object',
      properties,
      required: ['p59']
    })
    const kept = Object.keys(parameters.properties)
    assert.ok(kept.length <= LIMITS.propsPerLevel, `kept=${kept.length}`)
    assert.ok(kept.includes('p59'), 'required 字段必须留下')
    assert.equal(degraded, true)
    assert.ok(notes.some(note => note.includes('omitted')), JSON.stringify(notes))
  })

  it('超预算的 schema 降级成 properties: {}，带 degraded + notes', () => {
    const { parameters, degraded, notes } = toOpenAIParameters(hugeSchema())
    assert.deepEqual(parameters.properties, {})
    assert.equal(degraded, true)
    assert.ok(notes.length > 0, '降级必须留下可读原因，UI 徽章要读它')
    assert.ok(
      notes.some(note => note.includes('too large') || note.includes('bytes')),
      JSON.stringify(notes)
    )
    const bytes = Buffer.byteLength(JSON.stringify(parameters), 'utf8')
    assert.ok(bytes <= LIMITS.jsonBytes, `降级后仍超预算: ${bytes}`)
  })

  it('降级后的 parameters 对任何入参都放行（没有声明键可校验）', () => {
    const { parameters } = toOpenAIParameters(hugeSchema())
    for (const args of [
      {},
      { filter: 'anything' },
      { filter: 123, extra: { nested: [1, 2, 3] } },
      { totally: 'different', keys: true }
    ]) {
      const result = validateArgs(parameters, args)
      assert.equal(result.ok, true, `degraded parameters 不该拒绝 ${JSON.stringify(args)}`)
    }
  })

  it('validateArgs 的 required / type / enum 三正三反', () => {
    const parameters = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        count: { type: 'integer' },
        mode: { type: 'string', enum: ['fast', 'slow'] }
      },
      required: ['name']
    }

    assert.equal(validateArgs(parameters, { name: 'x', count: 2, mode: 'fast' }).ok, true)

    const missing = validateArgs(parameters, {})
    assert.equal(missing.ok, false)
    assert.equal(missing.errors[0].path, '$.name')
    assert.match(missing.errors[0].message, /required/)

    const wrongType = validateArgs(parameters, { name: 42 })
    assert.equal(wrongType.ok, false)
    assert.match(wrongType.errors[0].message, /expected string, got number/)

    const badEnum = validateArgs(parameters, { name: 'x', mode: 'medium' })
    assert.equal(badEnum.ok, false)
    assert.match(badEnum.errors[0].message, /value must be one of/)
  })

  it('未声明的键必须放行（否则「多余参数」会变成永远的调用失败）', () => {
    const parameters = {
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a']
    }
    const result = validateArgs(parameters, { a: 'x', b: 1, __proto__x: 2 })
    assert.equal(result.ok, true)
    assert.deepEqual(result.errors, [])
  })

  it('参数的嵌套数组元素也按 items 校验（宽松但不放过类型错）', () => {
    const parameters = {
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string' } }
      }
    }
    assert.equal(validateArgs(parameters, { tags: ['a', 'b'] }).ok, true)
    const bad = validateArgs(parameters, { tags: ['a', 2] })
    assert.equal(bad.ok, false)
    assert.equal(bad.errors[0].path, '$.tags[1]')
  })
})
