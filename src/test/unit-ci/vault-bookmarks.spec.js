/**
 * G6 阶段② dbAction 凭据读写包装（设计 阶段4 §14.7）
 *
 * 用内存里的假 dbAction 验口径，不碰真库：
 *   - 锁定读不泄明文，只标 `_sealed`；
 *   - 解锁读合并回明文，删 `_vault`；
 *   - 旧格式行在锁定态照样透传（迁移中断仍能连接）；
 *   - 缺省写时的三种去向：解锁封存 / 锁定拒绝 / legacyWrite 透传；
 *   - 只改非敏感字段的更新保留 `_vault`；
 *   - 非书签表完全透传。
 */
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')

const { wrapDbAction } = require('../../app/lib/vault-bookmarks')
const s = require('../../app/lib/vault-secrets')

const dek = crypto.randomBytes(32)

function fakeDb (seed = {}) {
  const tables = {}
  for (const [name, rows] of Object.entries(seed)) {
    tables[name] = rows.map(row => ({ ...row }))
  }
  const calls = []
  const raw = async (dbName, op, ...args) => {
    calls.push({ dbName, op, args })
    const rows = tables[dbName] || (tables[dbName] = [])
    if (op === 'find') {
      return rows.map(row => ({ ...row }))
    }
    if (op === 'findOne') {
      const id = (args[0] || {})._id
      const row = rows.find(r => r._id === id)
      return row ? { ...row } : null
    }
    if (op === 'insert') {
      const input = Array.isArray(args[0]) ? args[0] : [args[0]]
      const out = []
      for (const row of input) {
        const _id = row._id || row.id
        const existing = rows.findIndex(r => r._id === _id)
        const next = { ...row, _id }
        if (existing >= 0) {
          rows[existing] = next
        } else {
          rows.push(next)
        }
        out.push({ ...next })
      }
      return Array.isArray(args[0]) ? out : out[0]
    }
    if (op === 'update') {
      const id = (args[0] || {})._id
      const update = args[1] || {}
      const set = update.$set || update
      const index = rows.findIndex(r => r._id === id)
      if (index < 0) {
        return 0
      }
      rows[index] = { ...rows[index], ...set, _id: id }
      return 1
    }
    if (op === 'remove') {
      const id = (args[0] || {})._id
      const index = rows.findIndex(r => r._id === id)
      if (index >= 0) {
        rows.splice(index, 1)
      }
      return 1
    }
    return 0
  }
  return { raw, tables, calls }
}

function context ({ enabled = true, unlocked = true, legacyWrite = false, key = dek } = {}) {
  return {
    state: () => ({ enabled, unlocked, legacyWrite }),
    withDek: fn => {
      if (!unlocked) {
        throw new Error('vault is locked')
      }
      return fn(key)
    }
  }
}

function sealedBookmark () {
  return s.sealRow({
    _id: 'b1',
    title: 'prod/web',
    host: '10.0.0.1',
    password: 'p@ss',
    connectionHoppings: [{ host: 'hop', username: 'root', password: 'hop-pass' }]
  }, dek)
}

describe('读路径', () => {
  it('锁定读：去掉明文、保留封套、标 _sealed', async () => {
    const { raw } = fakeDb({ bookmarks: [sealedBookmark()] })
    const dbAction = wrapDbAction(raw, context({ unlocked: false }))
    const rows = await dbAction('bookmarks', 'find', {})
    assert.equal(rows[0].password, undefined)
    assert.equal(rows[0]._sealed, true)
    assert.equal(rows[0].connectionHoppings[0].password, undefined)
    assert.ok(rows[0]._vault)
    assert.equal(rows[0].title, 'prod/web')
  })

  it('解锁读：合并回明文并删掉 _vault', async () => {
    const { raw } = fakeDb({ bookmarks: [sealedBookmark()] })
    const dbAction = wrapDbAction(raw, context())
    const rows = await dbAction('bookmarks', 'find', {})
    assert.equal(rows[0].password, 'p@ss')
    assert.equal(rows[0].connectionHoppings[0].password, 'hop-pass')
    assert.equal(rows[0]._vault, undefined)
    assert.equal(rows[0]._sealed, undefined)
  })

  it('旧格式明文行在锁定态透传（迁移中断仍能连接）', async () => {
    const { raw } = fakeDb({
      bookmarks: [{ _id: 'b2', title: 'legacy', password: 'old-pass' }]
    })
    const dbAction = wrapDbAction(raw, context({ unlocked: false }))
    const rows = await dbAction('bookmarks', 'find', {})
    assert.equal(rows[0].password, 'old-pass')
    assert.equal(rows[0]._sealed, undefined)
  })

  it('解不开的封套：不抛、不回明文、仍标 _sealed', async () => {
    const { raw } = fakeDb({ bookmarks: [sealedBookmark()] })
    const dbAction = wrapDbAction(raw, context({ key: crypto.randomBytes(32) }))
    const rows = await dbAction('bookmarks', 'find', {})
    assert.equal(rows[0].password, undefined)
    assert.equal(rows[0]._sealed, true)
  })

  it('findOne 走同一条读路径', async () => {
    const { raw } = fakeDb({ bookmarks: [sealedBookmark()] })
    const dbAction = wrapDbAction(raw, context({ unlocked: false }))
    const row = await dbAction('bookmarks', 'findOne', { _id: 'b1' })
    assert.equal(row.password, undefined)
    assert.equal(row._sealed, true)
  })

  it('库没启用时读路径原样返回', async () => {
    const { raw } = fakeDb({ bookmarks: [sealedBookmark()] })
    const dbAction = wrapDbAction(raw, context({ enabled: false, unlocked: false }))
    const rows = await dbAction('bookmarks', 'find', {})
    assert.ok(rows[0]._vault)
    assert.equal(rows[0]._sealed, undefined)
  })
})

describe('写路径', () => {
  it('解锁态写入：明文被替换成 _vault', async () => {
    const { raw, tables } = fakeDb()
    const dbAction = wrapDbAction(raw, context())
    await dbAction('bookmarks', 'insert', [{ _id: 'b3', title: 'new', password: 'p' }])
    assert.equal(tables.bookmarks[0].password, undefined)
    assert.ok(tables.bookmarks[0]._vault)
  })

  it('锁定态写入带明文：抛 vault-locked，不写库', async () => {
    const { raw, tables } = fakeDb()
    const dbAction = wrapDbAction(raw, context({ unlocked: false }))
    await assert.rejects(
      () => dbAction('bookmarks', 'insert', [{ _id: 'b4', password: 'p' }]),
      err => err.reason === 'vault-locked'
    )
    assert.equal((tables.bookmarks || []).length, 0)
  })

  it('锁定态只改标题：原样透传，_vault 保留', async () => {
    const { raw, tables } = fakeDb({ bookmarks: [sealedBookmark()] })
    const dbAction = wrapDbAction(raw, context({ unlocked: false }))
    const row = { ...tables.bookmarks[0], title: 'renamed' }
    await dbAction('bookmarks', 'update', { _id: 'b1' }, { $set: row })
    assert.equal(tables.bookmarks[0].title, 'renamed')
    assert.ok(tables.bookmarks[0]._vault)
    assert.equal(tables.bookmarks[0].password, undefined)
  })

  it('legacyWrite 打开：明文照旧落库', async () => {
    const { raw, tables } = fakeDb()
    const dbAction = wrapDbAction(raw, context({ legacyWrite: true }))
    await dbAction('bookmarks', 'insert', [{ _id: 'b5', password: 'p' }])
    assert.equal(tables.bookmarks[0].password, 'p')
    assert.equal(tables.bookmarks[0]._vault, undefined)
  })

  it('库没启用：明文照旧落库', async () => {
    const { raw, tables } = fakeDb()
    const dbAction = wrapDbAction(raw, context({ enabled: false }))
    await dbAction('bookmarks', 'insert', [{ _id: 'b6', password: 'p' }])
    assert.equal(tables.bookmarks[0].password, 'p')
  })

  it('非敏感表完全透传（参数不变）', async () => {
    const { raw, calls } = fakeDb({ quickCommands: [{ _id: 'q1', command: 'ls' }] })
    const dbAction = wrapDbAction(raw, context({ unlocked: false }))
    await dbAction('quickCommands', 'find', {})
    assert.equal(calls.length, 1)
    assert.equal(calls[0].dbName, 'quickCommands')
    assert.equal(calls[0].op, 'find')
  })

  it('profiles 表同样封存/解开', async () => {
    const { raw, tables } = fakeDb()
    const dbAction = wrapDbAction(raw, context())
    await dbAction('profiles', 'insert', [{ _id: 'p1', name: 'daily', privateKey: 'KEY' }])
    assert.equal(tables.profiles[0].privateKey, undefined)
    assert.ok(tables.profiles[0]._vault)
    const rows = await dbAction('profiles', 'find', {})
    assert.equal(rows[0].privateKey, 'KEY')
  })
})
