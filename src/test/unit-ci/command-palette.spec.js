const { describe, test } = require('node:test')
const assert = require('node:assert/strict')

// filter.js 无任何依赖，可直接加载
const load = async () => {
  const { filterItems } = await import('../../client/components/command-palette/filter.js')
  return filterItems
}

describe('command-palette · filterItems', () => {
  test('空查询返回全部', async () => {
    const filterItems = await load()
    const items = [{ label: 'a' }, { label: 'b' }]
    assert.equal(filterItems(items, '').length, 2)
  })

  test('空白查询返回全部', async () => {
    const filterItems = await load()
    const items = [{ label: 'a' }]
    assert.equal(filterItems(items, '   ').length, 1)
  })

  test('按 label 过滤（大小写不敏感）', async () => {
    const filterItems = await load()
    const items = [{ label: 'Ubuntu Prod' }, { label: 'db-primary' }]
    assert.deepEqual(
      filterItems(items, 'ubun').map(i => i.label),
      ['Ubuntu Prod']
    )
  })

  test('按 keywords 过滤', async () => {
    const filterItems = await load()
    const items = [
      { label: 'x', keywords: 'redis cache' },
      { label: 'y' }
    ]
    assert.deepEqual(
      filterItems(items, 'redis').map(i => i.label),
      ['x']
    )
  })

  test('无匹配返回空数组', async () => {
    const filterItems = await load()
    assert.deepEqual(filterItems([{ label: 'a' }], 'zzz'), [])
  })

  test('缺失 label/keywords 不报错', async () => {
    const filterItems = await load()
    const items = [{}, { label: undefined, keywords: undefined }]
    assert.equal(filterItems(items, '').length, 2)
    assert.equal(filterItems(items, 'a').length, 0)
  })
})
