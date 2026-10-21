// T4 PG 跨库连接引导回归：
//  - 仅非当前 PG 库显示「连接」入口，不干扰 MySQL/Redis
//  - 确认后复制当前连接参数另开临时 tab，不写书签
//  - 弹窗只展示 host/port/user/target db，不出现密码
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const JSX = path.join(ROOT, 'src/client/components/database/db-session.jsx')
const STYL = path.join(ROOT, 'src/client/components/database/db-session.styl')
const LOCALES = path.join(ROOT, 'src/app/common/locales-extra.js')

const read = p => fs.readFileSync(p, 'utf8')

describe('T4 postgres cross-database connect', () => {
  test('入口仅对非当前 PG 库显示', () => {
    const src = read(JSX)
    assert.ok(src.includes("const isPg = tab.dbType === 'postgres'"), 'postgres guard missing')
    assert.ok(src.includes('isPg && db.name !== currentDbName'), 'must skip current database')
    assert.ok(src.includes("const currentDbName = tab.dbName || tab.dbUser || ''"), 'default db fallback missing')
    assert.ok(src.includes('stopPropagation'), 'connect click must not toggle tree node')
  })

  test('确认后新开临时 tab 并切换 dbName', () => {
    const src = read(JSX)
    const block = src.match(/const connectOtherDb = \(\) => \{[\s\S]*?\n\s{2}\}/)
    assert.ok(block, 'connectOtherDb not found')
    const code = block[0]
    assert.ok(code.includes('window.store.addTab(next)'), 'must open a new tab')
    assert.ok(code.includes('next.dbName = connectDb'), 'must target the clicked database')
    assert.ok(code.includes('delete next.id'), 'new tab needs a fresh id')
    assert.ok(!code.includes('bookmark'), 'temporary tab must not write bookmarks')
  })

  test('弹窗不回显密码', () => {
    const src = read(JSX)
    const modal = src.match(/<Modal[\s\S]*?<\/Modal>/)
    assert.ok(modal, 'connect modal missing')
    assert.ok(!modal[0].includes('dbPassword'), 'password must not be rendered')
    assert.ok(modal[0].includes("{e('dbName')}"), 'target database row missing')
  })

  test('i18n 词条与样式存在', () => {
    const locales = read(LOCALES)
    ;['dbConnect', 'dbConnectOther', 'dbConnectOtherHint'].forEach(key => {
      const hits = locales.match(new RegExp('\\b' + key + ':', 'g')) || []
      assert.equal(hits.length, 2, key + ' must exist in en and zh_cn')
    })
    const styl = read(STYL)
    ;['.db-tree-connect', '.db-connect-rows', '.db-connect-row'].forEach(sel => {
      assert.match(styl, new RegExp('^' + sel.replace('.', '\\.') + '$', 'm'), sel + ' block missing')
    })
  })
})
