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

const {
  wrapDbAction,
  migrateStatus,
  migrateBatch,
  unsealAll,
  revealSecrets
} = require('../../app/lib/vault-bookmarks')
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
      // 与 sqlite.js 一致：update 是整条 data 替换，不是字段合并
      rows[index] = { ...set, _id: id }
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

  it('锁定态写回读到的行：_sealed 只是渲染层标记，不落库', async () => {
    const { raw, tables } = fakeDb({ bookmarks: [sealedBookmark()] })
    const dbAction = wrapDbAction(raw, context({ unlocked: false }))
    const rows = await dbAction('bookmarks', 'find', {})
    assert.equal(rows[0]._sealed, true)
    const renamed = { ...rows[0], title: 'renamed' }
    await dbAction('bookmarks', 'update', { _id: 'b1' }, { $set: renamed })
    assert.equal(tables.bookmarks[0].title, 'renamed')
    assert.equal(tables.bookmarks[0]._sealed, undefined)
    assert.ok(tables.bookmarks[0]._vault)
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

describe('迁移', () => {
  function legacy (id, password) {
    return { _id: id, title: id, password }
  }

  it('migrateStatus 统计旧格式与已封存行', async () => {
    const { raw } = fakeDb({
      bookmarks: [legacy('a', 'p1'), legacy('b', 'p2'), sealedBookmark()],
      profiles: [{ _id: 'c', name: 'n' }]
    })
    const got = await migrateStatus(raw)
    assert.deepEqual(
      { total: got.total, sealed: got.sealed, plain: got.plain },
      { total: 3, sealed: 1, plain: 2 }
    )
  })

  it('migrateBatch 按 limit 分批，剩余行数正确，且不重封已封存行', async () => {
    const { raw, tables } = fakeDb({
      bookmarks: [legacy('a', 'p1'), legacy('b', 'p2'), legacy('c', 'p3'), sealedBookmark()]
    })
    const first = await migrateBatch(raw, { limit: 2 }, context())
    assert.equal(first.ok, true)
    assert.equal(first.migrated, 2)
    assert.equal(first.remaining, 1)
    assert.equal(tables.bookmarks.filter(row => row._vault).length, 3)
    assert.equal(tables.bookmarks.filter(row => row.password).length, 1)

    const second = await migrateBatch(raw, { limit: 2 }, context())
    assert.equal(second.migrated, 1)
    assert.equal(second.remaining, 0)
    assert.equal(tables.bookmarks.filter(row => row.password).length, 0)

    const third = await migrateBatch(raw, {}, context())
    assert.equal(third.migrated, 0)
    assert.equal(third.remaining, 0)
  })

  it('锁定态迁移被拒绝', async () => {
    const { raw } = fakeDb({ bookmarks: [legacy('a', 'p')] })
    const got = await migrateBatch(raw, {}, context({ unlocked: false }))
    assert.equal(got.ok, false)
    assert.equal(got.reason, 'vault-locked')
  })

  it('库没启用时迁移被拒绝', async () => {
    const { raw } = fakeDb({ bookmarks: [legacy('a', 'p')] })
    const got = await migrateBatch(raw, {}, context({ enabled: false }))
    assert.equal(got.ok, false)
    assert.equal(got.reason, 'no-vault')
  })
})

describe('停用前反解', () => {
  it('unsealAll 把封存行还原成明文并删掉封套', async () => {
    const { raw, tables } = fakeDb({
      bookmarks: [sealedBookmark(), { _id: 'plain', password: 'p' }]
    })
    const got = await unsealAll(raw, context())
    assert.equal(got.unsealed, 1)
    assert.equal(got.failed, 0)
    assert.equal(tables.bookmarks[0].password, 'p@ss')
    assert.equal(tables.bookmarks[0]._vault, undefined)
    // 本来就是旧格式的行不动
    assert.equal(tables.bookmarks[1].password, 'p')
  })

  it('单行解不开计入 failed，且不会被写成空行', async () => {
    const { raw, tables } = fakeDb({
      bookmarks: [{ _id: 'bad', _vault: { v: 1, data: 'broken' } }]
    })
    const got = await unsealAll(raw, context())
    assert.equal(got.failed, 1)
    assert.equal(got.unsealed, 0)
    assert.ok(tables.bookmarks[0]._vault)
  })

  it('锁定态反解被拒绝', async () => {
    const { raw } = fakeDb({ bookmarks: [sealedBookmark()] })
    const got = await unsealAll(raw, context({ unlocked: false }))
    assert.equal(got.ok, false)
    assert.equal(got.reason, 'vault-locked')
  })
})

describe('按 id 取回凭据', () => {
  it('只回敏感字段，不回标题/主机', async () => {
    const { raw } = fakeDb({ bookmarks: [sealedBookmark()] })
    const got = await revealSecrets(raw, 'b1', context())
    assert.equal(got.ok, true)
    assert.equal(got.secrets.top.password, 'p@ss')
    assert.equal(got.secrets.hoppings[0].password, 'hop-pass')
    assert.equal(got.secrets.title, undefined)
    assert.equal(got.secrets.host, undefined)
  })

  it('锁定态拒绝封印行', async () => {
    const { raw } = fakeDb({ bookmarks: [sealedBookmark()] })
    const got = await revealSecrets(raw, 'b1', context({ unlocked: false }))
    assert.equal(got.ok, false)
    assert.equal(got.reason, 'vault-locked')
  })

  it('旧格式行锁定态也能取（明文本来就在行里）', async () => {
    const { raw } = fakeDb({ bookmarks: [{ _id: 'legacy', password: 'old' }] })
    const got = await revealSecrets(raw, 'legacy', context({ unlocked: false }))
    assert.equal(got.ok, true)
    assert.equal(got.secrets.top.password, 'old')
  })

  it('找不到 / id 为空 / 库没启用各有独立 reason', async () => {
    const { raw } = fakeDb({ bookmarks: [] })
    assert.equal((await revealSecrets(raw, 'none', context())).reason, 'not-found')
    assert.equal((await revealSecrets(raw, '', context())).reason, 'bad-id')
    assert.equal((await revealSecrets(raw, 'b1', context({ enabled: false }))).reason, 'no-vault')
  })
})

describe('vault-instance 动作接线（源码契约）', () => {
  const fs = require('fs')
  const path = require('path')
  const src = fs.readFileSync(path.join(__dirname, '../../app/lib/vault-instance.js'), 'utf8')

  it('拦截 migrate / migrateStatus / unsealAll / revealBookmark / disable', () => {
    for (const action of ["'migrate'", "'migrateStatus'", "'unsealAll'", "'revealBookmark'", "'disable'"]) {
      assert.ok(src.includes('action === ' + action), 'missing action ' + action)
    }
  })

  it('停用顺序是"先解锁 → 再反解 → 最后删 config"', () => {
    const start = src.indexOf('async function disableVault')
    const end = src.indexOf('exports.vaultOp')
    const body = src.slice(start, end)
    const iUnseal = body.indexOf('unsealAll')
    const iDisable = body.lastIndexOf("service.run('disable'")
    assert.ok(iUnseal > 0 && iDisable > iUnseal, 'unseal must happen before disable')
    assert.ok(body.includes('vault-locked'), 'locked disable must be rejected')
  })
})
