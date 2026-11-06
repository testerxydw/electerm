// 审计中心加入左侧图标栏 —— 迁移语义回归：
// 1) 存量用户（从未自定义过，配置恰为旧 7 项默认）升级后能看到 auditCenter；
// 2) 自定义过的用户保持原选择（缺失项视为有意移除，不被强行插回）；
// 3) auditCenter 可被用户显式移除，移除后不回弹；
// 4) app 侧 CommonJS 默认列表补了 auditCenter，且与客户端合法 id 集合一致。
const { before, describe, test } = require('node:test')
const assert = require('node:assert/strict')

let defs
let appDefaults

const LEGACY = [
  'newBookmark',
  'quickConnect',
  'bookmarks',
  'terminalThemes',
  'setting',
  'settingSync',
  'widgets'
]

before(async () => {
  defs = await import('../../client/common/left-sidebar-icon-defs.js')
  appDefaults = require('../../app/common/default-setting.js')
})

describe('left sidebar icons: audit center migration', () => {
  test('options expose auditCenter as the 8th customizable icon', () => {
    assert.equal(defs.leftSidebarIconOptions.length, 8)
    assert.equal(defs.leftSidebarIconOptions[7].id, 'auditCenter')
    assert.equal(defs.defaultLeftSideBarIcons.length, 8)
    assert.equal(defs.defaultLeftSideBarIcons[7], 'auditCenter')
    assert.equal(defs.leftSidebarIconIds.has('auditCenter'), true)
  })

  test('legacy default list stays the untouched 7-item pre-audit list', () => {
    assert.deepStrictEqual(defs.legacyDefaultLeftSideBarIcons, LEGACY)
    // 关键反例：一旦把 auditCenter 混进 legacy 列表，存量迁移判定恒不成立
    assert.equal(defs.legacyDefaultLeftSideBarIcons.includes('auditCenter'), false)
  })

  test('legacy persisted config migrates to the new default (auditCenter appears)', () => {
    assert.deepStrictEqual(
      defs.normalizeLeftSideBarIcons(LEGACY),
      [...defs.defaultLeftSideBarIcons]
    )
  })

  test('customized list is preserved: removed items are not re-inserted', () => {
    const customized = LEGACY.filter(id => id !== 'newBookmark')
    assert.deepStrictEqual(
      defs.normalizeLeftSideBarIcons(customized),
      ['quickConnect', 'bookmarks', 'terminalThemes', 'setting', 'settingSync', 'widgets']
    )
  })

  test('user can explicitly remove auditCenter and it does not bounce back', () => {
    const withoutAudit = LEGACY.concat('auditCenter').slice(1)
    // = 自定义列表（去掉 newBookmark）+ 显式加入 auditCenter，再移除 auditCenter
    const explicit = [
      'quickConnect', 'bookmarks', 'terminalThemes',
      'setting', 'settingSync', 'widgets'
    ]
    assert.deepStrictEqual(defs.normalizeLeftSideBarIcons(explicit), explicit)
    assert.equal(defs.normalizeLeftSideBarIcons(explicit).includes('auditCenter'), false)
    assert.equal(withoutAudit.length, 7)
  })

  test('non-array values fall back to the new default', () => {
    for (const bad of [undefined, null, 'auditCenter', {}, 123]) {
      assert.deepStrictEqual(defs.normalizeLeftSideBarIcons(bad), [...defs.defaultLeftSideBarIcons])
    }
  })

  test('unknown ids are dropped, order is preserved for the rest', () => {
    assert.deepStrictEqual(
      defs.normalizeLeftSideBarIcons(['auditCenter', 'nope', 'setting']),
      ['auditCenter', 'setting']
    )
  })

  test('normalize is idempotent', () => {
    const once = defs.normalizeLeftSideBarIcons(LEGACY)
    assert.deepStrictEqual(defs.normalizeLeftSideBarIcons(once), once)
    const custom = defs.normalizeLeftSideBarIcons(['bookmarks', 'auditCenter'])
    assert.deepStrictEqual(defs.normalizeLeftSideBarIcons(custom), custom)
  })

  test('app-side CommonJS default list includes auditCenter with valid ids only', () => {
    const list = appDefaults.leftSideBarIcons
    assert.equal(Array.isArray(list), true)
    assert.equal(list.includes('auditCenter'), true)
    for (const id of list) {
      assert.equal(defs.leftSidebarIconIds.has(id), true, `unknown id in app defaults: ${id}`)
    }
    assert.equal(new Set(list).size, list.length, 'app defaults must not contain duplicates')
  })

  test('app default list survives normalize unchanged (not mistaken for legacy)', () => {
    assert.deepStrictEqual(
      defs.normalizeLeftSideBarIcons(appDefaults.leftSideBarIcons),
      appDefaults.leftSideBarIcons
    )
  })

  test('sidebar registry renders auditCenter via openAuditCenter; menu entry kept', async () => {
    const fs = require('node:fs')
    const path = require('node:path')
    const iconsJsx = fs.readFileSync(
      path.resolve(__dirname, '../../client/components/sidebar/left-sidebar-icons.jsx'),
      'utf8'
    )
    assert.match(iconsJsx, /auditCenter:\s*\(/, 'registry missing auditCenter entry')
    assert.match(iconsJsx, /HistoryOutlined/, 'auditCenter should use HistoryOutlined icon')
    assert.match(iconsJsx, /openAuditCenter\(\)/)
    const menuJsx = fs.readFileSync(
      path.resolve(__dirname, '../../client/components/sys-menu/menu-btn.jsx'),
      'utf8'
    )
    // 系统菜单原入口必须保留
    assert.match(menuJsx, /auditCenter/)
  })

  test('setting page and store both normalize through the shared helper', async () => {
    const fs = require('node:fs')
    const path = require('node:path')
    const settingJsx = fs.readFileSync(
      path.resolve(__dirname, '../../client/components/setting-panel/setting-left-sidebar-icons.jsx'),
      'utf8'
    )
    assert.match(settingJsx, /normalizeLeftSideBarIcons\(config\.leftSideBarIcons\)/)
    const mainJsx = fs.readFileSync(
      path.resolve(__dirname, '../../client/components/main/main.jsx'),
      'utf8'
    )
    assert.match(mainJsx, /normalizeLeftSideBarIcons\(config\.leftSideBarIcons\)/)
    const syncJs = fs.readFileSync(
      path.resolve(__dirname, '../../client/store/sync.js'),
      'utf8'
    )
    // configSyncKeys 必须带上 leftSideBarIcons，换机同步不丢
    assert.match(syncJs, /'leftSideBarIcons'/)
  })
})
