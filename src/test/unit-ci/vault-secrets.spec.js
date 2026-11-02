/**
 * G6 阶段② 敏感字段封装纯模块（设计 阶段4 §14.7）
 *
 * 只验形状与口径：
 *   - 收哪些字段（顶层 6 项 + 跳板 4 项）、空串不算；
 *   - 封套只有一个 `_vault`，明文被删干净，非敏感字段原样；
 *   - 解开能合并回原位（跳板按下标对齐）；
 *   - 解密失败不抛、也不回明文；
 *   - 不改入参。
 */
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')

const s = require('../../app/lib/vault-secrets')

const dek = crypto.randomBytes(32)

function bookmark (extra = {}) {
  return {
    id: 'b1',
    title: 'prod/web',
    host: '10.0.0.1',
    port: 22,
    username: 'root',
    ...extra
  }
}

describe('敏感字段口径', () => {
  it('顶层 6 项、跳板 4 项、只处理 bookmarks 与 profiles', () => {
    assert.deepEqual(s.SECRET_KEYS, [
      'password',
      'privateKey',
      'passphrase',
      'certificate',
      'dbPassword',
      'proxyPassword'
    ])
    assert.deepEqual(s.HOPPING_SECRET_KEYS, [
      'password',
      'privateKey',
      'passphrase',
      'certificate'
    ])
    assert.ok(s.SECRET_TABLES.has('bookmarks'))
    assert.ok(s.SECRET_TABLES.has('profiles'))
    assert.equal(s.SECRET_TABLES.has('addressBookmarks'), false)
    assert.equal(s.SECRET_TABLES.has('quickCommands'), false)
  })

  it('空串不算凭据，没有任何凭据时 collectSecrets 回 null', () => {
    assert.equal(s.collectSecrets(bookmark()), null)
    assert.equal(s.collectSecrets(bookmark({ password: '' })), null)
    assert.equal(s.collectSecrets(null), null)
  })

  it('跳板数组按下标保留空位，不把第 2 个跳板的凭据挤到第 1 个', () => {
    const row = bookmark({
      connectionHoppings: [
        { host: 'hop-a', username: 'root' },
        { host: 'hop-b', password: 'hop-pass', passphrase: 'hop-phrase' },
        { host: 'hop-c' }
      ]
    })
    const got = s.collectSecrets(row)
    assert.equal(got.hoppings.length, 3)
    assert.deepEqual(got.hoppings[0], {})
    assert.deepEqual(got.hoppings[1], { password: 'hop-pass', passphrase: 'hop-phrase' })
    assert.deepEqual(got.hoppings[2], {})
  })
})

describe('stripSecrets', () => {
  it('删掉顶层与跳板的明文，保留其它字段与已有的 _vault', () => {
    const row = bookmark({
      password: 'p',
      privateKey: 'k',
      dbPassword: 'db',
      connectionHoppings: [{ host: 'h', password: 'hp', username: 'root' }],
      _vault: { v: 1, data: 'old' }
    })
    const got = s.stripSecrets(row)
    assert.equal(got.password, undefined)
    assert.equal(got.privateKey, undefined)
    assert.equal(got.dbPassword, undefined)
    assert.equal(got.connectionHoppings[0].password, undefined)
    assert.equal(got.connectionHoppings[0].username, 'root')
    assert.deepEqual(got._vault, { v: 1, data: 'old' })
    assert.equal(row.password, 'p', '不得改入参')
  })
})

describe('封存与解开', () => {
  it('sealRow 只留一个 _vault，明文全删，非敏感字段原样', () => {
    const row = bookmark({
      password: 'p@ss',
      privateKey: 'KEY',
      proxyPassword: 'proxy',
      connectionHoppings: [{ host: 'h', password: 'hp', username: 'root' }]
    })
    const sealed = s.sealRow(row, dek)
    assert.equal(s.hasSealed(sealed), true)
    assert.deepEqual(sealed._vault.v, 1)
    assert.equal(typeof sealed._vault.data, 'string')
    assert.equal(sealed.password, undefined)
    assert.equal(sealed.privateKey, undefined)
    assert.equal(sealed.proxyPassword, undefined)
    assert.equal(sealed.connectionHoppings[0].password, undefined)
    assert.equal(sealed.connectionHoppings[0].username, 'root')
    assert.equal(sealed.title, 'prod/web')
    assert.equal(row.password, 'p@ss', '不得改入参')
  })

  it('openRow 能合并回顶层与跳板原位置，并删掉 _vault', () => {
    const original = bookmark({
      password: 'p@ss',
      dbPassword: 'db-pass',
      connectionHoppings: [
        { host: 'hop-a', username: 'root' },
        { host: 'hop-b', password: 'hop-pass' }
      ]
    })
    const sealed = s.sealRow(original, dek)
    const { row, error } = s.openRow(sealed, dek)
    assert.equal(error, null)
    assert.equal(row.password, 'p@ss')
    assert.equal(row.dbPassword, 'db-pass')
    assert.equal(row.connectionHoppings[0].password, undefined)
    assert.equal(row.connectionHoppings[1].password, 'hop-pass')
    assert.equal(row._vault, undefined)
    assert.equal(row.title, 'prod/web')
  })

  it('没有凭据时不制造空封套', () => {
    const row = bookmark()
    const sealed = s.sealRow(row, dek)
    assert.equal(sealed, row)
    assert.equal(s.hasSealed(sealed), false)
  })

  it('错误 DEK 不抛、不回明文，只留去掉明文的行', () => {
    const row = bookmark({ password: 'p@ss' })
    const sealed = s.sealRow(row, dek)
    const wrong = crypto.randomBytes(32)
    const got = s.openRow(sealed, wrong)
    assert.ok(got.error)
    assert.equal(got.row.password, undefined)
    assert.equal(got.row.title, 'prod/web')
  })

  it('封套损坏（data 不是密文）同样不抛', () => {
    const row = { ...bookmark({ password: 'p@ss' }), _vault: { v: 1, data: 'not-a-seal' } }
    const got = s.openRow(row, dek)
    assert.ok(got.error)
    assert.equal(got.row.password, undefined)
  })

  it('openRow 对没有 _vault 的行原样返回', () => {
    const row = bookmark({ password: 'legacy' })
    const got = s.openRow(row, dek)
    assert.equal(got.error, null)
    assert.equal(got.row.password, 'legacy')
  })
})

describe('状态与计数', () => {
  it('rowState 区分 sealed / plain / empty', () => {
    assert.equal(s.rowState(bookmark()), 'empty')
    assert.equal(s.rowState(bookmark({ password: 'p' })), 'plain')
    const sealed = s.sealRow(bookmark({ password: 'p' }), dek)
    assert.equal(s.rowState(sealed), 'sealed')
    // 同时存在封套与明文时以封套为准（写入路径会重新封存）
    assert.equal(s.rowState({ ...sealed, password: 'p' }), 'sealed')
  })

  it('secretCount 统计顶层 + 跳板的非空凭据数', () => {
    assert.equal(s.secretCount(bookmark()), 0)
    assert.equal(s.secretCount(bookmark({ password: 'p', passphrase: 'x' })), 2)
    assert.equal(s.secretCount(bookmark({
      password: 'p',
      connectionHoppings: [{ password: 'a' }, { passphrase: 'b' }]
    })), 3)
    // 封存后的行没有明文，计数为 0（迁移只看 plain 行）
    assert.equal(s.secretCount(s.sealRow(bookmark({ password: 'p' }), dek)), 0)
  })
})
